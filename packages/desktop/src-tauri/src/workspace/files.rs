use std::fs;
use std::path::{Path, PathBuf};

use crate::paths::{candidate_xdg_config_dirs, home_dir};
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

const LEGACY_ONBOARDING_SKILLS: &[&str] = &["workspace-guide", "get-started"];

fn normalize_legacy_skill_content(content: &str) -> String {
    content.replace("\r\n", "\n").replace("\\\"", "\"")
}

fn is_legacy_workspace_guide_content(content: &str) -> bool {
    let normalized = normalize_legacy_skill_content(content);
    normalized.contains("name: workspace-guide")
        && normalized.contains("description: Workspace guide to introduce")
        && normalized.contains("onboard new users")
        && normalized.contains("# Welcome to")
        && (normalized.contains("End with two friendly next actions to try")
            || normalized.contains("local-first alternative to Claude"))
}

fn is_legacy_get_started_content(content: &str) -> bool {
    let normalized = normalize_legacy_skill_content(content);
    normalized.contains("name: get-started")
        && normalized.contains("description: Guide users through the get started setup")
        && normalized.contains("Chrome DevTools demo")
        && normalized.contains("Always load this skill when the user says \"get started\"")
        && normalized.contains("Reply with these four lines, exactly and in order")
}

fn is_legacy_onboarding_skill_content(name: &str, content: &str) -> bool {
    match name {
        "workspace-guide" => is_legacy_workspace_guide_content(content),
        "get-started" => is_legacy_get_started_content(content),
        _ => false,
    }
}

fn is_private_workspace_path(workspace_root: &Path, app_data_dir: Option<&Path>) -> bool {
    if let Some(app_data_dir) = app_data_dir {
        if workspace_root.starts_with(app_data_dir.join("private-workspaces")) {
            return true;
        }
    }

    workspace_root
        .components()
        .any(|component| component.as_os_str() == "private-workspaces")
}

fn collect_user_skill_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for dir in candidate_xdg_config_dirs() {
        let opencode_root = dir.join("opencode").join("skills");
        if opencode_root.is_dir() {
            roots.push(opencode_root);
        }
    }

    if let Some(home) = home_dir() {
        for root in [
            home.join(".claude").join("skills"),
            home.join(".agents").join("skills"),
            home.join(".agent").join("skills"),
        ] {
            if root.is_dir() {
                roots.push(root);
            }
        }
    }

    roots
}

fn collect_user_skill_dirs_by_name(name: &str, user_skill_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for root in user_skill_roots {
        let direct = root.join(name);
        if direct.join("SKILL.md").is_file() {
            dirs.push(direct);
        }

        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let candidate = entry.path().join(name);
            if candidate.join("SKILL.md").is_file() {
                dirs.push(candidate);
            }
        }
    }
    dirs
}

fn collect_relative_files(
    root: &Path,
    current: &Path,
    out: &mut Vec<PathBuf>,
) -> Result<bool, String> {
    let mut only_regular_entries = true;
    let entries =
        fs::read_dir(current).map_err(|e| format!("Failed to read {}: {e}", current.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let path = entry.path();
        if file_type.is_dir() {
            only_regular_entries =
                collect_relative_files(root, &path, out)? && only_regular_entries;
            continue;
        }
        if file_type.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|e| format!("Failed to compare {}: {e}", path.display()))?
                .to_path_buf();
            out.push(relative);
            continue;
        }

        only_regular_entries = false;
    }

    Ok(only_regular_entries)
}

fn relative_file_list(root: &Path) -> Result<Option<Vec<PathBuf>>, String> {
    let mut files = Vec::new();
    if !collect_relative_files(root, root, &mut files)? {
        return Ok(None);
    }
    files.sort();
    Ok(Some(files))
}

fn skill_dirs_have_identical_files(left: &Path, right: &Path) -> Result<bool, String> {
    let Some(left_files) = relative_file_list(left)? else {
        return Ok(false);
    };
    let Some(right_files) = relative_file_list(right)? else {
        return Ok(false);
    };
    if left_files != right_files {
        return Ok(false);
    }

    for relative in left_files {
        let left_content = fs::read(left.join(&relative))
            .map_err(|e| format!("Failed to read {}: {e}", left.join(&relative).display()))?;
        let right_content = fs::read(right.join(&relative))
            .map_err(|e| format!("Failed to read {}: {e}", right.join(&relative).display()))?;
        if left_content != right_content {
            return Ok(false);
        }
    }

    Ok(true)
}

