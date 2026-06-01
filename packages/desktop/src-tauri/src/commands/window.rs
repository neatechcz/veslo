use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager};

/// Set window decorations (titlebar) visibility.
/// When `decorations` is false, the native titlebar is hidden.
/// This is useful for tiling window managers on Linux (e.g., Hyprland, i3, sway).
#[tauri::command]
pub fn set_window_decorations(app: AppHandle, decorations: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    window
        .set_decorations(decorations)
        .map_err(|e| format!("Failed to set decorations: {e}"))
}

#[cfg(all(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn e2e_position_main_window(
    app: AppHandle,
    width: f64,
    height: f64,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    let _ = window.show();
    let _ = window.unminimize();
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| format!("Failed to set E2E window size: {e}"))?;
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| format!("Failed to set E2E window position: {e}"))?;
    let _ = window.set_focus();

    Ok(())
}
