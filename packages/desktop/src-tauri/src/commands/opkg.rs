use crate::fs::copy_dir_recursive;
use crate::opkg::opkg_install as opkg_install_inner;
use crate::types::ExecResult;
use crate::workspace::validation::{validate_workspace_path, ValidationMode};

#[tauri::command]
pub fn opkg_install(
    app: tauri::AppHandle,
    project_dir: String,
    package: String,
) -> Result<ExecResult, String> {
    let project_dir =
        validate_workspace_path(&app, &project_dir, ValidationMode::IsRegisteredWorkspace)?
            .to_string_lossy()
            .to_string();

    let package = package.trim().to_string();
    if package.is_empty() {
        return Err("package is required".to_string());
    }

    opkg_install_inner(&project_dir, &package)
}

#[tauri::command]
pub fn import_skill(
    app: tauri::AppHandle,
    project_dir: String,
    source_dir: String,
    overwrite: bool,
) -> Result<ExecResult, String> {
    let project_dir =
        validate_workspace_path(&app, &project_dir, ValidationMode::IsRegisteredWorkspace)?;
    let src = validate_workspace_path(&app, &source_dir, ValidationMode::InAuthorizedRoot)?;

    let name = src
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Failed to infer skill name from directory".to_string())?;

    let dest = project_dir.join(".opencode").join("skills").join(name);

    if dest.exists() {
        if overwrite {
            std::fs::remove_dir_all(&dest).map_err(|e| {
                format!(
                    "Failed to remove existing skill dir {}: {e}",
                    dest.display()
                )
            })?;
        } else {
            return Err(format!("Skill already exists at {}", dest.display()));
        }
    }

    copy_dir_recursive(&src, &dest)?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Imported skill to {}", dest.display()),
        stderr: String::new(),
    })
}
