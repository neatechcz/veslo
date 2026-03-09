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

pub fn load_workspace_state(app: &tauri::AppHandle) -> Result<WorkspaceState, String> {
    let (_, path) = veslo_state_paths(app)?;
    if !path.exists() {
        return Ok(WorkspaceState::default());
    }

    let raw =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let mut state: WorkspaceState = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;

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
