use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use crate::paths::{candidate_xdg_config_dirs, home_dir};
use crate::types::ExecResult;

fn ensure_project_skill_root(project_dir: &str) -> Result<PathBuf, String> {
    let project_dir = project_dir.trim();
    if project_dir.is_empty() {
        return Err("projectDir is required".to_string());
    }

    let base = PathBuf::from(project_dir).join(".opencode");
    let legacy = base.join("skill");
    let modern = base.join("skills");

    if legacy.is_dir() && !modern.exists() {
        fs::rename(&legacy, &modern).map_err(|e| {
            format!(
                "Failed to move {} -> {}: {e}",
                legacy.display(),
                modern.display()
            )
        })?;
    }

    fs::create_dir_all(&modern)
        .map_err(|e| format!("Failed to create {}: {e}", modern.display()))?;
    Ok(modern)
}

fn ensure_global_skill_root() -> Result<PathBuf, String> {
    let Some(config_root) = candidate_xdg_config_dirs().into_iter().next() else {
        return Err("Home directory is required to install global skills".to_string());
    };
    let skill_root = config_root.join("opencode").join("skills");
    fs::create_dir_all(&skill_root)
        .map_err(|e| format!("Failed to create {}: {e}", skill_root.display()))?;
    Ok(skill_root)
}

fn collect_project_skill_roots(project_dir: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut current = Some(project_dir);

    while let Some(dir) = current {
        let opencode_root = dir.join(".opencode").join("skills");
        if opencode_root.is_dir() {
            roots.push(opencode_root);
        } else {
            let legacy_root = dir.join(".opencode").join("skill");
            if legacy_root.is_dir() {
                roots.push(legacy_root);
            }
        }

        let claude_root = dir.join(".claude").join("skills");
        if claude_root.is_dir() {
            roots.push(claude_root);
        }

        if dir.join(".git").exists() {
            break;
        }

        current = dir.parent();
    }

    roots
}

fn collect_global_skill_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for dir in candidate_xdg_config_dirs() {
        let opencode_root = dir.join("opencode").join("skills");
        if opencode_root.is_dir() {
            roots.push(opencode_root);
        }
    }

    if let Some(home) = home_dir() {
        let claude_root = home.join(".claude").join("skills");
        if claude_root.is_dir() {
            roots.push(claude_root);
        }

        let agents_root = home.join(".agents").join("skills");
        if agents_root.is_dir() {
            roots.push(agents_root);
        }

        let legacy_agents_root = home.join(".agent").join("skills");
        if legacy_agents_root.is_dir() {
            roots.push(legacy_agents_root);
        }
    }

    roots
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SkillListScope {
    Workspace,
    Global,
    Effective,
}

impl FromStr for SkillListScope {
    type Err = String;

    fn from_str(scope: &str) -> Result<Self, Self::Err> {
        match scope {
            "workspace" => Ok(Self::Workspace),
            "global" => Ok(Self::Global),
            "effective" => Ok(Self::Effective),
            _ => Err("scope must be workspace, global, or effective".to_string()),
        }
    }
}

fn dedupe_paths(roots: Vec<PathBuf>) -> Result<Vec<PathBuf>, String> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for root in roots {
        let key = root.to_string_lossy().to_string();
        if seen.insert(key) {
            unique.push(root);
        }
    }

    Ok(unique)
}

fn select_skill_roots_for_scope(
    project_roots: Vec<PathBuf>,
    global_roots: Vec<PathBuf>,
    scope: SkillListScope,
) -> Result<Vec<PathBuf>, String> {
    let mut roots = Vec::new();
    if matches!(scope, SkillListScope::Workspace | SkillListScope::Effective) {
        roots.extend(project_roots);
    }
    if matches!(scope, SkillListScope::Global | SkillListScope::Effective) {
        roots.extend(global_roots);
    }

    dedupe_paths(roots)
}

