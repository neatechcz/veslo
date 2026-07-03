use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::paths::home_dir;
use crate::paths::{prepended_path_env, sidecar_path_candidates};
use crate::supervised_process::{self, CommandEvent, SupervisedCommandChild};
use crate::types::{
    OrchestratorBinaryState, OrchestratorDaemonState, OrchestratorEngineSnapshot,
    OrchestratorOpencodeState, OrchestratorSharedEngineSnapshot, OrchestratorSidecarInfo,
    OrchestratorStatus, OrchestratorWorkspace,
};

pub mod manager;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorAuthFile {
    pub opencode_username: Option<String>,
    pub opencode_password: Option<String>,
    pub lifecycle_token: Option<String>,
    pub project_dir: Option<String>,
    pub updated_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorStateFile {
    #[allow(dead_code)]
    pub version: Option<u32>,
    pub daemon: Option<OrchestratorDaemonState>,
    pub opencode: Option<OrchestratorOpencodeState>,
    pub cli_version: Option<String>,
    pub sidecar: Option<OrchestratorSidecarInfo>,
    pub binaries: Option<OrchestratorBinaryState>,
    pub active_id: Option<String>,
    #[serde(default)]
    pub workspaces: Vec<OrchestratorWorkspace>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorHealth {
    pub ok: bool,
    pub daemon: Option<OrchestratorDaemonState>,
    pub opencode: Option<OrchestratorOpencodeState>,
    pub engine_topology: Option<String>,
    pub cli_version: Option<String>,
    pub sidecar: Option<OrchestratorSidecarInfo>,
    pub binaries: Option<OrchestratorBinaryState>,
    pub active_id: Option<String>,
    pub workspace_count: Option<usize>,
    #[serde(default)]
    pub engines: Vec<OrchestratorEngineSnapshot>,
    #[serde(default)]
    pub shared_engine: Option<OrchestratorSharedEngineSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorWorkspaceList {
    pub active_id: Option<String>,
    #[serde(default)]
    pub workspaces: Vec<OrchestratorWorkspace>,
}

pub struct OrchestratorSpawnOptions {
    pub data_dir: String,
    pub daemon_host: String,
    pub daemon_port: u16,
    pub opencode_bin: String,
    pub opencode_host: String,
    pub opencode_workdir: String,
    pub opencode_port: Option<u16>,
    pub opencode_username: Option<String>,
    pub opencode_password: Option<String>,
    pub veslo_token: Option<String>,
    pub lifecycle_token: Option<String>,
    pub cors: Option<String>,
    pub veslo_server_state_path: Option<String>,
    /// VSLO-171 F3Ú9: max concurrent engines in pool (1-16). None = orchestrator default.
    pub max_engines: Option<u32>,
    /// VSLO-171 F3Ú9: idle suspend threshold in ms. None = orchestrator default.
    pub idle_suspend_ms: Option<u64>,
    pub shared_unsandboxed_engine: Option<bool>,
}

pub fn resolve_orchestrator_data_dir() -> String {
    let env_dir = env::var("VESLO_DATA_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty());

    if let Some(dir) = env_dir {
        return dir;
    }

    #[cfg(windows)]
    {
        if let Some(root) = env::var("LOCALAPPDATA")
            .ok()
            .or_else(|| env::var("APPDATA").ok())
            .filter(|value| !value.trim().is_empty())
        {
            return PathBuf::from(root)
                .join("com.neatech.veslo")
                .join("veslo-orchestrator")
                .to_string_lossy()
                .to_string();
        }
    }

    if let Some(home) = home_dir() {
        return home
            .join(".veslo")
            .join("veslo-orchestrator")
            .to_string_lossy()
            .to_string();
    }

    ".veslo/veslo-orchestrator".to_string()
}

fn orchestrator_state_path(data_dir: &str) -> PathBuf {
    Path::new(data_dir).join("veslo-orchestrator-state.json")
}

fn orchestrator_auth_path(data_dir: &str) -> PathBuf {
    Path::new(data_dir).join("veslo-orchestrator-auth.json")
}

fn read_opencode_version_from_manifest(path: &Path) -> Option<String> {
    let payload = fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&payload).ok()?;
    let version = parsed
        .get("veslo-code")
        .and_then(|entry| entry.get("version"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;

    Some(version.to_string())
}

fn resolve_manifest_opencode_version(sidecar_paths: &[PathBuf]) -> Option<String> {
    let mut names = vec!["versions.json".to_string(), "versions.json.exe".to_string()];
    let target = env::var("TAURI_ENV_TARGET_TRIPLE")
        .ok()
        .or_else(|| env::var("TARGET").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if let Some(target) = target {
        names.push(format!("versions.json-{target}"));
        names.push(format!("versions.json-{target}.exe"));
    }

    for dir in sidecar_paths {
        for name in &names {
            if let Some(version) = read_opencode_version_from_manifest(&dir.join(name)) {
                return Some(version);
            }
        }

        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("versions.json-") {
                    continue;
                }
                if let Some(version) = read_opencode_version_from_manifest(&entry.path()) {
                    return Some(version);
                }
            }
        }
    }

    None
}

fn managed_deps_manifest_has_expected_packages(path: &Path) -> bool {
    let payload = match fs::read_to_string(path) {
        Ok(payload) => payload,
        Err(_) => return false,
    };
    let parsed: serde_json::Value = match serde_json::from_str(&payload) {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };
    if parsed.get("schemaVersion").and_then(|value| value.as_u64()) != Some(1) {
        return false;
    }
    let Some(packages) = parsed.get("packages").and_then(|value| value.as_array()) else {
        return false;
    };

    let has_package = |name: &str, version: &str| {
        packages.iter().any(|entry| {
            entry.get("name").and_then(|value| value.as_str()) == Some(name)
                && entry.get("version").and_then(|value| value.as_str()) == Some(version)
                && entry
                    .get("files")
                    .and_then(|value| value.as_array())
                    .map(|files| !files.is_empty())
                    .unwrap_or(false)
        })
    };

    has_package("@opencode-ai/plugin", "1.17.4") && has_package("zod", "4.1.8")
}

pub(crate) fn resolve_opencode_managed_deps_manifest(sidecar_paths: &[PathBuf]) -> Option<PathBuf> {
    let mut names = vec![
        "opencode-managed-deps.json".to_string(),
        "opencode-managed-deps.json.exe".to_string(),
    ];
    let target = env::var("TAURI_ENV_TARGET_TRIPLE")
        .ok()
        .or_else(|| env::var("TARGET").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if let Some(target) = target {
        names.push(format!("opencode-managed-deps.json-{target}"));
        names.push(format!("opencode-managed-deps.json-{target}.exe"));
    }

    for dir in sidecar_paths {
        for name in &names {
            let path = dir.join(name);
            if managed_deps_manifest_has_expected_packages(&path) {
                return Some(path);
            }
        }

        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("opencode-managed-deps.json-") {
                    continue;
                }
                let path = entry.path();
                if managed_deps_manifest_has_expected_packages(&path) {
                    return Some(path);
                }
            }
        }
    }

    None
}

pub fn read_orchestrator_auth(data_dir: &str) -> Option<OrchestratorAuthFile> {
    let path = orchestrator_auth_path(data_dir);
    let payload = fs::read_to_string(path).ok()?;
    serde_json::from_str(&payload).ok()
}

pub fn write_orchestrator_auth(
    data_dir: &str,
    opencode_username: Option<&str>,
    opencode_password: Option<&str>,
    lifecycle_token: Option<&str>,
    project_dir: Option<&str>,
) -> Result<(), String> {
    let path = orchestrator_auth_path(data_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    let payload = OrchestratorAuthFile {
        opencode_username: opencode_username.map(|value| value.to_string()),
        opencode_password: opencode_password.map(|value| value.to_string()),
        lifecycle_token: lifecycle_token.map(|value| value.to_string()),
        project_dir: project_dir.map(|value| value.to_string()),
        updated_at: Some(crate::utils::now_ms()),
    };
    fs::write(
        &path,
        serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(())
}

pub fn clear_orchestrator_auth(data_dir: &str) {
    let path = orchestrator_auth_path(data_dir);
    let _ = fs::remove_file(path);
}

pub fn read_orchestrator_state(data_dir: &str) -> Option<OrchestratorStateFile> {
    let path = orchestrator_state_path(data_dir);
    let payload = fs::read_to_string(path).ok()?;
    serde_json::from_str(&payload).ok()
}

fn fetch_json<T: DeserializeOwned>(url: &str) -> Result<T, String> {
    const ORCHESTRATOR_FETCH_TIMEOUT_MS: u64 = 1200;
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_millis(
            ORCHESTRATOR_FETCH_TIMEOUT_MS,
        ))
        .build();

    let response = agent
        .get(url)
        .set("Accept", "application/json")
        .call()
        .map_err(|e| format!("Failed to fetch {url}: {e}"))?;
    response
        .into_json::<T>()
        .map_err(|e| format!("Failed to parse response: {e}"))
}

pub fn fetch_orchestrator_health(base_url: &str) -> Result<OrchestratorHealth, String> {
    let url = format!("{}/health", base_url.trim_end_matches('/'));
    fetch_json(&url)
}

pub fn fetch_orchestrator_workspaces(base_url: &str) -> Result<OrchestratorWorkspaceList, String> {
    let url = format!("{}/workspaces", base_url.trim_end_matches('/'));
    fetch_json(&url)
}

pub fn request_orchestrator_shutdown(data_dir: &str) -> Result<bool, String> {
    let base_url = read_orchestrator_state(data_dir)
        .and_then(|state| state.daemon.map(|daemon| daemon.base_url))
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty());

    let Some(base_url) = base_url else {
        return Ok(false);
    };

    let url = format!("{}/shutdown", base_url.trim_end_matches('/'));
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_millis(1500))
        .build();

    agent
        .post(&url)
        .set("Accept", "application/json")
        .set("Content-Type", "application/json")
        .send_string("")
        .map_err(|e| format!("Failed to request orchestrator shutdown at {url}: {e}"))?;

    Ok(true)
}

pub fn build_orchestrator_env_overrides(
    veslo_server_state_path: Option<&Path>,
    shared_unsandboxed_engine: Option<bool>,
) -> Vec<(String, String)> {
    let mut env = Vec::new();

    if let Some(path) = veslo_server_state_path {
        env.push((
            "VESLO_SERVER_STATE_PATH".to_string(),
            path.to_string_lossy().to_string(),
        ));
    }

    env.extend(
        crate::runtime_preferences::shared_unsandboxed_engine_env_overrides(
            shared_unsandboxed_engine,
        ),
    );

    env
}

pub fn spawn_orchestrator_daemon(
    app: &AppHandle,
    options: &OrchestratorSpawnOptions,
) -> Result<
    (
        tauri::async_runtime::Receiver<CommandEvent>,
        SupervisedCommandChild,
    ),
    String,
> {
    let command = match supervised_process::sidecar(app, "veslo-orchestrator") {
        Ok(command) => command,
        Err(error) => supervised_process::command_fallback_for_missing_sidecar(
            app,
            "veslo-orchestrator",
            "veslo",
            error,
        )?,
    };

    let mut args = vec![
        "daemon".to_string(),
        "run".to_string(),
        "--data-dir".to_string(),
        options.data_dir.clone(),
        "--daemon-host".to_string(),
        options.daemon_host.clone(),
        "--daemon-port".to_string(),
        options.daemon_port.to_string(),
        "--opencode-bin".to_string(),
        options.opencode_bin.clone(),
        "--opencode-host".to_string(),
        options.opencode_host.clone(),
        "--opencode-workdir".to_string(),
        options.opencode_workdir.clone(),
        "--allow-external".to_string(),
    ];

    if let Some(port) = options.opencode_port {
        args.push("--opencode-port".to_string());
        args.push(port.to_string());
    }

    if let Some(username) = &options.opencode_username {
        if !username.trim().is_empty() {
            args.push("--opencode-username".to_string());
            args.push(username.to_string());
        }
    }

    if let Some(password) = &options.opencode_password {
        if !password.trim().is_empty() {
            args.push("--opencode-password".to_string());
            args.push(password.to_string());
        }
    }

    if let Some(token) = &options.veslo_token {
        if !token.trim().is_empty() {
            args.push("--veslo-token".to_string());
            args.push(token.to_string());
        }
    }

    if let Some(token) = &options.lifecycle_token {
        if !token.trim().is_empty() {
            args.push("--lifecycle-token".to_string());
            args.push(token.to_string());
        }
    }

    if let Some(cors) = &options.cors {
        if !cors.trim().is_empty() {
            args.push("--cors".to_string());
            args.push(cors.to_string());
        }
    }

    // VSLO-171 F3Ú9: pool tuning from Settings → Performance.
    if let Some(max) = options.max_engines {
        args.push("--max-engines".to_string());
        args.push(max.to_string());
    }

    if let Some(idle) = options.idle_suspend_ms {
        args.push("--idle-suspend-ms".to_string());
        args.push(idle.to_string());
    }

    let mut command = command.args(args);

    let resource_dir = app.path().resource_dir().ok();
    let current_bin_dir = tauri::process::current_binary(&app.env())
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));
    let sidecar_paths =
        sidecar_path_candidates(resource_dir.as_deref(), current_bin_dir.as_deref());
    if let Some(path_env) = prepended_path_env(&sidecar_paths) {
        command = command.env("PATH", path_env);
    }

