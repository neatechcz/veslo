use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use tauri::Manager;

use crate::types::{WorkspaceState, WORKSPACE_STATE_VERSION};

pub fn stable_workspace_id(path: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    format!("ws-{:x}", hasher.finish())
}

pub fn veslo_state_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let file_path = data_dir.join("veslo-workspaces.json");
    Ok((data_dir, file_path))
}

fn read_workspace_state_file(path: &PathBuf) -> Result<WorkspaceState, String> {
    let raw =
        fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str::<WorkspaceState>(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

fn legacy_state_candidates(data_dir: &PathBuf, current_state_path: &PathBuf) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();

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
        for legacy_dir in ["com.differentai.openwork", "com.differentai.openwork.dev"] {
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

pub fn load_workspace_state(app: &tauri::AppHandle) -> Result<WorkspaceState, String> {
    let (data_dir, path) = veslo_state_paths(app)?;
    let mut state = if path.exists() {
        read_workspace_state_file(&path)?
    } else if let Some(legacy) = try_load_legacy_workspace_state(&data_dir, &path) {
        // Best-effort one-time migration into the new state file location/name.
        if let Err(error) = fs::create_dir_all(&data_dir) {
            eprintln!(
                "[workspace] Failed to create migration directory {}: {error}",
                data_dir.display()
            );
        } else if let Ok(serialized) = serde_json::to_string_pretty(&legacy) {
            if let Err(error) = fs::write(&path, serialized) {
                eprintln!(
                    "[workspace] Failed to persist migrated state {}: {error}",
                    path.display()
                );
            }
        }
        legacy
    } else {
        return Ok(WorkspaceState::default());
    };

    if state.version < WORKSPACE_STATE_VERSION {
        state.version = WORKSPACE_STATE_VERSION;
    }

    Ok(state)
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
    use super::try_load_legacy_workspace_state;
    use crate::types::RemoteType;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("veslo-workspace-state-{label}-{}", Uuid::new_v4()))
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
        assert_eq!(workspace.veslo_workspace_id.as_deref(), Some("legacy-ws-id"));
        assert_eq!(workspace.veslo_workspace_name.as_deref(), Some("Legacy WS"));

        fs::remove_dir_all(&root).expect("cleanup temp dir");
    }
}
