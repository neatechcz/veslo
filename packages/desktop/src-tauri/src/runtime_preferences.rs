use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const RUNTIME_PREFERENCES_FILE: &str = "runtime-preferences.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimePreferences {
    pub shared_unsandboxed_engine: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PersistedRuntimePreferences {
    #[serde(default)]
    shared_unsandboxed_engine: Option<bool>,
}

impl Default for DesktopRuntimePreferences {
    fn default() -> Self {
        Self {
            shared_unsandboxed_engine: default_shared_unsandboxed_engine_enabled(),
        }
    }
}

fn default_shared_unsandboxed_engine_enabled() -> bool {
    cfg!(any(windows, target_os = "macos"))
}

fn default_shared_unsandboxed_engine_override() -> Option<bool> {
    if default_shared_unsandboxed_engine_enabled() {
        Some(true)
    } else {
        None
    }
}

fn resolve_shared_unsandboxed_engine_override(persisted: Option<bool>) -> Option<bool> {
    persisted.or_else(default_shared_unsandboxed_engine_override)
}

fn runtime_preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = crate::paths::app_config_dir_override()
        .or_else(|| app.path().app_config_dir().ok())
        .ok_or_else(|| "Failed to resolve app config dir".to_string())?;
    Ok(runtime_preferences_path_for_dir(config_dir))
}

fn runtime_preferences_path_for_dir(config_dir: PathBuf) -> PathBuf {
    config_dir.join(RUNTIME_PREFERENCES_FILE)
}

fn env_flag_enabled(value: Option<String>) -> bool {
    matches!(
        value
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

fn shared_unsandboxed_engine_from_env() -> bool {
    env_flag_enabled(std::env::var("VESLO_DISABLE_SANDBOX").ok())
        && env_flag_enabled(std::env::var("VESLO_SHARED_OPENCODE_ENGINE").ok())
}

pub fn read_shared_unsandboxed_engine_override(app: &AppHandle) -> Result<Option<bool>, String> {
    let path = runtime_preferences_path(app)?;
    if !path.exists() {
        return Ok(resolve_shared_unsandboxed_engine_override(None));
    }

    let payload =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let parsed: PersistedRuntimePreferences = serde_json::from_str(&payload)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;
    Ok(resolve_shared_unsandboxed_engine_override(
        parsed.shared_unsandboxed_engine,
    ))
}

pub fn read_runtime_preferences(app: &AppHandle) -> Result<DesktopRuntimePreferences, String> {
    Ok(DesktopRuntimePreferences {
        shared_unsandboxed_engine: read_shared_unsandboxed_engine_override(app)?
            .unwrap_or_else(shared_unsandboxed_engine_from_env),
    })
}

pub fn write_runtime_preferences(
    app: &AppHandle,
    preferences: DesktopRuntimePreferences,
) -> Result<DesktopRuntimePreferences, String> {
    let path = runtime_preferences_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    let persisted = PersistedRuntimePreferences {
        shared_unsandboxed_engine: Some(preferences.shared_unsandboxed_engine),
    };
    let payload = serde_json::to_string_pretty(&persisted).map_err(|e| e.to_string())?;
    fs::write(&path, format!("{payload}\n"))
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;

    Ok(preferences)
}

pub fn shared_unsandboxed_engine_env_overrides(preference: Option<bool>) -> Vec<(String, String)> {
    match preference {
        Some(true) => vec![
            ("VESLO_DISABLE_SANDBOX".to_string(), "1".to_string()),
            ("VESLO_SHARED_OPENCODE_ENGINE".to_string(), "1".to_string()),
        ],
        Some(false) => vec![
            ("VESLO_DISABLE_SANDBOX".to_string(), "0".to_string()),
            ("VESLO_SHARED_OPENCODE_ENGINE".to_string(), "0".to_string()),
        ],
        None => Vec::new(),
    }
}

#[tauri::command]
pub fn desktop_runtime_preferences_read(
    app: AppHandle,
) -> Result<DesktopRuntimePreferences, String> {
    read_runtime_preferences(&app)
}

#[tauri::command]
pub fn desktop_runtime_preferences_write(
    app: AppHandle,
    preferences: DesktopRuntimePreferences,
) -> Result<DesktopRuntimePreferences, String> {
    write_runtime_preferences(&app, preferences)
}

#[cfg(test)]
mod tests {
    use super::{
        default_shared_unsandboxed_engine_override, resolve_shared_unsandboxed_engine_override,
        runtime_preferences_path_for_dir, shared_unsandboxed_engine_env_overrides,
        DesktopRuntimePreferences,
    };
    use std::path::PathBuf;

    #[test]
    fn default_runtime_preference_uses_desktop_shared_engine_policy() {
        assert_eq!(
            DesktopRuntimePreferences::default().shared_unsandboxed_engine,
            cfg!(any(windows, target_os = "macos"))
        );
        assert_eq!(
            default_shared_unsandboxed_engine_override(),
            if cfg!(any(windows, target_os = "macos")) {
                Some(true)
            } else {
                None
            }
        );
        assert_eq!(
            resolve_shared_unsandboxed_engine_override(None),
            if cfg!(any(windows, target_os = "macos")) {
                Some(true)
            } else {
                None
            }
        );
    }

    #[test]
    fn explicit_runtime_preference_overrides_desktop_shared_engine_policy() {
        assert_eq!(
            resolve_shared_unsandboxed_engine_override(Some(true)),
            Some(true)
        );
        assert_eq!(
            resolve_shared_unsandboxed_engine_override(Some(false)),
            Some(false)
        );
    }

    #[test]
    fn shared_unsandboxed_engine_true_sets_required_env_pair() {
        let env = shared_unsandboxed_engine_env_overrides(Some(true));

        assert!(env
            .iter()
            .any(|(key, value)| key == "VESLO_DISABLE_SANDBOX" && value == "1"));
        assert!(env
            .iter()
            .any(|(key, value)| key == "VESLO_SHARED_OPENCODE_ENGINE" && value == "1"));
    }

    #[test]
    fn shared_unsandboxed_engine_false_explicitly_disables_env_pair() {
        let env = shared_unsandboxed_engine_env_overrides(Some(false));

        assert!(env
            .iter()
            .any(|(key, value)| key == "VESLO_DISABLE_SANDBOX" && value == "0"));
        assert!(env
            .iter()
            .any(|(key, value)| key == "VESLO_SHARED_OPENCODE_ENGINE" && value == "0"));
    }

    #[test]
    fn missing_preference_does_not_override_parent_env() {
        assert!(shared_unsandboxed_engine_env_overrides(None).is_empty());
    }

    #[test]
    fn runtime_preferences_path_uses_supplied_config_dir() {
        assert_eq!(
            runtime_preferences_path_for_dir(PathBuf::from("C:\\veslo\\config")),
            PathBuf::from("C:\\veslo\\config").join("runtime-preferences.json")
        );
    }
}
