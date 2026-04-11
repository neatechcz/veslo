use tauri::{AppHandle, State};

use crate::engine::manager::EngineManager;
use crate::opencode_router::manager::OpenCodeRouterManager;
use crate::veslo_server::manager::VesloServerManager;
use crate::veslo_server::{
    clear_persisted_veslo_server_info, recover_persisted_veslo_server_info, server_health_ok,
    start_veslo_server,
};
use crate::types::VesloServerInfo;
use crate::utils::truncate_output;

fn sanitize_live_info_with_health(
    mut info: VesloServerInfo,
    health_check: impl Fn(&str) -> bool,
) -> (VesloServerInfo, bool) {
    if !info.running {
        return (info, false);
    }

    let base_url = info.base_url.clone().unwrap_or_default();
    if !base_url.trim().is_empty() && health_check(&base_url) {
        return (info, false);
    }

    let label = if base_url.trim().is_empty() {
        "the recorded host".to_string()
    } else {
        base_url
    };

    info.running = false;
    info.base_url = None;
    info.connect_url = None;
    info.mdns_url = None;
    info.lan_url = None;
    info.client_token = None;
    info.host_token = None;
    info.pid = None;
    info.last_stderr = Some(truncate_output(
        &format!("Veslo server on {label} is no longer responding."),
        8000,
    ));

    (info, true)
}

#[tauri::command]
pub fn veslo_server_info(app: AppHandle, manager: State<VesloServerManager>) -> VesloServerInfo {
    {
        let mut state = manager
            .inner
            .lock()
            .expect("veslo server mutex poisoned");
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
            let mut state = manager
                .inner
                .lock()
                .expect("veslo server mutex poisoned");
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
    let (workspace_path, opencode_url, opencode_username, opencode_password) = {
        let engine = engine_manager
            .inner
            .lock()
            .map_err(|_| "engine mutex poisoned".to_string())?;
        (
            engine
                .project_dir
                .clone()
                .ok_or_else(|| "No active local workspace available".to_string())?,
            engine.base_url.clone(),
            engine.opencode_username.clone(),
            engine.opencode_password.clone(),
        )
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
    use super::sanitize_live_info_with_health;
    use crate::types::VesloServerInfo;

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
    fn sanitize_live_info_with_health_drops_stale_connection_details_when_health_fails() {
        let info = sample_live_info();
        let (sanitized, stale) = sanitize_live_info_with_health(info, |_| false);
        assert!(stale);
        assert!(!sanitized.running);
        assert_eq!(sanitized.base_url, None);
        assert_eq!(sanitized.connect_url, None);
        assert_eq!(sanitized.mdns_url, None);
        assert_eq!(sanitized.lan_url, None);
        assert_eq!(sanitized.client_token, None);
        assert_eq!(sanitized.host_token, None);
        assert_eq!(sanitized.pid, None);
        assert!(sanitized
            .last_stderr
            .as_deref()
            .unwrap_or_default()
            .contains("no longer responding"));
    }
}
