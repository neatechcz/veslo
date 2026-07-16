use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const RUNTIME_PREFERENCES_FILE: &str = "runtime-preferences.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimePreferences {
    pub shared_unsandboxed_engine: bool,
    pub support_diagnostics: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PersistedRuntimePreferences {
    #[serde(default)]
    shared_unsandboxed_engine: Option<bool>,
    #[serde(default)]
    support_diagnostics: Option<bool>,
}

impl Default for DesktopRuntimePreferences {
    fn default() -> Self {
        Self {
            shared_unsandboxed_engine: default_shared_unsandboxed_engine_enabled(),
            support_diagnostics: false,
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

fn support_diagnostics_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to resolve app log directory: {e}"))?
        .join("support-diagnostics");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    Ok(dir)
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

fn support_diagnostics_from_env() -> bool {
    env_flag_enabled(std::env::var("VESLO_RUNTIME_DIAGNOSTICS").ok())
}

fn read_persisted_runtime_preferences(
    app: &AppHandle,
) -> Result<Option<PersistedRuntimePreferences>, String> {
    let path = runtime_preferences_path(app)?;
    if !path.exists() {
        return Ok(None);
    }

    let payload =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&payload)
        .map(Some)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

pub fn read_shared_unsandboxed_engine_override(app: &AppHandle) -> Result<Option<bool>, String> {
    Ok(resolve_shared_unsandboxed_engine_override(
        read_persisted_runtime_preferences(app)?
            .and_then(|preferences| preferences.shared_unsandboxed_engine),
    ))
}

pub fn read_support_diagnostics_override(app: &AppHandle) -> Result<Option<bool>, String> {
    Ok(read_persisted_runtime_preferences(app)?
        .and_then(|preferences| preferences.support_diagnostics))
}

pub fn read_runtime_preferences(app: &AppHandle) -> Result<DesktopRuntimePreferences, String> {
    let persisted = read_persisted_runtime_preferences(app)?;
    Ok(DesktopRuntimePreferences {
        shared_unsandboxed_engine: resolve_shared_unsandboxed_engine_override(
            persisted
                .as_ref()
                .and_then(|preferences| preferences.shared_unsandboxed_engine),
        )
        .unwrap_or_else(shared_unsandboxed_engine_from_env),
        support_diagnostics: persisted
            .and_then(|preferences| preferences.support_diagnostics)
            .unwrap_or_else(support_diagnostics_from_env),
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
        support_diagnostics: Some(preferences.support_diagnostics),
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

pub fn runtime_diagnostics_enabled(app: &AppHandle) -> Result<bool, String> {
    if pilot_runtime_diagnostics_enabled() {
        return Ok(true);
    }
    Ok(read_runtime_preferences(app)?.support_diagnostics)
}

pub fn runtime_diagnostics_env_overrides(app: &AppHandle) -> Result<Vec<(String, String)>, String> {
    if let Some(dir) = pilot_diagnostics_dir_from_env() {
        return Ok(runtime_diagnostics_env_overrides_for_dir(&dir));
    }

    let preference = read_support_diagnostics_override(app)?;
    let mut overrides = runtime_diagnostics_env_overrides_from_override(preference);
    if preference == Some(true) {
        let dir = support_diagnostics_dir(app)?;
        overrides.extend([
            (
                "VESLO_RUNTIME_TRACE_DIR".to_string(),
                dir.to_string_lossy().to_string(),
            ),
            (
                "VESLO_SEND_WORKFLOW_TRACE_SERVER_FILE".to_string(),
                dir.join("send-workflow-trace.server.ndjson")
                    .to_string_lossy()
                    .to_string(),
            ),
            (
                "VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_FILE".to_string(),
                dir.join("send-workflow-trace.orchestrator.ndjson")
                    .to_string_lossy()
                    .to_string(),
            ),
            (
                "VESLO_OPENCODE_HEALTH_DIAG_FILE".to_string(),
                dir.join("opencode-health.ndjson")
                    .to_string_lossy()
                    .to_string(),
            ),
        ]);
    }
    Ok(overrides)
}

pub fn pilot_runtime_diagnostics_enabled() -> bool {
    pilot_diagnostics_dir_from_env().is_some()
}

fn pilot_diagnostics_dir_from_env() -> Option<PathBuf> {
    let dir =
        pilot_diagnostics_dir_from_value(std::env::var("TAURI_PILOT_LOG_DIR").ok().as_deref())?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn pilot_diagnostics_dir_from_value(value: Option<&str>) -> Option<PathBuf> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    let dir = PathBuf::from(raw);
    dir.is_absolute().then_some(dir)
}

fn runtime_diagnostics_env_overrides_for_dir(dir: &Path) -> Vec<(String, String)> {
    let dir = dir.to_string_lossy().to_string();
    let trace_dir = Path::new(&dir);
    let server_file = trace_dir
        .join("send-workflow-trace.server.ndjson")
        .to_string_lossy()
        .to_string();
    let orchestrator_file = trace_dir
        .join("send-workflow-trace.orchestrator.ndjson")
        .to_string_lossy()
        .to_string();
    let health_file = trace_dir
        .join("opencode-health.ndjson")
        .to_string_lossy()
        .to_string();
    vec![
        ("VESLO_RUNTIME_DIAGNOSTICS".to_string(), "1".to_string()),
        ("VESLO_RUNTIME_TRACE".to_string(), "1".to_string()),
        ("VESLO_RUNTIME_TRACE_DIR".to_string(), dir),
        ("VESLO_SEND_WORKFLOW_TRACE".to_string(), "1".to_string()),
        (
            "VESLO_SEND_WORKFLOW_TRACE_SERVER_FILE".to_string(),
            server_file,
        ),
        (
            "VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_FILE".to_string(),
            orchestrator_file,
        ),
        ("VESLO_OPENCODE_HEALTH_DIAG".to_string(), "1".to_string()),
        ("VESLO_OPENCODE_HEALTH_DIAG_FILE".to_string(), health_file),
    ]
}

fn runtime_diagnostics_env_overrides_from_override(
    preference: Option<bool>,
) -> Vec<(String, String)> {
    match preference {
        Some(true) => vec![
            ("VESLO_RUNTIME_DIAGNOSTICS".to_string(), "1".to_string()),
            ("VESLO_RUNTIME_TRACE".to_string(), "1".to_string()),
            ("VESLO_SEND_WORKFLOW_TRACE".to_string(), "1".to_string()),
            ("VESLO_OPENCODE_HEALTH_DIAG".to_string(), "1".to_string()),
        ],
        Some(false) => vec![("VESLO_RUNTIME_DIAGNOSTICS".to_string(), "0".to_string())],
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
        default_shared_unsandboxed_engine_override, pilot_diagnostics_dir_from_value,
        resolve_shared_unsandboxed_engine_override, runtime_diagnostics_env_overrides_for_dir,
        runtime_diagnostics_env_overrides_from_override, runtime_preferences_path_for_dir,
        shared_unsandboxed_engine_env_overrides, DesktopRuntimePreferences,
    };
    use std::path::PathBuf;

    #[test]
    fn default_runtime_preference_uses_desktop_shared_engine_policy() {
        assert_eq!(
            DesktopRuntimePreferences::default().shared_unsandboxed_engine,
            cfg!(any(windows, target_os = "macos"))
        );
        assert!(!DesktopRuntimePreferences::default().support_diagnostics);
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
    fn support_diagnostics_preference_controls_child_diagnostics_env() {
        let enabled = runtime_diagnostics_env_overrides_from_override(Some(true));
        assert!(enabled
            .iter()
            .any(|(key, value)| key == "VESLO_RUNTIME_DIAGNOSTICS" && value == "1"));
        assert!(enabled
            .iter()
            .any(|(key, value)| key == "VESLO_RUNTIME_TRACE" && value == "1"));
        assert!(enabled
            .iter()
            .any(|(key, value)| key == "VESLO_SEND_WORKFLOW_TRACE" && value == "1"));
        assert!(enabled
            .iter()
            .any(|(key, value)| key == "VESLO_OPENCODE_HEALTH_DIAG" && value == "1"));

        assert_eq!(
            runtime_diagnostics_env_overrides_from_override(Some(false)),
            vec![("VESLO_RUNTIME_DIAGNOSTICS".to_string(), "0".to_string())]
        );
        assert!(runtime_diagnostics_env_overrides_from_override(None).is_empty());
    }

    #[test]
    fn pilot_diagnostics_override_uses_the_explicit_pilot_trace_directory() {
        let trace_dir = std::env::temp_dir().join("veslo-pilot-trace");
        let trace_dir_text = trace_dir.to_string_lossy().to_string();
        let server_file = trace_dir
            .join("send-workflow-trace.server.ndjson")
            .to_string_lossy()
            .to_string();
        let orchestrator_file = trace_dir
            .join("send-workflow-trace.orchestrator.ndjson")
            .to_string_lossy()
            .to_string();
        let health_file = trace_dir
            .join("opencode-health.ndjson")
            .to_string_lossy()
            .to_string();
        let resolved = pilot_diagnostics_dir_from_value(trace_dir.to_str())
            .expect("an absolute trace directory should be accepted");
        let overrides = runtime_diagnostics_env_overrides_for_dir(&resolved);

        assert!(overrides
            .iter()
            .any(|(key, value)| { key == "VESLO_RUNTIME_DIAGNOSTICS" && value == "1" }));
        assert!(overrides
            .iter()
            .any(|(key, value)| { key == "VESLO_RUNTIME_TRACE_DIR" && value == &trace_dir_text }));
        assert!(overrides.iter().any(|(key, value)| {
            key == "VESLO_SEND_WORKFLOW_TRACE_SERVER_FILE" && value == &server_file
        }));
        assert!(overrides.iter().any(|(key, value)| {
            key == "VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_FILE" && value == &orchestrator_file
        }));
        assert!(overrides.iter().any(|(key, value)| {
            key == "VESLO_OPENCODE_HEALTH_DIAG_FILE" && value == &health_file
        }));
        assert!(pilot_diagnostics_dir_from_value(Some("relative/pilot-trace")).is_none());
        assert!(pilot_diagnostics_dir_from_value(Some("   ")).is_none());
    }

    #[test]
    fn runtime_preferences_path_uses_supplied_config_dir() {
        assert_eq!(
            runtime_preferences_path_for_dir(PathBuf::from("C:\\veslo\\config")),
            PathBuf::from("C:\\veslo\\config").join("runtime-preferences.json")
        );
    }
}
