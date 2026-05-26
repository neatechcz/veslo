use crate::config::{read_opencode_config as read_inner, write_opencode_config as write_inner};
use crate::types::{ExecResult, OpencodeConfigFile};
use crate::workspace::validation::{validate_workspace_path, ValidationMode};

fn resolve_project_dir(
    app: &tauri::AppHandle,
    scope: &str,
    project_dir: String,
) -> Result<String, String> {
    // The `global` scope writes to XDG_CONFIG_HOME, not a workspace — skip path validation.
    if scope == "global" {
        return Ok(project_dir);
    }
    let canonical =
        validate_workspace_path(app, &project_dir, ValidationMode::IsRegisteredWorkspace)?;
    Ok(canonical.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_opencode_config(
    app: tauri::AppHandle,
    scope: String,
    project_dir: String,
) -> Result<OpencodeConfigFile, String> {
    let scope = scope.trim().to_string();
    let project_dir = resolve_project_dir(&app, &scope, project_dir)?;
    read_inner(&scope, &project_dir)
}

#[tauri::command]
pub fn write_opencode_config(
    app: tauri::AppHandle,
    scope: String,
    project_dir: String,
    content: String,
) -> Result<ExecResult, String> {
    let scope = scope.trim().to_string();
    let project_dir = resolve_project_dir(&app, &scope, project_dir)?;
    write_inner(&scope, &project_dir, &content)
}
