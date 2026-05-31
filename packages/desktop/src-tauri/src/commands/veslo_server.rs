use tauri::{AppHandle, State};

use crate::engine::manager::EngineManager;
use crate::opencode_router::manager::OpenCodeRouterManager;
use crate::types::{VesloServerInfo, WorkspaceState, WorkspaceType};
use crate::veslo_server::manager::VesloServerManager;
use crate::veslo_server::{
    clear_persisted_veslo_server_info, recover_persisted_veslo_server_info, server_health_ok,
    start_veslo_server,
};
use crate::workspace::state::load_workspace_state;

fn active_local_workspace_path(state: &WorkspaceState) -> Option<String> {
    state
        .workspaces
        .iter()
        .find(|workspace| {
            workspace.id == state.active_id && workspace.workspace_type == WorkspaceType::Local
        })
        .and_then(|workspace| {
            let path = workspace.path.trim();
            if path.is_empty() {
                None
            } else {
                Some(path.to_string())
            }
        })
}

fn sanitize_live_info_with_health(
    info: VesloServerInfo,
    _health_check: impl Fn(&str) -> bool,
) -> (VesloServerInfo, bool) {
    // For the managed child, this command reports process ownership. HTTP
    // health is polled separately by the frontend; using it here turns one
    // transient probe failure into a lost token/PID snapshot and can trigger
    // a restart loop for an otherwise live sidecar.
    (info, false)
}

#[tauri::command]
pub fn veslo_server_info(app: AppHandle, manager: State<VesloServerManager>) -> VesloServerInfo {
    {
        let mut state = manager.inner.lock().expect("veslo server mutex poisoned");
        let info = VesloServerManager::snapshot_locked(&mut state);
        let (sanitized, stale) = sanitize_live_info_with_health(info, server_health_ok);
        if sanitized.running {
            return sanitized;
        }
        if stale {
            let _ = clear_persisted_veslo_server_info(&app);
            return sanitized;
        }
    }

    match recover_persisted_veslo_server_info(&app) {
        Ok(Some(info)) => info,
        Ok(None) | Err(_) => {
            let mut state = manager.inner.lock().expect("veslo server mutex poisoned");
            VesloServerManager::snapshot_locked(&mut state)
        }
    }
}

#[tauri::command]
pub fn veslo_server_restart(
    app: AppHandle,
    manager: State<VesloServerManager>,
    engine_manager: State<EngineManager>,
    opencode_router_manager: State<OpenCodeRouterManager>,
) -> Result<VesloServerInfo, String> {
    let (
        engine_workspace_path,
        engine_opencode_url,
        engine_opencode_username,
        engine_opencode_password,
    ) = {
        let engine = engine_manager
            .inner
            .lock()
            .map_err(|_| "engine mutex poisoned".to_string())?;
        (
            engine.project_dir.clone(),
            engine.base_url.clone(),
            engine.opencode_username.clone(),
            engine.opencode_password.clone(),
        )
    };

    let engine_workspace_path = engine_workspace_path
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());
    let workspace_path = match engine_workspace_path {
        Some(path) => path,
        None => {
            let workspace_state = load_workspace_state(&app)?;
            active_local_workspace_path(&workspace_state)
                .ok_or_else(|| "No active local workspace available".to_string())?
        }
    };

    let engine_attached = engine_opencode_url
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    let opencode_url = if engine_attached {
        engine_opencode_url
    } else {
        None
    };
    let opencode_username = if engine_attached {
        engine_opencode_username
    } else {
        None
    };
    let opencode_password = if engine_attached {
        engine_opencode_password
    } else {
        None
    };

    let opencode_router_health_port = opencode_router_manager
        .inner
        .lock()
        .ok()
        .and_then(|state| state.health_port);

    start_veslo_server(
        &app,
        &manager,
        &[workspace_path],
        opencode_url.as_deref(),
        opencode_username.as_deref(),
        opencode_password.as_deref(),
        opencode_router_health_port,
    )
}

#[cfg(test)]
mod tests {
    use super::{active_local_workspace_path, sanitize_live_info_with_health};
    use crate::types::{
        RemoteType, VesloServerInfo, WorkspaceInfo, WorkspaceState, WorkspaceType,
        WORKSPACE_STATE_VERSION,
    };

    fn workspace(id: &str, path: &str, workspace_type: WorkspaceType) -> WorkspaceInfo {
        WorkspaceInfo {
            id: id.to_string(),
            name: id.to_string(),
            path: path.to_string(),
            preset: "starter".to_string(),
            workspace_type,
            remote_type: Some(RemoteType::Opencode),
            base_url: None,
            directory: None,
            display_name: None,
            veslo_host_url: None,
            veslo_token: None,
            veslo_workspace_id: None,
            veslo_workspace_name: None,
            sandbox_backend: None,
            sandbox_run_id: None,
            sandbox_container_name: None,
        }
    }

    #[test]
    fn active_local_workspace_path_selects_active_local_workspace() {
        let state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: "ws-local".to_string(),
            workspaces: vec![
                workspace("ws-remote", "https://example.test", WorkspaceType::Remote),
                workspace("ws-local", "C:\\workspaces\\private", WorkspaceType::Local),
            ],
        };

        assert_eq!(
            active_local_workspace_path(&state).as_deref(),
            Some("C:\\workspaces\\private")
        );
    }

    fn sample_live_info() -> VesloServerInfo {
        VesloServerInfo {
            running: true,
            host: Some("0.0.0.0".to_string()),
            port: Some(8787),
            base_url: Some("http://127.0.0.1:8787".to_string()),
            connect_url: Some("http://192.168.0.10:8787".to_string()),
            mdns_url: Some("http://veslo.local:8787".to_string()),
            lan_url: Some("http://192.168.0.10:8787".to_string()),
            client_token: Some("client-token".to_string()),
            host_token: Some("host-token".to_string()),
            pid: Some(12345),
            last_stdout: None,
            last_stderr: None,
        }
    }

    #[test]
    fn sanitize_live_info_with_health_keeps_a_live_server_snapshot() {
        let info = sample_live_info();
        let (sanitized, stale) = sanitize_live_info_with_health(info.clone(), |_| true);
        assert!(!stale);
        assert!(sanitized.running);
        assert_eq!(sanitized.base_url, info.base_url);
        assert_eq!(sanitized.client_token, info.client_token);
    }

    #[test]
    fn sanitize_live_info_with_health_preserves_live_child_when_health_fails() {
        let info = sample_live_info();
        let (sanitized, stale) = sanitize_live_info_with_health(info.clone(), |_| false);
        assert!(!stale);
        assert!(sanitized.running);
        assert_eq!(sanitized.base_url, info.base_url);
        assert_eq!(sanitized.connect_url, info.connect_url);
        assert_eq!(sanitized.mdns_url, info.mdns_url);
        assert_eq!(sanitized.lan_url, info.lan_url);
        assert_eq!(sanitized.client_token, info.client_token);
        assert_eq!(sanitized.host_token, info.host_token);
        assert_eq!(sanitized.pid, info.pid);
    }
}
