import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { recordAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import { materializePluginPolicies } from "../plugin-materializer.js";
import {
  pluginPolicyActivationPhase,
  pluginPolicyColdStartCritical,
  pluginPolicyRequiresEngineRestart,
  resolveEffectivePluginPolicies,
  visiblePluginPolicies,
  type EffectivePluginPolicy,
  type PluginActivationPhase,
  type PluginOwnerKind,
  type PluginPolicy,
} from "../plugin-policy.js";
import {
  listPluginPolicyOverrides,
  setPluginEnabledState,
  setPluginRemovedState,
} from "../plugin-policy-store.js";
import { addPlugin, listPlugins, normalizePluginSpec, removePlugin } from "../plugins.js";
import {
  OPENCODE_SCHEDULER_PLATFORM_PLUGIN,
  SUPERPOWERS_PLATFORM_PLUGIN,
} from "../platform-managed-plugins.js";
import { workspaceResourceOwner } from "../resource-owner.js";
import { addRoute, type Route } from "../routing.js";
import {
  emitReloadEvent,
  ensureWritable,
  jsonResponse,
  readJsonBody,
  readOptionalJsonBody,
  requireApproval,
  requireClientScope,
  resolveWorkspace,
} from "../route-helpers.js";
import type { PluginInventoryItem, PluginItem, ResourceOwner, WorkspaceInfo } from "../types.js";
import { shortId } from "../utils.js";
import {
  opencodeConfigPath,
  projectManagedPluginSpecManifestPath,
  userManagedPluginSpecManifestPath,
  userOpencodeConfigPath,
} from "../workspace-files.js";

const ownerForWorkspace = (workspace: WorkspaceInfo) =>
  workspaceResourceOwner({ workspaceId: workspace.id, root: workspace.path, label: workspace.name });

const PLATFORM_PLUGIN_POLICIES = [
  OPENCODE_SCHEDULER_PLATFORM_PLUGIN,
  SUPERPOWERS_PLATFORM_PLUGIN,
];

const PLUGIN_ACTIVATION_PHASES = new Set<PluginActivationPhase>([
  "startup",
  "post-ready",
  "on-demand",
  "background-runtime",
]);

export type PluginRouteDependencies = {
  serverDataDir?: string;
  userOpencodeConfigDir?: string;
};

export function registerPluginRoutes(routes: Route[], dependencies: PluginRouteDependencies = {}): void {
  const { serverDataDir, userOpencodeConfigDir } = dependencies;

  addRoute(routes, "GET", "/workspace/:id/plugins", "client", async (ctx) => {
    const config = ctx.config;
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const debug = ctx.url.searchParams.get("debug") === "true";
    const result = await buildPluginInventory(workspace, {
      includeGlobal,
      debug,
      serverDataDir,
      userOpencodeConfigDir,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/plugins", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const spec = String(body.spec ?? "");
    const normalized = normalizePluginSpec(spec);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.add",
      summary: `Add plugin ${spec}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const changed = await addPlugin(workspace.path, spec);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.add",
      target: "opencode.json",
      summary: `Added ${spec}`,
      timestamp: Date.now(),
    });
    if (changed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "plugins", {
        type: "plugin",
        name: normalized,
        action: "added",
      });
    }
    const result = await buildPluginInventory(workspace, {
      includeGlobal: false,
      debug: false,
      serverDataDir,
      userOpencodeConfigDir,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/plugins/materialization/sync", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readOptionalJsonBody(ctx.request);
    const phase = parsePluginActivationPhase(body.phase ?? ctx.url.searchParams.get("phase"));
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.materialization.sync",
      summary: `Sync ${phase} managed plugins into OpenCode runtime state`,
      paths: materializationApprovalPaths(workspace, serverDataDir, userOpencodeConfigDir),
    });
    const policies = await resolveManagedPluginPolicies(workspace, { serverDataDir });
    const result = await materializePluginPolicies({
      workspaceRoot: workspace.path,
      dataDir: serverDataDir,
      userOpencodeConfigDir,
      policies,
      materializationPhase: phase,
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.materialization.sync",
      target: workspace.path,
      summary: `Synced ${phase} managed plugin policy record(s) from ${policies.length} total policy record(s)`,
      timestamp: Date.now(),
    });
    if (result.reloadRequired) {
      emitReloadEvent(ctx.reloadEvents, workspace, "plugins", {
        type: "plugin",
        name: "veslo-managed",
        action: "updated",
      });
    }
    return jsonResponse(result, result.ok ? 200 : 409);
  });

  addRoute(routes, "POST", "/workspace/:id/plugins/:pluginId/prepare", "client", async (ctx) => {
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    requireClientScope(ctx, "collaborator");
    const policy = requireManagedPluginPolicy(ctx.params.pluginId);
    if (policy.id !== OPENCODE_SCHEDULER_PLATFORM_PLUGIN.id) {
      throw new ApiError(409, "plugin_prepare_not_supported", "Plugin prepare is supported only for scheduler");
    }
    return jsonResponse(schedulerPrepareStatus(policy, workspace.id));
  });

  addRoute(routes, "POST", "/workspace/:id/plugins/:pluginId/enabled", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const policy = requireManagedPluginPolicy(ctx.params.pluginId);
    const body = await readJsonBody(ctx.request);
    if (typeof body.enabled !== "boolean") {
      throw new ApiError(400, "invalid_payload", "enabled must be a boolean");
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.enabled",
      summary: `${body.enabled ? "Enable" : "Disable"} plugin ${policy.displayName}`,
      paths: overrideApprovalPaths(serverDataDir),
    });
    await setPluginEnabledState({
      dataDir: serverDataDir,
      policy,
      scope: overrideScopeForPolicy(policy),
      workspaceId: workspace.id,
      enabled: body.enabled,
      actor: ctx.actor,
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.enabled",
      target: policy.id,
      summary: `${body.enabled ? "Enabled" : "Disabled"} ${policy.displayName}`,
      timestamp: Date.now(),
    });
    const item = await resolveManagedInventoryItem(workspace, policy.id, { serverDataDir });
    return jsonResponse({ item });
  });

  addRoute(routes, "DELETE", "/workspace/:id/plugins/:pluginId", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const pluginId = ctx.params.pluginId ?? "";
    const managedPolicy = findManagedPluginPolicy(pluginId);
    if (managedPolicy) {
      if (await unmanagedProjectConfigPluginMatches(workspace, pluginId, { serverDataDir, userOpencodeConfigDir })) {
        throw new ApiError(
          409,
          "plugin_delete_ambiguous",
          "Plugin id matches both a managed policy and an unmanaged project plugin",
          { pluginId },
        );
      }
      await requireApproval(ctx, {
        workspaceId: workspace.id,
        action: "plugins.remove",
        summary: `Remove plugin ${managedPolicy.displayName}`,
        paths: overrideApprovalPaths(serverDataDir),
      });
      await setPluginRemovedState({
        dataDir: serverDataDir,
        policy: managedPolicy,
        scope: overrideScopeForPolicy(managedPolicy),
        workspaceId: workspace.id,
        removed: true,
        actor: ctx.actor,
      });
      await recordAudit(workspace.path, {
        id: shortId(),
        workspaceId: workspace.id,
        actor: ctx.actor ?? { type: "remote" },
        action: "plugins.remove",
        target: managedPolicy.id,
        summary: `Removed ${managedPolicy.displayName}`,
        timestamp: Date.now(),
      });
      const item = await resolveManagedInventoryItem(workspace, managedPolicy.id, { serverDataDir });
      return jsonResponse({ item });
    }

    const normalized = normalizePluginSpec(pluginId);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.remove",
      summary: `Remove plugin ${pluginId}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const removed = await removePlugin(workspace.path, pluginId);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.remove",
      target: "opencode.json",
      summary: `Removed ${pluginId}`,
      timestamp: Date.now(),
    });
    if (removed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "plugins", {
        type: "plugin",
        name: normalized,
        action: "removed",
      });
    }
    const result = await buildPluginInventory(workspace, {
      includeGlobal: false,
      debug: false,
      serverDataDir,
      userOpencodeConfigDir,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/plugins/:pluginId/restore", "client", async (ctx) => {
    const config = ctx.config;
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const policy = requireManagedPluginPolicy(ctx.params.pluginId);
    if (policy.removalPolicy === "locked") {
      throw new ApiError(409, "plugin_policy_locked", "Plugin policy is locked and cannot be restored");
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.restore",
      summary: `Restore plugin ${policy.displayName}`,
      paths: overrideApprovalPaths(serverDataDir),
    });
    await setPluginRemovedState({
      dataDir: serverDataDir,
      policy,
      scope: overrideScopeForPolicy(policy),
      workspaceId: workspace.id,
      removed: false,
      actor: ctx.actor,
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.restore",
      target: policy.id,
      summary: `Restored ${policy.displayName}`,
      timestamp: Date.now(),
    });
    const item = await resolveManagedInventoryItem(workspace, policy.id, { serverDataDir });
    return jsonResponse({ item });
  });
}

async function buildPluginInventory(
  workspace: WorkspaceInfo,
  options: {
    includeGlobal: boolean;
    debug: boolean;
    serverDataDir?: string;
    userOpencodeConfigDir?: string;
  },
) {
  const [pluginList, policies] = await Promise.all([
    listPlugins(workspace.path, options.includeGlobal, {
      workspaceOwner: ownerForWorkspace(workspace),
      dataDir: options.serverDataDir,
      userOpencodeConfigDir: options.userOpencodeConfigDir,
    }),
    resolveManagedPluginPolicies(workspace, { serverDataDir: options.serverDataDir }),
  ]);
  const visiblePolicies = visiblePluginPolicies(policies, { debug: options.debug }) as EffectivePluginPolicy[];
  const policyItems = visiblePolicies
    .map((policy) => pluginPolicyInventoryItem(policy, workspace));
  const unmanagedItems = pluginList.items
    .filter((item) => !item.managed && !item.policyId)
    .map((item) => unmanagedPluginInventoryItem(item, workspace));
  return {
    items: pluginList.items,
    inventory: [...policyItems, ...unmanagedItems],
    loadOrder: pluginList.loadOrder,
    warnings: pluginList.warnings,
  };
}

async function unmanagedProjectConfigPluginMatches(
  workspace: WorkspaceInfo,
  pluginId: string,
  options: { serverDataDir?: string; userOpencodeConfigDir?: string },
): Promise<boolean> {
  const result = await listPlugins(workspace.path, false, {
    workspaceOwner: ownerForWorkspace(workspace),
    dataDir: options.serverDataDir,
    userOpencodeConfigDir: options.userOpencodeConfigDir,
  });
  const normalized = normalizePluginSpec(pluginId);
  return result.items.some((item) =>
    item.source === "config" &&
    item.scope === "project" &&
    !item.managed &&
    normalizePluginSpec(item.spec) === normalized
  );
}

async function resolveManagedPluginPolicies(
  workspace: WorkspaceInfo,
  options: { serverDataDir?: string },
): Promise<EffectivePluginPolicy[]> {
  const overrides = await listPluginPolicyOverrides({
    dataDir: options.serverDataDir,
    workspaceId: workspace.id,
  });
  return resolveEffectivePluginPolicies({
    scope: "project",
    workspaceId: workspace.id,
    platform: [...PLATFORM_PLUGIN_POLICIES],
    organization: [],
    user: [],
    project: [],
    overrides,
  });
}

async function resolveManagedInventoryItem(
  workspace: WorkspaceInfo,
  pluginId: string,
  options: { serverDataDir?: string },
): Promise<PluginInventoryItem> {
  const policies = await resolveManagedPluginPolicies(workspace, options);
  const policy = policies.find((candidate) => candidate.id === pluginId);
  if (!policy) {
    throw new ApiError(404, "plugin_policy_not_found", "Plugin policy not found");
  }
  return pluginPolicyInventoryItem(policy, workspace);
}

function pluginPolicyInventoryItem(policy: EffectivePluginPolicy, workspace: WorkspaceInfo): PluginInventoryItem {
  return {
    id: policy.id,
    spec: policy.spec,
    displayName: policy.displayName,
    owner: ownerForPolicy(policy, workspace),
    scope: pluginPolicyScope(policy.owner.kind),
    target: policy.target,
    source: policy.source,
    visibility: policy.visibility,
    enabled: policy.effectiveEnabled,
    lifecycle: policy.lifecycle,
    removalPolicy: policy.removalPolicy,
    enabledPolicy: policy.enabledPolicy,
    activationPhase: pluginPolicyActivationPhase(policy),
    coldStartCritical: pluginPolicyColdStartCritical(policy),
    requiresEngineRestart: pluginPolicyRequiresEngineRestart(policy),
    managed: true,
    ...(policy.visibility === "hidden-debug-only" ? { debugOnly: true } : {}),
  };
}

function unmanagedPluginInventoryItem(item: PluginItem, workspace: WorkspaceInfo): PluginInventoryItem {
  const scope = item.scope === "global" ? "user" : "project";
  return {
    id: item.spec,
    spec: item.spec,
    displayName: item.displayName ?? unmanagedDisplayName(item.spec),
    owner: item.owner ?? (scope === "project" ? ownerForWorkspace(workspace) : { kind: "user", id: "local-user", label: "Local user" }),
    scope,
    target: scope,
    source: "config.unmanaged",
    visibility: "visible",
    enabled: item.lifecycle !== "disabled" && item.lifecycle !== "removed" && item.lifecycle !== "conflict",
    lifecycle: item.lifecycle ?? "active",
    removalPolicy: "user-removable",
    enabledPolicy: "user-toggleable",
    activationPhase: "startup",
    coldStartCritical: true,
    requiresEngineRestart: false,
    managed: false,
    ...(item.conflict ? { conflict: item.conflict } : {}),
  };
}

function parsePluginActivationPhase(value: unknown): PluginActivationPhase {
  if (typeof value !== "string" || !value.trim()) return "startup";
  const phase = value.trim();
  if (PLUGIN_ACTIVATION_PHASES.has(phase as PluginActivationPhase)) {
    return phase as PluginActivationPhase;
  }
  throw new ApiError(400, "invalid_plugin_activation_phase", "Invalid plugin materialization phase", {
    phase,
  });
}

function schedulerPrepareStatus(policy: PluginPolicy, workspaceId: string) {
  const activationPhase = pluginPolicyActivationPhase(policy);
  const schedulerCommand = schedulerSystemCommand();
  const platformSupported = schedulerCommand !== null;
  const schedulerCommandAvailable = schedulerCommand ? commandExists(schedulerCommand) : false;
  const packageSpecAvailable = Boolean(policy.spec.trim());
  const activeConfigDeferred = activationPhase !== "startup" && policy.autoInstall === false;
  const status = platformSupported && schedulerCommandAvailable && packageSpecAvailable && activeConfigDeferred
    ? "ready"
    : "degraded";

  return {
    ok: true,
    status,
    workspaceId,
    pluginId: policy.id,
    spec: policy.spec,
    activationPhase,
    coldStartCritical: pluginPolicyColdStartCritical(policy),
    requiresEngineRestart: pluginPolicyRequiresEngineRestart(policy),
    activeConfigProjection: activeConfigDeferred ? "deferred" : "startup",
    checks: [
      {
        name: "platform",
        ok: platformSupported,
        message: platformSupported
          ? `Scheduler platform support is available on ${process.platform}`
          : `Scheduler platform support is unavailable on ${process.platform}`,
      },
      {
        name: "systemCommand",
        ok: schedulerCommandAvailable,
        message: schedulerCommand
          ? `${schedulerCommand} ${schedulerCommandAvailable ? "was found" : "was not found"} on PATH`
          : "No scheduler system command applies to this platform",
      },
      {
        name: "packageSpec",
        ok: packageSpecAvailable,
        message: packageSpecAvailable
          ? `Scheduler package spec is ${policy.spec}`
          : "Scheduler package spec is missing",
      },
      {
        name: "activeConfigProjection",
        ok: activeConfigDeferred,
        message: activeConfigDeferred
          ? "Scheduler remains outside active OpenCode config during prepare"
          : "Scheduler would be projected into startup OpenCode config",
      },
    ],
  };
}

function schedulerSystemCommand(): string | null {
  if (process.platform === "darwin") return "launchctl";
  if (process.platform === "linux") return "systemctl";
  return null;
}

function commandExists(command: string): boolean {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      if (existsSync(join(dir, `${command}${extension}`))) return true;
    }
  }
  return false;
}

