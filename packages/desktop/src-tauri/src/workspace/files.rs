use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use zip::ZipArchive;

use crate::types::{OpencodeCommand, WorkspaceVesloConfig};
use crate::utils::now_ms;
use crate::workspace::commands::{sanitize_command_name, serialize_command_frontmatter};
use crate::workspace::internal_provision::{provision_internal_workspace_assets, ProvisionStatus};

const DEFAULT_SOUL_COMPANY: &str = r#"# Company Instructions

<!-- Edit this file to set company-wide tone, guardrails, and context. -->
<!-- This file is loaded into every workspace conversation. -->
<!-- Template location: ~/Library/Application Support/com.neatech.veslo/templates/soul-company.md -->

## Tone & Style
- Professional and clear.
- Respond in the user's language.

## Guardrails
- Never share credentials, tokens, or API keys.
- Explain consequences before destructive actions.
- Respect workspace boundaries.
"#;

const DEFAULT_SOUL_USER: &str = r#"# User Memory

<!-- This file stores personal notes and preferences. -->
<!-- Say "remember this" or "zapamatuj si" to add entries. -->
<!-- Veslo will append new facts below. -->
"#;

const SOUL_INSTRUCTIONS: &[&str] = &[".opencode/soul-company.md", ".opencode/soul-user.md"];

/// Seed soul template files into app_data_dir/templates/ if they don't exist.
pub fn seed_soul_templates(templates_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(templates_dir)
        .map_err(|e| format!("Failed to create templates dir: {e}"))?;

    let company_path = templates_dir.join("soul-company.md");
    if !company_path.exists() {
        fs::write(&company_path, DEFAULT_SOUL_COMPANY)
            .map_err(|e| format!("Failed to write soul-company.md template: {e}"))?;
    }

    let user_path = templates_dir.join("soul-user.md");
    if !user_path.exists() {
        fs::write(&user_path, DEFAULT_SOUL_USER)
            .map_err(|e| format!("Failed to write soul-user.md template: {e}"))?;
    }

    Ok(())
}

/// Copy soul files into workspace .opencode/ from templates (or inline defaults).
fn seed_soul_files(opencode_dir: &Path, templates_dir: Option<&Path>) -> Result<(), String> {
    let files: &[(&str, &str)] = &[
        ("soul-company.md", DEFAULT_SOUL_COMPANY),
        ("soul-user.md", DEFAULT_SOUL_USER),
    ];

    for (filename, default_content) in files {
        let dest = opencode_dir.join(filename);
        if dest.exists() {
            continue;
        }

        let content = templates_dir
            .map(|dir| dir.join(filename))
            .filter(|path| path.exists())
            .and_then(|path| fs::read_to_string(&path).ok());

        let content = content.as_deref().unwrap_or(default_content);
        fs::write(&dest, content).map_err(|e| format!("Failed to write {filename}: {e}"))?;
    }

    Ok(())
}

fn merge_instructions(existing: Vec<String>, required: &[&str]) -> Vec<String> {
    let mut out = existing;
    for instruction in required {
        if !out.iter().any(|entry| entry == instruction) {
            out.push(instruction.to_string());
        }
    }
    out
}

pub fn merge_plugins(existing: Vec<String>, required: &[&str]) -> Vec<String> {
    let mut out = existing;
    for plugin in required {
        if !out.iter().any(|entry| entry == plugin) {
            out.push(plugin.to_string());
        }
    }
    out
}

fn has_chrome_mcp_alias(mcp_obj: &serde_json::Map<String, serde_json::Value>) -> bool {
    mcp_obj.contains_key("chrome-devtools") || mcp_obj.contains_key("control-chrome")
}

fn seed_veslo_agent(agent_root: &PathBuf) -> Result<(), String> {
    let agent_path = agent_root.join("veslo.md");
    if agent_path.exists() {
        return Ok(());
    }

    fs::create_dir_all(agent_root)
        .map_err(|e| format!("Failed to create {}: {e}", agent_root.display()))?;

    // Full veslo.md content — written synchronously at workspace creation time,
    // before any user interaction. Content mirrors vesloAgentBaseContent() in TS.
    let doc = r#"---
description: Veslo default agent (desktop-first, safe, self-referential)
mode: primary
temperature: 0.2
---

You are Veslo.

When the user refers to "you", they mean the Veslo app and the current workspace.

Your job:
- Help the user work with files safely and efficiently.
- Automate repeatable work.
- Keep behavior portable and reproducible.

Memory (two kinds)
1) Workspace memory (shareable)
- `.opencode/skills/**` — reusable workflows
- `.opencode/agents/**` — agent configurations
- Project documentation and notes

