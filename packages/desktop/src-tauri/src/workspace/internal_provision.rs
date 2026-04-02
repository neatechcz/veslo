use std::fs;
use std::path::Path;

use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};

const INTERNAL_PACK_VERSION: &str = "2026-04-02.1";
const INTERNAL_PACK_SOURCE: &str = "openwork-snapshot";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const ROUTING_BLOCK_VERSION: u32 = 3;

const DELEGATE_PLUGIN_FILE: &str = "veslo-delegate.js";

const ROUTING_BLOCK_START: &str = "<!-- VESLO_INTERNAL_ROUTING_START -->";
const ROUTING_BLOCK_END: &str = "<!-- VESLO_INTERNAL_ROUTING_END -->";

const AGENT_BLOCK_START: &str = "<!-- VESLO_AGENT_INSTRUCTIONS_START -->";
const AGENT_BLOCK_END: &str = "<!-- VESLO_AGENT_INSTRUCTIONS_END -->";


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

const PACKS: &[&str] = &["docx", "pdf", "pptx", "xlsx", "skill-creator", "research"];
const INTERNAL_AGENTS: &[&str] = &[
    "veslo-internal-docx.md",
    "veslo-internal-pdf.md",
    "veslo-internal-pptx.md",
    "veslo-internal-xlsx.md",
    "veslo-internal-skill-creator.md",
    "veslo-internal-research.md",
];

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

fn managed_veslo_routing_block() -> String {
    format!(
        "{start}\n\
         ## Managed Internal Delegation (Veslo)\n\
         \n\
         This block is managed by Veslo. Keep it intact.\n\
         \n\
         Document, skill, and explicit subagent requests are handled via the `delegate` tool, which routes work\n\
         to specialized hidden subagents. Use it like any other tool — the model selects it\n\
         based on context (file types, document references, skill creation requests, explicit delegation language).\n\
         \n\
         Execution behavior:\n\
         - Internal subagent identities are implementation details; do not surface their names unless explicitly requested in developer/debug context.\n\
         - Return normal progress/results in the parent session.\n\
         {end}",
        start = ROUTING_BLOCK_START,
        end = ROUTING_BLOCK_END,
    )
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
         - **delegate** — routes document tasks and explicit \"use subagent/delegate\" requests to specialized subagents.\n\
         - **Skills** — reusable workflows in `.opencode/skills/`. Suggest creating one when work repeats.\n\
         - **Scheduler** — recurring tasks (daily, weekly, interval). Mention when a task could be automated.\n\
         - **Workspace** — user may have multiple workspaces; respect workspace boundaries.\n\
         {end}",
        start = AGENT_BLOCK_START,
        end = AGENT_BLOCK_END,
    )
}

fn ensure_veslo_agent_routing(
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

    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;

    let mut next = upsert_managed_block(
        &raw,
        &managed_veslo_routing_block(),
        ROUTING_BLOCK_START,
        ROUTING_BLOCK_END,
    );
    next = upsert_managed_block(
        &next,
        &managed_veslo_agent_instructions_block(),
        AGENT_BLOCK_START,
        AGENT_BLOCK_END,
    );

    write_if_changed(&path, next.as_bytes(), stats)
}

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
      " skill ",
      " skills ",
      " skill.md ",
      " .opencode/skills ",
      " create skill ",
      " update skill ",
      " vytvor skill ",
      " vytvorit skill ",
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
- Keep the resulting skill concise and runnable.
- Do not write company-global/shared skills in this flow.
- Do not expose internal implementation details unless explicitly requested in developer/debug mode.
"#
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
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

    #[test]
    fn provision_includes_research_delegate_routing() {
        let workspace_root = temp_workspace_root("research");

        let result = provision_internal_workspace_assets(&workspace_root).unwrap();
        assert_eq!(result.status, ProvisionStatus::Updated);

        let research_agent = fs::read_to_string(
            workspace_root
                .join(".opencode")
                .join("agents")
                .join("veslo-internal-research.md"),
        )
        .unwrap();
        assert!(research_agent.contains("Veslo internal Research execution agent"));
        assert!(research_agent.contains("mode: subagent"));

        let plugin = fs::read_to_string(
            workspace_root
                .join(".opencode")
                .join("plugins")
                .join("veslo-delegate.js"),
        )
        .unwrap();
        assert!(plugin.contains("veslo-internal-research"));
        assert!(plugin.contains("hasExplicitDelegateRequest"));
        assert!(plugin.contains("spusť subagenta"));

        let manifest = fs::read_to_string(
            workspace_root
                .join(".opencode")
                .join("veslo")
                .join("internal")
                .join("manifest.json"),
        )
        .unwrap();
        assert!(manifest.contains("veslo-internal-research"));
        assert!(manifest.contains("\"routingBlockVersion\": 3"));

        fs::remove_dir_all(workspace_root).unwrap();
    }
}
