use std::fs;
use std::path::{Path, PathBuf};

use crate::fs::copy_dir_recursive;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};

// VSLO-86 — bundled with the orchestrator; same versions are vendored into
// `<configDir>/node_modules/` by the orchestrator (`ensureOpencodeManagedTools`)
// for managed tool files. Keep these aligned with the constants in
// `packages/orchestrator/src/cli.ts`.
const VESLO_MANAGED_PLUGIN_VERSION: &str = "1.17.4";
const VESLO_MANAGED_ZOD_VERSION: &str = "4.1.8";

const INTERNAL_PACK_VERSION: &str = "2026-04-22.1";
const INTERNAL_PACK_SOURCE: &str = "openwork-snapshot";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const ROUTING_BLOCK_VERSION: u32 = 3;

const DELEGATE_PLUGIN_FILE: &str = "veslo-delegate.js";
const AUTOMATIONS_PLUGIN_FILE: &str = "veslo-automations.js";

const ROUTING_BLOCK_START: &str = "<!-- VESLO_INTERNAL_ROUTING_START -->";
const ROUTING_BLOCK_END: &str = "<!-- VESLO_INTERNAL_ROUTING_END -->";

const AGENT_BLOCK_START: &str = "<!-- VESLO_AGENT_INSTRUCTIONS_START -->";
const AGENT_BLOCK_END: &str = "<!-- VESLO_AGENT_INSTRUCTIONS_END -->";