fn skill_dir_contains_only_entrypoint(skill_dir: &Path) -> Result<bool, String> {
    let mut entries = fs::read_dir(skill_dir)
        .map_err(|e| format!("Failed to read {}: {e}", skill_dir.display()))?;
    let Some(entry) = entries.next() else {
        return Ok(false);
    };
    let entry = entry.map_err(|e| e.to_string())?;
    let file_type = entry.file_type().map_err(|e| e.to_string())?;
    if entry.file_name() != std::ffi::OsStr::new("SKILL.md") || !file_type.is_file() {
        return Ok(false);
    }
    Ok(entries.next().is_none())
}

fn remove_legacy_onboarding_skill_copies(skill_root: &Path) -> Result<(), String> {
    for name in LEGACY_ONBOARDING_SKILLS {
        let skill_dir = skill_root.join(name);
        let skill_path = skill_dir.join("SKILL.md");
        if !skill_path.is_file() || !skill_dir_contains_only_entrypoint(&skill_dir)? {
            continue;
        }
        let raw = fs::read_to_string(&skill_path)
            .map_err(|e| format!("Failed to read {}: {e}", skill_path.display()))?;
        if is_legacy_onboarding_skill_content(name, &raw) {
            fs::remove_dir_all(&skill_dir).map_err(|e| {
                format!(
                    "Failed to remove legacy onboarding skill {}: {e}",
                    skill_dir.display()
                )
            })?;
        }
    }

    Ok(())
}

fn remove_private_workspace_user_skill_copies(
    workspace_root: &Path,
    skill_root: &Path,
    app_data_dir: Option<&Path>,
) -> Result<(), String> {
    let user_skill_roots = collect_user_skill_roots();
    remove_private_workspace_user_skill_copies_with_roots(
        workspace_root,
        skill_root,
        app_data_dir,
        &user_skill_roots,
    )
}

