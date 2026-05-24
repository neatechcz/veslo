use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::fs::{collect_copy_conflicts, copy_dir_recursive};
use crate::paths::home_dir;
use crate::types::{
    ExecResult, RemoteType, WorkspaceInfo, WorkspaceList, WorkspaceState, WorkspaceType,
    WorkspaceVesloConfig,
};
use crate::workspace::files::{ensure_workspace_files, seed_soul_templates};
use crate::workspace::state::{
    load_workspace_state, private_workspace_root_from_data_dir, save_workspace_state, stable_workspace_id,
    stable_workspace_id_for_remote, stable_workspace_id_for_veslo,
};
use crate::workspace::watch::{update_workspace_watch, WorkspaceWatchState};
use serde::{Deserialize, Serialize};
use tauri::State;
use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

// ---------------------------------------------------------------------------
// OpenCode session cleanup (used by workspace_forget)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn workspace_private_root(app: tauri::AppHandle) -> Result<String, String> {
    let (data_dir, _) = crate::workspace::state::veslo_state_paths(&app)?;
    Ok(private_workspace_root_from_data_dir(&data_dir)
        .to_string_lossy()
        .to_string())
}

/// Resolve the path to the global OpenCode SQLite database.
fn opencode_db_path() -> Option<PathBuf> {
    let data_home = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = home_dir().unwrap_or_default();
            home.join(".local").join("share")
        });
    let db = data_home.join("opencode").join("opencode.db");
    db.exists().then_some(db)
}

/// Try to delete all sessions for `directory` via the OpenCode HTTP API.
/// Returns `true` if the cleanup succeeded (or there was nothing to clean).
fn try_cleanup_sessions_via_http(base_url: &str, directory: &str) -> bool {
    let trimmed = base_url.trim().trim_end_matches('/');
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(3))
        .build();

    // GET /session → list sessions
    let list_url = format!("{trimmed}/session");
    let response = match agent
        .get(&list_url)
        .set("x-opencode-directory", directory)
        .set("Accept", "application/json")
        .call()
    {
        Ok(r) => r,
        Err(e) => {
            println!("[workspace] session cleanup HTTP list failed: {e}");
            return false;
        }
    };

    let body: serde_json::Value = match response.into_json() {
        Ok(v) => v,
        Err(e) => {
            println!("[workspace] session cleanup HTTP parse failed: {e}");
            return false;
        }
    };

    // The response is typically an array of session objects with "id" fields.
    let sessions = match body.as_array() {
        Some(arr) => arr.clone(),
        None => {
            // Some API versions wrap in { "sessions": [...] }
            body.get("sessions")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default()
        }
    };

    if sessions.is_empty() {
        println!("[workspace] no sessions to cleanup for {directory}");
        return true;
    }

    let mut all_ok = true;
    for session in &sessions {
        if let Some(id) = session.get("id").and_then(|v| v.as_str()) {
            let delete_url = format!("{trimmed}/session/{id}");
            if let Err(e) = agent
                .delete(&delete_url)
                .set("x-opencode-directory", directory)
                .call()
            {
                println!("[workspace] session cleanup HTTP delete {id} failed: {e}");
                all_ok = false;
            }
        }
    }

    if all_ok {
        println!(
            "[workspace] cleaned up {} session(s) via HTTP for {directory}",
            sessions.len()
        );
    }
    all_ok
}

/// Fallback: delete sessions directly from the global OpenCode SQLite database.
fn try_cleanup_sessions_via_sqlite(directory: &str) -> Result<usize, String> {
    let db_path = opencode_db_path().ok_or_else(|| "OpenCode DB not found".to_string())?;

    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("Failed to open OpenCode DB: {e}"))?;

    // Enable foreign keys so cascade deletes work (message, part, todo, session_share).
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("PRAGMA foreign_keys failed: {e}"))?;

    let deleted = conn
        .execute("DELETE FROM session WHERE directory = ?1", [directory])
        .map_err(|e| format!("DELETE FROM session failed: {e}"))?;

    println!("[workspace] cleaned up {deleted} session(s) via SQLite for {directory}");
    Ok(deleted)
}

/// Clean up OpenCode sessions for a workspace directory.
/// Tries HTTP API first, falls back to direct SQLite access.
fn cleanup_opencode_sessions(base_url: Option<&str>, directory: &str) {
    if let Some(url) = base_url {
        if try_cleanup_sessions_via_http(url, directory) {
            return;
        }
    }

    if let Err(e) = try_cleanup_sessions_via_sqlite(directory) {
        println!("[workspace] warning: failed to cleanup sessions from global DB: {e}");
    }
}

fn upsert_workspace(workspaces: &mut Vec<WorkspaceInfo>, workspace: WorkspaceInfo) {
    workspaces.retain(|existing| existing.id != workspace.id);
    workspaces.insert(0, workspace);
}