fn collect_skill_roots(project_dir: &str, scope: SkillListScope) -> Result<Vec<PathBuf>, String> {
    let project_dir = project_dir.trim();
    if project_dir.is_empty() && scope != SkillListScope::Global {
        return Err("projectDir is required".to_string());
    }

    let project_roots = if matches!(scope, SkillListScope::Workspace | SkillListScope::Effective) {
        let project_path = PathBuf::from(project_dir);
        collect_project_skill_roots(&project_path)
    } else {
        Vec::new()
    };
    let global_roots = if matches!(scope, SkillListScope::Global | SkillListScope::Effective) {
        collect_global_skill_roots()
    } else {
        Vec::new()
    };

    select_skill_roots_for_scope(project_roots, global_roots, scope)
}

fn validate_skill_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("skill name is required".to_string());
    }

    if !trimmed
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err("skill name must be kebab-case".to_string());
    }

    if trimmed.starts_with('-') || trimmed.ends_with('-') || trimmed.contains("--") {
        return Err("skill name must be kebab-case".to_string());
    }

    Ok(trimmed.to_string())
}

fn gather_skills(
    root: &Path,
    seen: &mut HashSet<String>,
    out: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if !root.is_dir() {
        return Ok(());
    }

    for entry in
        fs::read_dir(root).map_err(|e| format!("Failed to read {}: {e}", root.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !file_type.is_dir() {
            continue;
        }

        let path = entry.path();
        if path.join("SKILL.md").is_file() {
            // Direct skill: <root>/<name>/SKILL.md
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if seen.insert(name.to_string()) {
                out.push(path);
            }
        } else {
            // Domain/category folder: <root>/<domain>/<name>/SKILL.md – scan one level deeper.
            // This supports the convention where global skills are organised as
            //   skills/<domain>/<skill-name>/SKILL.md
            // in addition to the flat   skills/<skill-name>/SKILL.md  layout.
            if let Ok(sub_entries) = fs::read_dir(&path) {
                for sub_entry in sub_entries.flatten() {
                    let Ok(sub_ft) = sub_entry.file_type() else {
                        continue;
                    };
                    if !sub_ft.is_dir() {
                        continue;
                    }
                    let sub_path = sub_entry.path();
                    if !sub_path.join("SKILL.md").is_file() {
                        continue;
                    }
                    let Some(name) = sub_path.file_name().and_then(|s| s.to_str()) else {
                        continue;
                    };
                    if seen.insert(name.to_string()) {
                        out.push(sub_path);
                    }
                }
            }
        }
    }

    Ok(())
}

fn find_skill_file_in_root(root: &Path, name: &str) -> Option<PathBuf> {
    let direct = root.join(name).join("SKILL.md");
    if direct.is_file() {
        return Some(direct);
    }

    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let candidate = entry.path().join(name).join("SKILL.md");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

fn collect_skill_dirs_by_name(root: &Path, name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();

    let direct = root.join(name);
    if direct.join("SKILL.md").is_file() {
        out.push(direct);
    }

    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let candidate = entry.path().join(name);
            if candidate.join("SKILL.md").is_file() {
                out.push(candidate);
            }
        }
    }

    out
}

fn is_path_inside(parent: &Path, child: &Path) -> bool {
    child.starts_with(parent)
}