#[derive(Default)]
struct WriteStats {
    written: u32,
    unchanged: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PackProvisionMode {
    Symlink,
    Copy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct InternalManifest {
    schema_version: u32,
    version: String,
    source: String,
    packs: Vec<String>,
    agents: Vec<String>,
    plugins: Vec<String>,
    routing_block_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    packs_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    central_packs_dir: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedDepsManifest {
    schema_version: u32,
    packages: Vec<ManagedDepsPackage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedDepsPackage {
    name: String,
    version: String,
    files: Vec<ManagedDepsFile>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedDepsFile {
    path: String,
    content_base64: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProvisionStatus {
    Updated,
    Unchanged,
}

#[derive(Debug, Clone)]
pub struct ProvisionResult {
    pub status: ProvisionStatus,
    pub written: u32,
    pub unchanged: u32,
}

impl ProvisionResult {
    pub fn version() -> &'static str {
        PROVISION_VERSION
    }
}

const INTERNAL_AGENTS: &[&str] = &[
    "veslo-internal-docx.md",
    "veslo-internal-pdf.md",
    "veslo-internal-pptx.md",
    "veslo-internal-xlsx.md",
    "veslo-internal-skill-creator.md",
    "veslo-internal-research.md",
];

const INTERNAL_PACKS: &[&str] = &["docx", "pdf", "pptx", "xlsx", "skill-creator", "research"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InternalManifest {
    source: Option<String>,
    #[serde(default)]
    agents: Vec<String>,
    #[serde(default)]
    plugins: Vec<String>,
}

fn upsert_managed_block(
    existing: &str,
    block: &str,
    start_marker: &str,
    end_marker: &str,
) -> String {
    if let Some(start_pos) = existing.find(start_marker) {
        if let Some(end_relative) = existing[start_pos..].find(end_marker) {
            let after_end = start_pos + end_relative + end_marker.len();
            let before = existing[..start_pos].trim_end_matches('\n');
            let after = existing[after_end..].trim_start_matches('\n');
            let compact_block = block.trim_end();
            if before.is_empty() && after.is_empty() {
                return format!("{compact_block}\n");
            }
            let prefix = if !before.is_empty() {
                format!("{before}\n\n")
            } else {
                String::new()
            };
            let suffix = if !after.is_empty() {
                format!("\n\n{after}")
            } else {
                String::new()
            };
            return format!("{prefix}{compact_block}{suffix}\n");
        }
    }

    let trimmed = existing.trim_end();
    if trimmed.is_empty() {
        return format!("{}\n", block.trim_end());
    }
    format!("{trimmed}\n\n{}\n", block.trim_end())
}

fn remove_managed_block(existing: &str, start_marker: &str, end_marker: &str) -> String {
    if let Some(start_pos) = existing.find(start_marker) {
        if let Some(end_relative) = existing[start_pos..].find(end_marker) {
            let after_end = start_pos + end_relative + end_marker.len();
            let before = existing[..start_pos].trim_end_matches('\n');
            let after = existing[after_end..].trim_start_matches('\n');
            if before.is_empty() && after.is_empty() {
                return String::new();
            }
            return [before, after]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n")
                + "\n";
        }
    }

    existing.to_string()
}

fn managed_veslo_agent_instructions_block() -> String {
    format!(
        "{start}\n\
         ## Managed Agent Instructions (Veslo)\n\
         \n\
         This block is managed by Veslo. Keep it intact.\n\
         \n\
         ### Response Style\n\
         - Simple question: answer directly and concisely.\n\
         - Complex task: outline steps first, then execute one by one.\n\
         - File question: read and explain, ask before modifying.\n\
         - Unclear request: ask one clarifying question rather than guessing.\n\
         \n\
         ### Output Hygiene\n\
         - Do not print raw JSON, tool payloads, message objects, file manifests, event objects, or internal diagnostic structures in the user-facing final answer unless the user explicitly asks for that raw data or a loaded skill requires it.\n\
         - When a structured file is created or updated, summarize what changed and reference the file path instead of dumping the file contents.\n\
         - If technical detail is useful, keep it short and explain it in normal language.\n\
         \n\
         ### Communication Style\n\
         - Progressive disclosure: start with a simple answer, add technical details only if asked.\n\
         - Explain what you're doing and why, in terms the user can understand.\n\
         - Adapt to the user's technical level based on their language and questions.\n\
         - For file operations, explain the impact before making changes.\n\
         \n\
         ### Document Download Safety\n\
         - Prefer stable document links when multiple variants exist; avoid session-bound or short-lived download URLs unless no stable option exists.\n\
         - If a fetch tool already returned bytes for a file URL, persist those bytes to a workspace file and reuse that file. Do not re-download the same URL with curl/wget.\n\
         - Before attaching a claimed PDF, validate bytes in the saved file: it should contain a PDF header ('%PDF-') and must not start as HTML/XML error content.\n\
         - If validation fails, do not attach the file. Continue with a short diagnostic note and request/choose a different document source.\n\
         \n\
         ### Veslo Tools & Features\n\
         - **Skills** - reusable workflows distributed through user, workspace, organization, and platform skill roots.\n\
         - **Scheduler** - recurring tasks (daily, weekly, interval). Mention when a task could be automated.\n\
         - **Workspace** - user may have multiple workspaces; respect workspace boundaries.\n\
         \n\
         ### User Memory\n\
         - The materialized Soul files are read-only runtime output owned by Veslo. Do not edit `.opencode/soul-company.md`, `.opencode/soul-user.md`, or `.opencode/soul-workspace.md` directly.\n\
         - When the user says \"remember this\", \"zapamatuj si\", or \"ulož si\", save the memory through the Soul memory API or ask the user to save it in Veslo.\n\
         - Keep memory entries concise and scoped to the right Soul level.\n\
         - Never store credentials, tokens, or API keys in Soul memory.\n\
         {end}",
        start = AGENT_BLOCK_START,
        end = AGENT_BLOCK_END,
    )
}

fn ensure_veslo_agent_instructions(
    workspace_root: &Path,
    stats: &mut WriteStats,
) -> Result<(), String> {
    let path = workspace_root
        .join(".opencode")
        .join("agents")
        .join("veslo.md");
    if !path.exists() {
        return Ok(());
    }

    let raw =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;

    let without_routing = remove_managed_block(&raw, ROUTING_BLOCK_START, ROUTING_BLOCK_END);
    let next = upsert_managed_block(
        &without_routing,
        &managed_veslo_agent_instructions_block(),
        AGENT_BLOCK_START,
        AGENT_BLOCK_END,
    );

    write_if_changed(&path, next.as_bytes(), stats)
}

fn automations_plugin_source() -> String {
    r#"import { readFile } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";

/**
 * Veslo Automations Plugin
 *
 * Registers tools that create, inspect, update, cancel, and run persistent
 * Veslo app-backed automations through the running Veslo server.
 *
 * Managed by Veslo internal system (v__VESLO_INTERNAL_VERSION__). Do not edit manually.
 */

const AUTOMATIONS_ROUTE_TEMPLATE = "/workspace/${workspaceId}/automations";
const TIMEZONE_CAPABLE_SCHEDULES = new Set(["oneShot", "cron", "daily", "weekly"]);

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDirectoryPath(value) {
  return cleanString(value).replace(/\\/g, "/").replace(/\/+$/, "");
}

function firstWorkspaceIdCandidate(value) {
  if (!value || typeof value !== "object") return "";
  const direct =
    cleanString(value.workspaceId) ||
    cleanString(value.workspaceID) ||
    cleanString(value.id && value.type === "workspace" ? value.id : "") ||
    cleanString(value.workspace && value.workspace.id) ||
    cleanString(value.workspace && value.workspace.workspaceId) ||
    cleanString(value.workspace && value.workspace.workspaceID) ||
    cleanString(value.project && value.project.workspaceId) ||
    cleanString(value.project && value.project.workspaceID);
  if (direct) return direct;
  if (value.data && typeof value.data === "object") {
    return firstWorkspaceIdCandidate(value.data);
  }
  if (value.session && typeof value.session === "object") {
    return firstWorkspaceIdCandidate(value.session);
  }
  return "";
}

function firstDirectoryCandidate(value) {
  if (!value || typeof value !== "object") return "";
  const direct =
    cleanString(value.directory) ||
    cleanString(value.cwd) ||
    cleanString(value.workdir) ||
    cleanString(value.path) ||
    cleanString(value.workspace && value.workspace.directory) ||
    cleanString(value.workspace && value.workspace.path) ||
    cleanString(value.workspace && value.workspace.opencode && value.workspace.opencode.directory) ||
    cleanString(value.project && value.project.directory) ||
    cleanString(value.project && value.project.path);
  if (direct) return direct;
  if (value.data && typeof value.data === "object") {
    return firstDirectoryCandidate(value.data);
  }
  if (value.session && typeof value.session === "object") {
    return firstDirectoryCandidate(value.session);
  }
  return "";
}

async function readOpenCodeSession(context, client) {
  const sessionID = cleanString(context && context.sessionID);
  if (!sessionID || !client || !client.session || typeof client.session.get !== "function") {
    return null;
  }
  try {
    return await client.session.get({ path: { sessionID } });
  } catch {
    return null;
  }
}

function workspaceDirectoryCandidates(workspace) {
  if (!workspace || typeof workspace !== "object") return [];
  return [
    workspace.path,
    workspace.directory,
    workspace.opencode && workspace.opencode.directory,
    workspace.workspace && workspace.workspace.path,
    workspace.workspace && workspace.workspace.directory,
    workspace.workspace && workspace.workspace.opencode && workspace.workspace.opencode.directory,
  ]
    .map(normalizeDirectoryPath)
    .filter(Boolean);
}

function matchWorkspaceByDirectory(workspaces, directory) {
  const target = normalizeDirectoryPath(directory);
  if (!target || !Array.isArray(workspaces)) return "";
  const matches = [];
  for (const workspace of workspaces) {
    const id = cleanString(workspace && workspace.id);
    if (!id) continue;
    if (workspaceDirectoryCandidates(workspace).some((candidate) => candidate === target)) {
      matches.push(id);
    }
  }
  return Array.from(new Set(matches)).length === 1 ? matches[0] : "";
}

function activeWorkspaceIdWhenSafe(workspacesPayload) {
  const activeId = cleanString(workspacesPayload && workspacesPayload.activeId);
  const items = Array.isArray(workspacesPayload && workspacesPayload.items) ? workspacesPayload.items : [];
  if (!activeId || items.length !== 1) return "";
  return cleanString(items[0] && items[0].id) === activeId ? activeId : "";
}

async function fetchWorkspaces(state) {
  return await vesloFetchJson(state, "/workspaces", { method: "GET" });
}

async function resolveWorkspaceId(args, context, client, state) {
  const explicit = cleanString(args.workspaceId);
  if (explicit) return explicit;

  const fromContext = firstWorkspaceIdCandidate(context);
  if (fromContext) return fromContext;

  const session = await readOpenCodeSession(context, client);
  const fromSession = firstWorkspaceIdCandidate(session);
  if (fromSession) return fromSession;

  const directory = firstDirectoryCandidate(context) || firstDirectoryCandidate(session);
  if (state) {
    const workspaces = await fetchWorkspaces(state);
    const fromDirectory = matchWorkspaceByDirectory(workspaces.items, directory);
    if (fromDirectory) return fromDirectory;
    const fromActive = activeWorkspaceIdWhenSafe(workspaces);
    if (fromActive) return fromActive;
  }

  return "";
}

function missingWorkspaceIdError() {
  return "Error: workspaceId is required. Provide workspaceId explicitly; Veslo could not match the current OpenCode directory to a workspace.";
}

async function readServerState() {
  const statePath = cleanString(process.env.VESLO_SERVER_STATE_PATH);
  if (!statePath) {
    return {
      error: "Error: VESLO_SERVER_STATE_PATH is not set. Start the Veslo desktop server and retry.",
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: "Error: Failed to read Veslo server state: " + message };
  }

  const baseUrl = cleanString(parsed && parsed.baseUrl).replace(/\/+$/, "");
  const clientToken = cleanString(parsed && parsed.clientToken);
  if (!baseUrl || !clientToken) {
    return {
      error: "Error: Veslo server state is missing baseUrl or clientToken. Restart the Veslo desktop server and retry.",
    };
  }

  return { baseUrl, clientToken };
}

async function vesloFetchJson(state, path, options) {
  const response = await fetch(state.baseUrl + path, {
    method: options.method,
    headers: {
      Authorization: "Bearer " + state.clientToken,
      "Content-Type": "application/json",
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = cleanString(payload && (payload.message || payload.error || payload.code));
    } catch {
      detail = cleanString(await response.text().catch(() => ""));
    }
    throw new Error("Veslo API request failed with HTTP " + response.status + (detail ? ": " + detail : ""));
  }

  if (response.status === 204) return {};
  return await response.json();
}

function automationsPath(workspaceId) {
  return "/workspace/" + encodeURIComponent(workspaceId) + "/automations";
}

async function vesloRequest(state, workspaceId, suffix, options) {
  return await vesloFetchJson(state, automationsPath(workspaceId) + suffix, options);
}

function summarizeAutomation(automation) {
  if (!automation || typeof automation !== "object") return automation;
  return {
    id: automation.id,
    status: automation.status,
    nextRunAt: automation.nextRunAt ?? null,
  };
}

function summarizeRun(run) {
  if (!run || typeof run !== "object") return run;
  return {
    id: run.id,
    automationId: run.automationId,
    status: run.status,
    sessionId: run.sessionId ?? null,
  };
}

function jsonSummary(value) {
  return JSON.stringify(value, null, 2);
}

function createTarget(args, context) {
  const explicit = args.target === undefined ? {} : args.target;
  if (!explicit || typeof explicit !== "object" || Array.isArray(explicit)) {
    return { error: "Error: target must be an object when provided." };
  }

  const target = { ...explicit };
  if (!Object.prototype.hasOwnProperty.call(target, "preferredSessionId")) {
    const sessionID = cleanString(context && context.sessionID);
    if (sessionID) {
      target.preferredSessionId = sessionID;
    }
  }
  return { target };
}

function withTopLevelTimezone(schedule, timezone) {
  const normalizedTimezone = cleanString(timezone);
  if (!normalizedTimezone || !schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    return schedule;
  }
  if (schedule.kind === "interval" || !TIMEZONE_CAPABLE_SCHEDULES.has(schedule.kind)) {
    return schedule;
  }
  if (Object.prototype.hasOwnProperty.call(schedule, "timezone")) {
    return schedule;
  }
  return { ...schedule, timezone: normalizedTimezone };
}

function definedPatch(args, keys) {
  const out = {};
  for (const key of keys) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  return out;
}

async function withVesloWorkspace(args, context, client, action) {
  const state = await readServerState();
  if (state.error) return state.error;

  const workspaceId = await resolveWorkspaceId(args, context, client, state);
  if (!workspaceId) return missingWorkspaceIdError();

  try {
    return await action(state, workspaceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return "Error: " + message;
  }
}

export default async (ctx) => {
  const { client } = ctx;

  return {
    tool: {
      veslo_create_automation: tool({
        description: "Create a persistent Veslo automation in the current workspace through the running Veslo server.",
        args: {
          workspaceId: tool.schema.string().optional().describe("Veslo workspace id. Provide this when it cannot be inferred from the current session."),
          id: tool.schema.string().optional().describe("Optional stable automation id."),
          name: tool.schema.string().describe("Short automation name."),
          prompt: tool.schema.string().describe("Prompt to run when the automation fires."),
          schedule: tool.schema.any().describe("Automation schedule object: oneShot, interval, daily, weekly, or cron."),
          timezone: tool.schema.string().optional().describe("Optional timezone for oneShot, cron, daily, or weekly schedules when schedule.timezone is absent."),
          target: tool.schema.any().optional().describe("Optional target overrides such as preferredSessionId, fallbackTitle, agent, model, or variant."),
          enabled: tool.schema.boolean().optional().describe("Whether the automation starts enabled."),
          status: tool.schema.enum(["active", "paused", "completed", "failed", "cancelled"]).optional().describe("Initial automation status."),
        },
        async execute(args, context) {
          return await withVesloWorkspace(args, context, client, async (state, workspaceId) => {
            if (args.schedule === undefined) return "Error: schedule is required.";
            const target = createTarget(args, context);
            if (target.error) return target.error;
            const body = {
              ...definedPatch(args, ["id", "enabled", "status"]),
              name: args.name,
              prompt: args.prompt,
              schedule: withTopLevelTimezone(args.schedule, args.timezone),
              target: target.target,
            };
            const data = await vesloRequest(state, workspaceId, "", { method: "POST", body });
            return jsonSummary({
              action: "created",
              automation: summarizeAutomation(data.automation),
            });
          });
        },
      }),

      veslo_list_automations: tool({
        description: "List persistent Veslo automations for a workspace through the running Veslo server.",
        args: {
          workspaceId: tool.schema.string().optional().describe("Veslo workspace id. Provide this when it cannot be inferred from the current session."),
        },
        async execute(args, context) {
          return await withVesloWorkspace(args, context, client, async (state, workspaceId) => {
            const data = await vesloRequest(state, workspaceId, "", { method: "GET" });
            const items = Array.isArray(data.items) ? data.items.map(summarizeAutomation) : [];
            return jsonSummary({ count: items.length, items });
          });
        },
      }),

      veslo_run_automation: tool({
        description: "Run a persistent Veslo automation immediately through the running Veslo server.",
        args: {
          workspaceId: tool.schema.string().optional().describe("Veslo workspace id. Provide this when it cannot be inferred from the current session."),
          automationId: tool.schema.string().describe("Automation id to run."),
        },
        async execute(args, context) {
          return await withVesloWorkspace(args, context, client, async (state, workspaceId) => {
            const suffix = "/" + encodeURIComponent(args.automationId) + "/run";
            const data = await vesloRequest(state, workspaceId, suffix, { method: "POST" });
            return jsonSummary({ action: "ran", run: summarizeRun(data.run) });
          });
        },
      }),

      veslo_update_automation: tool({
        description: "Update a persistent Veslo automation through the running Veslo server.",
        args: {
          workspaceId: tool.schema.string().optional().describe("Veslo workspace id. Provide this when it cannot be inferred from the current session."),
          automationId: tool.schema.string().describe("Automation id to update."),
          name: tool.schema.string().optional().describe("Updated automation name."),
          prompt: tool.schema.string().optional().describe("Updated automation prompt."),
          schedule: tool.schema.any().optional().describe("Updated automation schedule object."),
          target: tool.schema.any().optional().describe("Updated target object."),
          enabled: tool.schema.boolean().optional().describe("Updated enabled flag."),
          status: tool.schema.enum(["active", "paused", "completed", "failed", "cancelled"]).optional().describe("Updated automation status."),
        },
        async execute(args, context) {
          return await withVesloWorkspace(args, context, client, async (state, workspaceId) => {
            const body = definedPatch(args, ["name", "prompt", "schedule", "target", "enabled", "status"]);
            const suffix = "/" + encodeURIComponent(args.automationId);
            const data = await vesloRequest(state, workspaceId, suffix, { method: "PATCH", body });
            return jsonSummary({
              action: "updated",
              automation: summarizeAutomation(data.automation),
            });
          });
        },
      }),

      veslo_delete_automation: tool({
        description: "Cancel a persistent Veslo automation through the running Veslo server.",
        args: {
          workspaceId: tool.schema.string().optional().describe("Veslo workspace id. Provide this when it cannot be inferred from the current session."),
          automationId: tool.schema.string().describe("Automation id to cancel."),
        },
        async execute(args, context) {
          return await withVesloWorkspace(args, context, client, async (state, workspaceId) => {
            const suffix = "/" + encodeURIComponent(args.automationId);
            const data = await vesloRequest(state, workspaceId, suffix, { method: "DELETE" });
            return jsonSummary({
              action: "cancelled",
              automation: summarizeAutomation(data.automation),
            });
          });
        },
      }),
    },
  };
};
"#
    .replace("__VESLO_INTERNAL_VERSION__", PROVISION_VERSION)
}

fn write_internal_plugins(workspace_root: &Path, stats: &mut WriteStats) -> Result<(), String> {
    let plugins_root = workspace_root.join(".opencode").join("plugins");
    fs::create_dir_all(&plugins_root)
        .map_err(|e| format!("Failed to create {}: {e}", plugins_root.display()))?;
    let plugin_path = plugins_root.join(AUTOMATIONS_PLUGIN_FILE);
    write_if_changed(&plugin_path, automations_plugin_source().as_bytes(), stats)
}

/// Compatibility wrapper for existing workspace creation callers.
/// Internal packs are no longer provisioned centrally; the returned path is ignored by the
/// workspace cleanup/provisioning pass and kept only to avoid widening the call-site diff.
pub fn provision_central_packs(app_data_dir: &Path) -> Result<PathBuf, String> {
    Ok(app_data_dir.join("internal-packs").join(PROVISION_VERSION))
}

pub fn provision_internal_workspace_assets(
    workspace_root: &Path,
    _central_packs_dir: Option<&Path>,
) -> Result<ProvisionResult, String> {
    let mut stats = WriteStats::default();

    remove_legacy_internal_delegation(workspace_root, &mut stats)?;
    write_internal_plugins(workspace_root, &mut stats)?;
    ensure_veslo_agent_instructions(workspace_root, &mut stats)?;

    Ok(ProvisionResult {
        status: if stats.written > 0 {
            ProvisionStatus::Updated
        } else {
            ProvisionStatus::Unchanged
        },
        written: stats.written,
        unchanged: stats.unchanged,
    })
}

fn remove_legacy_internal_delegation(
    workspace_root: &Path,
    stats: &mut WriteStats,
) -> Result<(), String> {
    let opencode_root = workspace_root.join(".opencode");
    remove_managed_legacy_internal_root(&opencode_root, stats)?;
    remove_managed_legacy_internal_agents(&opencode_root, stats)?;
    remove_managed_legacy_delegate_plugin(&opencode_root, stats)?;
    Ok(())
}

fn remove_managed_legacy_internal_root(
    opencode_root: &Path,
    stats: &mut WriteStats,
) -> Result<(), String> {
    let internal_root = opencode_root.join("veslo").join("internal");
    if !path_exists_or_symlink(&internal_root) {
        return Ok(());
    }

    if !is_managed_legacy_internal_root(&internal_root)? {
        return Ok(());
    }

    for pack in INTERNAL_PACKS {
        let pack_dir = internal_root.join(pack);
        if remove_managed_legacy_internal_pack(&pack_dir)? {
            stats.written += 1;
        }
    }

    let manifest_path = internal_root.join("manifest.json");
    fs::remove_file(&manifest_path)
        .map_err(|e| format!("Failed to remove {}: {e}", manifest_path.display()))?;
    stats.written += 1;

    if dir_is_empty(&internal_root)? {
        remove_path(&internal_root)?;
        stats.written += 1;
    }
    Ok(())
}

fn remove_managed_legacy_internal_pack(pack_dir: &Path) -> Result<bool, String> {
    if !path_exists_or_symlink(pack_dir) {
        return Ok(false);
    }

    let meta = pack_dir
        .symlink_metadata()
        .map_err(|e| format!("Failed to stat {}: {e}", pack_dir.display()))?;
    if meta.file_type().is_symlink() {
        remove_path(pack_dir)?;
        return Ok(true);
    }

    let skill_path = pack_dir.join("SKILL.md");
    if !skill_path.exists() {
        return Ok(false);
    }

    let content = fs::read_to_string(&skill_path)
        .map_err(|e| format!("Failed to read {}: {e}", skill_path.display()))?;
    if !content.contains("veslo_internal_pack: true") {
        return Ok(false);
    }

    remove_path(pack_dir)?;
    Ok(true)
}

fn dir_is_empty(path: &Path) -> Result<bool, String> {
    let mut entries =
        fs::read_dir(path).map_err(|e| format!("Failed to read directory {}: {e}", path.display()))?;
    Ok(entries.next().is_none())
}

fn is_managed_legacy_internal_root(internal_root: &Path) -> Result<bool, String> {
    let manifest_path = internal_root.join("manifest.json");
    if !manifest_path.exists() {
        return Ok(false);
    }

    let raw = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read {}: {e}", manifest_path.display()))?;
    let manifest: InternalManifest = match serde_json::from_str(&raw) {
        Ok(manifest) => manifest,
        Err(_) => return Ok(false),
    };

    Ok(manifest.source.as_deref() == Some(LEGACY_INTERNAL_SOURCE)
        || manifest_contains_legacy_internal_artifacts(&manifest))
}

fn manifest_contains_legacy_internal_artifacts(manifest: &InternalManifest) -> bool {
    let has_legacy_agent = manifest.agents.iter().any(|agent| {
        let normalized = agent.trim_end_matches(".md");
        INTERNAL_AGENTS
            .iter()
            .any(|filename| filename.trim_end_matches(".md") == normalized)
    });
    let has_legacy_plugin = manifest
        .plugins
        .iter()
        .any(|plugin| plugin == DELEGATE_PLUGIN_FILE);

    has_legacy_agent || has_legacy_plugin
}

fn remove_managed_legacy_internal_agents(
    opencode_root: &Path,
    stats: &mut WriteStats,
) -> Result<(), String> {
    let agents_root = opencode_root.join("agents");
    for filename in INTERNAL_AGENTS {
        let path = agents_root.join(filename);
        if !path_exists_or_symlink(&path) {
            continue;
        }

        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };

        if is_managed_legacy_internal_agent(&content) {
            remove_path(&path)?;
            stats.written += 1;
        }
    }

    Ok(())
}

fn is_managed_legacy_internal_agent(content: &str) -> bool {
    content.contains("mode: subagent")
        && content.contains("hidden: true")
        && content.contains("Veslo internal")
}

fn remove_managed_legacy_delegate_plugin(
    opencode_root: &Path,
    stats: &mut WriteStats,
) -> Result<(), String> {
    let path = opencode_root.join("plugins").join(DELEGATE_PLUGIN_FILE);
    if !path_exists_or_symlink(&path) {
        return Ok(());
    }

    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(_) => return Ok(()),
    };

    if content.contains("Veslo Delegate Plugin")
        && content.contains("Managed by Veslo internal system")
    {
        remove_path(&path)?;
        stats.written += 1;
    }

    Ok(())
}

fn path_exists_or_symlink(path: &Path) -> bool {
    path.exists() || path.symlink_metadata().is_ok()
}

fn remove_path(path: &Path) -> Result<(), String> {
    let meta = path
        .symlink_metadata()
        .map_err(|e| format!("Failed to stat {}: {e}", path.display()))?;

    if meta.file_type().is_symlink() {
        #[cfg(windows)]
        {
            fs::remove_dir(path)
                .or_else(|_| fs::remove_file(path))
                .map_err(|e| format!("Failed to remove symlink {}: {e}", path.display()))?;
        }
        #[cfg(not(windows))]
        {
            fs::remove_file(path)
                .map_err(|e| format!("Failed to remove symlink {}: {e}", path.display()))?;
        }
        return Ok(());
    }

    if meta.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|e| format!("Failed to remove directory {}: {e}", path.display()))?;
        return Ok(());
    }

    fs::remove_file(path).map_err(|e| format!("Failed to remove file {}: {e}", path.display()))
}

fn copy_central_pack_dir(
    source: &Path,
    destination: &Path,
    stats: &mut WriteStats,
) -> Result<(), String> {
    remove_existing_pack_path(destination)?;
    copy_dir_recursive(source, destination)?;
    stats.written += 1;
    Ok(())
}

fn should_fallback_to_copy_after_symlink_error(error: &str) -> bool {
    #[cfg(windows)]
    {
        error.contains("os error 1314")
            || error.contains("A required privilege is not held by the client")
    }

    #[cfg(not(windows))]
    {
        let _ = error;
        false
    }
}

fn provision_central_packs_into_workspace(
    central_dir: &Path,
    internal_root: &Path,
    stats: &mut WriteStats,
) -> Result<PackProvisionMode, String> {
    let mut any_pack_updated = false;

    for pack_name in PACKS {
        let link_path = internal_root.join(pack_name);
        let target_path = central_dir.join(pack_name);
        match ensure_symlink(&target_path, &link_path) {
            Ok(updated) => {
                if updated {
                    any_pack_updated = true;
                }
            }
            Err(error) if should_fallback_to_copy_after_symlink_error(&error) => {
                for fallback_pack_name in PACKS {
                    copy_central_pack_dir(
                        &central_dir.join(fallback_pack_name),
                        &internal_root.join(fallback_pack_name),
                        stats,
                    )?;
                }
                return Ok(PackProvisionMode::Copy);
            }
            Err(error) => return Err(error),
        }
    }

    if any_pack_updated {
        stats.written += 1;
    }

    Ok(PackProvisionMode::Symlink)
}

/// Create a symlink from `link` to `target`. If `link` exists as a real directory,
/// remove it first. If it's a symlink pointing elsewhere, replace it.
#[cfg(unix)]
fn ensure_symlink(target: &Path, link: &Path) -> Result<bool, String> {
    if link.exists() || link.symlink_metadata().is_ok() {
        let meta = link
            .symlink_metadata()
            .map_err(|e| format!("Failed to stat {}: {e}", link.display()))?;

        if meta.file_type().is_symlink() {
            let current_target = fs::read_link(link)
                .map_err(|e| format!("Failed to read symlink {}: {e}", link.display()))?;
            if current_target == target {
                return Ok(false);
            }
            fs::remove_file(link)
                .map_err(|e| format!("Failed to remove old symlink {}: {e}", link.display()))?;
        } else if meta.is_dir() {
            fs::remove_dir_all(link)
                .map_err(|e| format!("Failed to remove directory {}: {e}", link.display()))?;
        } else {
            fs::remove_file(link)
                .map_err(|e| format!("Failed to remove file {}: {e}", link.display()))?;
        }
    }

    std::os::unix::fs::symlink(target, link).map_err(|e| {
        format!(
            "Failed to create symlink {} -> {}: {e}",
            link.display(),
            target.display()
        )
    })?;
    Ok(true)
}

#[cfg(windows)]
fn ensure_symlink(target: &Path, link: &Path) -> Result<bool, String> {
    if link.exists() || link.symlink_metadata().is_ok() {
        let meta = link
            .symlink_metadata()
            .map_err(|e| format!("Failed to stat {}: {e}", link.display()))?;

        if meta.file_type().is_symlink() {
            let current_target = fs::read_link(link)
                .map_err(|e| format!("Failed to read symlink {}: {e}", link.display()))?;
            if current_target == target {
                return Ok(false);
            }
            fs::remove_dir(link)
                .map_err(|e| format!("Failed to remove old symlink {}: {e}", link.display()))?;
        } else if meta.is_dir() {
            fs::remove_dir_all(link)
                .map_err(|e| format!("Failed to remove directory {}: {e}", link.display()))?;
        } else {
            fs::remove_file(link)
                .map_err(|e| format!("Failed to remove file {}: {e}", link.display()))?;
        }
    }

    std::os::windows::fs::symlink_dir(target, link).map_err(|e| {
        format!(
            "Failed to create symlink {} -> {}: {e}",
            link.display(),
            target.display()
        )
    })?;
    Ok(true)
}

pub fn provision_internal_workspace_assets(
    workspace_root: &Path,
    central_packs_dir: Option<&Path>,
    managed_deps_manifest_path: Option<&Path>,
) -> Result<ProvisionResult, String> {
    let opencode_root = workspace_root.join(".opencode");
    let internal_root = opencode_root.join("veslo").join("internal");
    let manifest_path = internal_root.join("manifest.json");
    let agents_root = opencode_root.join("agents");

    fs::create_dir_all(&internal_root).map_err(|e| {
        format!(
            "Failed to create internal pack directory {}: {e}",
            internal_root.display()
        )
    })?;
    fs::create_dir_all(&agents_root)
        .map_err(|e| format!("Failed to create {}: {e}", agents_root.display()))?;

    let mut stats = WriteStats::default();
    let mut pack_provision_mode = if central_packs_dir.is_some() {
        PackProvisionMode::Symlink
    } else {
        PackProvisionMode::Copy
    };

    // 1) Provision internal packs under .opencode/veslo/internal/<pack>/...
    if let Some(central_dir) = central_packs_dir {
        pack_provision_mode =
            provision_central_packs_into_workspace(central_dir, &internal_root, &mut stats)?;
    } else {
        // Copy mode: write packs directly (fallback when no central store)
        for pack_name in PACKS {
            let source_pack = INTERNAL_PACKS_DIR
                .get_dir(pack_name)
                .ok_or_else(|| format!("Missing internal pack source: {pack_name}"))?;
            let destination = internal_root.join(pack_name);
            write_dir_recursive(source_pack, source_pack.path(), &destination, &mut stats)?;
        }
    }

    // 2) Provision hidden internal subagents
    for (filename, content) in internal_agent_documents() {
        let path = agents_root.join(filename);
        write_if_changed(&path, content.as_bytes(), &mut stats)?;
    }

    // 3) Provision delegate plugin to .opencode/plugins/
    let plugins_root = opencode_root.join("plugins");
    fs::create_dir_all(&plugins_root)
        .map_err(|e| format!("Failed to create {}: {e}", plugins_root.display()))?;
    let plugin_path = plugins_root.join(DELEGATE_PLUGIN_FILE);
    write_if_changed(
        &plugin_path,
        delegate_plugin_source().as_bytes(),
        &mut stats,
    )?;

    // VSLO-86 — vendor @opencode-ai/plugin + zod into <workspace>/.opencode/node_modules/.
    // The delegate plugin (.opencode/plugins/veslo-delegate.js) imports
    // `@opencode-ai/plugin`; opencode runs Bun with `--no-install`, so Bun.resolve
    // walks node_modules from the plugin's parent directories. Without a local
    // copy here the engine fails to load the plugin with "Cannot find module
    // '@opencode-ai/plugin' from .../veslo-delegate.js" and the assistant becomes
    // unresponsive. Source is the Bun install cache populated by `bun install`.
    vendor_opencode_plugin_into_workspace(&opencode_root, managed_deps_manifest_path, &mut stats)?;

    // 4) Upsert managed blocks in veslo.md (routing + agent instructions)
    ensure_veslo_agent_routing(workspace_root, &mut stats)?;

    // 5) Write deterministic manifest for versioned/idempotent upgrades
    let manifest = InternalManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        version: INTERNAL_PACK_VERSION.to_string(),
        source: INTERNAL_PACK_SOURCE.to_string(),
        packs: PACKS.iter().map(|value| value.to_string()).collect(),
        agents: INTERNAL_AGENTS
            .iter()
            .map(|value| value.trim_end_matches(".md").to_string())
            .collect(),
        plugins: vec![DELEGATE_PLUGIN_FILE.to_string()],
        routing_block_version: ROUTING_BLOCK_VERSION,
        packs_mode: Some(
            match pack_provision_mode {
                PackProvisionMode::Symlink => "symlink",
                PackProvisionMode::Copy => "copy",
            }
            .to_string(),
        ),
        central_packs_dir: central_packs_dir.map(|p| p.display().to_string()),
    };

    let serialized = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Failed to serialize internal manifest: {e}"))?
        + "\n";
    write_if_changed(&manifest_path, serialized.as_bytes(), &mut stats)?;

    // If manifest already matched and no managed artifact changed, this is a no-op run.
    let status = if stats.written > 0 {
        ProvisionStatus::Updated
    } else if manifest_matches(&manifest_path, &manifest)? {
        ProvisionStatus::Unchanged
    } else {
        ProvisionStatus::Updated
    };

    Ok(ProvisionResult {
        status,
        written: stats.written,
        unchanged: stats.unchanged,
    })
}

fn vendor_opencode_plugin_into_workspace(
    opencode_root: &Path,
    managed_deps_manifest_path: Option<&Path>,
    stats: &mut WriteStats,
) -> Result<(), String> {
    let node_modules_root = opencode_root.join("node_modules");
    if let Err(err) = fs::create_dir_all(&node_modules_root) {
        return Err(format!("failed to create plugin node_modules: {err}"));
    }

    let plugin_vendored = ensure_workspace_managed_package(
        "@opencode-ai/plugin",
        VESLO_MANAGED_PLUGIN_VERSION,
        &node_modules_root,
        managed_deps_manifest_path,
        stats,
    )?;
    let zod_vendored = ensure_workspace_managed_package(
        "zod",
        VESLO_MANAGED_ZOD_VERSION,
        &node_modules_root,
        managed_deps_manifest_path,
        stats,
    )?;

    if managed_deps_manifest_path.is_none() && (!plugin_vendored || !zod_vendored) {
        eprintln!(
            "[workspace] managed OpenCode dependencies incomplete (plugin_vendored={plugin_vendored}, zod_vendored={zod_vendored}); no fallback shim will be written"
        );
    }
    log_workspace_opencode_dependency_status(opencode_root, &node_modules_root);
    if managed_deps_manifest_path.is_some() && (!plugin_vendored || !zod_vendored) {
        return Err(format!(
            "managed OpenCode dependencies could not be provisioned into {}",
            node_modules_root.display()
        ));
    }
    Ok(())
}

fn ensure_workspace_managed_package(
    pkg: &str,
    version: &str,
    node_modules_root: &Path,
    managed_deps_manifest_path: Option<&Path>,
    stats: &mut WriteStats,
) -> Result<bool, String> {
    let dst = node_modules_root.join(pkg);
    if package_json_version(&dst).as_deref() == Some(version) {
        return Ok(true);
    }

    if let Some(manifest_path) = managed_deps_manifest_path {
        return vendor_manifest_package(manifest_path, pkg, version, node_modules_root, stats);
    }

    let Some(home) = crate::paths::home_dir() else {
        eprintln!(
            "[workspace] home directory unavailable; cannot vendor {pkg}@{version} from Bun cache"
        );
        return Ok(vendor_node_module_package(
            pkg,
            version,
            node_modules_root,
            stats,
        ));
    };
    if vendor_bun_cache_package(
        &home.to_string_lossy(),
        pkg,
        version,
        node_modules_root,
        stats,
    ) {
        return Ok(true);
    }

    Ok(vendor_node_module_package(
        pkg,
        version,
        node_modules_root,
        stats,
    ))
}

fn read_managed_deps_manifest(path: &Path) -> Result<ManagedDepsManifest, String> {
    let raw = fs::read_to_string(path).map_err(|e| {
        format!(
            "Failed to read managed deps manifest {}: {e}",
            path.display()
        )
    })?;
    let manifest: ManagedDepsManifest = serde_json::from_str(&raw).map_err(|e| {
        format!(
            "Failed to parse managed deps manifest {}: {e}",
            path.display()
        )
    })?;
    if manifest.schema_version != 1 {
        return Err(format!(
            "Unsupported managed deps manifest schema {} in {}",
            manifest.schema_version,
            path.display()
        ));
    }
    Ok(manifest)
}

fn safe_manifest_relative_path(value: &str) -> Option<PathBuf> {
    if value.is_empty() || value.contains('\0') {
        return None;
    }
    let normalized = value.replace('\\', "/");
    if normalized.starts_with('/') || normalized.get(1..3) == Some(":/") {
        return None;
    }
    let mut out = PathBuf::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        out.push(part);
    }
    Some(out)
}

fn vendor_manifest_package(
    manifest_path: &Path,
    pkg: &str,
    version: &str,
    node_modules_root: &Path,
    stats: &mut WriteStats,
) -> Result<bool, String> {
    let manifest = read_managed_deps_manifest(manifest_path)?;
    let package = manifest
        .packages
        .iter()
        .find(|entry| entry.name == pkg && entry.version == version)
        .ok_or_else(|| {
            format!(
                "Managed deps manifest {} does not contain {pkg}@{version}",
                manifest_path.display()
            )
        })?;

    if package.files.is_empty() {
        return Err(format!(
            "Managed deps manifest {} contains {pkg}@{version} without files",
            manifest_path.display()
        ));
    }

    let dst = node_modules_root.join(pkg);
    remove_existing_pack_path(&dst)?;
    for file in &package.files {
        let relative = safe_manifest_relative_path(&file.path)
            .ok_or_else(|| format!("Invalid managed dependency file path '{}'", file.path))?;
        let target = dst.join(relative);
        let bytes = BASE64_STANDARD.decode(&file.content_base64).map_err(|e| {
            format!(
                "Invalid base64 content for {pkg}@{version} file {}: {e}",
                file.path
            )
        })?;
        write_if_changed(&target, &bytes, stats)?;
    }

    if package_json_version(&dst).as_deref() != Some(version) {
        return Err(format!(
            "Managed deps manifest wrote wrong package version for {pkg}@{version} into {}",
            dst.display()
        ));
    }

    Ok(true)
}

fn vendor_bun_cache_package(
    home: &str,
    pkg: &str,
    version: &str,
    node_modules_root: &Path,
    stats: &mut WriteStats,
) -> bool {
    let flat_src = PathBuf::from(home)
        .join(".bun")
        .join("install")
        .join("cache")
        .join(format!("{pkg}@{version}@@@1"));
    let legacy_src = PathBuf::from(home)
        .join(".bun")
        .join("install")
        .join("cache")
        .join(pkg)
        .join(format!("{}@@@1", version));
    let src = if flat_src.exists() {
        flat_src
    } else {
        legacy_src
    };
    if !src.exists() {
        eprintln!(
            "[workspace] Bun cache miss for {pkg}@{version} (looked at {}); engine plugins importing this package may fail to load",
            src.display()
        );
        return false;
    }
    let dst = node_modules_root.join(pkg);
    // Skip only when the exact expected version is already present. A stale
    // fallback shim or mismatched package must be replaced.
    if package_json_version(&dst).as_deref() == Some(version) {
        return true;
    }
    if let Some(parent) = dst.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(err) = remove_existing_pack_path(&dst) {
        eprintln!(
            "[workspace] failed to remove stale {pkg} package at {}: {err}",
            dst.display()
        );
        return false;
    }
    match copy_dir_recursive(&src, &dst) {
        Ok(_) => {
            stats.written += 1;
            true
        }
        Err(err) => {
            eprintln!(
                "[workspace] failed to vendor {pkg}@{version} into {}: {err}",
                dst.display()
            );
            false
        }
    }
}

fn vendor_node_module_package(
    pkg: &str,
    version: &str,
    node_modules_root: &Path,
    stats: &mut WriteStats,
) -> bool {
    let package_parts: Vec<&str> = pkg.split('/').collect();
    let mut starts = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            starts.push(parent.to_path_buf());
        }
    }

