use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use crate::engine::doctor::resolve_engine_path;
use crate::engine::manager::EngineManager;
use crate::opencode_router::manager::OpenCodeRouterManager;
use crate::orchestrator;
use crate::orchestrator::manager::OrchestratorManager;
use crate::orchestrator::OrchestratorShutdownAttribution;
use crate::paths::home_dir;
use crate::platform::command_for_program;
use crate::types::ExecResult;
use crate::veslo_server::manager::VesloServerManager;
use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager, State};

static SEND_WORKFLOW_TRACE_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(serde::Serialize)]
pub struct CacheResetResult {
    pub removed: Vec<String>,
    pub missing: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBuildInfo {
    pub version: String,
    pub git_sha: Option<String>,
    pub build_epoch: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSandboxEnvironment {
    pub backend: String,
    pub enabled: bool,
}

fn opencode_cache_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(value) = std::env::var("XDG_CACHE_HOME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            candidates.push(PathBuf::from(trimmed).join("opencode"));
        }
    }

    if let Some(home) = home_dir() {
        candidates.push(home.join(".cache").join("opencode"));

        #[cfg(target_os = "macos")]
        {
            candidates.push(home.join("Library").join("Caches").join("opencode"));
        }
    }

    #[cfg(windows)]
    {
        if let Ok(value) = std::env::var("LOCALAPPDATA") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                candidates.push(PathBuf::from(trimmed).join("opencode"));
            }
        }
        if let Ok(value) = std::env::var("APPDATA") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                candidates.push(PathBuf::from(trimmed).join("opencode"));
            }
        }
    }

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|path| seen.insert(path.to_string_lossy().to_string()))
        .collect()
}

fn stop_host_services(
    engine_manager: &State<EngineManager>,
    orchestrator_manager: &State<OrchestratorManager>,
    veslo_manager: &State<VesloServerManager>,
    opencode_router_manager: &State<OpenCodeRouterManager>,
) {
    if let Ok(mut engine) = engine_manager.inner.lock() {
        EngineManager::stop_locked(&mut engine);
    }
    if let Ok(mut orchestrator_state) = orchestrator_manager.inner.lock() {
        OrchestratorManager::stop_locked(
            &mut orchestrator_state,
            OrchestratorShutdownAttribution::new("host_stop", "stop_host_services"),
        );
    }
    if let Ok(mut veslo_state) = veslo_manager.inner.lock() {
        VesloServerManager::stop_locked(&mut veslo_state);
    }
    if let Ok(mut opencode_router_state) = opencode_router_manager.inner.lock() {
        OpenCodeRouterManager::stop_locked(&mut opencode_router_state);
    }
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    if path.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|e| format!("Failed to remove directory {}: {e}", path.display()))
    } else {
        fs::remove_file(path).map_err(|e| format!("Failed to remove file {}: {e}", path.display()))
    }
}

fn validate_server_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("server_name is required".to_string());
    }

    if trimmed.starts_with('-') {
        return Err("server_name must not start with '-'".to_string());
    }

    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("server_name must be alphanumeric with '-' or '_'".to_string());
    }

    Ok(trimmed.to_string())
}

use crate::workspace::validation::{validate_project_dir, validate_workspace_path, ValidationMode};

fn resolve_opencode_program(
    app: &AppHandle,
    prefer_sidecar: bool,
    opencode_bin_path: Option<String>,
) -> Result<PathBuf, String> {
    if let Some(custom) = opencode_bin_path {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    let resource_dir = app.path().resource_dir().ok();
    let current_bin_dir = tauri::process::current_binary(&app.env())
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));

    let (program, _in_path, notes) = resolve_engine_path(
        prefer_sidecar,
        resource_dir.as_deref(),
        current_bin_dir.as_deref(),
    );

    program.ok_or_else(|| {
        let notes_text = notes.join("\n");
        format!(
            "OpenCode CLI not found.\n\nInstall with:\n- brew install anomalyco/tap/opencode\n- curl -fsSL https://opencode.ai/install | bash\n\nNotes:\n{notes_text}"
        )
    })
}