function unmanagedDisplayName(spec: string): string {
  const normalized = normalizePluginSpec(spec);
  return normalized.split(/[\\/]/).pop()?.replace(/^@/, "") || normalized || spec;
}

function findManagedPluginPolicy(pluginId: string): PluginPolicy | undefined {
  return PLATFORM_PLUGIN_POLICIES.find((policy) => policy.id === pluginId);
}

function requireManagedPluginPolicy(pluginId: string | undefined): PluginPolicy {
  const policy = pluginId ? findManagedPluginPolicy(pluginId) : undefined;
  if (!policy) {
    throw new ApiError(404, "plugin_policy_not_found", "Plugin policy not found");
  }
  return policy;
}

function pluginPolicyScope(ownerKind: PluginOwnerKind): PluginInventoryItem["scope"] {
  return ownerKind;
}

function ownerForPolicy(policy: PluginPolicy, workspace: WorkspaceInfo): ResourceOwner {
  if (policy.owner.kind === "project") {
    return ownerForWorkspace(workspace);
  }
  return {
    kind: policy.owner.kind,
    id: policy.owner.id,
    ...(policy.owner.label ? { label: policy.owner.label } : {}),
  };
}

function overrideScopeForPolicy(policy: PluginPolicy): "user" | "project" {
  return policy.target === "project" ? "project" : "user";
}

function overrideApprovalPaths(serverDataDir: string | undefined): string[] {
  return [serverDataDir ? `${serverDataDir}/plugin-policy-overrides.json` : "plugin-policy-overrides.json"];
}

function materializationApprovalPaths(
  workspace: WorkspaceInfo,
  serverDataDir: string | undefined,
  userOpencodeConfigDir: string | undefined,
): string[] {
  const paths = [
    opencodeConfigPath(workspace.path),
    projectManagedPluginSpecManifestPath(workspace.path),
    userOpencodeConfigPath(userOpencodeConfigDir),
  ];
  if (serverDataDir) {
    paths.push(userManagedPluginSpecManifestPath(serverDataDir));
  }
  return paths;
}