fn resolve_skill_file_at_path(
    project_dir: &str,
    name: &str,
    path: &str,
    allow_managed: bool,
) -> Result<PathBuf, String> {
    let project_dir = project_dir.trim();
    if project_dir.is_empty() {
        return Err("projectDir is required".to_string());
    }

    let name = validate_skill_name(name)?;
    let candidate = PathBuf::from(path.trim());
    if candidate.file_name().and_then(|s| s.to_str()) != Some("SKILL.md") {
        return Err("skill path must point to SKILL.md".to_string());
    }
    if candidate
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|s| s.to_str())
        != Some(name.as_str())
    {
        return Err("skill path must match skill name".to_string());
    }
    if !candidate.is_file() {
        return Err("Skill not found".to_string());
    }

    let canonical_candidate = fs::canonicalize(&candidate)
        .map_err(|e| format!("Failed to resolve {}: {e}", candidate.display()))?;
    let roots = collect_skill_roots(project_dir, SkillListScope::Effective)?;
    for root in roots {
        let Ok(canonical_root) = fs::canonicalize(&root) else {
            continue;
        };
        if !is_path_inside(&canonical_root, &canonical_candidate) {
            continue;
        }
        if !allow_managed {
            if let Ok(relative) = canonical_candidate.strip_prefix(&canonical_root) {
                let mut parts = relative.components();
                if parts.next().and_then(|part| part.as_os_str().to_str()) == Some("veslo-managed")
                {
                    return Err(
                        "Managed materialized skills must be edited through the registry"
                            .to_string(),
                    );
                }
            }
        }
        return Ok(canonical_candidate);
    }

    Err("skill path must be inside a configured skill root".to_string())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkillRegistryMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removal_policy: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkillCard {
    pub name: String,
    pub path: String,
    pub description: Option<String>,
    pub trigger: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry: Option<LocalSkillRegistryMetadata>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkillContent {
    pub path: String,
    pub content: String,
}

fn extract_frontmatter_value(raw: &str, keys: &[&str]) -> Option<String> {
    let mut lines = raw.lines();
    let first = lines.next()?.trim();
    if first != "---" {
        return None;
    }

    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if trimmed.is_empty() {
            continue;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        if !keys
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(key.trim()))
        {
            continue;
        }
        let mut cleaned = value.trim().to_string();
        if (cleaned.starts_with('"') && cleaned.ends_with('"'))
            || (cleaned.starts_with('\'') && cleaned.ends_with('\''))
        {
            if cleaned.len() >= 2 {
                cleaned = cleaned[1..cleaned.len() - 1].to_string();
            }
        }
        let cleaned = cleaned.trim();
        if cleaned.is_empty() {
            continue;
        }
        return Some(cleaned.to_string());
    }

    None
}

fn extract_trigger(raw: &str) -> Option<String> {
    if let Some(frontmatter) = extract_frontmatter_value(raw, &["trigger", "when"]) {
        return Some(frontmatter);
    }

    let mut in_frontmatter = false;
    let mut in_when_section = false;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed == "---" {
            in_frontmatter = !in_frontmatter;
            continue;
        }
        if in_frontmatter {
            continue;
        }
        if trimmed.starts_with('#') {
            let heading = trimmed.trim_start_matches('#').trim();
            in_when_section = heading.eq_ignore_ascii_case("When to use");
            continue;
        }
        if !in_when_section {
            continue;
        }

        let cleaned = trimmed
            .trim_start_matches(|c: char| c == '-' || c == '*' || c == '+')
            .trim_start_matches(|c: char| c.is_whitespace())
            .trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ')')
            .trim();
        if !cleaned.is_empty() {
            return Some(cleaned.to_string());
        }
    }

    None
}

fn extract_description(raw: &str) -> Option<String> {
    // Keep this lightweight: take the first non-empty line that isn't a header or frontmatter marker.
    let mut in_frontmatter = false;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed == "---" {
            in_frontmatter = !in_frontmatter;
            continue;
        }
        if in_frontmatter {
            continue;
        }
        if trimmed.starts_with('#') {
            continue;
        }

        let cleaned = trimmed.replace('`', "");
        if cleaned.is_empty() {
            continue;
        }

        let max = 180;
        let truncated: String = cleaned.chars().take(max).collect();
        if truncated.len() < cleaned.len() {
            return Some(format!("{}...", truncated));
        }
        return Some(cleaned);
    }

    None
}

fn marker_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|candidate| candidate.as_str())
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .map(ToString::to_string)
}