    let veslo_server_state_path = options.veslo_server_state_path.as_deref().map(Path::new);
    for (key, value) in
        build_orchestrator_env_overrides(veslo_server_state_path, options.shared_unsandboxed_engine)
    {
        command = command.env(key, value);
    }

    for (key, value) in crate::bun_env::bun_env_overrides() {
        command = command.env(key, value);
    }

    if env::var_os("OPENCODE_VERSION").is_none() {
        if let Some(version) = resolve_manifest_opencode_version(&sidecar_paths) {
            command = command.env("OPENCODE_VERSION", version);
        }
    }

    if env::var_os("VESLO_OPENCODE_MANAGED_DEPS_FILE").is_none() {
        if let Some(path) = resolve_opencode_managed_deps_manifest(&sidecar_paths) {
            command = command.env(
                "VESLO_OPENCODE_MANAGED_DEPS_FILE",
                path.to_string_lossy().to_string(),
            );
        }
    }

    command
        .spawn()
        .map_err(|e| format!("Failed to start orchestrator: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{
        build_orchestrator_env_overrides, request_orchestrator_shutdown,
        resolve_manifest_opencode_version, resolve_opencode_managed_deps_manifest,
    };
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use uuid::Uuid;

    #[test]
    fn orchestrator_env_overrides_include_veslo_server_state_path_when_available() {
        let state_path = std::env::temp_dir()
            .join("veslo-orchestrator-env-test")
            .join("veslo-server-plugin-state.json");

        let env = build_orchestrator_env_overrides(Some(&state_path), None);

        assert!(env.iter().any(|(key, value)| {
            key == "VESLO_SERVER_STATE_PATH" && value == state_path.to_string_lossy().as_ref()
        }));
    }

    #[test]
    fn orchestrator_env_overrides_include_shared_unsandboxed_engine_pair_when_enabled() {
        let env = build_orchestrator_env_overrides(None, Some(true));

        assert!(env
            .iter()
            .any(|(key, value)| key == "VESLO_DISABLE_SANDBOX" && value == "1"));
        assert!(env
            .iter()
            .any(|(key, value)| key == "VESLO_SHARED_OPENCODE_ENGINE" && value == "1"));
    }

    #[test]
    fn request_shutdown_returns_false_without_state() {
        let dir = std::env::temp_dir().join(format!(
            "veslo-orchestrator-shutdown-missing-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create test dir");

        let stopped = request_orchestrator_shutdown(&dir.to_string_lossy()).expect("request");
        assert!(!stopped);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn request_shutdown_posts_to_daemon_endpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind shutdown listener");
        let port = listener.local_addr().expect("listener addr").port();

        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept shutdown request");
            let mut buffer = [0u8; 2048];
            let bytes = stream.read(&mut buffer).expect("read request");
            let request = String::from_utf8_lossy(&buffer[..bytes]);
            assert!(request.starts_with("POST /shutdown "));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
                )
                .expect("write response");
        });

