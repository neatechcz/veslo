use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use sha1::{Digest, Sha1};
use tauri::Manager;

use crate::types::{
    RemoteType, WorkspaceInfo, WorkspaceState, WorkspaceType, WORKSPACE_STATE_VERSION,
};
use crate::workspace::reserved::is_reserved_internal_workspace_dir_name;

// Match orchestrator's workspaceIdForLocal in packages/orchestrator/src/cli.ts.
// SHA1(path) truncated to 12 hex chars produces a deterministic ID that stays
// stable across process restarts AND matches whatever the orchestrator
// synthesizes for the same path, so the frontend / Tauri local state /
// orchestrator state all agree on workspace identity. The previous
// DefaultHasher implementation reseeded SipHash on every process boot,
// producing fresh IDs that never matched the orchestrator's IDs — workspace
// switches issued POST /workspaces/:id/activate against orchestrator-unknown
// IDs, the activate handler returned 404 silently, the frontend's
// connectingWorkspaceId never cleared, and createSessionAndOpen stayed
// permanently blocked for every workspace after the first.
pub fn stable_workspace_id(path: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(path.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{:02x}", b)).collect();
    format!("ws-{}", &hex[..12])
}

pub fn veslo_state_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let data_dir = if let Some(override_dir) = crate::paths::app_data_dir_override() {
        override_dir
    } else {
        app.path()
            .app_data_dir()
            .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
    };
    let file_path = data_dir.join("veslo-workspaces.json");
    Ok((data_dir, file_path))
}

pub fn private_workspace_root_from_data_dir(data_dir: &PathBuf) -> PathBuf {
    data_dir.join("private-workspaces")
}