fn remove_private_workspace_user_skill_copies_with_roots(
    workspace_root: &Path,
    skill_root: &Path,
    app_data_dir: Option<&Path>,
    user_skill_roots: &[PathBuf],
) -> Result<(), String> {
    if !is_private_workspace_path(workspace_root, app_data_dir) || !skill_root.is_dir() {
        return Ok(());
    }

    if user_skill_roots.is_empty() {
        return Ok(());
    }

    let entries = fs::read_dir(skill_root)
        .map_err(|e| format!("Failed to read {}: {e}", skill_root.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !file_type.is_dir() {
            continue;
        }

        let workspace_skill_dir = entry.path();
        if !workspace_skill_dir.join("SKILL.md").is_file() {
            continue;
        }
        let Some(name) = workspace_skill_dir
            .file_name()
            .and_then(|value| value.to_str())
        else {
            continue;
        };

        for user_skill_dir in collect_user_skill_dirs_by_name(name, &user_skill_roots) {
            if skill_dirs_have_identical_files(&workspace_skill_dir, &user_skill_dir)? {
                fs::remove_dir_all(&workspace_skill_dir).map_err(|e| {
                    format!(
                        "Failed to remove copied user skill {}: {e}",
                        workspace_skill_dir.display()
                    )
                })?;
                break;
            }
        }
    }

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

    let opencode_dir = root.join(".opencode");
    fs::create_dir_all(&opencode_dir).map_err(|e| format!("Failed to create .opencode: {e}"))?;
    let _ = templates_dir;

    let skill_root = root.join(".opencode").join("skills");
    fs::create_dir_all(&skill_root)
        .map_err(|e| format!("Failed to create .opencode/skills: {e}"))?;
    remove_legacy_onboarding_skill_copies(&skill_root)?;
    remove_private_workspace_user_skill_copies(&root, &skill_root, app_data_dir)?;

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
    fn starter_workspace_does_not_seed_creator_skills() {
        let root = temp_workspace_root("starter-no-creator-skills");
        let root_str = root.to_string_lossy().to_string();

        ensure_workspace_files(&root_str, "starter", None, None).expect("seed workspace files");

        let skills_dir = root.join(".opencode").join("skills");
        assert!(!skills_dir.join("skill-creator").exists());
        assert!(!skills_dir.join("plugin-creator").exists());
        assert!(!skills_dir.join("agent-creator").exists());
    }

    #[test]
    fn ensure_workspace_files_does_not_seed_runtime_soul_files_or_old_instructions() {
        let root = temp_workspace_root("no-runtime-soul-seed");
        let root_str = root.to_string_lossy().to_string();

        ensure_workspace_files(&root_str, "starter", None, None).expect("seed workspace files");

        assert!(!root.join(".opencode").join("soul-company.md").exists());
        assert!(!root.join(".opencode").join("soul-user.md").exists());

        let config_raw =
            fs::read_to_string(root.join("opencode.jsonc")).expect("read generated config");
        let config: serde_json::Value =
            serde_json::from_str(&config_raw).expect("parse generated config");
        let instructions = config
            .get("instructions")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();

        assert!(!instructions.contains(&serde_json::Value::String(
            ".opencode/soul-company.md".to_string()
        )));
        assert!(!instructions.contains(&serde_json::Value::String(
            ".opencode/soul-user.md".to_string()
        )));

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn private_workspace_cleanup_removes_exact_user_skill_copies() {
        let app_data_dir = temp_workspace_root("app-data");
        let home_dir = temp_workspace_root("home");
        let workspace_root = app_data_dir
            .join("private-workspaces")
            .join("private-workspace");
        let user_skill_dir = home_dir
            .join(".config")
            .join("opencode")
            .join("skills")
            .join("skill-creator");
        let workspace_skill_dir = workspace_root
            .join(".opencode")
            .join("skills")
            .join("skill-creator");
        let skill_content = "---\nname: skill-creator\n---\n\n# Skill Creator\n";

        fs::create_dir_all(&user_skill_dir).expect("create user skill");
        fs::write(user_skill_dir.join("SKILL.md"), skill_content).expect("write user skill");
        fs::create_dir_all(&workspace_skill_dir).expect("create workspace skill");
        fs::write(workspace_skill_dir.join("SKILL.md"), skill_content)
            .expect("write workspace skill copy");

        remove_private_workspace_user_skill_copies_with_roots(
            &workspace_root,
            &workspace_root.join(".opencode").join("skills"),
            Some(&app_data_dir),
            &[home_dir.join(".config").join("opencode").join("skills")],
        )
        .expect("remove private workspace user skill copies");

        assert!(
            user_skill_dir.join("SKILL.md").exists(),
            "user skill should stay in the user root"
        );
        assert!(
            !workspace_skill_dir.exists(),
            "private workspace should not keep an exact user skill copy"
        );
    }

    #[test]
    fn ensure_workspace_files_removes_legacy_onboarding_skills_only_when_unmodified() {
        let root = temp_workspace_root("legacy-onboarding-skills");
        let legacy_root = root.join(".opencode").join("skills");
        let guide_dir = legacy_root.join("workspace-guide");
        let get_started_dir = legacy_root.join("get-started");
        let custom_dir = legacy_root.join("user-guide");
        fs::create_dir_all(&guide_dir).expect("create workspace-guide");
        fs::create_dir_all(&get_started_dir).expect("create get-started");
        fs::create_dir_all(&custom_dir).expect("create user-guide");
        fs::write(
            guide_dir.join("SKILL.md"),
            r#"---
name: workspace-guide
description: Workspace guide to introduce Veslo and onboard new users.
---

# Welcome to Veslo

Hi, I'm Ben and this is Veslo. It's a local-first alternative to Claude's cowork.

End with two friendly next actions to try in Veslo.
"#,
        )
        .expect("write workspace-guide");
        fs::write(
            get_started_dir.join("SKILL.md"),
            r#"---
name: get-started
description: Guide users through the get started setup and Chrome DevTools demo.
---

## When to use
- Always load this skill when the user says "get started".

## What to do
- Reply with these four lines, exactly and in order:
  1) hey there welcome this is veslo
"#,
        )
        .expect("write get-started");
        fs::write(
            custom_dir.join("SKILL.md"),
            r#"---
name: user-guide
description: User-owned onboarding notes.
---

# User guide
"#,
        )
        .expect("write custom skill");

        let root_str = root.to_string_lossy().to_string();
        ensure_workspace_files(&root_str, "starter", None, None).expect("seed workspace files");

        assert!(!guide_dir.exists());
        assert!(!get_started_dir.exists());
        assert!(custom_dir.join("SKILL.md").exists());

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn ensure_workspace_files_preserves_customized_legacy_onboarding_skill_names() {
        let root = temp_workspace_root("customized-onboarding-skills");
        let skill_root = root.join(".opencode").join("skills");
        let guide_dir = skill_root.join("workspace-guide");
        fs::create_dir_all(&guide_dir).expect("create workspace-guide");
        fs::write(
            guide_dir.join("SKILL.md"),
            r#"---
name: workspace-guide
description: User-owned workspace guide.
---

# Team Workspace Guide

Use this guide for the team's custom process.
"#,
        )
        .expect("write custom workspace-guide");

        let root_str = root.to_string_lossy().to_string();
        ensure_workspace_files(&root_str, "starter", None, None).expect("seed workspace files");

        assert!(guide_dir.join("SKILL.md").exists());

        fs::remove_dir_all(root).ok();
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
