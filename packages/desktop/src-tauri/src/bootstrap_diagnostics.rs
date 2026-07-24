use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::debug_logs_forwarder::DebugLogsForwarder;
use crate::user_diagnostic_capture::UserDiagnosticCaptureStatus;

fn with_forwarder(app: &AppHandle, action: impl FnOnce(&DebugLogsForwarder)) {
    if let Some(forwarder) = app.try_state::<Arc<DebugLogsForwarder>>() {
        action(forwarder.inner().as_ref());
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn record_bootstrap_diagnostic(
    app: AppHandle,
    event_type: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    let forwarder = app
        .try_state::<Arc<DebugLogsForwarder>>()
        .ok_or_else(|| "desktop diagnostics forwarder is unavailable".to_string())?;
    forwarder
        .inner()
        .as_ref()
        .append_bootstrap_diagnostic(&event_type, payload)
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_bootstrap_diagnostics_cloud_context(
    app: AppHandle,
    den_api_base: String,
    token: String,
    user_id: String,
    org_id: String,
    workspace_id: Option<String>,
) {
    with_forwarder(&app, |forwarder| {
        forwarder.set_cloud_diagnostics_context(den_api_base, token, user_id, org_id, workspace_id);
    });
}

#[tauri::command]
pub fn clear_bootstrap_diagnostics_cloud_context(app: AppHandle) {
    with_forwarder(&app, |forwarder| {
        forwarder.clear_cloud_diagnostics_context();
    });
}

#[tauri::command]
pub fn user_diagnostic_capture_status(
    app: AppHandle,
) -> Result<UserDiagnosticCaptureStatus, String> {
    let forwarder = app.try_state::<Arc<DebugLogsForwarder>>().ok_or_else(|| {
        eprintln!(
            "[user-diagnostic-capture] status requested but debug logs forwarder is unavailable"
        );
        "desktop diagnostics forwarder is unavailable".to_string()
    })?;
    Ok(forwarder.inner().as_ref().user_diagnostic_capture_status())
}

#[tauri::command]
pub fn start_user_diagnostic_capture(
    app: AppHandle,
) -> Result<UserDiagnosticCaptureStatus, String> {
    let forwarder = app
        .try_state::<Arc<DebugLogsForwarder>>()
        .ok_or_else(|| "desktop diagnostics forwarder is unavailable".to_string())?;
    forwarder.inner().as_ref().start_user_diagnostic_capture()
}

#[tauri::command]
pub fn stop_user_diagnostic_capture(app: AppHandle) -> Result<UserDiagnosticCaptureStatus, String> {
    let forwarder = app
        .try_state::<Arc<DebugLogsForwarder>>()
        .ok_or_else(|| "desktop diagnostics forwarder is unavailable".to_string())?;
    Ok(forwarder.inner().as_ref().stop_user_diagnostic_capture())
}