2) Private memory (never share)
- Tokens, credentials, API keys
- Local configuration and logs
- Connected services (Notion, databases, etc.)

Hard rule: never copy private memory into shared files. Store only redacted summaries, schemas, and pointers.

Reconstruction-first
- Do not assume prior setup or context.
- If required information is missing, ask one targeted question.
- After the user provides it, store it and continue.

Verification-first
- After making changes, verify the result works correctly.
- If something fails, explain what happened and suggest a fix.

Incremental adoption loop
- Do the task once end-to-end.
- If steps repeat, suggest creating a skill.
- If the work becomes ongoing, refine the agent role.
- If it should run regularly, suggest scheduling it.

Response style
- Simple question → answer directly, concisely.
- Complex task → outline steps first, then execute one by one.
- File question → read and explain, ask before modifying.
- Unclear request → ask one clarifying question.
"#;

    fs::write(&agent_path, doc)
        .map_err(|e| format!("Failed to write {}: {e}", agent_path.display()))?;

    Ok(())
}

fn seed_plan_agent(agent_root: &PathBuf) -> Result<(), String> {
    let agent_path = agent_root.join("plan.md");
    if agent_path.exists() {
        return Ok(());
    }

    fs::create_dir_all(agent_root)
        .map_err(|e| format!("Failed to create {}: {e}", agent_root.display()))?;

    // Custom plan.md overrides the native OpenCode Plan agent prompt.
    // Engine-enforced read-only permissions are preserved (edit: deny),
    // but the prompt is conversational instead of structured planning phases.
    let doc = r#"---
description: Veslo — read-only mode
mode: primary
temperature: 0.2
---

You are Veslo in read-only mode.

When the user refers to "you", they mean the Veslo app and the current workspace.

You can read, search, and explore files. You cannot edit, create, or delete files.
This is enforced by the system — do not attempt file modifications.

Respond naturally and conversationally. Do not use structured planning phases,
numbered workflows, or phase-based responses. Just answer questions directly.

Do not mention internal implementation details like engine names, frameworks,
or technical architecture. You are Veslo — that is all the user needs to know.

If the user asks you to modify a file, explain that read-only mode is active
and they need to switch it off first.
"#;

    fs::write(&agent_path, doc)
        .map_err(|e| format!("Failed to write {}: {e}", agent_path.display()))?;

    Ok(())
}

fn seed_workspace_guide(skill_root: &PathBuf) -> Result<(), String> {
    let guide_dir = skill_root.join("workspace-guide");
    if guide_dir.exists() {
        return Ok(());
    }

    fs::create_dir_all(&guide_dir)
        .map_err(|e| format!("Failed to create {}: {e}", guide_dir.display()))?;

    let doc = r#"---
name: workspace-guide
description: Workspace guide to introduce Veslo and onboard new users.
---

# Welcome to Veslo

Hi, I'm Ben and this is Veslo. It's a local-first alternative to Claude's cowork. It helps you work on your files with AI and automate the mundane tasks so you don't have to.

Before we start, use the question tool to ask:
"Are you more technical or non-technical? I'll tailor the explanation."

## If the person is non-technical
Veslo feels like a chat app, but it can safely work with the files you allow. Put files in this workspace and I can summarize them, create new ones, or help organize them.

Try:
- "Summarize the files in this workspace."
- "Create a checklist for my week."
- "Draft a short summary from this document."

## Skills and plugins (simple)
Skills add new capabilities. Plugins add advanced features like scheduling or browser automation. We can add them later when you're ready.

## If the person is technical
Veslo is a GUI for OpenCode. Everything that works in OpenCode works here.

Most reliable setup today:
1) Install OpenCode from opencode.ai
2) Configure providers there (models and API keys)
3) Come back to Veslo and start a session