#[tauri::command]
pub fn reset_opencode_cache() -> Result<CacheResetResult, String> {
    let candidates = opencode_cache_candidates();
    let mut removed = Vec::new();
    let mut missing = Vec::new();
    let mut errors = Vec::new();

    for path in candidates {
        if path.exists() {
            if let Err(err) = std::fs::remove_dir_all(&path) {
                errors.push(format!("Failed to remove {}: {err}", path.display()));
            } else {
                removed.push(path.to_string_lossy().to_string());
            }
        } else {
            missing.push(path.to_string_lossy().to_string());
        }
    }

    Ok(CacheResetResult {
        removed,
        missing,
        errors,
    })
}

#[tauri::command]
pub fn reset_veslo_state(
    app: tauri::AppHandle,
    mode: String,
    engine_manager: State<EngineManager>,
    orchestrator_manager: State<OrchestratorManager>,
    veslo_manager: State<VesloServerManager>,
    opencode_router_manager: State<OpenCodeRouterManager>,
) -> Result<(), String> {
    let mode = mode.trim();
    if mode != "onboarding" && mode != "all" {
        return Err("mode must be 'onboarding' or 'all'".to_string());
    }

    stop_host_services(
        &engine_manager,
        &orchestrator_manager,
        &veslo_manager,
        &opencode_router_manager,
    );

    let mut paths = vec![
        app.path()
            .app_cache_dir()
            .map_err(|e| format!("Failed to resolve app cache dir: {e}"))?,
        app.path()
            .app_config_dir()
            .map_err(|e| format!("Failed to resolve app config dir: {e}"))?,
        app.path()
            .app_local_data_dir()
            .map_err(|e| format!("Failed to resolve app local data dir: {e}"))?,
    ];

    if mode == "all" {
        paths.push(
            app.path()
                .app_data_dir()
                .map_err(|e| format!("Failed to resolve app data dir: {e}"))?,
        );
        paths.push(PathBuf::from(orchestrator::resolve_orchestrator_data_dir()));
    }

    let mut seen = HashSet::new();
    for path in paths {
        let key = path.to_string_lossy().to_string();
        if seen.insert(key) {
            remove_path_if_exists(&path)?;
        }
    }

    Ok(())
}

/// VSLO-86 — webview console events forwarded to Tauri stderr so they land
/// in /tmp/veslo.log alongside Rust-side logs. Used by `_wsLog`, `wsDebug`,
/// and the SSE/session loggers when running inside the Tauri runtime, so
/// production diagnostics don't require opening DevTools.
#[tauri::command]
pub fn log_ui_event(app: AppHandle, scope: String, message: String, payload: Option<String>) {
    let is_send_workflow_trace = scope == "send-workflow-trace";
    if !should_emit_send_workflow_trace(
        is_send_workflow_trace,
        crate::runtime_preferences::pilot_runtime_diagnostics_enabled(),
        crate::runtime_preferences::runtime_diagnostics_enabled(&app).unwrap_or(false),
    ) {
        return;
    }
    if is_send_workflow_trace {
        append_send_workflow_trace_event(&app, &message, payload.as_deref());
    }
    let line = match payload.as_deref() {
        Some(p) if !p.is_empty() => format!("[ui:{}] {} {}", scope, message, p),
        _ => format!("[ui:{}] {}", scope, message),
    };
    eprintln!("{}", line);
    if let Some(forwarder) =
        app.try_state::<std::sync::Arc<crate::debug_logs_forwarder::DebugLogsForwarder>>()
    {
        forwarder.append(
            "Veslo UI",
            crate::debug_logs_forwarder::LogStream::Stderr,
            &line,
        );
    }
}

fn should_emit_send_workflow_trace(
    is_send_workflow_trace: bool,
    pilot_diagnostics_enabled: bool,
    runtime_diagnostics_enabled: bool,
) -> bool {
    !is_send_workflow_trace || pilot_diagnostics_enabled || runtime_diagnostics_enabled
}

fn truthy_env(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            let trimmed = value.trim();
            trimmed == "1"
                || trimmed.eq_ignore_ascii_case("true")
                || trimmed.eq_ignore_ascii_case("yes")
        })
        .unwrap_or(false)
}