fn set_active_workspace(
    state: &mut WorkspaceState,
    workspace_id: &str,
    promote_to_front: bool,
) -> Result<(), String> {
    let id = workspace_id.trim();
    if id.is_empty() {
        return Err("workspaceId is required".to_string());
    }
    let workspace_index = state
        .workspaces
        .iter()
        .position(|workspace| workspace.id == id)
        .ok_or_else(|| "Unknown workspaceId".to_string())?;
    if promote_to_front && workspace_index > 0 {
        let workspace = state.workspaces.remove(workspace_index);
        state.workspaces.insert(0, workspace);
    }

    state.active_id = id.to_string();
    Ok(())
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceForgetMode {
    DetachOnly,
    DeleteLocalData,
}

impl Default for WorkspaceForgetMode {
    fn default() -> Self {
        Self::DetachOnly
    }
}

fn cleanup_workspace_local_state(workspace_root: &Path, mode: WorkspaceForgetMode) {
    if mode != WorkspaceForgetMode::DeleteLocalData {
        return;
    }

    let opencode_dir = workspace_root.join(".opencode");
    if opencode_dir.is_dir() {
        if let Err(e) = fs::remove_dir_all(&opencode_dir) {
            println!(
                "[workspace] warning: failed to remove {}: {e}",
                opencode_dir.display()
            );
        }
    }

    let opencode_jsonc = workspace_root.join("opencode.jsonc");
    if opencode_jsonc.is_file() {
        if let Err(e) = fs::remove_file(&opencode_jsonc) {
            println!(
                "[workspace] warning: failed to remove {}: {e}",
                opencode_jsonc.display()
            );
        }
    }
}

#[tauri::command]
pub fn workspace_bootstrap(
    app: tauri::AppHandle,
    watch_state: State<WorkspaceWatchState>,
) -> Result<WorkspaceList, String> {
    println!("[workspace] bootstrap");
    let mut state = load_workspace_state(&app)?;

    let (data_dir, _) = crate::workspace::state::veslo_state_paths(&app)?;
    let templates_dir = data_dir.join("templates");
    if let Err(e) = seed_soul_templates(&templates_dir) {
        eprintln!("[workspace] failed to seed soul templates: {e}");
    }

    for workspace in state.workspaces.iter_mut() {
        if workspace.workspace_type != WorkspaceType::Local {
            continue;
        }
        if let Err(error) =
            ensure_workspace_files(&workspace.path, &workspace.preset, Some(&templates_dir), Some(&data_dir))
        {
            eprintln!(
                "[workspace] bootstrap provisioning failed for {}: {}",
                workspace.path, error
            );
        }
    }

    save_workspace_state(&app, &state)?;
    let active_workspace = state.workspaces.iter().find(|w| w.id == state.active_id);
    update_workspace_watch(&app, watch_state, active_workspace)?;

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command]
pub fn workspace_forget(
    app: tauri::AppHandle,
    workspace_id: String,
    mode: Option<WorkspaceForgetMode>,
    watch_state: State<WorkspaceWatchState>,
    engine_manager: State<crate::engine::manager::EngineManager>,
) -> Result<WorkspaceList, String> {
    println!("[workspace] forget request: {workspace_id}");
    let forget_mode = mode.unwrap_or_default();
    let mut state = load_workspace_state(&app)?;
    let id = workspace_id.trim();

    if id.is_empty() {
        return Err("workspaceId is required".to_string());
    }

    let forgotten_workspace = state.workspaces.iter().find(|w| w.id == id).cloned();

    let before = state.workspaces.len();
    state.workspaces.retain(|w| w.id != id);
    if before == state.workspaces.len() {
        return Err("Unknown workspaceId".to_string());
    }

    if state.active_id == id {
        state.active_id = state
            .workspaces
            .first()
            .map(|entry| entry.id.clone())
            .unwrap_or_else(|| "".to_string());
    }

    save_workspace_state(&app, &state)?;
    let active_workspace = state.workspaces.iter().find(|w| w.id == state.active_id);
    update_workspace_watch(&app, watch_state, active_workspace)?;

    // Mirror the deletion into the server registry (best-effort).
    crate::workspace::server_client::delete_workspace(&app, id);

    // Cleanup OpenCode sessions and local files only for explicit destructive forget mode.
    if let Some(ref ws) = forgotten_workspace {
        if ws.workspace_type == WorkspaceType::Local
            && forget_mode == WorkspaceForgetMode::DeleteLocalData
        {
            // Clean up sessions from the global OpenCode DB before removing local state
            let base_url = engine_manager
                .inner
                .lock()
                .ok()
                .and_then(|s| s.base_url.clone());
            cleanup_opencode_sessions(base_url.as_deref(), &ws.path);
            cleanup_workspace_local_state(Path::new(&ws.path), forget_mode);
        }
    }

    println!("[workspace] forget complete");

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command]
pub fn workspace_set_active(
    app: tauri::AppHandle,
    workspace_id: String,
    promote_to_front: Option<bool>,
    watch_state: State<WorkspaceWatchState>,
) -> Result<WorkspaceList, String> {
    println!("[workspace] set_active request: {workspace_id}");
    let mut state = load_workspace_state(&app)?;
    let promote = promote_to_front.unwrap_or(false);
    set_active_workspace(&mut state, &workspace_id, promote)?;
    save_workspace_state(&app, &state)?;
    let active_workspace = state.workspaces.iter().find(|w| w.id == state.active_id);
    update_workspace_watch(&app, watch_state, active_workspace)?;
    println!("[workspace] set_active complete: {}", workspace_id.trim());

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command]
pub fn workspace_update_display_name(
    app: tauri::AppHandle,
    workspace_id: String,
    display_name: Option<String>,
) -> Result<WorkspaceList, String> {
    println!("[workspace] update display name request: {workspace_id}");
    let mut state = load_workspace_state(&app)?;
    let id = workspace_id.trim();

    if id.is_empty() {
        return Err("workspaceId is required".to_string());
    }

    let next_name = display_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let workspace = state.workspaces.iter_mut().find(|w| w.id == id);
    match workspace {
        Some(entry) => {
            entry.display_name = next_name;
        }
        None => return Err("Unknown workspaceId".to_string()),
    }

    save_workspace_state(&app, &state)?;

    // Mirror the rename into the server registry. We send the effective name
    // (display_name if set, otherwise the existing entry.name) so the server
    // sees what the user sees in the sidebar.
    if let Some(ws) = state.workspaces.iter().find(|w| w.id == id) {
        let effective_name = ws.display_name.as_deref().unwrap_or(&ws.name);
        crate::workspace::server_client::patch_workspace(&app, &ws.id, effective_name);
    }

    println!("[workspace] update display name complete: {id}");

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFolderTransferResult {
    kind: String,
    conflicts: Vec<String>,
}

#[tauri::command]
pub fn workspace_copy_into_folder(
    source_path: String,
    target_path: String,
    overwrite: bool,
) -> Result<WorkspaceFolderTransferResult, String> {
    let source = PathBuf::from(source_path.trim());
    let target = PathBuf::from(target_path.trim());

    if source.as_os_str().is_empty() {
        return Err("sourcePath is required".to_string());
    }
    if target.as_os_str().is_empty() {
        return Err("targetPath is required".to_string());
    }
    if !source.is_dir() {
        return Err(format!("Source is not a directory: {}", source.display()));
    }
    if source == target {
        return Err("Choose a different folder.".to_string());
    }
    if target.starts_with(&source) {
        return Err("Choose a folder outside the current private workspace.".to_string());
    }

    fs::create_dir_all(&target)
        .map_err(|e| format!("Failed to create target folder {}: {e}", target.display()))?;

    let conflicts = collect_copy_conflicts(&source, &target)?;
    if !conflicts.is_empty() && !overwrite {
        return Ok(WorkspaceFolderTransferResult {
            kind: "conflict".to_string(),
            conflicts,
        });
    }

    copy_dir_recursive(&source, &target)?;
    Ok(WorkspaceFolderTransferResult {
        kind: "ok".to_string(),
        conflicts: Vec::new(),
    })
}

#[tauri::command]
pub fn workspace_create(
    app: tauri::AppHandle,
    folder_path: String,
    name: String,
    preset: String,
    watch_state: State<WorkspaceWatchState>,
) -> Result<WorkspaceList, String> {
    println!("[workspace] create local request");
    let folder = folder_path.trim().to_string();
    if folder.is_empty() {
        return Err("folderPath is required".to_string());
    }

    let workspace_name = name.trim().to_string();
    if workspace_name.is_empty() {
        return Err("name is required".to_string());
    }

    let preset = preset.trim().to_string();
    let preset = if preset.is_empty() {
        "starter".to_string()
    } else {
        preset
    };

    fs::create_dir_all(&folder).map_err(|e| format!("Failed to create workspace folder: {e}"))?;

    let (data_dir, _) = crate::workspace::state::veslo_state_paths(&app)?;
    let templates_dir = data_dir.join("templates");
    if let Err(e) = seed_soul_templates(&templates_dir) {
        eprintln!("[workspace] failed to seed soul templates: {e}");
    }

    let id = stable_workspace_id(&folder);

    ensure_workspace_files(&folder, &preset, Some(&templates_dir), Some(&data_dir))?;

    let mut state = load_workspace_state(&app)?;
    upsert_workspace(
        &mut state.workspaces,
        WorkspaceInfo {
            id: id.clone(),
            name: workspace_name,
            path: folder,
            preset,
            workspace_type: WorkspaceType::Local,
            remote_type: None,
            base_url: None,
            directory: None,
            display_name: None,
            veslo_host_url: None,
            veslo_token: None,
            veslo_workspace_id: None,
            veslo_workspace_name: None,
        },
    );
    state.active_id = id.clone();
    save_workspace_state(&app, &state)?;
    let active_workspace = state.workspaces.iter().find(|w| w.id == state.active_id);
    update_workspace_watch(&app, watch_state, active_workspace)?;

    // Mirror the new workspace into the server registry (hybrid C —
    // server is the future single-source-of-truth, ignored if not running).
    if let Some(ws) = state.workspaces.iter().find(|w| w.id == id) {
        crate::workspace::server_client::post_local_workspace(&app, &ws.path, &ws.name);
    }

    println!("[workspace] create local complete: {id}");

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command]
pub fn workspace_create_remote(
    app: tauri::AppHandle,
    base_url: String,
    directory: Option<String>,
    display_name: Option<String>,
    remote_type: Option<RemoteType>,
    veslo_host_url: Option<String>,
    veslo_token: Option<String>,
    veslo_workspace_id: Option<String>,
    veslo_workspace_name: Option<String>,
    watch_state: State<WorkspaceWatchState>,
) -> Result<WorkspaceList, String> {
    println!("[workspace] create remote request");
    let base_url = base_url.trim().to_string();
    let remote_type = remote_type.unwrap_or_default();
    if base_url.is_empty() {
        return Err("baseUrl is required".to_string());
    }
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return Err("baseUrl must start with http:// or https://".to_string());
    }

    let directory = directory
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let display_name = display_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let veslo_host_url = veslo_host_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let veslo_token = veslo_token
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if remote_type == RemoteType::Veslo {
        let host_url = veslo_host_url.clone().unwrap_or_default();
        if host_url.is_empty() {
            return Err("vesloHostUrl is required for Veslo remote".to_string());
        }
        if !host_url.starts_with("http://") && !host_url.starts_with("https://") {
            return Err("vesloHostUrl must start with http:// or https://".to_string());
        }
    }

    let id = if remote_type == RemoteType::Veslo {
        stable_workspace_id_for_veslo(
            veslo_host_url.as_deref().unwrap_or(""),
            veslo_workspace_id.as_deref(),
        )
    } else {
        stable_workspace_id_for_remote(&base_url, directory.as_deref())
    };
    let name = veslo_workspace_name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| display_name.clone())
        .unwrap_or_else(|| {
            if remote_type == RemoteType::Veslo {
                veslo_host_url.clone().unwrap_or_else(|| base_url.clone())
            } else {
                base_url.clone()
            }
        });
    let path = directory.clone().unwrap_or_default();

    let mut state = load_workspace_state(&app)?;
    upsert_workspace(
        &mut state.workspaces,
        WorkspaceInfo {
            id: id.clone(),
            name,
            path,
            preset: "remote".to_string(),
            workspace_type: WorkspaceType::Remote,
            remote_type: Some(remote_type),
            base_url: Some(base_url),
            directory,
            display_name,
            veslo_host_url,
            veslo_token,
            veslo_workspace_id,
            veslo_workspace_name,
        },
    );
    state.active_id = id.clone();
    save_workspace_state(&app, &state)?;
    let active_workspace = state.workspaces.iter().find(|w| w.id == state.active_id);
    update_workspace_watch(&app, watch_state, active_workspace)?;
    println!("[workspace] create remote complete: {id}");

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command]
pub fn workspace_update_remote(
    app: tauri::AppHandle,
    workspace_id: String,
    base_url: Option<String>,
    directory: Option<String>,
    display_name: Option<String>,
    remote_type: Option<RemoteType>,
    veslo_host_url: Option<String>,
    veslo_token: Option<String>,
    veslo_workspace_id: Option<String>,
    veslo_workspace_name: Option<String>,
) -> Result<WorkspaceList, String> {
    println!("[workspace] update remote request: {workspace_id}");
    let mut state = load_workspace_state(&app)?;
    let id = workspace_id.trim();
    if id.is_empty() {
        return Err("workspaceId is required".to_string());
    }

    let entry = state.workspaces.iter_mut().find(|w| w.id == id);
    let Some(entry) = entry else {
        return Err("Unknown workspaceId".to_string());
    };

    if entry.workspace_type != WorkspaceType::Remote {
        return Err("workspaceId is not remote".to_string());
    }

    if let Some(next_base_url) = base_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        if !next_base_url.starts_with("http://") && !next_base_url.starts_with("https://") {
            return Err("baseUrl must start with http:// or https://".to_string());
        }
        entry.base_url = Some(next_base_url);
    }

    let next_directory = directory
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if directory.is_some() {
        entry.directory = next_directory.clone();
        entry.path = next_directory.unwrap_or_default();
    }

    if let Some(next_name) = display_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        entry.display_name = Some(next_name.clone());
        entry.name = next_name;
    }

    if let Some(next_remote_type) = remote_type {
        entry.remote_type = Some(next_remote_type);
    }

    if let Some(next_host_url) = veslo_host_url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        if !next_host_url.starts_with("http://") && !next_host_url.starts_with("https://") {
            return Err("vesloHostUrl must start with http:// or https://".to_string());
        }
        entry.veslo_host_url = Some(next_host_url);
    }

    if veslo_token.is_some() {
        entry.veslo_token = veslo_token
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }

    if veslo_workspace_id.is_some() {
        entry.veslo_workspace_id = veslo_workspace_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }

    if let Some(next_name) = veslo_workspace_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        entry.veslo_workspace_name = Some(next_name.clone());
        if entry.display_name.is_none() {
            entry.name = next_name;
        }
    }

    save_workspace_state(&app, &state)?;
    println!("[workspace] update remote complete: {id}");

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[tauri::command]
pub fn workspace_add_authorized_root(
    _app: tauri::AppHandle,
    workspace_path: String,
    folder_path: String,
) -> Result<ExecResult, String> {
    let workspace_path = workspace_path.trim().to_string();
    let folder_path = folder_path.trim().to_string();

    if workspace_path.is_empty() {
        return Err("workspacePath is required".to_string());
    }
    if folder_path.is_empty() {
        return Err("folderPath is required".to_string());
    }

    let veslo_path = PathBuf::from(&workspace_path)
        .join(".opencode")
        .join("veslo.json");

    if let Some(parent) = veslo_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    let mut config: WorkspaceVesloConfig = if veslo_path.exists() {
        let raw = fs::read_to_string(&veslo_path)
            .map_err(|e| format!("Failed to read {}: {e}", veslo_path.display()))?;
        serde_json::from_str(&raw).unwrap_or_default()
    } else {
        let mut cfg = WorkspaceVesloConfig::default();
        if !cfg.authorized_roots.iter().any(|p| p == &workspace_path) {
            cfg.authorized_roots.push(workspace_path.clone());
        }
        cfg
    };

    if !config.authorized_roots.iter().any(|p| p == &folder_path) {
        config.authorized_roots.push(folder_path);
    }

    fs::write(
        &veslo_path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", veslo_path.display()))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: "Updated authorizedRoots".to_string(),
        stderr: String::new(),
    })
}