Skills:
- Install from the Skills tab, or add them to this workspace.
- Docs: https://opencode.ai/docs/skills

Plugins:
- Configure in opencode.json or use the Plugins tab.
- Docs: https://opencode.ai/docs/plugins/

MCP servers:
- Add external tools via opencode.json.
- Docs: https://opencode.ai/docs/mcp-servers/

Config reference:
- Docs: https://opencode.ai/docs/config/

End with two friendly next actions to try in Veslo."#;

    fs::write(guide_dir.join("SKILL.md"), doc)
        .map_err(|e| format!("Failed to write SKILL.md: {e}"))?;

    Ok(())
}

fn seed_get_started_skill(skill_root: &PathBuf) -> Result<(), String> {
    let skill_dir = skill_root.join("get-started");
    if skill_dir.exists() {
        return Ok(());
    }

    fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("Failed to create {}: {e}", skill_dir.display()))?;

    let doc = r#"---
name: get-started
description: Guide users through the get started setup and Chrome DevTools demo.
---

## When to use
- Always load this skill when the user says \"get started\".

## What to do
- Reply with these four lines, exactly and in order:
  1) hey there welcome this is veslo
  2) we've pre-configured you with a couple tools
  3) Get Started
  4) write \"hey go on google.com\"

## Then
- If the user writes \"go on google.com\" (or \"hey go on google.com\"), use the chrome-devtools MCP to open the site.
- After the navigation completes, reply: \"I'm on <site>\" where <site> is the final URL or page title they asked for.
"#;

    fs::write(skill_dir.join("SKILL.md"), doc)
        .map_err(|e| format!("Failed to write SKILL.md: {e}"))?;

    Ok(())
}

const ENTERPRISE_ARCHIVE_URL: &str =
    "https://github.com/different-ai/openwork-enterprise/archive/refs/heads/main.zip";
const ENTERPRISE_SEED_MARKER: &str = ".veslo-enterprise-creators";
const ENTERPRISE_ALLOWED_CREATORS: [&str; 3] = ["skill-creator", "plugin-creator", "agent-creator"];

fn is_allowed_enterprise_creator_skill_name(skill_name: &str) -> bool {
    ENTERPRISE_ALLOWED_CREATORS.contains(&skill_name)
}

fn seed_enterprise_creator_skills(root: &PathBuf, skill_root: &PathBuf) -> Result<(), String> {
    let marker_path = root.join(".opencode").join(ENTERPRISE_SEED_MARKER);
    if marker_path.exists() {
        return Ok(());
    }

    let mut existing = HashSet::new();
    if let Ok(entries) = fs::read_dir(skill_root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.is_empty() {
                existing.insert(name);
            }
        }
    }

    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(15))
        .redirects(5)
        .build();
    let response = match agent.get(ENTERPRISE_ARCHIVE_URL).call() {
        Ok(resp) => resp,
        Err(e) => {
            // Write the marker so we don't retry on every bootstrap for every
            // workspace.  The download can be re-attempted by deleting the
            // marker file manually.
            let _ = fs::write(&marker_path, format!("failed: {e}\n"));
            return Err(format!("Failed to download enterprise archive: {e}"));
        }
    };

    let mut buffer = Vec::new();
    response
        .into_reader()
        .read_to_end(&mut buffer)
        .map_err(|e| format!("Failed to read enterprise archive: {e}"))?;

    let cursor = Cursor::new(buffer);
    let mut archive =
        ZipArchive::new(cursor).map_err(|e| format!("Failed to open enterprise archive: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read enterprise entry: {e}"))?;
        let name = entry.name().to_string();
        let entry_path = Path::new(&name);
        if entry_path.components().any(|component| match component {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => true,
            _ => false,
        }) {
            continue;
        }

        let parts: Vec<String> = entry_path
            .components()
            .map(|component| component.as_os_str().to_string_lossy().to_string())
            .collect();
        if parts.len() < 5 {
            continue;
        }
        if parts[1] != ".opencode" || parts[2] != "skills" {
            continue;
        }

        let skill_name = &parts[3];
        if !is_allowed_enterprise_creator_skill_name(skill_name) || existing.contains(skill_name) {
            continue;
        }

        let dest_root = skill_root.join(skill_name);
        let mut dest_path = dest_root.clone();
        for part in parts.iter().skip(4) {
            dest_path = dest_path.join(part);
        }

        if name.ends_with('/') {
            fs::create_dir_all(&dest_path)
                .map_err(|e| format!("Failed to create {}: {e}", dest_path.display()))?;
            continue;
        }

        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }

        let mut file_buffer = Vec::new();
        entry
            .read_to_end(&mut file_buffer)
            .map_err(|e| format!("Failed to read enterprise entry: {e}"))?;
        fs::write(&dest_path, file_buffer)
            .map_err(|e| format!("Failed to write {}: {e}", dest_path.display()))?;
    }

    fs::write(&marker_path, "seeded\n")
        .map_err(|e| format!("Failed to write {}: {e}", marker_path.display()))?;

    Ok(())
}