fn resolve_send_workflow_trace_file(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("VESLO_SEND_WORKFLOW_TRACE_UI_FILE") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    if let Ok(path) = std::env::var("VESLO_SEND_WORKFLOW_TRACE_FILE") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    if !truthy_env("VESLO_SEND_WORKFLOW_TRACE") {
        return app.path().app_log_dir().ok().map(|dir| {
            dir.join("support-diagnostics")
                .join("send-workflow-trace.ui.ndjson")
        });
    }
    if let Ok(dir) = std::env::var("TAURI_PILOT_LOG_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed).join("send-workflow-trace.ui.ndjson"));
        }
    }
    if let Ok(runtime_trace) = std::env::var("VESLO_RUNTIME_TRACE_FILE") {
        let trimmed = runtime_trace.trim();
        if !trimmed.is_empty() {
            if let Some(parent) = PathBuf::from(trimmed).parent() {
                return Some(parent.join("send-workflow-trace.ui.ndjson"));
            }
        }
    }
    None
}

fn resolve_send_workflow_trace_mirror_file() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("VESLO_SEND_WORKFLOW_TRACE_UI_MIRROR_FILE") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    if let Ok(path) = std::env::var("VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    None
}

fn send_workflow_trace_write_lock() -> &'static Mutex<()> {
    SEND_WORKFLOW_TRACE_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

fn append_send_workflow_trace_line(path: &Path, line: &str) {
    let _guard = match send_workflow_trace_write_lock().lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
        let _ = file.write_all(b"\n");
        let _ = file.flush();
    }
}

fn is_private_send_workflow_trace_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("token")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("authorization")
        || lower.contains("credential")
        || lower.contains("api_key")
        || lower.contains("apikey")
        || matches!(
            lower.as_str(),
        "message"
            | "error"
            | "failure"
            | "stack"
            | "body"
            | "text"
            | "label"
            | "title"
            | "content"
            | "prompt"
            | "transcript"
            | "workspacepath"
            | "workspace_path"
            | "workspaceroot"
            | "workspace_root"
            | "directory"
            | "projectdir"
            | "project_dir"
            | "dbpath"
            | "db_path"
            | "path"
            | "filepath"
            | "file_path"
            | "email"
            | "subject"
            | "laststdout"
            | "laststderr"
        )
}

fn send_workflow_trace_string_contains_absolute_path(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains(":\\")
        || lower.contains(":/users/")
        || lower.starts_with("/users/")
        || lower.starts_with("/home/")
        || lower.starts_with("/workspace/")
}

fn redact_send_workflow_trace_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                redact_send_workflow_trace_value(item);
            }
        }
        serde_json::Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if is_private_send_workflow_trace_key(key) {
                    *child = serde_json::Value::String("[redacted]".to_string());
                } else {
                    redact_send_workflow_trace_value(child);
                }
            }
        }
        serde_json::Value::String(text) if send_workflow_trace_string_contains_absolute_path(text) => {
            *value = serde_json::Value::String("[redacted-path]".to_string());
        }
        _ => {}
    }
}

fn redact_send_workflow_trace_payload(raw: &str) -> String {
    let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(raw) else {
        return r#"{"schema":"send-workflow/v1","source":"ui","event":"unstructured-trace","payload":"[redacted]"}"#.to_string();
    };
    redact_send_workflow_trace_value(&mut payload);
    serde_json::to_string(&payload).unwrap_or_else(|_| {
        r#"{"schema":"send-workflow/v1","source":"ui","event":"trace-redaction-failed"}"#.to_string()
    })
}

fn append_send_workflow_trace_event(app: &AppHandle, message: &str, payload: Option<&str>) {
    let line = match payload {
        Some(raw) if !raw.trim().is_empty() => redact_send_workflow_trace_payload(raw.trim()),
        _ => format!(
            "{{\"schema\":\"send-workflow/v1\",\"source\":\"ui\",\"event\":{}}}",
            serde_json::to_string(message).unwrap_or_else(|_| "\"ui-event\"".to_string())
        ),
    };
    let primary = resolve_send_workflow_trace_file(app);
    let mirror = resolve_send_workflow_trace_mirror_file();

    if let Some(path) = primary.as_deref() {
        append_send_workflow_trace_line(path, &line);
    }
    if let Some(path) = mirror.as_deref() {
        if primary
            .as_ref()
            .is_some_and(|primary_path| primary_path == path)
        {
            return;
        }
        append_send_workflow_trace_line(path, &line);
    }
}