fn read_workspace_state_file(path: &PathBuf) -> Result<WorkspaceState, String> {
    let raw =
        fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str::<WorkspaceState>(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

fn legacy_state_candidates(data_dir: &PathBuf, current_state_path: &PathBuf) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    let mut push_candidate = |candidate: PathBuf| {
        if candidate == *current_state_path {
            return;
        }
        if seen.insert(candidate.clone()) {
            out.push(candidate);
        }
    };

    push_candidate(data_dir.join("openwork-workspaces.json"));

    if let Some(parent) = data_dir.parent() {
        for legacy_dir in [
            "com.neatech.veslo",
            "com.neatech.veslo.dev",
            "com.differentai.openwork",
            "com.differentai.openwork.dev",
        ] {
            let base = parent.join(legacy_dir);
            push_candidate(base.join("veslo-workspaces.json"));
            push_candidate(base.join("openwork-workspaces.json"));
        }
    }

    out
}

fn try_load_legacy_workspace_state(
    data_dir: &PathBuf,
    current_state_path: &PathBuf,
) -> Option<WorkspaceState> {
    for candidate in legacy_state_candidates(data_dir, current_state_path) {
        if !candidate.exists() {
            continue;
        }

        if let Ok(state) = read_workspace_state_file(&candidate) {
            return Some(state);
        }
    }

    None
}

fn persist_workspace_state_file(data_dir: &PathBuf, path: &PathBuf, state: &WorkspaceState) {
    if let Err(error) = fs::create_dir_all(data_dir) {
        eprintln!(
            "[workspace] Failed to create migration directory {}: {error}",
            data_dir.display()
        );
        return;
    }

    match serde_json::to_string_pretty(state) {
        Ok(serialized) => {
            if let Err(error) = fs::write(path, serialized) {
                eprintln!(
                    "[workspace] Failed to persist migrated state {}: {error}",
                    path.display()
                );
            }
        }
        Err(error) => {
            eprintln!(
                "[workspace] Failed to serialize workspace state {}: {error}",
                path.display()
            );
        }
    }
}

fn workspace_identity_key(workspace: &WorkspaceInfo) -> String {
    let normalized_path = workspace.path.trim().replace('\\', "/");
    match workspace.workspace_type {
        WorkspaceType::Local => format!("local::{normalized_path}"),
        WorkspaceType::Remote => {
            let remote_type = match workspace.remote_type.as_ref() {
                Some(RemoteType::Veslo) => "veslo",
                _ => "opencode",
            };
            let host = workspace
                .veslo_host_url
                .as_deref()
                .or(workspace.base_url.as_deref())
                .unwrap_or("")
                .trim()
                .replace('\\', "/");
            let scope = workspace
                .veslo_workspace_id
                .as_deref()
                .or(workspace.directory.as_deref())
                .unwrap_or("")
                .trim()
                .replace('\\', "/");
            format!("remote::{remote_type}::{host}::{scope}")
        }
    }
}

fn workspace_exists_by_id_or_identity(
    seen_ids: &HashSet<String>,
    seen_identity: &HashSet<String>,
    workspace: &WorkspaceInfo,
) -> bool {
    if seen_ids.contains(workspace.id.trim()) {
        return true;
    }
    let identity = workspace_identity_key(workspace);
    !identity.trim().is_empty() && seen_identity.contains(&identity)
}

fn normalized_local_path_key(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    while normalized.ends_with('/') {
        normalized.pop();
    }
    normalized.to_ascii_lowercase()
}

fn reserved_internal_child_parent_key(path: &str) -> Option<String> {
    let normalized = normalized_local_path_key(path);
    let (parent, leaf) = normalized.rsplit_once('/')?;
    if is_reserved_internal_workspace_dir_name(leaf) && !parent.is_empty() {
        Some(parent.to_string())
    } else {
        None
    }
}

fn prune_reserved_internal_child_workspaces(state: &mut WorkspaceState) -> bool {
    let mut local_workspace_by_path = std::collections::HashMap::<String, String>::new();
    for workspace in &state.workspaces {
        if workspace.workspace_type != WorkspaceType::Local {
            continue;
        }
        let path_key = normalized_local_path_key(&workspace.path);
        if !path_key.is_empty() {
            local_workspace_by_path.insert(path_key, workspace.id.clone());
        }
    }

    let mut changed = false;
    let mut active_replacement: Option<String> = None;
    state.workspaces.retain(|workspace| {
        if workspace.workspace_type != WorkspaceType::Local {
            return true;
        }
        let Some(parent_key) = reserved_internal_child_parent_key(&workspace.path) else {
            return true;
        };
        let Some(parent_id) = local_workspace_by_path.get(&parent_key) else {
            return true;
        };
        if state.active_id == workspace.id {
            active_replacement = Some(parent_id.clone());
        }
        changed = true;
        false
    });

    if let Some(parent_id) = active_replacement {
        state.active_id = parent_id;
        changed = true;
    }

    changed
}

fn merge_workspace_states(base: &mut WorkspaceState, imported: Vec<WorkspaceState>) -> bool {
    let mut changed = false;
    let mut seen_ids = HashSet::new();
    let mut seen_identity = HashSet::new();

    for workspace in &base.workspaces {
        let id = workspace.id.trim();
        if !id.is_empty() {
            seen_ids.insert(id.to_string());
        }
        let identity = workspace_identity_key(workspace);
        if !identity.trim().is_empty() {
            seen_identity.insert(identity);
        }
    }

    for state in imported {
        if state.version > base.version {
            base.version = state.version;
            changed = true;
        }

        let imported_active_id = state.active_id.trim().to_string();
        for workspace in state.workspaces {
            if workspace.id.trim().is_empty() {
                continue;
            }
            if workspace_exists_by_id_or_identity(&seen_ids, &seen_identity, &workspace) {
                continue;
            }
            seen_ids.insert(workspace.id.trim().to_string());
            let identity = workspace_identity_key(&workspace);
            if !identity.trim().is_empty() {
                seen_identity.insert(identity);
            }
            base.workspaces.push(workspace);
            changed = true;
        }

        let base_has_active = base
            .workspaces
            .iter()
            .any(|workspace| workspace.id == base.active_id);
        if !base_has_active
            && !imported_active_id.is_empty()
            && base
                .workspaces
                .iter()
                .any(|workspace| workspace.id == imported_active_id)
        {
            if base.active_id != imported_active_id {
                base.active_id = imported_active_id;
                changed = true;
            }
        }
    }

    changed
}

fn load_imported_workspace_states(
    data_dir: &PathBuf,
    current_state_path: &PathBuf,
) -> Vec<WorkspaceState> {
    legacy_state_candidates(data_dir, current_state_path)
        .into_iter()
        .filter_map(|candidate| {
            if !candidate.exists() {
                return None;
            }
            read_workspace_state_file(&candidate).ok()
        })
        .collect()
}

fn load_workspace_state_from_paths(
    data_dir: &PathBuf,
    path: &PathBuf,
) -> Result<WorkspaceState, String> {
    let mut migrated = false;
    let mut state = if path.exists() {
        read_workspace_state_file(path)?
    } else if let Some(legacy) = try_load_legacy_workspace_state(data_dir, path) {
        migrated = true;
        legacy
    } else {
        WorkspaceState::default()
    };

    let imported = load_imported_workspace_states(data_dir, path);
    let mut changed = merge_workspace_states(&mut state, imported);

    if state.version < WORKSPACE_STATE_VERSION {
        state.version = WORKSPACE_STATE_VERSION;
        changed = true;
    }

    // Migrate stale workspace IDs that were generated by the old DefaultHasher
    // (random SipHash seed each boot) to the deterministic SHA1 IDs the
    // orchestrator uses. Without this, every workspace entry persisted before
    // the algorithm change keeps an ID the orchestrator cannot resolve and
    // workspace switches hang in "connecting" forever. We map old ID → new ID
    // and rewrite both the workspaces table and active_id so the rest of the
    // app sees a self-consistent state.
    let mut id_remap: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for workspace in state.workspaces.iter_mut() {
        if workspace.workspace_type != WorkspaceType::Local {
            continue;
        }
        let path = workspace.path.trim();
        if path.is_empty() {
            continue;
        }
        let canonical = stable_workspace_id(path);
        if workspace.id != canonical {
            id_remap.insert(workspace.id.clone(), canonical.clone());
            workspace.id = canonical;
            changed = true;
        }
    }
    if !id_remap.is_empty() {
        if let Some(remapped_active) = id_remap.get(&state.active_id) {
            state.active_id = remapped_active.clone();
        }
    }

    if prune_reserved_internal_child_workspaces(&mut state) {
        changed = true;
    }

    let active_is_valid = state
        .workspaces
        .iter()
        .any(|workspace| workspace.id == state.active_id);
    if !active_is_valid {
        let next_active = state
            .workspaces
            .first()
            .map(|workspace| workspace.id.clone())
            .unwrap_or_else(|| "".to_string());
        if state.active_id != next_active {
            state.active_id = next_active;
            changed = true;
        }
    }

    if migrated || changed {
        persist_workspace_state_file(data_dir, path, &state);
    }

    Ok(state)
}

pub fn load_workspace_state(app: &tauri::AppHandle) -> Result<WorkspaceState, String> {
    let (data_dir, path) = veslo_state_paths(app)?;
    load_workspace_state_from_paths(&data_dir, &path)
}

pub fn save_workspace_state(app: &tauri::AppHandle, state: &WorkspaceState) -> Result<(), String> {
    let (dir, path) = veslo_state_paths(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    fs::write(
        &path,
        serde_json::to_string_pretty(state).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(())
}

pub fn stable_workspace_id_for_remote(base_url: &str, directory: Option<&str>) -> String {
    let mut key = format!("remote::{base_url}");
    if let Some(dir) = directory {
        if !dir.trim().is_empty() {
            key.push_str("::");
            key.push_str(dir.trim());
        }
    }
    stable_workspace_id(&key)
}

pub fn stable_workspace_id_for_veslo(host_url: &str, workspace_id: Option<&str>) -> String {
    let mut key = format!("veslo::{host_url}");
    if let Some(id) = workspace_id {
        if !id.trim().is_empty() {
            key.push_str("::");
            key.push_str(id.trim());
        }
    }
    stable_workspace_id(&key)
}

#[cfg(test)]
mod tests {
    use super::{
        legacy_state_candidates, load_workspace_state_from_paths,
        private_workspace_root_from_data_dir, stable_workspace_id, try_load_legacy_workspace_state,
    };
    use crate::types::{RemoteType, WorkspaceInfo, WorkspaceState, WorkspaceType};
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("veslo-workspace-state-{label}-{}", Uuid::new_v4()))
    }

    #[test]
    fn private_workspace_root_is_nested_under_resolved_workspace_data_dir() {
        let data_dir = PathBuf::from("/tmp/veslo-profile/app-data");
        assert_eq!(
            private_workspace_root_from_data_dir(&data_dir),
            data_dir.join("private-workspaces"),
        );
    }

    #[test]
    fn loads_legacy_openwork_state_from_neighbor_app_dir() {
        let root = temp_root("legacy-load");
        let current_data_dir = root.join("com.neatech.veslo.dev");
        let current_state_path = current_data_dir.join("veslo-workspaces.json");
        let legacy_data_dir = root.join("com.differentai.openwork");
        let legacy_state_path = legacy_data_dir.join("openwork-workspaces.json");

        fs::create_dir_all(&legacy_data_dir).expect("create legacy dir");
        fs::write(
            &legacy_state_path,
            r#"{
  "version": 4,
  "activeId": "ws-legacy",
  "workspaces": [
    {
      "id": "ws-legacy",
      "name": "Legacy Remote",
      "path": "/tmp/legacy",
      "preset": "starter",
      "workspaceType": "remote",
      "remoteType": "openwork",
      "baseUrl": "https://legacy.example",
      "openworkHostUrl": "https://legacy-host.example",
      "openworkToken": "token-123",
      "openworkWorkspaceId": "legacy-ws-id",
      "openworkWorkspaceName": "Legacy WS"
    }
  ]
}"#,
        )
        .expect("write legacy state");

        let loaded = try_load_legacy_workspace_state(&current_data_dir, &current_state_path)
            .expect("legacy state should load");
        let workspace = loaded.workspaces.first().expect("workspace should exist");

        assert_eq!(workspace.remote_type, Some(RemoteType::Veslo));
        assert_eq!(
            workspace.veslo_host_url.as_deref(),
            Some("https://legacy-host.example")
        );
        assert_eq!(workspace.veslo_token.as_deref(), Some("token-123"));
        assert_eq!(
            workspace.veslo_workspace_id.as_deref(),
            Some("legacy-ws-id")
        );
        assert_eq!(workspace.veslo_workspace_name.as_deref(), Some("Legacy WS"));

        fs::remove_dir_all(&root).expect("cleanup temp dir");
    }

    #[test]
    fn legacy_candidates_include_neighbor_veslo_profile_state() {
        let root = temp_root("legacy-candidates");
        let current_data_dir = root.join("com.neatech.veslo");
        let current_state_path = current_data_dir.join("veslo-workspaces.json");

        let candidates = legacy_state_candidates(&current_data_dir, &current_state_path);
        let expected = root
            .join("com.neatech.veslo.dev")
            .join("veslo-workspaces.json");

        assert!(
            candidates.iter().any(|candidate| candidate == &expected),
            "expected sibling Veslo profile state candidate: {}",
            expected.display()
        );
    }

    fn local_workspace(id: &str, name: &str, path: &str) -> WorkspaceInfo {
        WorkspaceInfo {
            id: id.to_string(),
            name: name.to_string(),
            path: path.to_string(),
            preset: "starter".to_string(),
            workspace_type: WorkspaceType::Local,
            remote_type: None,
            base_url: None,
            directory: None,
            display_name: None,
            veslo_host_url: None,
            veslo_token: None,
            veslo_workspace_id: None,
            veslo_workspace_name: None,
        }
    }

    fn write_state(path: &PathBuf, state: &WorkspaceState) {
        let dir = path.parent().expect("state file should have parent dir");
        fs::create_dir_all(dir).expect("create state dir");
        let serialized = serde_json::to_string_pretty(state).expect("serialize state");
        fs::write(path, serialized).expect("write state");
    }

    #[test]
    fn load_workspace_state_merges_neighbor_veslo_entries_when_current_exists() {
        let root = temp_root("merge-neighbor");
        let current_data_dir = root.join("com.neatech.veslo");
        let current_state_path = current_data_dir.join("veslo-workspaces.json");
        let sibling_state_path = root
            .join("com.neatech.veslo.dev")
            .join("veslo-workspaces.json");

        write_state(
            &current_state_path,
            &WorkspaceState {
                version: 4,
                active_id: "ws-local-a".to_string(),
                workspaces: vec![local_workspace("ws-local-a", "A", "/tmp/workspace-a")],
            },
        );
        write_state(
            &sibling_state_path,
            &WorkspaceState {
                version: 4,
                active_id: "ws-local-b".to_string(),
                workspaces: vec![local_workspace(
                    "ws-local-b",
                    "Company searcher",
                    "/tmp/company-searcher",
                )],
            },
        );

        let loaded = load_workspace_state_from_paths(&current_data_dir, &current_state_path)
            .expect("load merged state");

        assert_eq!(loaded.active_id, "ws-local-a");
        assert_eq!(loaded.workspaces.len(), 2);
        assert!(loaded
            .workspaces
            .iter()
            .any(|workspace| workspace.id == "ws-local-a" && workspace.path == "/tmp/workspace-a"));
        assert!(loaded
            .workspaces
            .iter()
            .any(|workspace| workspace.id == "ws-local-b"
                && workspace.path == "/tmp/company-searcher"));

        let persisted = fs::read_to_string(&current_state_path).expect("read persisted state");
        let parsed: WorkspaceState =
            serde_json::from_str(&persisted).expect("parse persisted state");
        assert_eq!(parsed.workspaces.len(), 2);

        fs::remove_dir_all(root).expect("cleanup temp dir");
    }

    #[test]
    fn load_workspace_state_dedupes_neighbor_local_entries_with_same_path() {
        let root = temp_root("dedupe-neighbor");
        let current_data_dir = root.join("com.neatech.veslo");
        let current_state_path = current_data_dir.join("veslo-workspaces.json");
        let sibling_state_path = root
            .join("com.neatech.veslo.dev")
            .join("veslo-workspaces.json");

        write_state(
            &current_state_path,
            &WorkspaceState {
                version: 4,
                active_id: "ws-local-a".to_string(),
                workspaces: vec![local_workspace("ws-local-a", "A", "/tmp/workspace-a")],
            },
        );
        write_state(
            &sibling_state_path,
            &WorkspaceState {
                version: 4,
                active_id: "ws-local-b".to_string(),
                workspaces: vec![local_workspace("ws-local-b", "A clone", "/tmp/workspace-a")],
            },
        );

        let loaded = load_workspace_state_from_paths(&current_data_dir, &current_state_path)
            .expect("load merged state");
        assert_eq!(loaded.workspaces.len(), 1);
        assert_eq!(loaded.workspaces[0].id, "ws-local-a");

        fs::remove_dir_all(root).expect("cleanup temp dir");
    }

    #[test]
    fn load_workspace_state_prunes_internal_opencode_child_workspace() {
        let root = temp_root("prune-opencode-child");
        let current_data_dir = root.join("com.neatech.veslo.dev");
        let current_state_path = current_data_dir.join("veslo-workspaces.json");
        let workspace_root = root.join("project");
        let opencode_root = workspace_root.join(".opencode");
        fs::create_dir_all(&opencode_root).expect("create workspace dirs");

        let workspace_path = workspace_root.to_string_lossy().to_string();
        let opencode_path = opencode_root.to_string_lossy().to_string();
        let workspace_id = stable_workspace_id(&workspace_path);
        let opencode_id = stable_workspace_id(&opencode_path);

        write_state(
            &current_state_path,
            &WorkspaceState {
                version: 4,
                active_id: opencode_id.clone(),
                workspaces: vec![
                    local_workspace(&opencode_id, ".opencode", &opencode_path),
                    local_workspace(&workspace_id, "project", &workspace_path),
                ],
            },
        );

        let loaded = load_workspace_state_from_paths(&current_data_dir, &current_state_path)
            .expect("load migrated state");
        assert_eq!(loaded.active_id, workspace_id);
        assert_eq!(loaded.workspaces.len(), 1);
        assert_eq!(loaded.workspaces[0].path, workspace_path);

        let persisted = fs::read_to_string(&current_state_path).expect("read persisted state");
        let parsed: WorkspaceState =
            serde_json::from_str(&persisted).expect("parse persisted state");
        assert_eq!(parsed.active_id, workspace_id);
        assert_eq!(parsed.workspaces.len(), 1);
        assert_eq!(parsed.workspaces[0].path, workspace_path);

        fs::remove_dir_all(root).expect("cleanup temp dir");
    }
}
