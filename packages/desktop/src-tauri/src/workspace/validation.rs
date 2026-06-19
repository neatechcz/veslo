use std::fs;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::types::WorkspaceVesloConfig;
use crate::workspace::state::load_workspace_state;

/// Validation modes for workspace path arguments coming from IPC commands.
#[derive(Debug, Clone, Copy)]
pub enum ValidationMode {
    /// Path must be inside one of the registered workspaces' `authorized_roots`.
    /// Used for engine spawn (`project_dir`) and operations that touch arbitrary
    /// files inside authorized areas.
    InAuthorizedRoot,
    /// Path must exactly match a registered workspace root.
    /// Used for per-workspace operations: forget, veslo_read/write, add_authorized_root.
    IsRegisteredWorkspace,
    /// Path must not be a system directory.
    /// Used for create operations where the workspace is not yet registered;
    /// the path may not exist yet (we resolve its parent instead).
    NotSystemPath,
}

/// Validate a workspace-related path argument from an IPC command.
/// Returns the canonical absolute path if valid, or a human-readable error.
pub fn validate_workspace_path(
    app: &AppHandle,
    path: &str,
    mode: ValidationMode,
) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path is required".to_string());
    }

    let candidate = PathBuf::from(trimmed);
    if !candidate.is_absolute() {
        return Err("path must be an absolute path".to_string());
    }

    let canonical = canonicalize_existing_or_parent(&candidate, mode)?;

    match mode {
        ValidationMode::InAuthorizedRoot => {
            let roots = load_authorized_roots(app)?;
            for root in roots {
                let Ok(root_canonical) = fs::canonicalize(&root) else {
                    continue;
                };
                if canonical.starts_with(&root_canonical) {
                    return Ok(canonical);
                }
            }
            Err("path is not within an authorized root".to_string())
        }
        ValidationMode::IsRegisteredWorkspace => {
            let state = load_workspace_state(app)?;
            for workspace in state.workspaces {
                let Ok(workspace_canonical) = fs::canonicalize(&workspace.path) else {
                    continue;
                };
                if canonical == workspace_canonical {
                    return Ok(canonical);
                }
            }
            Err("path is not a registered workspace".to_string())
        }
        ValidationMode::NotSystemPath => {
            for prefix in system_path_prefixes() {
                if canonical.starts_with(&prefix) {
                    return Err(format!(
                        "path is a system directory and cannot be used: {}",
                        prefix.display()
                    ));
                }
            }
            Ok(canonical)
        }
    }
}

/// Resolve a path to its canonical form, handling NotSystemPath mode where the
/// path may not exist yet (we canonicalize the parent and re-join the leaf).
fn canonicalize_existing_or_parent(
    candidate: &Path,
    mode: ValidationMode,
) -> Result<PathBuf, String> {
    if candidate.exists() {
        return fs::canonicalize(candidate).map_err(|e| format!("Failed to resolve path: {e}"));
    }

    // For modes that require the path to exist (workspace / authorized root)
    // a missing path is an error.
    if !matches!(mode, ValidationMode::NotSystemPath) {
        return Err(format!("path does not exist: {}", candidate.display()));
    }

    // NotSystemPath: canonicalize the parent and re-join the leaf.
    let parent = candidate
        .parent()
        .ok_or_else(|| "path must have a parent directory".to_string())?;
    if !parent.exists() {
        return Err(format!(
            "parent directory does not exist: {}",
            parent.display()
        ));
    }
    let parent_canonical =
        fs::canonicalize(parent).map_err(|e| format!("Failed to resolve parent: {e}"))?;
    let leaf = candidate
        .file_name()
        .ok_or_else(|| "path must have a final component".to_string())?;
    Ok(parent_canonical.join(leaf))
}

/// Aggregate `authorized_roots` from every registered workspace's `.opencode/veslo.json`.
/// If a workspace has no authorized_roots entry, its own path is treated as the root.
pub fn load_authorized_roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let state = load_workspace_state(app)?;
    let mut roots = Vec::new();

    for workspace in state.workspaces {
        let workspace_path = PathBuf::from(&workspace.path);
        let mut config = read_workspace_veslo_config(&workspace_path)?;

        if config.authorized_roots.is_empty() {
            config.authorized_roots.push(workspace.path.clone());
        }

        for root in config.authorized_roots {
            let trimmed = root.trim();
            if !trimmed.is_empty() {
                roots.push(PathBuf::from(trimmed));
            }
        }
    }

    if roots.is_empty() {
        return Err("No authorized roots configured".to_string());
    }

    Ok(roots)
}

/// Read `.opencode/veslo.json` for a workspace, or return a default config
/// containing the workspace path as the sole authorized root.
pub fn read_workspace_veslo_config(workspace_path: &Path) -> Result<WorkspaceVesloConfig, String> {
    let veslo_path = workspace_path.join(".opencode").join("veslo.json");
    if !veslo_path.exists() {
        let mut cfg = WorkspaceVesloConfig::default();
        let workspace_value = workspace_path.to_string_lossy().to_string();
        if !workspace_value.trim().is_empty() {
            cfg.authorized_roots.push(workspace_value);
        }
        return Ok(cfg);
    }

    let raw = fs::read_to_string(&veslo_path)
        .map_err(|e| format!("Failed to read {}: {e}", veslo_path.display()))?;

    serde_json::from_str::<WorkspaceVesloConfig>(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", veslo_path.display()))
}

/// Backward-compat wrapper for `validate_project_dir` callers.
/// Equivalent to `validate_workspace_path(app, project_dir, InAuthorizedRoot)`.
pub fn validate_project_dir(app: &AppHandle, project_dir: &str) -> Result<PathBuf, String> {
    validate_workspace_path(app, project_dir, ValidationMode::InAuthorizedRoot)
}

#[cfg(target_os = "macos")]
fn system_path_prefixes() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/etc"),
        PathBuf::from("/usr"),
        PathBuf::from("/bin"),
        PathBuf::from("/sbin"),
        PathBuf::from("/var"),
        PathBuf::from("/System"),
        PathBuf::from("/private/etc"),
        PathBuf::from("/private/var/db"),
        PathBuf::from("/Library/Application Support/Apple"),
    ]
}

#[cfg(target_os = "linux")]
fn system_path_prefixes() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/etc"),
        PathBuf::from("/usr"),
        PathBuf::from("/bin"),
        PathBuf::from("/sbin"),
        PathBuf::from("/proc"),
        PathBuf::from("/sys"),
        PathBuf::from("/dev"),
        PathBuf::from("/boot"),
        PathBuf::from("/root"),
    ]
}

#[cfg(target_os = "windows")]
fn system_path_prefixes() -> Vec<PathBuf> {
    vec![
        PathBuf::from(r"C:\Windows"),
        PathBuf::from(r"C:\Program Files"),
        PathBuf::from(r"C:\Program Files (x86)"),
        PathBuf::from(r"C:\ProgramData"),
    ]
}