#[tauri::command]
pub fn app_build_info(app: AppHandle) -> AppBuildInfo {
    let version = app.package_info().version.to_string();
    let git_sha = option_env!("VESLO_GIT_SHA").map(|value| value.to_string());
    let build_epoch = option_env!("VESLO_BUILD_EPOCH").map(|value| value.to_string());
    AppBuildInfo {
        version,
        git_sha,
        build_epoch,
    }
}

#[tauri::command]
pub fn desktop_sandbox_environment() -> DesktopSandboxEnvironment {
    let backend = crate::veslo_server::spawn::resolve_server_sandbox_backend();
    DesktopSandboxEnvironment {
        enabled: backend != "none",
        backend,
    }
}

#[tauri::command]
pub fn obsidian_is_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        let mut candidates = vec![PathBuf::from("/Applications/Obsidian.app")];
        if let Some(home) = home_dir() {
            candidates.push(home.join("Applications").join("Obsidian.app"));
        }
        return candidates.into_iter().any(|path| path.exists());
    }

    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[tauri::command]
pub fn open_in_obsidian(app: AppHandle, file_path: String) -> Result<(), String> {
    let path = match validate_workspace_path(&app, &file_path, ValidationMode::InAuthorizedRoot) {
        Ok(canonical) => canonical,
        Err(e) => {
            println!("[misc][obsidian] rejected: {e}");
            return Err(e);
        }
    };
    println!("[misc][obsidian] open request path={}", path.display());

    #[cfg(target_os = "macos")]
    {
        if !obsidian_is_available() {
            println!("[misc][obsidian] rejected: app not installed");
            return Err("Obsidian is not installed.".to_string());
        }

        println!("[misc][obsidian] launching path={}", path.display());
        let status = std::process::Command::new("open")
            .arg("-a")
            .arg("Obsidian")
            .arg(&path)
            .status()
            .map_err(|e| format!("Failed to launch Obsidian: {e}"))?;
        if status.success() {
            println!("[misc][obsidian] launch success path={}", path.display());
            return Ok(());
        }
        println!(
            "[misc][obsidian] launch failed path={} status={status}",
            path.display()
        );
        return Err(format!(
            "Failed to launch Obsidian (exit status: {status})."
        ));
    }

    #[cfg(not(target_os = "macos"))]
    {
        println!(
            "[misc][obsidian] unsupported platform request path={}",
            path.display()
        );
        Err("Open in Obsidian is currently supported on macOS only.".to_string())
    }
}

fn sanitize_obsidian_workspace_id(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut out = String::with_capacity(trimmed.len());
    let mut last_dash = false;
    for ch in trimmed.chars() {
        let normalized = if ch.is_ascii_alphanumeric() || ch == '_' {
            ch.to_ascii_lowercase()
        } else {
            '-'
        };

        if normalized == '-' {
            if last_dash {
                continue;
            }
            out.push('-');
            last_dash = true;
            continue;
        }

        out.push(normalized);
        last_dash = false;
    }

    out.trim_matches('-').to_string()
}

fn normalize_obsidian_mirror_relative_path(file_path: &str) -> Result<PathBuf, String> {
    let mut value = file_path.trim().replace('\\', "/");
    if value.is_empty() {
        return Err("file_path is required".to_string());
    }

    while let Some(stripped) = value.strip_prefix("./") {
        value = stripped.to_string();
    }

    if value.is_empty() {
        return Err("file_path is required".to_string());
    }

    let lower = value.to_ascii_lowercase();
    if lower.starts_with("workspace/") {
        value = value["workspace/".len()..].to_string();
    } else if lower.starts_with("/workspace/") {
        let without_leading_slash = value.trim_start_matches('/').to_string();
        if without_leading_slash
            .to_ascii_lowercase()
            .starts_with("workspace/")
        {
            value = without_leading_slash["workspace/".len()..].to_string();
        }
    }

    let bytes = value.as_bytes();
    let is_windows_abs =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/';

    if value.starts_with('/') || value.starts_with('~') || is_windows_abs {
        return Err("file_path must be worker-relative".to_string());
    }

    let mut relative = PathBuf::new();
    for part in value.split('/').filter(|part| !part.is_empty()) {
        if part == "." || part == ".." {
            return Err("file_path must not contain '.' or '..' segments".to_string());
        }
        relative.push(part);
    }

    if relative.as_os_str().is_empty() {
        return Err("file_path is required".to_string());
    }

    Ok(relative)
}