#[tauri::command]
pub fn workspace_veslo_read(
    _app: tauri::AppHandle,
    workspace_path: String,
) -> Result<WorkspaceVesloConfig, String> {
    let workspace_path = workspace_path.trim().to_string();
    if workspace_path.is_empty() {
        return Err("workspacePath is required".to_string());
    }

    let veslo_path = PathBuf::from(&workspace_path)
        .join(".opencode")
        .join("veslo.json");

    if !veslo_path.exists() {
        let mut cfg = WorkspaceVesloConfig::default();
        cfg.authorized_roots.push(workspace_path);
        return Ok(cfg);
    }

    let raw = fs::read_to_string(&veslo_path)
        .map_err(|e| format!("Failed to read {}: {e}", veslo_path.display()))?;

    serde_json::from_str::<WorkspaceVesloConfig>(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", veslo_path.display()))
}

#[tauri::command]
pub fn workspace_veslo_write(
    _app: tauri::AppHandle,
    workspace_path: String,
    config: WorkspaceVesloConfig,
) -> Result<ExecResult, String> {
    let workspace_path = workspace_path.trim().to_string();
    if workspace_path.is_empty() {
        return Err("workspacePath is required".to_string());
    }

    let veslo_path = PathBuf::from(&workspace_path)
        .join(".opencode")
        .join("veslo.json");

    if let Some(parent) = veslo_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    fs::write(
        &veslo_path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", veslo_path.display()))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Wrote {}", veslo_path.display()),
        stderr: String::new(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceExportSummary {
    pub output_path: String,
    pub included: usize,
    pub excluded: Vec<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_zip_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

const REDACTED_SECRET_VALUE: &str = "[REDACTED]";

fn normalize_exported_config_key(input: &str) -> String {
    input
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn is_sensitive_exported_config_key(key: &str) -> bool {
    let normalized = normalize_exported_config_key(key);
    if normalized.is_empty() || normalized == "tokensource" {
        return false;
    }
    matches!(
        normalized.as_str(),
        "password" | "token" | "secret" | "apikey" | "accesskey" | "privatekey" | "authorization"
    ) || normalized.ends_with("password")
        || normalized.ends_with("token")
        || normalized.ends_with("secret")
        || normalized.ends_with("apikey")
        || normalized.ends_with("accesskey")
        || normalized.ends_with("privatekey")
}

fn redact_exported_json_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                redact_exported_json_value(item);
            }
        }
        serde_json::Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if is_sensitive_exported_config_key(key) {
                    let should_redact = !matches!(child, serde_json::Value::Null)
                        && !matches!(child, serde_json::Value::String(text) if text.is_empty());
                    if should_redact {
                        *child = serde_json::Value::String(REDACTED_SECRET_VALUE.to_string());
                    }
                    continue;
                }
                redact_exported_json_value(child);
            }
        }
        _ => {}
    }
}

