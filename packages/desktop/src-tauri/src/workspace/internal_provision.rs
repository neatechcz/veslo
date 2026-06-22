use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

const PROVISION_VERSION: &str = "2026-06-06.1";
const LEGACY_INTERNAL_SOURCE: &str = "openwork-snapshot";

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
    let mut entries = fs::read_dir(path)
        .map_err(|e| format!("Failed to read directory {}: {e}", path.display()))?;
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

    fn opencode_path(workspace_root: &Path, segments: &[&str]) -> std::path::PathBuf {
        let mut path = workspace_root.join(".opencode");
        for segment in segments {
            path = path.join(segment);
        }
        path
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn managed_legacy_agent(label: &str) -> String {
        format!(
            "---\ndescription: Veslo internal {label} execution agent\nmode: subagent\nhidden: true\n---\n\nVeslo internal execution agent\n"
        )
    }

    #[test]
    fn provision_does_not_create_internal_delegation_runtime() {
        let workspace_root = temp_workspace_root("no-delegation");

        let result = provision_internal_workspace_assets(&workspace_root, None).unwrap();
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
    fn provision_removes_managed_legacy_internal_delegation_artifacts() {
        let workspace_root = temp_workspace_root("cleanup-managed");
        let internal_root = opencode_path(&workspace_root, &["veslo", "internal"]);
        write_file(
            &internal_root.join("manifest.json"),
            r#"{
  "schemaVersion": 1,
  "version": "2026-04-22.1",
  "source": "openwork-snapshot",
  "packs": ["docx"],
  "agents": ["veslo-internal-docx"],
  "plugins": ["veslo-delegate.js"],
  "routingBlockVersion": 3
}
"#,
        );
        write_file(
            &internal_root.join("docx").join("SKILL.md"),
            "---\nname: docx\nveslo_internal_pack: true\n---\n\n# Managed DOCX\n",
        );
        for filename in INTERNAL_AGENTS {
            write_file(
                &opencode_path(&workspace_root, &["agents", filename]),
                &managed_legacy_agent(
                    filename
                        .trim_start_matches("veslo-internal-")
                        .trim_end_matches(".md"),
                ),
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
        let managed_pdf_agent =
            opencode_path(&workspace_root, &["agents", "veslo-internal-pdf.md"]);
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
        assert_eq!(
            fs::read_to_string(&user_docx_agent).unwrap(),
            user_docx_content
        );
        assert_eq!(
            fs::read_to_string(&user_plugin).unwrap(),
            user_plugin_content
        );

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