    for start in starts {
        for ancestor in start.ancestors() {
            let candidates = [
                package_parts
                    .iter()
                    .fold(ancestor.join("node_modules"), |path, part| path.join(part)),
                package_parts.iter().fold(
                    ancestor
                        .join("packages")
                        .join("orchestrator")
                        .join("node_modules"),
                    |path, part| path.join(part),
                ),
            ];
            for src in candidates {
                if package_json_version(&src).as_deref() != Some(version) {
                    continue;
                }
                let dst = node_modules_root.join(pkg);
                if package_json_version(&dst).as_deref() == Some(version) {
                    return true;
                }
                if let Some(parent) = dst.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if let Err(err) = remove_existing_pack_path(&dst) {
                    eprintln!(
                        "[workspace] failed to remove stale {pkg} package at {}: {err}",
                        dst.display()
                    );
                    return false;
                }
                match copy_dir_recursive(&src, &dst) {
                    Ok(_) => {
                        stats.written += 1;
                        return true;
                    }
                    Err(err) => {
                        eprintln!(
                            "[workspace] failed to vendor {pkg}@{version} from {} into {}: {err}",
                            src.display(),
                            dst.display()
                        );
                    }
                }
            }
        }
    }
    false
}

fn package_json_version(package_dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(package_dir.join("package.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parsed
        .get("version")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

fn log_workspace_opencode_dependency_status(opencode_root: &Path, node_modules_root: &Path) {
    let plugin_dir = node_modules_root.join("@opencode-ai").join("plugin");
    let zod_dir = node_modules_root.join("zod");
    let plugin_version = package_json_version(&plugin_dir);
    let zod_version = package_json_version(&zod_dir);
    let plugin_mode = match plugin_version.as_deref() {
        Some("0.0.0-veslo-managed") => "fallback-shim",
        Some(VESLO_MANAGED_PLUGIN_VERSION) => "vendored",
        Some(_) => "vendored-version-mismatch",
        None => "missing",
    };
    let zod_mode = match zod_version.as_deref() {
        Some(VESLO_MANAGED_ZOD_VERSION) => "vendored",
        Some(_) => "vendored-version-mismatch",
        None => "missing",
    };
    let payload = serde_json::json!({
        "opencodeRoot": opencode_root.display().to_string(),
        "pluginMode": plugin_mode,
        "pluginVersion": plugin_version,
        "pluginPackagePath": plugin_dir.join("package.json").display().to_string(),
        "expectedPluginVersion": VESLO_MANAGED_PLUGIN_VERSION,
        "zodMode": zod_mode,
        "zodVersion": zod_version,
        "zodPackagePath": zod_dir.join("package.json").display().to_string(),
        "expectedZodVersion": VESLO_MANAGED_ZOD_VERSION,
    });

    if plugin_mode == "fallback-shim" || plugin_mode == "missing" || zod_mode == "missing" {
        eprintln!(
            "[workspace] opencode plugin dependency status {payload} — workspace plugins may fail OpenCode zod introspection (symptom: Object.values on null/undefined)"
        );
    } else if plugin_mode == "vendored-version-mismatch" || zod_mode == "vendored-version-mismatch"
    {
        eprintln!("[workspace] opencode plugin dependency status {payload}");
    } else {
        println!("[workspace] opencode plugin dependency status {payload}");
    }
}

fn manifest_matches(path: &Path, expected: &InternalManifest) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let raw =
        fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let parsed: InternalManifest = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;
    Ok(parsed == *expected)
}

fn write_dir_recursive(
    dir: &Dir<'_>,
    base: &Path,
    destination_root: &Path,
    stats: &mut WriteStats,
) -> Result<(), String> {
    fs::create_dir_all(destination_root)
        .map_err(|e| format!("Failed to create {}: {e}", destination_root.display()))?;

    for file in dir.files() {
        let relative = file
            .path()
            .strip_prefix(base)
            .map_err(|e| format!("Failed to derive internal pack relative path: {e}"))?;
        let target = destination_root.join(relative);
        write_if_changed(&target, file.contents(), stats)?;
    }

    for child in dir.dirs() {
        let relative = child
            .path()
            .strip_prefix(base)
            .map_err(|e| format!("Failed to derive internal pack directory path: {e}"))?;
        let target_dir = destination_root.join(relative);
        write_dir_recursive(child, base, &target_dir, stats)?;
    }

    Ok(())
}

fn write_if_changed(path: &Path, contents: &[u8], stats: &mut WriteStats) -> Result<(), String> {
    let unchanged = match fs::read(path) {
        Ok(existing) => existing == contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
        Err(err) => {
            return Err(format!("Failed to read {}: {err}", path.display()));
        }
    };

    if unchanged {
        stats.unchanged += 1;
        return Ok(());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    fs::write(path, contents).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    stats.written += 1;
    Ok(())
}

fn delegate_plugin_source() -> String {
    format!(
        r#"import {{ tool }} from "@opencode-ai/plugin";

/**
 * Veslo Delegate Plugin
 *
 * Registers a `delegate` tool that the model can call via native tool_use
 * to route work to specialized Veslo internal subagents (docx, pdf, pptx,
 * xlsx, skill-creator, research).
 *
 * This replaces text-based routing with a hard tool-call mechanism — the
 * same way the model invokes read, bash, etc.
 *
 * Managed by Veslo internal system (v{version}). Do not edit manually.
 */

const AGENTS = [
  "veslo-internal-docx",
  "veslo-internal-pdf",
  "veslo-internal-pptx",
  "veslo-internal-xlsx",
  "veslo-internal-skill-creator",
  "veslo-internal-research",
];

const FORCE_DELEGATE_PREFIX = "[VESLO_ROUTER_FORCE_DELEGATE]";

function normalizedText(value) {{
  return ` ${{String(value || "")
    .toLowerCase()
    .replaceAll("\n", " ")
    .replaceAll("\r", " ")
    .replaceAll("\t", " ")}} `;
}}

function includesAny(value, tokens) {{
  return tokens.some((token) => value.includes(token));
}}

function hasExplicitDelegateRequest(value) {{
  return includesAny(value, [
    " subagent ",
    " sub-agent ",
    " subagenta",
    " subagenti",
    " spusť subagenta",
    " spust subagenta",
    " použij subagenta",
    " pouzij subagenta",
    " spawn subagent",
    " run subagent",
    " start subagent",
    " use subagent",
    " delegate this ",
    " delegate to subagent",
    " delegate to a subagent",
    " deleguj na subagenta",
    " deleguj to ",
  ]);
}}

function detectDelegateAgentFromText(text) {{
  const value = normalizedText(text);

  if (
    includesAny(value, [
      " skill.md ",
      "/skill.md ",
      " .opencode/skills ",
      " .opencode/skills/",
      " create skill ",
      " create a skill ",
      " create new skill ",
      " write skill ",
      " author skill ",
      " update skill ",
      " update a skill ",
      " reusable skill ",
      " new skill ",
      " vytvor skill ",
      " vytvorit skill ",
      " novy skill ",
      " uprav skill ",
      " skill creator ",
    ])
  ) {{
    return "veslo-internal-skill-creator";
  }}

  if (
    includesAny(value, [
      ".xlsx",
      ".xlsm",
      ".xls ",
      ".csv",
      ".tsv",
      " excel ",
      " excelu ",
      " exelu ",
      " spreadsheet ",
      " workbook ",
      " worksheet ",
      " tabulk",
      " sesit ",
      " sloupc",
      " radek ",
      " radku ",
      " bunka ",
      " listu ",
    ])
  ) {{
    return "veslo-internal-xlsx";
  }}

  if (
    includesAny(value, [
      ".docx",
      ".doc ",
      " docx ",
      " word ",
      " dokument ",
      " smlouva ",
    ])
  ) {{
    return "veslo-internal-docx";
  }}

  if (includesAny(value, [".pdf", " pdf ", " acrobat "])) {{
    return "veslo-internal-pdf";
  }}

  if (
    includesAny(value, [
      ".pptx",
      ".ppt ",
      " pptx ",
      " powerpoint ",
      " prezentace ",
      " slide ",
      " slides ",
      " slajd ",
    ])
  ) {{
    return "veslo-internal-pptx";
  }}

  if (hasExplicitDelegateRequest(value)) {{
    return "veslo-internal-research";
  }}

  return null;
}}

function textParts(parts) {{
  return (parts || [])
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}}

function forceDelegateInstruction(agent, userText) {{
  return [
    `${{FORCE_DELEGATE_PREFIX}} ${{agent}}`,
    "Managed Veslo routing:",
    `First action MUST be a tool call: delegate(agent=\"${{agent}}\").`,
    "Use the full original user request as delegate.task.",
    "Do not answer from memory before delegate returns.",
    "",
    "IMPORTANT: Do NOT use the 'skill' tool for this request. The delegate tool",
    "routes to a specialized subagent that has the correct tools and context.",
    "Using 'skill' instead of 'delegate' will produce incorrect results.",
    "",
    "Original user request:",
    userText,
  ].join("\n");
}}

export default async (ctx) => {{
  const {{ client }} = ctx;

  return {{
    "chat.message": async (input, output) => {{
      if (input.agent && input.agent !== "veslo") return;

      const userText = textParts(output.parts);
      if (!userText) return;
      if (userText.includes(FORCE_DELEGATE_PREFIX)) return;

      const delegateAgent = detectDelegateAgentFromText(userText);
      if (!delegateAgent) return;

      output.parts = [
        {{
          type: "text",
          text: forceDelegateInstruction(delegateAgent, userText),
        }},
        ...output.parts,
      ];
    }},
    "experimental.chat.system.transform": async (input, output) => {{
      if (!input.sessionID) return;

      let latestUser = null;
      try {{
        const messages = await client.session.messages({{
          path: {{ sessionID: input.sessionID }},
          query: {{ limit: 8 }},
        }});
        const history = Array.isArray(messages.data) ? messages.data : [];
        for (let index = history.length - 1; index >= 0; index -= 1) {{
          const candidate = history[index];
          if (candidate?.info?.role === "user") {{
            latestUser = candidate;
            break;
          }}
        }}
      }} catch {{
        return;
      }}

      if (!latestUser) return;
      if (latestUser.info?.agent && latestUser.info.agent !== "veslo") return;

      const userText = textParts(latestUser.parts);
      if (!userText) return;

      const delegateAgent = detectDelegateAgentFromText(userText);
      if (!delegateAgent) return;

      output.system.push(
        [
          "Managed Veslo routing instruction:",
          `For the current user request, first action MUST be tool call delegate(agent=\"${{delegateAgent}}\").`,
          "Pass the full user request as delegate.task.",
          "Do not answer from memory before delegate returns.",
          "Do NOT use the 'skill' tool — use 'delegate' exclusively.",
        ].join("\n"),
      );
    }},
    tool: {{
      delegate: tool({{
        description: [
          "Delegate a task to a specialized Veslo subagent.",
          "Use this tool when the user's message involves documents, skill creation,",
          "or explicitly asks to run/delegate to a subagent:",
          "- veslo-internal-xlsx: Excel/spreadsheet files (.xlsx, .xlsm, .csv, .tsv) — reading, writing, editing, charting, formulas",
          "- veslo-internal-docx: Word documents (.docx) — authoring, editing, conversion, formatting",
          "- veslo-internal-pdf: PDF files (.pdf) — extraction, form filling, transformation, merging",
          "- veslo-internal-pptx: PowerPoint presentations (.pptx) — creating, editing slides",
          "- veslo-internal-skill-creator: Creating or updating reusable skills (only on explicit user request)",
          "- veslo-internal-research: Explicit user request to run/delegate to a subagent for general research/execution",
          "",
          "Delegate on any signal that document work is needed: file extensions, attached files,",
          "file paths, references to document content, or phrasing about editing/reading/creating",
          "those formats. When unsure whether a file exists, delegate to search for it.",
          "Do not delegate general coding or plain-text tasks unless the user explicitly requests subagent delegation.",
          "",
          "Return the subagent's results directly. Do not expose internal agent names to the user.",
        ].join("\n"),
        args: {{
          agent: tool.schema
            .enum(AGENTS)
            .describe("Which specialized subagent to delegate the task to"),
          task: tool.schema
            .string()
            .describe("Complete description of what the subagent should do, including any relevant context from the conversation"),
        }},
        async execute(args, context) {{
          try {{
            let parentDirectory = "";
            try {{
              const parent = await client.session.get({{
                path: {{ sessionID: context.sessionID }},
              }});
              const candidate =
                (typeof parent?.data?.directory === "string" && parent.data.directory.trim()) ||
                (typeof parent?.directory === "string" && parent.directory.trim()) ||
                "";
              parentDirectory = candidate || "";
            }} catch {{
              // Fallback to default workspace directory when parent lookup fails.
            }}

            const created = await client.session.create({{
              ...(parentDirectory ? {{ query: {{ directory: parentDirectory }} }} : {{}}),
              body: {{
                parentID: context.sessionID,
                title: `Delegate: ${{args.agent}}`,
              }},
            }});

            const sessionId = created.data?.id ?? created.data;
            if (!sessionId) {{
              return "Error: Failed to create delegate session — no session ID returned.";
            }}

            const response = await client.session.prompt({{
              path: {{ id: typeof sessionId === "string" ? sessionId : String(sessionId) }},
              body: {{
                agent: args.agent,
                parts: [{{ type: "text", text: args.task }}],
              }},
            }});

            const parts = response.data?.parts ?? [];
            const textParts = parts.filter((p) => p.type === "text");
            const result = textParts.map((p) => p.text).join("\n").trim();
            return result || "Task completed (no text output from subagent).";
          }} catch (error) {{
            const message = error instanceof Error ? error.message : String(error);
            return `Error during delegation to ${{args.agent}}: ${{message}}`;
          }}
        }},
      }}),
    }},
  }};
}};
"#,
        version = INTERNAL_PACK_VERSION
    )
}

fn internal_agent_documents() -> Vec<(&'static str, String)> {
    vec![
        (
            "veslo-internal-docx.md",
            internal_agent_doc(
                "DOCX",
                "docx",
                "Handle .docx authoring, editing, conversion, and XML-safe patching tasks.",
            ),
        ),
        (
            "veslo-internal-pdf.md",
            internal_agent_doc(
                "PDF",
                "pdf",
                "Handle PDF extraction, form filling, transformation, and validation tasks.",
            ),
        ),
        (
            "veslo-internal-pptx.md",
            internal_agent_doc(
                "PPTX",
                "pptx",
                "Handle .pptx generation, slide edits, and OOXML-safe presentation updates.",
            ),
        ),
        (
            "veslo-internal-xlsx.md",
            internal_agent_doc(
                "XLSX",
                "xlsx",
                "Handle spreadsheet recalculation and workbook-safe mutation tasks.",
            ),
        ),
        (
            "veslo-internal-skill-creator.md",
            internal_skill_creator_agent_doc(),
        ),
        (
            "veslo-internal-research.md",
            internal_agent_doc(
                "Research",
                "research",
                "Handle explicit user requests to run/delegate to a subagent for general research or multi-step execution.",
            ),
        ),
    ]
}

fn internal_agent_doc(label: &str, pack: &str, summary: &str) -> String {
    format!(
        r#"---
description: Veslo internal {label} execution agent
mode: subagent
hidden: true
temperature: 0.5
tools:
  "*": false
  "read": true
  "write": true
  "edit": true
  "apply_patch": true
  "glob": true
  "grep": true
  "list": true
  "bash": true
---

You are a hidden Veslo internal execution agent.

Scope:
- {summary}
- Use resources from `.opencode/veslo/internal/{pack}`.

MANDATORY first step:
1. Read `.opencode/veslo/internal/{pack}/SKILL.md` using the read tool.
2. Follow the workflow described in SKILL.md exactly.
3. Only read additional helper files when SKILL.md references them.

Critical rules:
- You MUST read SKILL.md before doing anything else. Do not skip this step.
- You MUST produce files in the correct binary format (e.g. .docx must be a valid ZIP/OOXML archive, not plaintext).
- If SKILL.md says to use a library (e.g. `npm install -g docx`, `pip install pypdf`), install it first via bash, then use it.
- Perform concrete file/tool work end-to-end.
- Keep edits deterministic and minimal.
- Return concise execution status and outputs to the parent.
- Do not dump raw JSON, manifests, tool payloads, or full generated file contents unless explicitly requested.
- Do not expose internal implementation details unless explicitly requested in developer/debug mode.
"#
    )
}

fn internal_skill_creator_agent_doc() -> String {
    r#"---
description: Veslo internal skill-creator execution agent
mode: subagent
hidden: true
temperature: 0.5
tools:
  "*": false
  "read": true
  "write": true
  "edit": true
  "apply_patch": true
  "glob": true
  "grep": true
  "list": true
  "bash": true
---

You are a hidden Veslo internal execution agent for reusable skill authoring.

Scope:
- Use resources from `.opencode/veslo/internal/skill-creator`.
- Load `.opencode/veslo/internal/skill-creator/SKILL.md` first.

Rules:
- Only run for explicit requests to create/update reusable skills.
- Create or update skills only in this workspace at `.opencode/skills/<name>/SKILL.md`.
- Do not write user-global/shared skills directly. Create a workspace skill and tell the user it can be promoted through Veslo when needed.
- Keep the resulting skill concise and runnable.
- Do not write company-global/shared skills in this flow.
- Do not dump raw JSON, manifests, tool payloads, or full generated file contents unless explicitly requested.
- Do not expose internal implementation details unless explicitly requested in developer/debug mode.
"#
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_workspace_root(label: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("veslo-internal-provision-{label}-{unique}"));
        fs::create_dir_all(path.join(".opencode").join("agents")).unwrap();
        fs::write(
            path.join(".opencode").join("agents").join("veslo.md"),
            "---\ndescription: Veslo default agent\nmode: primary\n---\n\nYou are Veslo.\n",
        )
        .unwrap();
        path
    }

    fn write_test_package_manifest(
        manifest_path: &Path,
        packages: &[(&str, &str, Vec<(&str, &str)>)],
    ) {
        let packages_json: Vec<serde_json::Value> = packages
            .iter()
            .map(|(name, version, files)| {
                serde_json::json!({
                    "name": name,
                    "version": version,
                    "files": files.iter().map(|(path, content)| {
                        serde_json::json!({
                            "path": path,
                            "contentBase64": BASE64_STANDARD.encode(content.as_bytes()),
                        })
                    }).collect::<Vec<_>>()
                })
            })
            .collect();
        let manifest = serde_json::json!({
            "schemaVersion": 1,
            "packages": packages_json,
        });
        fs::write(
            manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn provision_does_not_create_internal_delegation_runtime() {
        let workspace_root = temp_workspace_root("no-delegation");

        let result = provision_internal_workspace_assets(&workspace_root, None, None).unwrap();
        assert_eq!(result.status, ProvisionStatus::Updated);

        assert!(!opencode_path(&workspace_root, &["veslo", "internal"]).exists());
        assert!(!opencode_path(&workspace_root, &["plugins", "veslo-delegate.js"]).exists());
        for filename in INTERNAL_AGENTS {
            assert!(!opencode_path(&workspace_root, &["agents", filename]).exists());
        }

        let veslo_agent =
            fs::read_to_string(opencode_path(&workspace_root, &["agents", "veslo.md"])).unwrap();
        assert!(veslo_agent.contains("You are Veslo."));
        assert!(veslo_agent.contains(AGENT_BLOCK_START));
        assert!(!veslo_agent.contains(ROUTING_BLOCK_START));
        assert!(!veslo_agent.to_lowercase().contains("delegate"));
        assert!(!veslo_agent.contains("subagent"));
        assert!(!veslo_agent.contains("child session"));

        let second = provision_internal_workspace_assets(&workspace_root, None).unwrap();
        assert_eq!(second.status, ProvisionStatus::Unchanged);
        assert!(!opencode_path(&workspace_root, &["veslo", "internal"]).exists());
        assert!(!opencode_path(&workspace_root, &["plugins", "veslo-delegate.js"]).exists());

        fs::remove_dir_all(workspace_root).unwrap();
    }

    #[test]
    fn provision_replaces_fallback_plugin_with_manifest_packages() {
        let workspace_root = temp_workspace_root("managed-deps");
        let manifest_path = workspace_root.join("managed-deps.json");
        let plugin_dir = workspace_root
            .join(".opencode")
            .join("node_modules")
            .join("@opencode-ai")
            .join("plugin");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("package.json"),
            r#"{"name":"@opencode-ai/plugin","version":"0.0.0-veslo-managed"}"#,
        )
        .unwrap();
        write_test_package_manifest(
            &manifest_path,
            &[
                (
                    "@opencode-ai/plugin",
                    "1.17.4",
                    vec![
                        (
                            "package.json",
                            r#"{"name":"@opencode-ai/plugin","version":"1.17.4","type":"module","exports":{".":{"import":"./dist/index.js"},"./tool":{"import":"./dist/tool.js"}}}"#,
                        ),
                        ("dist/index.js", "export * from './tool.js';\n"),
                        (
                            "dist/tool.js",
                            "export function tool(input) { return input; }\n",
                        ),
                    ],
                ),
                (
                    "zod",
                    "4.1.8",
                    vec![
                        (
                            "package.json",
                            r#"{"name":"zod","version":"4.1.8","type":"module"}"#,
                        ),
                        ("index.js", "export const z = {};\n"),
                    ],
                ),
            ],
        );

        let result =
            provision_internal_workspace_assets(&workspace_root, None, Some(&manifest_path))
                .unwrap();
        assert_eq!(result.status, ProvisionStatus::Updated);

        assert_eq!(
            package_json_version(
                &workspace_root
                    .join(".opencode")
                    .join("node_modules")
                    .join("@opencode-ai")
                    .join("plugin")
            )
            .as_deref(),
            Some("1.17.4")
        );
        assert_eq!(
            package_json_version(
                &workspace_root
                    .join(".opencode")
                    .join("node_modules")
                    .join("zod")
            )
            .as_deref(),
            Some("4.1.8")
        );

        fs::remove_dir_all(workspace_root).unwrap();
    }

    #[test]
    fn copy_central_pack_dir_replaces_existing_directory_for_windows_symlink_fallback() {
        let workspace_root = temp_workspace_root("central-copy");
        let central_root = temp_workspace_root("central-copy-src");
        let central_docx = central_root.join("docx");
        fs::create_dir_all(&central_docx).unwrap();
        fs::write(central_docx.join("SKILL.md"), "central docx skill").unwrap();
        fs::create_dir_all(central_docx.join("nested")).unwrap();
        fs::write(central_docx.join("nested").join("helper.txt"), "helper").unwrap();

        let destination = workspace_root
            .join(".opencode")
            .join("veslo")
            .join("internal")
            .join("docx");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("stale.txt"), "stale").unwrap();

        let mut stats = WriteStats::default();
        copy_central_pack_dir(&central_docx, &destination, &mut stats).unwrap();

        assert_eq!(
            fs::read_to_string(destination.join("SKILL.md")).unwrap(),
            "central docx skill"
        );
        write_file(
            &internal_root.join("docx").join("SKILL.md"),
            "---\nname: docx\nveslo_internal_pack: true\n---\n\n# Managed DOCX\n",
        );
        for filename in INTERNAL_AGENTS {
            write_file(
                &opencode_path(&workspace_root, &["agents", filename]),
                &managed_legacy_agent(filename.trim_start_matches("veslo-internal-").trim_end_matches(".md")),
            );
        }
        write_file(
            &opencode_path(&workspace_root, &["plugins", "veslo-delegate.js"]),
            "/* Veslo Delegate Plugin\n * Managed by Veslo internal system (v2026-04-22.1). Do not edit manually.\n */\n",
        );
        write_file(
            &opencode_path(&workspace_root, &["agents", "veslo.md"]),
            "---\ndescription: Veslo default agent\nmode: primary\n---\n\nUser-owned introduction.\n\n<!-- VESLO_INTERNAL_ROUTING_START -->\nmanaged routing with delegate and subagent language\n<!-- VESLO_INTERNAL_ROUTING_END -->\n\nKeep this user note.\n",
        );

        let result = provision_internal_workspace_assets(&workspace_root, None).unwrap();
        assert_eq!(result.status, ProvisionStatus::Updated);

        assert!(!internal_root.exists());
        for filename in INTERNAL_AGENTS {
            assert!(!opencode_path(&workspace_root, &["agents", filename]).exists());
        }
        assert!(!opencode_path(&workspace_root, &["plugins", "veslo-delegate.js"]).exists());

        let veslo_agent =
            fs::read_to_string(opencode_path(&workspace_root, &["agents", "veslo.md"])).unwrap();
        assert!(veslo_agent.contains("User-owned introduction."));
        assert!(veslo_agent.contains("Keep this user note."));
        assert!(veslo_agent.contains(AGENT_BLOCK_START));
        assert!(!veslo_agent.contains(ROUTING_BLOCK_START));
        assert!(!veslo_agent.to_lowercase().contains("delegate"));
        assert!(!veslo_agent.contains("subagent"));

        let second = provision_internal_workspace_assets(&workspace_root, None).unwrap();
        assert_eq!(second.status, ProvisionStatus::Unchanged);
        assert!(!internal_root.exists());

        fs::remove_dir_all(workspace_root).unwrap();
    }

    #[test]
    fn provision_preserves_ambiguous_user_owned_files() {
        let workspace_root = temp_workspace_root("preserve-ambiguous");
        let internal_skill = opencode_path(
            &workspace_root,
            &["veslo", "internal", "custom", "SKILL.md"],
        );
        let custom_agent = opencode_path(&workspace_root, &["agents", "veslo-internal-custom.md"]);
        let ambiguous_plugin = opencode_path(&workspace_root, &["plugins", "veslo-delegate.js"]);
        write_file(&internal_skill, "# User internal workflow\n");
        write_file(
            &custom_agent,
            "---\ndescription: user custom helper\nmode: primary\n---\n\nThis is not Veslo-managed.\n",
        );
        write_file(
            &ambiguous_plugin,
            "// User-owned plugin with a legacy filename but no managed header.\nexport default {};\n",
        );

        let result = provision_internal_workspace_assets(&workspace_root, None).unwrap();
        assert_eq!(result.status, ProvisionStatus::Updated);

        assert_eq!(
            fs::read_to_string(&internal_skill).unwrap(),
            "# User internal workflow\n"
        );
        assert_eq!(
            fs::read_to_string(&custom_agent).unwrap(),
            "---\ndescription: user custom helper\nmode: primary\n---\n\nThis is not Veslo-managed.\n"
        );
        assert_eq!(
            fs::read_to_string(&ambiguous_plugin).unwrap(),
            "// User-owned plugin with a legacy filename but no managed header.\nexport default {};\n"
        );

        let second = provision_internal_workspace_assets(&workspace_root, None).unwrap();
        assert_eq!(second.status, ProvisionStatus::Unchanged);

        fs::remove_dir_all(workspace_root).unwrap();
    }

    #[test]
    fn provision_preserves_user_owned_same_name_files_during_legacy_cleanup() {
        let workspace_root = temp_workspace_root("preserve-same-name");
        let internal_root = opencode_path(&workspace_root, &["veslo", "internal"]);
        let user_docx_agent = opencode_path(&workspace_root, &["agents", "veslo-internal-docx.md"]);
        let managed_pdf_agent = opencode_path(&workspace_root, &["agents", "veslo-internal-pdf.md"]);
        let user_plugin = opencode_path(&workspace_root, &["plugins", "veslo-delegate.js"]);
        let user_docx_content = "---\ndescription: user-owned DOCX helper\nmode: primary\n---\n\nThis same-name file is user-authored.\n";
        let user_plugin_content =
            "// User-owned plugin with the legacy filename but no managed header.\nexport default {};\n";

        write_file(
            &internal_root.join("manifest.json"),
            r#"{
  "schemaVersion": 1,
  "source": "openwork-snapshot",
  "agents": ["veslo-internal-docx", "veslo-internal-pdf"],
  "plugins": ["veslo-delegate.js"]
}
"#,
        );
        write_file(
            &internal_root.join("docx").join("SKILL.md"),
            "---\nname: docx\nveslo_internal_pack: true\n---\n\n# Managed DOCX\n",
        );
        write_file(&user_docx_agent, user_docx_content);
        write_file(&managed_pdf_agent, &managed_legacy_agent("PDF"));
        write_file(&user_plugin, user_plugin_content);

        let result = provision_internal_workspace_assets(&workspace_root, None).unwrap();
        assert_eq!(result.status, ProvisionStatus::Updated);

        assert!(!internal_root.exists());
        assert!(!managed_pdf_agent.exists());
        assert_eq!(fs::read_to_string(&user_docx_agent).unwrap(), user_docx_content);
        assert_eq!(fs::read_to_string(&user_plugin).unwrap(), user_plugin_content);

        let second = provision_internal_workspace_assets(&workspace_root, None).unwrap();
        assert_eq!(second.status, ProvisionStatus::Unchanged);

        fs::remove_dir_all(workspace_root).unwrap();
    }

    #[test]
    fn provision_preserves_user_files_inside_managed_legacy_internal_root() {
        let workspace_root = temp_workspace_root("preserve-managed-root-user-content");
        let internal_root = opencode_path(&workspace_root, &["veslo", "internal"]);
        let custom_notes = internal_root.join("custom").join("notes.md");
        write_file(
            &internal_root.join("manifest.json"),
            r#"{
  "schemaVersion": 1,
  "source": "openwork-snapshot",
  "packs": ["docx"],
  "agents": ["veslo-internal-docx"]
}
"#,
        );
        write_file(
            &internal_root.join("docx").join("SKILL.md"),
            "---\nname: docx\nveslo_internal_pack: true\n---\n\n# Managed DOCX\n",
        );
        write_file(&custom_notes, "user notes\n");
        write_file(
            &opencode_path(&workspace_root, &["agents", "veslo-internal-docx.md"]),
            &managed_legacy_agent("DOCX"),
        );

        let result = provision_internal_workspace_assets(&workspace_root, None).unwrap();
        assert_eq!(result.status, ProvisionStatus::Updated);

        assert!(!internal_root.join("manifest.json").exists());
        assert!(!internal_root.join("docx").exists());
        assert!(!opencode_path(&workspace_root, &["agents", "veslo-internal-docx.md"]).exists());
        assert_eq!(fs::read_to_string(&custom_notes).unwrap(), "user notes\n");

        let second = provision_internal_workspace_assets(&workspace_root, None).unwrap();
        assert_eq!(second.status, ProvisionStatus::Unchanged);
        assert_eq!(fs::read_to_string(&custom_notes).unwrap(), "user notes\n");

        fs::remove_dir_all(workspace_root).unwrap();
    }
}
