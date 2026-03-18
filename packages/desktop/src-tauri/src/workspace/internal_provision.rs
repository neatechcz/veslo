use std::fs;
use std::path::Path;

use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};

const INTERNAL_PACK_VERSION: &str = "2026-03-17.1";
const INTERNAL_PACK_SOURCE: &str = "openwork-snapshot";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const ROUTING_BLOCK_VERSION: u32 = 2;

const DELEGATE_PLUGIN_FILE: &str = "veslo-delegate.js";

const ROUTING_BLOCK_START: &str = "<!-- VESLO_INTERNAL_ROUTING_START -->";
const ROUTING_BLOCK_END: &str = "<!-- VESLO_INTERNAL_ROUTING_END -->";

static INTERNAL_PACKS_DIR: Dir<'_> =
    include_dir!("$CARGO_MANIFEST_DIR/../../../internal/veslo-internal-packs");

#[derive(Default)]
struct WriteStats {
    written: u32,
    unchanged: u32,
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
        INTERNAL_PACK_VERSION
    }
}

const PACKS: &[&str] = &["docx", "pdf", "pptx", "xlsx", "skill-creator"];
const INTERNAL_AGENTS: &[&str] = &[
    "veslo-internal-docx.md",
    "veslo-internal-pdf.md",
    "veslo-internal-pptx.md",
    "veslo-internal-xlsx.md",
    "veslo-internal-skill-creator.md",
];

pub fn provision_internal_workspace_assets(
    workspace_root: &Path,
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

    // 1) Provision internal packs under .opencode/veslo/internal/<pack>/...
    for pack_name in PACKS {
        let source_pack = INTERNAL_PACKS_DIR
            .get_dir(pack_name)
            .ok_or_else(|| format!("Missing internal pack source: {pack_name}"))?;
        let destination = internal_root.join(pack_name);
        write_dir_recursive(source_pack, source_pack.path(), &destination, &mut stats)?;
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
    write_if_changed(&plugin_path, delegate_plugin_source().as_bytes(), &mut stats)?;

    // 4) Ensure veslo primary agent contains managed routing/delegation instructions
    let veslo_agent_path = agents_root.join("veslo.md");
    ensure_veslo_agent_routing(&veslo_agent_path, &mut stats)?;

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

fn ensure_veslo_agent_routing(
    veslo_agent_path: &Path,
    stats: &mut WriteStats,
) -> Result<(), String> {
    let existing = match fs::read_to_string(veslo_agent_path) {
        Ok(value) => value,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => {
            return Err(format!(
                "Failed to read managed agent {}: {err}",
                veslo_agent_path.display()
            ));
        }
    };

    let block = managed_veslo_routing_block();
    let updated = upsert_managed_block(&existing, &block);
    write_if_changed(veslo_agent_path, updated.as_bytes(), stats)
}

fn upsert_managed_block(existing: &str, block: &str) -> String {
    if let Some(start_index) = existing.find(ROUTING_BLOCK_START) {
        if let Some(end_relative) = existing[start_index..].find(ROUTING_BLOCK_END) {
            let end_index = start_index + end_relative + ROUTING_BLOCK_END.len();
            let before = existing[..start_index].trim_end_matches('\n');
            let after = existing[end_index..].trim_start_matches('\n');
            let compact_block = block.trim_end_matches('\n');

            if before.is_empty() && after.is_empty() {
                return format!("{compact_block}\n");
            }

            let mut next = String::new();
            if !before.is_empty() {
                next.push_str(before);
                next.push_str("\n\n");
            }
            next.push_str(compact_block);
            if !after.is_empty() {
                next.push_str("\n\n");
                next.push_str(after);
            }
            next.push('\n');
            return next;
        }
    }

    if existing.trim().is_empty() {
        return format!("{block}\n");
    }

    let mut next = existing.trim_end_matches('\n').to_string();
    next.push_str("\n\n");
    next.push_str(block.trim_end_matches('\n'));
    next.push('\n');
    next
}

fn managed_veslo_routing_block() -> String {
    format!(
        r#"{ROUTING_BLOCK_START}
## Managed Internal Delegation (Veslo)

This block is managed by Veslo. Keep it intact.

Document and skill tasks are handled via the `delegate` tool, which routes work
to specialized hidden subagents. Use it like any other tool — the model selects it
based on context (file types, document references, skill creation requests).

Execution behavior:
- Internal subagent identities are implementation details; do not surface their names unless explicitly requested in developer/debug context.
- Return normal progress/results in the parent session.
{ROUTING_BLOCK_END}"#
    )
}

fn delegate_plugin_source() -> String {
    format!(
        r#"import {{ tool }} from "@opencode-ai/plugin";

/**
 * Veslo Delegate Plugin
 *
 * Registers a `delegate` tool that the model can call via native tool_use
 * to route work to specialized Veslo internal subagents (docx, pdf, pptx,
 * xlsx, skill-creator).
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
];

export default async (ctx) => {{
  const {{ client }} = ctx;

  return {{
    tool: {{
      delegate: tool({{
        description: [
          "Delegate a task to a specialized Veslo document subagent.",
          "Use this tool when the user's message involves working with documents:",
          "- veslo-internal-xlsx: Excel/spreadsheet files (.xlsx, .xlsm, .csv, .tsv) — reading, writing, editing, charting, formulas",
          "- veslo-internal-docx: Word documents (.docx) — authoring, editing, conversion, formatting",
          "- veslo-internal-pdf: PDF files (.pdf) — extraction, form filling, transformation, merging",
          "- veslo-internal-pptx: PowerPoint presentations (.pptx) — creating, editing slides",
          "- veslo-internal-skill-creator: Creating or updating reusable skills (only on explicit user request)",
          "",
          "Delegate on any signal that document work is needed: file extensions, attached files,",
          "file paths, references to document content, or phrasing about editing/reading/creating",
          "those formats. When unsure whether a file exists, delegate to search for it.",
          "Do not delegate general coding or plain-text tasks without document signals.",
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
            const created = await client.session.create({{
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
    ]
}

fn internal_agent_doc(label: &str, pack: &str, summary: &str) -> String {
    format!(
        r#"---
description: Veslo internal {label} execution agent
mode: subagent
hidden: true
temperature: 0.1
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
- Load `.opencode/veslo/internal/{pack}/SKILL.md` first, then only the needed helper files.

Rules:
- Perform concrete file/tool work end-to-end.
- Keep edits deterministic and minimal.
- Return concise execution status and outputs to the parent.
- Do not expose internal implementation details unless explicitly requested in developer/debug mode.
"#
    )
}

fn internal_skill_creator_agent_doc() -> String {
    r#"---
description: Veslo internal skill-creator execution agent
mode: subagent
hidden: true
temperature: 0.1
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
- Keep the resulting skill concise and runnable.
- Do not write company-global/shared skills in this flow.
- Do not expose internal implementation details unless explicitly requested in developer/debug mode.
"#
    .to_string()
}