fn redact_exported_opencode_config(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|e| format!("Failed to parse opencode.json for export redaction: {e}"))?;
    redact_exported_json_value(&mut value);
    let mut output = serde_json::to_vec_pretty(&value)
        .map_err(|e| format!("Failed to serialize redacted opencode.json: {e}"))?;
    output.push(b'\n');
    Ok(output)
}

fn is_secret_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower == ".env" || lower.starts_with(".env.") {
        return true;
    }
    if lower == "credentials.json" || lower == "credentials.yml" || lower == "credentials.yaml" {
        return true;
    }
    if lower.ends_with(".key")
        || lower.ends_with(".pem")
        || lower.ends_with(".p12")
        || lower.ends_with(".pfx")
    {
        return true;
    }
    false
}

fn should_exclude(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|entry| entry.to_str())
        .unwrap_or("");
    is_secret_name(name)
}

fn collect_workspace_entries(
    workspace_root: &Path,
) -> Result<(Vec<(PathBuf, String)>, Vec<String>), String> {
    let mut entries: Vec<(PathBuf, String)> = Vec::new();
    let mut excluded: Vec<String> = Vec::new();

    let config_path = workspace_root.join("opencode.json");
    if config_path.exists() && config_path.is_file() {
        if should_exclude(&config_path) {
            excluded.push("opencode.json".to_string());
        } else {
            entries.push((config_path, "opencode.json".to_string()));
        }
    }

    let opencode_dir = workspace_root.join(".opencode");
    if opencode_dir.exists() {
        for entry in WalkDir::new(&opencode_dir) {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().is_file() {
                continue;
            }
            let absolute = entry.path().to_path_buf();
            let rel = absolute
                .strip_prefix(workspace_root)
                .map_err(|e| format!("Failed to compute relative path: {e}"))?;
            let rel_str = normalize_zip_path(rel);
            if should_exclude(&absolute) {
                if !excluded.contains(&rel_str) {
                    excluded.push(rel_str);
                }
                continue;
            }
            entries.push((absolute, rel_str));
        }
    }

    Ok((entries, excluded))
}