        let dir = std::env::temp_dir().join(format!(
            "veslo-orchestrator-shutdown-state-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create state dir");
        let state_path = dir.join("veslo-orchestrator-state.json");
        fs::write(
            &state_path,
            format!(
                "{{\"daemon\":{{\"pid\":1,\"port\":{port},\"baseUrl\":\"http://127.0.0.1:{port}\",\"startedAt\":1}}}}"
            ),
        )
        .expect("write state file");

        let stopped = request_orchestrator_shutdown(&dir.to_string_lossy()).expect("request");
        assert!(stopped);

        handle.join().expect("server thread");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn resolve_manifest_opencode_version_reads_sidecar_manifest() {
        let dir = std::env::temp_dir().join(format!(
            "veslo-orchestrator-version-manifest-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create test dir");
        fs::write(
            dir.join("versions.json.exe"),
            r#"{"veslo-code":{"version":"1.17.4","sha256":"abc"}}"#,
        )
        .expect("write manifest");

        let version = resolve_manifest_opencode_version(&[dir.clone()]);
        assert_eq!(version.as_deref(), Some("1.17.4"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn managed_deps_manifest_resolver_ignores_empty_stub_and_selects_real_manifest() {
        let dir = std::env::temp_dir().join(format!(
            "veslo-orchestrator-managed-deps-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create test dir");
        fs::write(
            dir.join("opencode-managed-deps.json"),
            r#"{"schemaVersion":1,"packages":[]}"#,
        )
        .expect("write empty manifest");
        let target_manifest = dir.join("opencode-managed-deps.json-x86_64-pc-windows-msvc.exe");
        fs::write(
            &target_manifest,
            r#"{
  "schemaVersion": 1,
  "packages": [
    { "name": "@opencode-ai/plugin", "version": "1.17.4", "files": [{ "path": "package.json", "contentBase64": "e30=" }] },
    { "name": "zod", "version": "4.1.8", "files": [{ "path": "package.json", "contentBase64": "e30=" }] }
  ]
}"#,
        )
        .expect("write real manifest");

        let resolved = resolve_opencode_managed_deps_manifest(&[dir.clone()])
            .expect("resolve managed deps manifest");
        assert_eq!(resolved, target_manifest);

        let _ = fs::remove_dir_all(dir);
    }
}

pub fn orchestrator_status_from_state(
    data_dir: &str,
    last_error: Option<String>,
) -> OrchestratorStatus {
    let state = read_orchestrator_state(data_dir);
    let workspaces = state
        .as_ref()
        .map(|state| state.workspaces.clone())
        .unwrap_or_default();
    let workspace_count = workspaces.len();
    let active_id = state
        .as_ref()
        .and_then(|state| state.active_id.clone())
        .filter(|id| !id.trim().is_empty());
    OrchestratorStatus {
        running: false,
        data_dir: data_dir.to_string(),
        daemon: state.as_ref().and_then(|state| state.daemon.clone()),
        opencode: state.as_ref().and_then(|state| state.opencode.clone()),
        engine_topology: None,
        cli_version: state.as_ref().and_then(|state| state.cli_version.clone()),
        sidecar: state.as_ref().and_then(|state| state.sidecar.clone()),
        binaries: state.as_ref().and_then(|state| state.binaries.clone()),
        active_id,
        workspace_count,
        workspaces,
        engines: Vec::new(),
        shared_engine: None,
        last_error,
    }
}

pub fn resolve_orchestrator_status(
    data_dir: &str,
    last_error: Option<String>,
) -> OrchestratorStatus {
    let fallback = orchestrator_status_from_state(data_dir, last_error);
    let base_url = fallback
        .daemon
        .as_ref()
        .map(|daemon| daemon.base_url.clone());
    let Some(base_url) = base_url else {
        return fallback;
    };

    match fetch_orchestrator_health(&base_url) {
        Ok(health) => {
            let workspace_payload = fetch_orchestrator_workspaces(&base_url).ok();
            let workspaces = workspace_payload
                .as_ref()
                .map(|payload| payload.workspaces.clone())
                .unwrap_or_else(|| fallback.workspaces.clone());
            let active_id = workspace_payload
                .as_ref()
                .and_then(|payload| payload.active_id.clone())
                .or_else(|| health.active_id.clone())
                .filter(|id| !id.trim().is_empty());
            let workspace_count = workspace_payload
                .as_ref()
                .map(|payload| payload.workspaces.len())
                .or(health.workspace_count)
                .unwrap_or(workspaces.len());
            OrchestratorStatus {
                running: health.ok,
                data_dir: data_dir.to_string(),
                daemon: health.daemon,
                opencode: health.opencode,
                engine_topology: health.engine_topology,
                cli_version: health.cli_version,
                sidecar: health.sidecar,
                binaries: health.binaries,
                active_id,
                workspace_count,
                workspaces,
                engines: health.engines,
                shared_engine: health.shared_engine,
                last_error: None,
            }
        }
        Err(error) => OrchestratorStatus {
            last_error: Some(error),
            ..fallback
        },
    }
}