#[tauri::command]
pub fn write_obsidian_mirror_file(
    app: AppHandle,
    workspace_id: String,
    file_path: String,
    content: String,
) -> Result<String, String> {
    let workspace_trimmed = workspace_id.trim();
    if workspace_trimmed.is_empty() {
        return Err("workspace_id is required".to_string());
    }

    let workspace_key = sanitize_obsidian_workspace_id(workspace_trimmed);
    if workspace_key.is_empty() {
        return Err("workspace_id must contain at least one alphanumeric character".to_string());
    }

    let relative_path = normalize_obsidian_mirror_relative_path(&file_path)?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    let mirror_root = app_data_dir.join("obsidian-mirror").join(workspace_key);
    let target = mirror_root.join(relative_path);

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    fs::write(&target, content.as_bytes())
        .map_err(|e| format!("Failed to write {}: {e}", target.display()))?;

    Ok(target.to_string_lossy().to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianMirrorFileContent {
    pub exists: bool,
    pub path: String,
    pub content: Option<String>,
    pub updated_at_ms: Option<u64>,
}

#[tauri::command]
pub fn read_obsidian_mirror_file(
    app: AppHandle,
    workspace_id: String,
    file_path: String,
) -> Result<ObsidianMirrorFileContent, String> {
    let workspace_trimmed = workspace_id.trim();
    if workspace_trimmed.is_empty() {
        return Err("workspace_id is required".to_string());
    }

    let workspace_key = sanitize_obsidian_workspace_id(workspace_trimmed);
    if workspace_key.is_empty() {
        return Err("workspace_id must contain at least one alphanumeric character".to_string());
    }

    let relative_path = normalize_obsidian_mirror_relative_path(&file_path)?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    let mirror_root = app_data_dir.join("obsidian-mirror").join(workspace_key);
    let target = mirror_root.join(relative_path);
    let path_string = target.to_string_lossy().to_string();

    if !target.exists() {
        return Ok(ObsidianMirrorFileContent {
            exists: false,
            path: path_string,
            content: None,
            updated_at_ms: None,
        });
    }

    let metadata =
        fs::metadata(&target).map_err(|e| format!("Failed to stat {}: {e}", target.display()))?;
    if !metadata.is_file() {
        return Err(format!("Mirror path is not a file: {}", target.display()));
    }

    let content = fs::read_to_string(&target)
        .map_err(|e| format!("Failed to read {}: {e}", target.display()))?;
    let updated_at_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);

    Ok(ObsidianMirrorFileContent {
        exists: true,
        path: path_string,
        content: Some(content),
        updated_at_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        append_send_workflow_trace_line, normalize_obsidian_mirror_relative_path,
        redact_send_workflow_trace_payload, sanitize_obsidian_workspace_id, should_emit_send_workflow_trace,
        update_session_directory_in_db,
    };
    use rusqlite::Connection;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tempfile::tempdir;

    #[test]
    fn send_workflow_trace_allows_an_explicit_pilot_diagnostic_run() {
        assert!(should_emit_send_workflow_trace(false, false, false));
        assert!(!should_emit_send_workflow_trace(true, false, false));
        assert!(should_emit_send_workflow_trace(true, true, false));
        assert!(should_emit_send_workflow_trace(true, false, true));
    }

    #[test]
    fn send_workflow_trace_redacts_private_payload_fields_before_persisting() {
        let raw = r#"{
          "event":"server:conversation-run:lifecycle-register",
          "workspacePath":"C:\\Users\\pilot-user\\workspace",
          "message":"Reply with exactly sensitive-prompt",
          "token":"secret-token",
          "detail":"workspace=C:\\Users\\pilot-user\\workspace",
          "nested":{"directory":"C:\\Users\\pilot-user\\workspace\\nested"}
        }"#;

        let redacted = redact_send_workflow_trace_payload(raw);
        assert!(!redacted.contains("pilot-user"));
        assert!(!redacted.contains("sensitive-prompt"));
        assert!(!redacted.contains("secret-token"));
        let parsed: serde_json::Value = serde_json::from_str(&redacted).expect("redacted JSON");
        assert_eq!(parsed["event"], "server:conversation-run:lifecycle-register");
        assert_eq!(parsed["workspacePath"], "[redacted]");
        assert_eq!(parsed["detail"], "[redacted-path]");
        assert_eq!(parsed["nested"]["directory"], "[redacted]");
    }

    #[test]
    fn sanitize_workspace_id_collapses_separators() {
        let out = sanitize_obsidian_workspace_id(" Team Alpha / Worker #1 ");
        assert_eq!(out, "team-alpha-worker-1");
    }

    #[test]
    fn send_workflow_trace_append_keeps_concurrent_writes_line_delimited() {
        let dir = tempdir().expect("temp dir");
        let path = Arc::new(dir.path().join("send-workflow-trace.ui.ndjson"));
        let mut handles = Vec::new();

        for thread_id in 0..8 {
            let path = Arc::clone(&path);
            handles.push(std::thread::spawn(move || {
                for item_id in 0..25 {
                    append_send_workflow_trace_line(
                        &path,
                        &format!("{{\"thread\":{thread_id},\"item\":{item_id}}}"),
                    );
                }
            }));
        }

        for handle in handles {
            handle.join().expect("writer thread should finish");
        }

        let raw = fs::read_to_string(path.as_ref()).expect("trace file");
        let lines: Vec<&str> = raw.lines().collect();
        assert_eq!(lines.len(), 200);
        assert!(lines
            .iter()
            .all(|line| line.starts_with('{') && line.ends_with('}')));
        assert!(lines.iter().all(|line| !line.contains("}{")));
    }

    #[test]
    fn normalize_mirror_path_strips_workspace_prefixes() {
        let path = normalize_obsidian_mirror_relative_path("/workspace/notes/plan.md")
            .expect("path should normalize");
        assert_eq!(path, PathBuf::from("notes").join("plan.md"));

        let path = normalize_obsidian_mirror_relative_path("workspace/notes/plan.md")
            .expect("path should normalize");
        assert_eq!(path, PathBuf::from("notes").join("plan.md"));
    }

    #[test]
    fn normalize_mirror_path_rejects_parent_segments() {
        let err = normalize_obsidian_mirror_relative_path("notes/../secret.md")
            .expect_err("parent segments should be rejected");
        assert!(err.contains("must not contain"));
    }

    #[test]
    fn normalize_mirror_path_rejects_absolute_paths() {
        let err = normalize_obsidian_mirror_relative_path("/etc/passwd")
            .expect_err("absolute path should be rejected");
        assert!(err.contains("worker-relative"));
    }

    #[test]
    fn update_session_directory_allows_apostrophes() {
        let mut conn = Connection::open_in_memory().expect("db");
        conn.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);
             CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);",
        )
        .expect("schema");

        let session_id = "s1";
        let old_dir = "/tmp/old";
        let new_dir = "/tmp/o'connor";
        conn.execute(
            "INSERT INTO session (id, directory) VALUES (?1, ?2)",
            [session_id, old_dir],
        )
        .expect("insert session");
        conn.execute(
            "INSERT INTO message (id, session_id, data) VALUES (?1, ?2, ?3)",
            ["m1", session_id, "{\"path\":{\"cwd\":\"/tmp/old\"}}"],
        )
        .expect("insert message");
        conn.execute(
            "INSERT INTO part (id, session_id, data) VALUES (?1, ?2, ?3)",
            [
                "p1",
                session_id,
                "{\"tool\":{\"filePaths\":[\"/tmp/old/a.txt\"]}}",
            ],
        )
        .expect("insert part");

        update_session_directory_in_db(&mut conn, session_id, old_dir, new_dir)
            .expect("update should succeed");

        let session_dir: String = conn
            .query_row(
                "SELECT directory FROM session WHERE id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .expect("query session");
        assert_eq!(session_dir, new_dir);

        let message_data: String = conn
            .query_row(
                "SELECT data FROM message WHERE session_id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .expect("query message");
        assert!(message_data.contains("/tmp/o'connor"));

        let part_data: String = conn
            .query_row(
                "SELECT data FROM part WHERE session_id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .expect("query part");
        assert!(part_data.contains("/tmp/o'connor/a.txt"));
    }
}

#[tauri::command]
pub fn opencode_db_migrate(
    app: AppHandle,
    project_dir: String,
    prefer_sidecar: Option<bool>,
    opencode_bin_path: Option<String>,
) -> Result<ExecResult, String> {
    let project_dir = validate_project_dir(&app, &project_dir)?;
    let program =
        resolve_opencode_program(&app, prefer_sidecar.unwrap_or(false), opencode_bin_path)?;

    let mut command = command_for_program(&program);
    for (key, value) in crate::bun_env::bun_env_overrides() {
        command.env(key, value);
    }

    let output = command
        .arg("db")
        .arg("migrate")
        .current_dir(&project_dir)
        .output()
        .map_err(|e| format!("Failed to run opencode db migrate: {e}"))?;

    let status = output.status.code().unwrap_or(-1);
    Ok(ExecResult {
        ok: output.status.success(),
        status,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

/// Run `opencode mcp auth <server_name>` in the given project directory.
/// This spawns the process detached so the OAuth flow can open a browser.
#[tauri::command]
pub fn opencode_mcp_auth(
    app: AppHandle,
    project_dir: String,
    server_name: String,
) -> Result<ExecResult, String> {
    let project_dir = validate_project_dir(&app, &project_dir)?;
    let server_name = validate_server_name(&server_name)?;

    let program = resolve_opencode_program(&app, true, None)?;

    let mut command = command_for_program(&program);
    for (key, value) in crate::bun_env::bun_env_overrides() {
        command.env(key, value);
    }

    let output = command
        .arg("mcp")
        .arg("auth")
        .arg(server_name)
        .current_dir(&project_dir)
        .output()
        .map_err(|e| format!("Failed to run opencode mcp auth: {e}"))?;

    let status = output.status.code().unwrap_or(-1);
    Ok(ExecResult {
        ok: output.status.success(),
        status,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

/// Update the `directory` column for a session in the OpenCode SQLite database
/// and rewrite `path.cwd` inside every assistant message's JSON `data` blob so
/// the engine won't generate stale `external_directory` permission prompts.
///
/// Used after "Choose folder" moves a session from a private workspace to a real folder.
fn update_session_directory_in_db(
    conn: &mut Connection,
    session_id: &str,
    old_directory: &str,
    directory: &str,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;

    tx.execute(
        "UPDATE session SET directory = ?1 WHERE id = ?2",
        params![directory, session_id],
    )?;

    if !old_directory.is_empty() {
        tx.execute(
            "UPDATE message SET data = replace(data, ?1, ?2) WHERE session_id = ?3",
            params![old_directory, directory, session_id],
        )?;
        tx.execute(
            "UPDATE part SET data = replace(data, ?1, ?2) WHERE session_id = ?3",
            params![old_directory, directory, session_id],
        )?;
    }

    tx.commit()?;
    Ok(())
}

/// Update the `directory` column for a session in the OpenCode SQLite database
/// and rewrite `path.cwd` inside every assistant message's JSON `data` blob so
/// the engine won't generate stale `external_directory` permission prompts.
///
/// Used after "Choose folder" moves a session from a private workspace to a real folder.
#[tauri::command]
pub fn opencode_db_update_session_directory(
    session_id: String,
    old_directory: String,
    directory: String,
) -> Result<ExecResult, String> {
    let session_id = session_id.trim().to_string();
    let old_directory = old_directory.trim().to_string();
    let directory = directory.trim().to_string();
    if session_id.is_empty() {
        return Err("session_id is required".to_string());
    }
    if directory.is_empty() {
        return Err("directory is required".to_string());
    }

    let home = home_dir().ok_or("Cannot determine home directory")?;
    let db_path = home.join(".local/share/opencode/opencode.db");
    if !db_path.exists() {
        return Err(format!(
            "OpenCode database not found at {}",
            db_path.display()
        ));
    }

    let mut conn = Connection::open(&db_path).map_err(|e| {
        format!(
            "Failed to open OpenCode database at {}: {e}",
            db_path.display()
        )
    })?;
    update_session_directory_in_db(&mut conn, &session_id, &old_directory, &directory).map_err(
        |e| {
            format!(
                "Failed to update OpenCode database at {}: {e}",
                db_path.display()
            )
        },
    )?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: String::new(),
        stderr: String::new(),
    })
}