#[tauri::command]
pub fn workspace_export_config(
    app: tauri::AppHandle,
    workspace_id: String,
    output_path: String,
) -> Result<WorkspaceExportSummary, String> {
    let workspace_id = workspace_id.trim().to_string();
    if workspace_id.is_empty() {
        return Err("workspaceId is required".to_string());
    }
    let output_path = output_path.trim().to_string();
    if output_path.is_empty() {
        return Err("outputPath is required".to_string());
    }

    let state = load_workspace_state(&app)?;
    let workspace = state
        .workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| "Unknown workspaceId".to_string())?;

    if workspace.workspace_type != WorkspaceType::Local {
        return Err("Workspace export is only supported for local workspaces".to_string());
    }

    let workspace_root = PathBuf::from(&workspace.path);
    if !workspace_root.exists() {
        return Err(format!(
            "Workspace path not found: {}",
            workspace_root.display()
        ));
    }

    let output_path = PathBuf::from(&output_path);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create export folder {}: {e}", parent.display()))?;
    }

    let (entries, excluded_paths) = collect_workspace_entries(&workspace_root)?;
    if entries.is_empty() {
        return Err("No workspace config files found to export".to_string());
    }

    let file = fs::File::create(&output_path)
        .map_err(|e| format!("Failed to create {}: {e}", output_path.display()))?;
    let mut zip = ZipWriter::new(file);
    let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut included_paths: Vec<String> = Vec::new();

    for (src, rel) in entries {
        let mut input =
            fs::File::open(&src).map_err(|e| format!("Failed to read {}: {e}", src.display()))?;
        zip.start_file(rel.clone(), options)
            .map_err(|e| format!("Failed to add {}: {e}", rel))?;
        let mut buffer = Vec::new();
        input
            .read_to_end(&mut buffer)
            .map_err(|e| format!("Failed to read {}: {e}", src.display()))?;
        if rel == "opencode.json" {
            buffer = redact_exported_opencode_config(&buffer)?;
        }
        zip.write_all(&buffer)
            .map_err(|e| format!("Failed to write {}: {e}", src.display()))?;
        included_paths.push(rel);
    }

    let included_count = included_paths.len();
    let excluded_summary = excluded_paths.clone();
    let manifest = serde_json::json!({
        "version": 1,
        "createdAtMs": now_ms(),
        "workspace": {
            "id": workspace.id.clone(),
            "name": workspace.name.clone(),
            "path": workspace.path.clone()
        },
        "included": included_paths,
        "excluded": excluded_paths,
    });
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    zip.start_file("manifest.json", options)
        .map_err(|e| format!("Failed to add manifest: {e}"))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("Failed to write manifest: {e}"))?;

    zip.finish()
        .map_err(|e| format!("Failed to finalize export: {e}"))?;

    Ok(WorkspaceExportSummary {
        output_path: output_path.to_string_lossy().to_string(),
        included: included_count,
        excluded: excluded_summary,
    })
}

