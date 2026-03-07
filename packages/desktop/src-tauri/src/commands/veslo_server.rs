use tauri::{AppHandle, State};

use crate::engine::manager::EngineManager;
use crate::opencode_router::manager::OpenCodeRouterManager;
use crate::veslo_server::manager::VesloServerManager;
use crate::veslo_server::start_veslo_server;
use crate::types::VesloServerInfo;

#[tauri::command]
pub fn veslo_server_info(manager: State<VesloServerManager>) -> VesloServerInfo {
    let mut state = manager
        .inner
        .lock()
        .expect("veslo server mutex poisoned");
    VesloServerManager::snapshot_locked(&mut state)
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