fn seed_commands(commands_dir: &PathBuf, preset: &str) -> Result<(), String> {
    if fs::read_dir(commands_dir)
        .map_err(|e| format!("Failed to read {}: {e}", commands_dir.display()))?
        .next()
        .is_some()
    {
        return Ok(());
    }

    let defaults = vec![
    OpencodeCommand {
      name: "learn-files".to_string(),
      description: Some("Safe, practical file workflows".to_string()),
      template: "Show me how to interact with files in this workspace. Include safe examples for reading, summarizing, and editing.".to_string(),
      agent: None,
      model: None,
      subtask: None,
    },
    OpencodeCommand {
      name: "learn-skills".to_string(),
      description: Some("How skills work and how to create your own".to_string()),
      template: "Explain what skills are, how to use them, and how to create a new skill for this workspace.".to_string(),
      agent: None,
      model: None,
      subtask: None,
    },
    OpencodeCommand {
      name: "learn-plugins".to_string(),
      description: Some("What plugins are and how to install them".to_string()),
      template: "Explain what plugins are and how to install them in this workspace.".to_string(),
      agent: None,
      model: None,
      subtask: None,
    },
  ];

    let mut defaults = defaults;
    if preset == "starter" {
        defaults.push(OpencodeCommand {
            name: "Get Started".to_string(),
            description: Some("Get started".to_string()),
            template: "get started".to_string(),
            agent: None,
            model: None,
            subtask: None,
        });
    }

    for command in defaults {
        let Some(name) = sanitize_command_name(&command.name) else {
            continue;
        };

        let file_path = commands_dir.join(format!("{name}.md"));
        if file_path.exists() {
            continue;
        }

        let serialized = serialize_command_frontmatter(&command)?;
        fs::write(&file_path, serialized)
            .map_err(|e| format!("Failed to write {}: {e}", file_path.display()))?;
    }

    Ok(())
}