fn marker_source(value: &serde_json::Value) -> Option<String> {
    match marker_string(value, "source").as_deref() {
        Some("personal") => Some("personal".to_string()),
        Some("workspace") => Some("workspace".to_string()),
        Some("organization") => Some("organization".to_string()),
        Some("platform") => Some("platform".to_string()),
        _ => match marker_string(value, "target").as_deref() {
            Some("workspace") => Some("workspace".to_string()),
            Some("personal-global") => Some("personal".to_string()),
            _ => None,
        },
    }
}

fn marker_removal_policy(value: &serde_json::Value) -> Option<String> {
    match marker_string(value, "removalPolicy").as_deref() {
        Some("user_removable") => Some("user_removable".to_string()),
        Some("admin_removable") => Some("admin_removable".to_string()),
        Some("locked") => Some("locked".to_string()),
        _ => Some("user_removable".to_string()),
    }
}

fn registry_metadata_from_managed_marker(skill_dir: &Path) -> Option<LocalSkillRegistryMetadata> {
    let raw = fs::read_to_string(skill_dir.join(".veslo-managed.json")).ok()?;
    let marker: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let marker_installation_id = marker_string(&marker, "installationId")?;
    let source = marker_source(&marker);
    let removal_policy = marker_removal_policy(&marker);

    let (installation_id, policy_id) =
        if let Some(policy_id) = marker_installation_id.strip_prefix("rollout:") {
            let policy_id = policy_id.trim().to_string();
            if policy_id.is_empty() {
                return None;
            }
            (None, Some(policy_id))
        } else {
            (Some(marker_installation_id), None)
        };

    Some(LocalSkillRegistryMetadata {
        skill_id: marker_string(&marker, "skillId"),
        installation_id,
        policy_id,
        version_id: marker_string(&marker, "versionId"),
        package_sha256: marker_string(&marker, "packageSha256"),
        source,
        removal_policy,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        collect_skill_roots, extract_description, registry_metadata_from_managed_marker,
        select_skill_roots_for_scope, SkillListScope,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::str::FromStr;

    fn root(path: &str) -> PathBuf {
        PathBuf::from(path)
    }

    #[test]
    fn skill_list_scope_workspace_excludes_global_roots_and_requires_project_dir() {
        assert_eq!(
            SkillListScope::from_str("workspace").unwrap(),
            SkillListScope::Workspace
        );

        let project_roots = vec![root("/workspace/.opencode/skills")];
        let global_roots = vec![root("/home/user/.config/opencode/skills")];

        assert_eq!(
            select_skill_roots_for_scope(
                project_roots.clone(),
                global_roots,
                SkillListScope::Workspace
            )
            .unwrap(),
            project_roots
        );
        assert_eq!(
            collect_skill_roots("", SkillListScope::Workspace).unwrap_err(),
            "projectDir is required"
        );
    }

    #[test]
    fn skill_list_scope_global_excludes_project_roots_and_allows_empty_project_dir() {
        assert_eq!(
            SkillListScope::from_str("global").unwrap(),
            SkillListScope::Global
        );

        let project_roots = vec![root("/workspace/.opencode/skills")];
        let global_roots = vec![root("/home/user/.config/opencode/skills")];

        assert_eq!(
            select_skill_roots_for_scope(
                project_roots,
                global_roots.clone(),
                SkillListScope::Global,
            )
            .unwrap(),
            global_roots
        );
        assert!(collect_skill_roots("", SkillListScope::Global).is_ok());
    }

    #[test]
    fn skill_list_scope_effective_includes_project_and_global_roots_and_requires_project_dir() {
        assert_eq!(
            SkillListScope::from_str("effective").unwrap(),
            SkillListScope::Effective
        );

        let project_roots = vec![root("/workspace/.opencode/skills")];
        let global_roots = vec![root("/home/user/.config/opencode/skills")];

        assert_eq!(
            select_skill_roots_for_scope(
                project_roots.clone(),
                global_roots.clone(),
                SkillListScope::Effective
            )
            .unwrap(),
            vec![project_roots[0].clone(), global_roots[0].clone()]
        );
        assert_eq!(
            collect_skill_roots("", SkillListScope::Effective).unwrap_err(),
            "projectDir is required"
        );
    }

    #[test]
    fn extract_description_truncates_multibyte_text_without_panicking() {
        let raw = &"て".repeat(181);

        let description = extract_description(raw).expect("description should be present");

        assert!(description.ends_with("..."));
        assert!(description.is_char_boundary(description.len()));
        assert_eq!(description.chars().count(), 183);
    }

    #[test]
    fn extract_description_keeps_short_text_unchanged() {
        let raw = "Short description";

        let description = extract_description(raw).expect("description should be present");

        assert_eq!(description, "Short description");
    }

    #[test]
    fn managed_marker_exposes_installation_metadata_for_inventory() {
        let temp = tempfile::tempdir().expect("temp dir");
        let skill_dir = temp.path().join("managed-tool");
        fs::create_dir_all(&skill_dir).expect("create skill dir");
        fs::write(
            skill_dir.join(".veslo-managed.json"),
            r#"{
              "installationId": "install_workspace_tool",
              "skillId": "skill_workspace_tool",
              "versionId": "version_1",
              "packageSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "target": "workspace"
            }"#,
        )
        .expect("write managed marker");

        let metadata =
            registry_metadata_from_managed_marker(&skill_dir).expect("registry metadata");

        assert_eq!(
            metadata.installation_id.as_deref(),
            Some("install_workspace_tool")
        );
        assert_eq!(metadata.policy_id.as_deref(), None);
        assert_eq!(metadata.skill_id.as_deref(), Some("skill_workspace_tool"));
        assert_eq!(metadata.version_id.as_deref(), Some("version_1"));
        assert_eq!(metadata.source.as_deref(), Some("workspace"));
        assert_eq!(metadata.removal_policy.as_deref(), Some("user_removable"));
    }

    #[test]
    fn managed_marker_maps_rollout_installation_to_policy_metadata() {
        let temp = tempfile::tempdir().expect("temp dir");
        let skill_dir = temp.path().join("managed-tool");
        fs::create_dir_all(&skill_dir).expect("create skill dir");
        fs::write(
            skill_dir.join(".veslo-managed.json"),
            r#"{
              "installationId": "rollout:policy_workspace_tool",
              "skillId": "skill_workspace_tool",
              "versionId": "version_1",
              "packageSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "target": "workspace"
            }"#,
        )
        .expect("write managed marker");

        let metadata =
            registry_metadata_from_managed_marker(&skill_dir).expect("registry metadata");

        assert_eq!(metadata.installation_id.as_deref(), None);
        assert_eq!(metadata.policy_id.as_deref(), Some("policy_workspace_tool"));
        assert_eq!(metadata.source.as_deref(), Some("workspace"));
        assert_eq!(metadata.removal_policy.as_deref(), Some("user_removable"));
    }

    #[test]
    fn managed_marker_preserves_platform_lock_metadata() {
        let temp = tempfile::tempdir().expect("temp dir");
        let skill_dir = temp.path().join("platform-tool");
        fs::create_dir_all(&skill_dir).expect("create skill dir");
        fs::write(
            skill_dir.join(".veslo-managed.json"),
            r#"{
              "installationId": "platform_install_tool",
              "skillId": "platform_skill_tool",
              "versionId": "platform_version_tool_v1",
              "packageSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
              "target": "personal-global",
              "source": "platform",
              "removalPolicy": "locked"
            }"#,
        )
        .expect("write managed marker");

        let metadata =
            registry_metadata_from_managed_marker(&skill_dir).expect("registry metadata");

        assert_eq!(
            metadata.installation_id.as_deref(),
            Some("platform_install_tool")
        );
        assert_eq!(metadata.policy_id.as_deref(), None);
        assert_eq!(metadata.skill_id.as_deref(), Some("platform_skill_tool"));
        assert_eq!(metadata.version_id.as_deref(), Some("platform_version_tool_v1"));
        assert_eq!(metadata.source.as_deref(), Some("platform"));
        assert_eq!(metadata.removal_policy.as_deref(), Some("locked"));
    }
}