#[tauri::command]
pub fn workspace_import_config(
    app: tauri::AppHandle,
    archive_path: String,
    target_dir: String,
    name: Option<String>,
    watch_state: State<WorkspaceWatchState>,
) -> Result<WorkspaceList, String> {
    let archive_path = archive_path.trim().to_string();
    if archive_path.is_empty() {
        return Err("archivePath is required".to_string());
    }
    let target_dir = target_dir.trim().to_string();
    if target_dir.is_empty() {
        return Err("targetDir is required".to_string());
    }

    let target_path = PathBuf::from(&target_dir);
    if target_path.exists() {
        let mut entries = fs::read_dir(&target_path)
            .map_err(|e| format!("Failed to read {}: {e}", target_path.display()))?;
        if entries.next().is_some() {
            return Err("Target folder must be empty".to_string());
        }
    }

    fs::create_dir_all(&target_path)
        .map_err(|e| format!("Failed to create {}: {e}", target_path.display()))?;

    let file = fs::File::open(&archive_path)
        .map_err(|e| format!("Failed to open {}: {e}", archive_path))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Failed to read archive: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        if name == "manifest.json" {
            continue;
        }
        let entry_path = Path::new(&name);
        if entry_path.components().any(|component| match component {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => true,
            _ => false,
        }) {
            return Err("Archive contains an unsafe path".to_string());
        }
        if !(name == "opencode.json" || name.starts_with(".opencode/")) {
            continue;
        }
        if let Some(file_name) = entry_path.file_name().and_then(|entry| entry.to_str()) {
            if is_secret_name(file_name) {
                continue;
            }
        }
        let out_path = target_path.join(Path::new(&name));
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }
        if entry.name().ends_with('/') {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create {}: {e}", out_path.display()))?;
            continue;
        }
        let mut buffer = Vec::new();
        entry
            .read_to_end(&mut buffer)
            .map_err(|e| format!("Failed to read archive entry: {e}"))?;
        fs::write(&out_path, buffer)
            .map_err(|e| format!("Failed to write {}: {e}", out_path.display()))?;
    }

    let opencode_dir = target_path.join(".opencode");
    if !opencode_dir.exists() {
        return Err("Archive is missing .opencode config".to_string());
    }

    let veslo_path = target_path.join(".opencode").join("veslo.json");
    let mut preset = "starter".to_string();
    let mut workspace_name = name.clone().filter(|value| !value.trim().is_empty());

    if veslo_path.exists() {
        let raw = fs::read_to_string(&veslo_path)
            .map_err(|e| format!("Failed to read {}: {e}", veslo_path.display()))?;
        if let Ok(mut config) = serde_json::from_str::<WorkspaceVesloConfig>(&raw) {
            config.authorized_roots = vec![target_dir.clone()];
            if let Some(workspace) = &config.workspace {
                if workspace_name.is_none() {
                    workspace_name = workspace
                        .name
                        .clone()
                        .filter(|value| !value.trim().is_empty());
                }
                if let Some(next_preset) = &workspace.preset {
                    if !next_preset.trim().is_empty() {
                        preset = next_preset.clone();
                    }
                }
            }
            fs::write(
                &veslo_path,
                serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
            )
            .map_err(|e| format!("Failed to write {}: {e}", veslo_path.display()))?;
        }
    } else {
        let config = WorkspaceVesloConfig::new(&target_dir, &preset, now_ms());
        if let Some(parent) = veslo_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }
        fs::write(
            &veslo_path,
            serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("Failed to write {}: {e}", veslo_path.display()))?;
    }

    let name = workspace_name
        .unwrap_or_else(|| {
            target_path
                .file_name()
                .and_then(|entry| entry.to_str())
                .unwrap_or("Workspace")
                .to_string()
        })
        .trim()
        .to_string();

    let id = stable_workspace_id(&target_dir);

    let mut state = load_workspace_state(&app)?;
    upsert_workspace(
        &mut state.workspaces,
        WorkspaceInfo {
            id: id.clone(),
            name,
            path: target_dir.clone(),
            preset,
            workspace_type: WorkspaceType::Local,
            remote_type: None,
            base_url: None,
            directory: None,
            display_name: None,
            veslo_host_url: None,
            veslo_token: None,
            veslo_workspace_id: None,
            veslo_workspace_name: None,
        },
    );
    state.active_id = id.clone();
    save_workspace_state(&app, &state)?;

    let active_workspace = state.workspaces.iter().find(|w| w.id == state.active_id);
    update_workspace_watch(&app, watch_state, active_workspace)?;

    Ok(WorkspaceList {
        active_id: state.active_id,
        workspaces: state.workspaces,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn local_workspace(id: &str, path: &str) -> WorkspaceInfo {
        WorkspaceInfo {
            id: id.to_string(),
            name: id.to_string(),
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

    fn temp_workspace_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("veslo-workspace-forget-{name}-{nonce}"));
        fs::create_dir_all(root.join(".opencode")).expect("create .opencode");
        fs::write(root.join("opencode.jsonc"), "{}").expect("create opencode.jsonc");
        root
    }

    #[test]
    fn workspace_forget_default_keeps_local_files() {
        let root = temp_workspace_root("detach");
        cleanup_workspace_local_state(&root, WorkspaceForgetMode::DetachOnly);
        assert!(
            root.join(".opencode").is_dir(),
            ".opencode should remain for detach"
        );
        assert!(
            root.join("opencode.jsonc").is_file(),
            "opencode.jsonc should remain for detach"
        );
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn workspace_forget_delete_local_data_removes_local_files() {
        let root = temp_workspace_root("delete");
        cleanup_workspace_local_state(&root, WorkspaceForgetMode::DeleteLocalData);
        assert!(
            !root.join(".opencode").exists(),
            ".opencode should be removed for destructive mode"
        );
        assert!(
            !root.join("opencode.jsonc").exists(),
            "opencode.jsonc should be removed for destructive mode"
        );
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn upsert_workspace_puts_new_workspace_first() {
        let mut workspaces = vec![
            local_workspace("ws-a", "/tmp/a"),
            local_workspace("ws-b", "/tmp/b"),
        ];

        upsert_workspace(&mut workspaces, local_workspace("ws-c", "/tmp/c"));

        let ids = workspaces
            .iter()
            .map(|workspace| workspace.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["ws-c", "ws-a", "ws-b"]);
    }

    #[test]
    fn upsert_workspace_moves_existing_workspace_to_front() {
        let mut workspaces = vec![
            local_workspace("ws-a", "/tmp/a"),
            local_workspace("ws-b", "/tmp/b"),
        ];

        upsert_workspace(&mut workspaces, local_workspace("ws-a", "/tmp/a-renamed"));

        let ids = workspaces
            .iter()
            .map(|workspace| workspace.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["ws-a", "ws-b"]);
        assert_eq!(workspaces[0].path, "/tmp/a-renamed");
    }

    #[test]
    fn set_active_workspace_promotes_active_workspace_to_front_when_requested() {
        let mut state = WorkspaceState {
            version: 4,
            active_id: "ws-a".to_string(),
            workspaces: vec![
                local_workspace("ws-a", "/tmp/a"),
                local_workspace("ws-b", "/tmp/b"),
                local_workspace("ws-c", "/tmp/c"),
            ],
        };

        set_active_workspace(&mut state, "ws-c", true).expect("workspace should activate");

        assert_eq!(state.active_id, "ws-c");
        let ids = state
            .workspaces
            .iter()
            .map(|workspace| workspace.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["ws-c", "ws-a", "ws-b"]);
    }

    #[test]
    fn set_active_workspace_keeps_order_when_promotion_is_disabled() {
        let mut state = WorkspaceState {
            version: 4,
            active_id: "ws-a".to_string(),
            workspaces: vec![
                local_workspace("ws-a", "/tmp/a"),
                local_workspace("ws-b", "/tmp/b"),
                local_workspace("ws-c", "/tmp/c"),
            ],
        };

        set_active_workspace(&mut state, "ws-c", false).expect("workspace should activate");

        assert_eq!(state.active_id, "ws-c");
        let ids = state
            .workspaces
            .iter()
            .map(|workspace| workspace.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["ws-a", "ws-b", "ws-c"]);
    }

    #[test]
    fn redact_exported_opencode_config_hides_gateway_tokens() {
        let redacted = redact_exported_opencode_config(
            br#"{
              "provider": {
                "openai": {
                  "models": {
                    "gpt-4o-mini": {
                      "headers": {
                        "x-veslo-gateway-token": "gateway-access-token",
                        "x-veslo-session-id": "${OPENCODE_SESSION_ID}",
                        "x-extra": "keep-me"
                      }
                    }
                  }
                }
              }
            }"#,
        )
        .expect("redact opencode config");

        let parsed: serde_json::Value =
            serde_json::from_slice(&redacted).expect("parse redacted config");

        assert_eq!(
            parsed["provider"]["openai"]["models"]["gpt-4o-mini"]["headers"]["x-veslo-gateway-token"],
            "[REDACTED]"
        );
        assert_eq!(
            parsed["provider"]["openai"]["models"]["gpt-4o-mini"]["headers"]["x-veslo-session-id"],
            "${OPENCODE_SESSION_ID}"
        );
        assert_eq!(
            parsed["provider"]["openai"]["models"]["gpt-4o-mini"]["headers"]["x-extra"],
            "keep-me"
        );
    }
}