pub fn ensure_workspace_files(
    workspace_path: &str,
    preset: &str,
    templates_dir: Option<&Path>,
    app_data_dir: Option<&Path>,
) -> Result<(), String> {
    let root = PathBuf::from(workspace_path);

    // Seed soul files into .opencode/ before anything else that reads config
    let opencode_dir = root.join(".opencode");
    fs::create_dir_all(&opencode_dir).map_err(|e| format!("Failed to create .opencode: {e}"))?;
    seed_soul_files(&opencode_dir, templates_dir)?;

    let skill_root = root.join(".opencode").join("skills");
    fs::create_dir_all(&skill_root)
        .map_err(|e| format!("Failed to create .opencode/skills: {e}"))?;
    if preset == "starter" {
        if let Err(err) = seed_enterprise_creator_skills(&root, &skill_root) {
            println!("[workspace] Failed to seed creator skills: {err}");
        }
    }

    let agents_dir = root.join(".opencode").join("agents");
    fs::create_dir_all(&agents_dir)
        .map_err(|e| format!("Failed to create .opencode/agents: {e}"))?;
    // Seed full veslo.md (identity, rules, tone) synchronously at workspace creation.
    // Managed blocks (routing, agent instructions) are added by Rust provision + TS server.
    seed_veslo_agent(&agents_dir)?;
    seed_plan_agent(&agents_dir)?;
    let central_packs_dir = app_data_dir
        .map(|dir| crate::workspace::internal_provision::provision_central_packs(dir))
        .transpose()?;
    let provision = provision_internal_workspace_assets(&root, central_packs_dir.as_deref())?;
    let provision_status = match provision.status {
        ProvisionStatus::Updated => "updated",
        ProvisionStatus::Unchanged => "unchanged",
    };
    println!(
        "[workspace] internal provisioning {} (written={}, unchanged={}, version={})",
        provision_status,
        provision.written,
        provision.unchanged,
        crate::workspace::internal_provision::ProvisionResult::version(),
    );

    let commands_dir = root.join(".opencode").join("commands");
    fs::create_dir_all(&commands_dir)
        .map_err(|e| format!("Failed to create .opencode/commands: {e}"))?;
    seed_commands(&commands_dir, preset)?;

    let config_path_jsonc = root.join("opencode.jsonc");
    let config_path_json = root.join("opencode.json");
    let config_path = if config_path_jsonc.exists() {
        config_path_jsonc
    } else if config_path_json.exists() {
        config_path_json
    } else {
        config_path_jsonc
    };

    let config_exists = config_path.exists();
    let mut config_changed = !config_exists;
    let mut config: serde_json::Value = if config_exists {
        let raw = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {e}", config_path.display()))?;
        json5::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({
          "$schema": "https://opencode.ai/config.json"
        })
    };

    if !config.is_object() {
        config = serde_json::json!({
          "$schema": "https://opencode.ai/config.json"
        });
        config_changed = true;
    }

    if let Some(obj) = config.as_object_mut() {
        let current = obj
            .get("default_agent")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if current.is_empty() {
            obj.insert(
                "default_agent".to_string(),
                serde_json::Value::String("veslo".to_string()),
            );
            config_changed = true;
        }
    }

    let required_plugins: Vec<&str> = match preset {
        "starter" => vec!["opencode-scheduler"],
        "automation" => vec!["opencode-scheduler"],
        _ => vec![],
    };

    let should_seed_chrome_mcp = true;

    if !required_plugins.is_empty() {
        let plugins_value = config
            .get("plugin")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));

        let existing_plugins: Vec<String> = match plugins_value {
            serde_json::Value::Array(arr) => arr
                .into_iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
            serde_json::Value::String(s) => vec![s],
            _ => vec![],
        };

        let merged = merge_plugins(existing_plugins.clone(), &required_plugins);
        if merged != existing_plugins {
            config_changed = true;
        }
        if let Some(obj) = config.as_object_mut() {
            obj.insert(
                "plugin".to_string(),
                serde_json::Value::Array(
                    merged.into_iter().map(serde_json::Value::String).collect(),
                ),
            );
        }
    }

    if should_seed_chrome_mcp {
        if let Some(obj) = config.as_object_mut() {
            let mcp_value = obj
                .get("mcp")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));

            let mut mcp_obj = match mcp_value {
                serde_json::Value::Object(map) => map,
                _ => serde_json::Map::new(),
            };

            if !has_chrome_mcp_alias(&mcp_obj) {
                mcp_obj.insert(
                    "chrome-devtools".to_string(),
                    serde_json::json!({
                      "type": "local",
                      "command": ["npx", "-y", "chrome-devtools-mcp@latest", "--isolated"]
                    }),
                );
                config_changed = true;
            }

            obj.insert("mcp".to_string(), serde_json::Value::Object(mcp_obj));
        }
    }

    // Ensure soul files are listed in instructions
    if let Some(obj) = config.as_object_mut() {
        let instructions_value = obj
            .get("instructions")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));

        let existing_instructions: Vec<String> = match instructions_value {
            serde_json::Value::Array(arr) => arr
                .into_iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
            serde_json::Value::String(s) => vec![s],
            _ => vec![],
        };

        let merged = merge_instructions(existing_instructions.clone(), SOUL_INSTRUCTIONS);
        if merged != existing_instructions {
            config_changed = true;
        }
        obj.insert(
            "instructions".to_string(),
            serde_json::Value::Array(merged.into_iter().map(serde_json::Value::String).collect()),
        );
    }

    if config_changed {
        fs::write(
            &config_path,
            serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("Failed to write {}: {e}", config_path.display()))?;
    }

    let veslo_path = root.join(".opencode").join("veslo.json");
    if !veslo_path.exists() {
        let veslo = WorkspaceVesloConfig::new(workspace_path, preset, now_ms());

        fs::create_dir_all(veslo_path.parent().unwrap())
            .map_err(|e| format!("Failed to create {}: {e}", veslo_path.display()))?;

        fs::write(
            &veslo_path,
            serde_json::to_string_pretty(&veslo).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("Failed to write {}: {e}", veslo_path.display()))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_workspace_root(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("veslo-workspace-files-{name}-{unique}"));
        fs::create_dir_all(&root).expect("create temp workspace root");
        root
    }

    #[test]
    fn has_chrome_mcp_alias_matches_chrome_devtools_key() {
        let mut mcp = serde_json::Map::new();
        mcp.insert(
            "chrome-devtools".to_string(),
            serde_json::json!({ "type": "local" }),
        );

        assert!(has_chrome_mcp_alias(&mcp));
    }

    #[test]
    fn has_chrome_mcp_alias_matches_control_chrome_key() {
        let mut mcp = serde_json::Map::new();
        mcp.insert(
            "control-chrome".to_string(),
            serde_json::json!({ "type": "local" }),
        );

        assert!(has_chrome_mcp_alias(&mcp));
    }

    #[test]
    fn has_chrome_mcp_alias_is_false_without_known_aliases() {
        let mut mcp = serde_json::Map::new();
        mcp.insert(
            "context7".to_string(),
            serde_json::json!({ "type": "remote" }),
        );

        assert!(!has_chrome_mcp_alias(&mcp));
    }

    #[test]
    fn enterprise_creator_allowlist_accepts_required_creators() {
        assert!(is_allowed_enterprise_creator_skill_name("skill-creator"));
        assert!(is_allowed_enterprise_creator_skill_name("plugin-creator"));
        assert!(is_allowed_enterprise_creator_skill_name("agent-creator"));
    }

    #[test]
    fn enterprise_creator_allowlist_rejects_non_allowed_skills() {
        assert!(!is_allowed_enterprise_creator_skill_name("command-creator"));
        assert!(!is_allowed_enterprise_creator_skill_name("workspace-guide"));
        assert!(!is_allowed_enterprise_creator_skill_name("get-started"));
    }

    #[test]
    fn ensure_workspace_files_seeds_chrome_for_non_starter_presets() {
        let root = temp_workspace_root("automation");
        let root_str = root.to_string_lossy().to_string();

        ensure_workspace_files(&root_str, "automation", None, None).expect("seed workspace files");

        let config_raw =
            fs::read_to_string(root.join("opencode.jsonc")).expect("read generated config");
        let config: serde_json::Value =
            serde_json::from_str(&config_raw).expect("parse generated config");
        let command = config
            .get("mcp")
            .and_then(|value| value.get("chrome-devtools"))
            .and_then(|value| value.get("command"))
            .and_then(|value| value.as_array())
            .cloned()
            .expect("chrome-devtools command array");

        assert_eq!(
            command,
            vec![
                serde_json::Value::String("npx".to_string()),
                serde_json::Value::String("-y".to_string()),
                serde_json::Value::String("chrome-devtools-mcp@latest".to_string()),
                serde_json::Value::String("--isolated".to_string()),
            ]
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn ensure_workspace_files_preserves_existing_chrome_alias_without_duplicate() {
        let root = temp_workspace_root("alias");
        let config_path = root.join("opencode.jsonc");
        fs::write(
            &config_path,
            r#"{
  "mcp": {
    "control-chrome": {
      "type": "local",
      "command": ["existing"]
    }
  }
}"#,
        )
        .expect("write existing config");

        let root_str = root.to_string_lossy().to_string();
        ensure_workspace_files(&root_str, "minimal", None, None).expect("seed workspace files");

        let config_raw = fs::read_to_string(&config_path).expect("read updated config");
        let config: serde_json::Value =
            serde_json::from_str(&config_raw).expect("parse updated config");
        let mcp = config
            .get("mcp")
            .and_then(|value| value.as_object())
            .expect("mcp object");

        assert!(mcp.contains_key("control-chrome"));
        assert!(!mcp.contains_key("chrome-devtools"));

        fs::remove_dir_all(root).ok();
    }
}