#[tauri::command]
pub fn list_local_skills(project_dir: String) -> Result<Vec<LocalSkillCard>, String> {
    let project_dir = project_dir.trim();
    if project_dir.is_empty() {
        return Err("projectDir is required".to_string());
    }

    let skill_roots = collect_skill_roots(project_dir, SkillListScope::Effective)?;
    list_skill_cards_from_roots(skill_roots)
}

#[tauri::command]
pub fn list_local_skills_scoped(
    project_dir: String,
    scope: String,
) -> Result<Vec<LocalSkillCard>, String> {
    let scope = SkillListScope::from_str(scope.trim())?;
    let skill_roots = collect_skill_roots(project_dir.trim(), scope)?;
    list_skill_cards_from_roots(skill_roots)
}

fn list_skill_cards_from_roots(skill_roots: Vec<PathBuf>) -> Result<Vec<LocalSkillCard>, String> {
    let mut found: Vec<PathBuf> = Vec::new();
    let mut seen = HashSet::new();
    for root in skill_roots {
        gather_skills(&root, &mut seen, &mut found)?;
    }

    let mut out = Vec::new();
    for path in found {
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };

        let (description, trigger) = match fs::read_to_string(path.join("SKILL.md")) {
            Ok(raw) => (extract_description(&raw), extract_trigger(&raw)),
            Err(_) => (None, None),
        };

        out.push(LocalSkillCard {
            name: name.to_string(),
            path: path.to_string_lossy().to_string(),
            description,
            trigger,
            registry: registry_metadata_from_managed_marker(&path),
        });
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub fn read_local_skill(project_dir: String, name: String) -> Result<LocalSkillContent, String> {
    let project_dir = project_dir.trim();
    if project_dir.is_empty() {
        return Err("projectDir is required".to_string());
    }

    let name = validate_skill_name(&name)?;
    let roots = collect_skill_roots(project_dir, SkillListScope::Effective)?;

    for root in roots {
        let Some(path) = find_skill_file_in_root(&root, &name) else {
            continue;
        };
        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
        return Ok(LocalSkillContent {
            path: path.to_string_lossy().to_string(),
            content: raw,
        });
    }

    Err("Skill not found".to_string())
}

#[tauri::command]
pub fn read_local_skill_at_path(
    project_dir: String,
    name: String,
    path: String,
) -> Result<LocalSkillContent, String> {
    let path = resolve_skill_file_at_path(&project_dir, &name, &path, true)?;
    let raw =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    Ok(LocalSkillContent {
        path: path.to_string_lossy().to_string(),
        content: raw,
    })
}

#[tauri::command]
pub fn write_local_skill(
    project_dir: String,
    name: String,
    content: String,
) -> Result<ExecResult, String> {
    let project_dir = project_dir.trim();
    if project_dir.is_empty() {
        return Err("projectDir is required".to_string());
    }

    let name = validate_skill_name(&name)?;
    let roots = collect_skill_roots(project_dir, SkillListScope::Effective)?;
    let mut target: Option<PathBuf> = None;

    for root in roots {
        if let Some(path) = find_skill_file_in_root(&root, &name) {
            target = Some(path);
            break;
        }
    }

    let Some(path) = target else {
        return Ok(ExecResult {
            ok: false,
            status: 1,
            stdout: String::new(),
            stderr: "Skill not found".to_string(),
        });
    };

    let next = if content.ends_with('\n') {
        content
    } else {
        format!("{}\n", content)
    };
    fs::write(&path, next).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Saved skill {}", name),
        stderr: String::new(),
    })
}

#[tauri::command]
pub fn write_local_skill_at_path(
    project_dir: String,
    name: String,
    path: String,
    content: String,
) -> Result<ExecResult, String> {
    let path = resolve_skill_file_at_path(&project_dir, &name, &path, false)?;
    let name = validate_skill_name(&name)?;
    let next = if content.ends_with('\n') {
        content
    } else {
        format!("{}\n", content)
    };
    fs::write(&path, next).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Saved skill {}", name),
        stderr: String::new(),
    })
}

#[tauri::command]
pub fn uninstall_skill_at_path(
    project_dir: String,
    name: String,
    path: String,
) -> Result<ExecResult, String> {
    let path = resolve_skill_file_at_path(&project_dir, &name, &path, false)?;
    let name = validate_skill_name(&name)?;
    let Some(skill_dir) = path.parent() else {
        return Err("Skill path must have a parent directory".to_string());
    };
    fs::remove_dir_all(skill_dir)
        .map_err(|e| format!("Failed to remove {}: {e}", skill_dir.display()))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Removed skill {}", name),
        stderr: String::new(),
    })
}

#[tauri::command]
pub fn install_skill_template(
    project_dir: String,
    name: String,
    content: String,
    overwrite: bool,
) -> Result<ExecResult, String> {
    let project_dir = project_dir.trim();
    if project_dir.is_empty() {
        return Err("projectDir is required".to_string());
    }

    let name = validate_skill_name(&name)?;
    let skill_root = ensure_project_skill_root(project_dir)?;
    let dest = skill_root.join(&name);

    if dest.exists() {
        if overwrite {
            fs::remove_dir_all(&dest).map_err(|e| {
                format!(
                    "Failed to remove existing skill dir {}: {e}",
                    dest.display()
                )
            })?;
        } else {
            return Ok(ExecResult {
                ok: false,
                status: 1,
                stdout: String::new(),
                stderr: format!("Skill already exists at {}", dest.display()),
            });
        }
    }

    fs::create_dir_all(&dest).map_err(|e| format!("Failed to create {}: {e}", dest.display()))?;
    fs::write(dest.join("SKILL.md"), content)
        .map_err(|e| format!("Failed to write SKILL.md: {e}"))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Installed skill to {}", dest.display()),
        stderr: String::new(),
    })
}

#[tauri::command]
pub fn install_global_skill_template(
    name: String,
    content: String,
    overwrite: bool,
) -> Result<ExecResult, String> {
    let name = validate_skill_name(&name)?;
    let skill_root = ensure_global_skill_root()?;
    let dest = skill_root.join(&name);

    if dest.exists() {
        if overwrite {
            fs::remove_dir_all(&dest).map_err(|e| {
                format!(
                    "Failed to remove existing skill dir {}: {e}",
                    dest.display()
                )
            })?;
        } else {
            return Ok(ExecResult {
                ok: false,
                status: 1,
                stdout: String::new(),
                stderr: format!("Skill already exists at {}", dest.display()),
            });
        }
    }

    fs::create_dir_all(&dest).map_err(|e| format!("Failed to create {}: {e}", dest.display()))?;
    fs::write(dest.join("SKILL.md"), content)
        .map_err(|e| format!("Failed to write SKILL.md: {e}"))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Installed global skill to {}", dest.display()),
        stderr: String::new(),
    })
}

#[tauri::command]
pub fn uninstall_skill(project_dir: String, name: String) -> Result<ExecResult, String> {
    let project_dir = project_dir.trim();
    if project_dir.is_empty() {
        return Err("projectDir is required".to_string());
    }

    let name = validate_skill_name(&name)?;
    let skill_roots = collect_skill_roots(project_dir, SkillListScope::Effective)?;
    let mut removed = false;

    for root in skill_roots {
        for dest in collect_skill_dirs_by_name(&root, &name) {
            fs::remove_dir_all(&dest)
                .map_err(|e| format!("Failed to remove {}: {e}", dest.display()))?;
            removed = true;
        }
    }

    if !removed {
        return Ok(ExecResult {
            ok: false,
            status: 1,
            stdout: String::new(),
            stderr: "Skill not found in .opencode/skills or .claude/skills".to_string(),
        });
    }

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Removed skill {}", name),
        stderr: String::new(),
    })
}
