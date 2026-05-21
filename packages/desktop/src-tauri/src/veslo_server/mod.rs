use std::fs;
use std::path::{Path, PathBuf};

use gethostname::gethostname;
use local_ip_address::local_ip;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::Manager;
use uuid::Uuid;

use crate::debug_logs_forwarder::DebugLogsForwarder;
use crate::process_supervisor::spawn_output_collector_with_forwarder;
use crate::types::{VesloServerInfo, WorkspaceType};
use crate::workspace::state::load_workspace_state;
use std::sync::Arc;

pub mod manager;
pub mod spawn;

use manager::VesloServerManager;
use spawn::{resolve_veslo_port_after_restart, spawn_veslo_server};

const PERSISTED_STATE_FILE_NAME: &str = "veslo-server-state.json";
const PERSISTED_PLUGIN_STATE_FILE_NAME: &str = "veslo-server-plugin-state.json";

fn resolve_workspace_ids(app: &AppHandle, workspace_paths: &[String]) -> Vec<Option<String>> {
    let state = load_workspace_state(app).ok();
    workspace_paths
        .iter()
        .map(|path| {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                return None;
            }
            state.as_ref().and_then(|state| {
                state
                    .workspaces
                    .iter()
                    .find(|workspace| {
                        workspace.workspace_type == WorkspaceType::Local
                            && workspace.path.trim() == trimmed
                    })
                    .map(|workspace| workspace.id.clone())
            })
        })
        .collect()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedVesloServerState {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub base_url: Option<String>,
    pub connect_url: Option<String>,
    pub mdns_url: Option<String>,
    pub lan_url: Option<String>,
    pub client_token: Option<String>,
    pub pid: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedVesloServerPluginState {
    pub base_url: Option<String>,
    pub client_token: Option<String>,
}

fn generate_token() -> String {
    Uuid::new_v4().to_string()
}

fn build_urls(port: u16) -> (Option<String>, Option<String>, Option<String>) {
    let hostname = gethostname().to_string_lossy().trim().to_string();
    let mdns_url = if hostname.is_empty() {
        None
    } else {
        let trimmed = hostname.trim_end_matches(".local");
        Some(format!("http://{trimmed}.local:{port}"))
    };

    let lan_url = local_ip().ok().map(|ip| format!("http://{ip}:{port}"));

    let connect_url = lan_url.clone().or(mdns_url.clone());

    (connect_url, mdns_url, lan_url)
}

fn persisted_state_path(dir: &Path) -> PathBuf {
    dir.join(PERSISTED_STATE_FILE_NAME)
}

fn persisted_plugin_state_path(dir: &Path) -> PathBuf {
    dir.join(PERSISTED_PLUGIN_STATE_FILE_NAME)
}

fn persisted_state_dir_override() -> Option<PathBuf> {
    crate::paths::app_local_data_dir_override()
}

fn persisted_state_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(override_dir) = persisted_state_dir_override() {
        return Ok(override_dir);
    }

    app.path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to resolve app local data dir: {e}"))
}

#[allow(dead_code)]
pub fn persisted_veslo_server_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(persisted_state_path(&persisted_state_dir(app)?))
}

pub fn persisted_veslo_server_plugin_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(persisted_plugin_state_path(&persisted_state_dir(app)?))
}

#[cfg(test)]
fn persisted_veslo_server_state_path_from_override() -> Option<PathBuf> {
    persisted_state_dir_override().map(|dir| persisted_state_path(&dir))
}

#[cfg(test)]
fn persisted_veslo_server_plugin_state_path_from_override() -> Option<PathBuf> {
    persisted_state_dir_override().map(|dir| persisted_plugin_state_path(&dir))
}

pub(crate) fn server_health_ok(base_url: &str) -> bool {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return false;
    }

    let url = format!("{trimmed}/health");
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_millis(1200))
        .build();

    agent
        .get(&url)
        .call()
        .map(|response| response.status() == 200)
        .unwrap_or(false)
}

fn persisted_state_to_info_with_health(
    state: &PersistedVesloServerState,
    health_check: impl Fn(&str) -> bool,
) -> Option<VesloServerInfo> {
    let base_url = state
        .base_url
        .clone()
        .filter(|value| !value.trim().is_empty())?;
    if !health_check(&base_url) {
        return None;
    }

    Some(VesloServerInfo {
        running: true,
        host: state.host.clone(),
        port: state.port,
        base_url: Some(base_url),
        connect_url: state.connect_url.clone(),
        mdns_url: state.mdns_url.clone(),
        lan_url: state.lan_url.clone(),
        client_token: state.client_token.clone(),
        host_token: None,
        pid: state.pid,
        last_stdout: None,
        last_stderr: None,
    })
}

fn read_persisted_veslo_server_info_with_cleanup(
    dir: &Path,
    health_check: impl Fn(&str) -> bool,
    mut cleanup_stale_pid: impl FnMut(u32) -> Result<(), String>,
) -> Result<Option<VesloServerInfo>, String> {
    let path = persisted_state_path(dir);
    if !path.exists() {
        return Ok(None);
    }

    let payload =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let state: PersistedVesloServerState = serde_json::from_str(&payload)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;

    let info = persisted_state_to_info_with_health(&state, health_check);
    if info.is_none() {
        if let Some(pid) = state.pid.filter(|pid| *pid > 0) {
            if let Err(error) = cleanup_stale_pid(pid) {
                eprintln!("[veslo-server] Failed to terminate stale persisted PID {pid}: {error}");
            }
        }
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(persisted_plugin_state_path(dir));
    }
    Ok(info)
}

pub fn read_persisted_veslo_server_info(dir: &Path) -> Result<Option<VesloServerInfo>, String> {
    read_persisted_veslo_server_info_with_cleanup(dir, server_health_ok, |pid| {
        kill_stale_veslo_server_process(pid)
    })
}

fn kill_stale_veslo_server_process(pid: u32) -> Result<(), String> {
    terminate_stale_veslo_server_process(pid)
        .map_err(|error| format!("Failed to terminate stale persisted PID {pid}: {error}"))
}

#[cfg(windows)]
fn terminate_stale_veslo_server_process(pid: u32) -> Result<(), String> {
    use std::process::Stdio;

    use crate::platform::configure_hidden;

    let pid_arg = pid.to_string();
    let mut command = std::process::Command::new("taskkill");
    command
        .args([
            "/PID",
            pid_arg.as_str(),
            "/T",
            "/F",
            "/FI",
            "IMAGENAME eq veslo-server.exe",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_hidden(&mut command);

    let status = command
        .status()
        .map_err(|e| format!("failed to launch taskkill: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("taskkill exited with status {status}"))
    }
}

#[cfg(not(windows))]
fn terminate_stale_veslo_server_process(_pid: u32) -> Result<(), String> {
    Ok(())
}

pub fn recover_persisted_veslo_server_info(
    app: &AppHandle,
) -> Result<Option<VesloServerInfo>, String> {
    let dir = persisted_state_dir(app)?;
    read_persisted_veslo_server_info(&dir)
}

pub fn clear_persisted_veslo_server_info(app: &AppHandle) -> Result<(), String> {
    let dir = persisted_state_dir(app)?;
    let path = persisted_state_path(&dir);
    let plugin_path = persisted_plugin_state_path(&dir);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove {}: {error}", path.display())),
    }?;
    match fs::remove_file(&plugin_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to remove {}: {error}",
            plugin_path.display()
        )),
    }
}

fn write_token_state_file(path: &Path, payload: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
        file.write_all(payload.as_bytes())
            .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
        let mut permissions = file
            .metadata()
            .map_err(|e| format!("Failed to stat {}: {e}", path.display()))?
            .permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(path, permissions)
            .map_err(|e| format!("Failed to chmod {}: {e}", path.display()))?;
        return Ok(());
    }

    #[cfg(not(unix))]
    {
        fs::write(path, payload).map_err(|e| format!("Failed to write {}: {e}", path.display()))
    }
}

fn persist_veslo_server_plugin_state(dir: &Path, info: &VesloServerInfo) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| {
        format!(
            "Failed to create persisted state dir {}: {e}",
            dir.display()
        )
    })?;
    let path = persisted_plugin_state_path(dir);
    let state = PersistedVesloServerPluginState {
        base_url: info.base_url.clone(),
        client_token: info.client_token.clone(),
    };
    let payload = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("Failed to serialize {}: {e}", path.display()))?;
    write_token_state_file(&path, &payload)
}

fn persist_veslo_server_info(app: &AppHandle, info: &VesloServerInfo) -> Result<(), String> {
    let dir = persisted_state_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "Failed to create persisted state dir {}: {e}",
            dir.display()
        )
    })?;
    let path = persisted_state_path(&dir);
    let state = PersistedVesloServerState {
        host: info.host.clone(),
        port: info.port,
        base_url: info.base_url.clone(),
        connect_url: info.connect_url.clone(),
        mdns_url: info.mdns_url.clone(),
        lan_url: info.lan_url.clone(),
        client_token: info.client_token.clone(),
        pid: info.pid,
    };
    let payload = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("Failed to serialize {}: {e}", path.display()))?;
    write_token_state_file(&path, &payload)?;
    persist_veslo_server_plugin_state(&dir, info)
}

pub fn start_veslo_server(
    app: &AppHandle,
    manager: &VesloServerManager,
    workspace_paths: &[String],
    opencode_base_url: Option<&str>,
    opencode_username: Option<&str>,
    opencode_password: Option<&str>,
    opencode_router_health_port: Option<u16>,
) -> Result<VesloServerInfo, String> {
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "veslo server mutex poisoned".to_string())?;

    // VSLO-171 — idempotent skip: if a healthy child is already running with
    // an equivalent workspace set, reuse it instead of kill+respawn. Avoids
    // rotating the bearer token under an active frontend session.
    let normalize_paths = |paths: &[String]| -> Vec<String> {
        let mut normalized: Vec<String> = paths
            .iter()
            .map(|path| path.trim().trim_end_matches('/').to_string())
            .filter(|path| !path.is_empty())
            .collect();
        normalized.sort();
        normalized.dedup();
        normalized
    };
    let requested_paths = normalize_paths(workspace_paths);
    let existing_paths = normalize_paths(&state.workspace_paths);
    if state.child.is_some()
        && !state.child_exited
        && state.client_token.is_some()
        && state.host_token.is_some()
        && state.port.is_some()
        && requested_paths == existing_paths
    {
        let info = VesloServerManager::snapshot_locked(&mut state);
        drop(state);
        // VSLO-86 — re-persist on every idempotent reuse so the on-disk
        // state.json stays in sync with the live in-memory state across
        // long-running sessions (port/token rotations from previous boots
        // would otherwise linger forever, fooling external readers).
        if let Err(error) = persist_veslo_server_info(app, &info) {
            eprintln!("[veslo-server] Failed to re-persist on idempotent reuse: {error}");
        }
        return Ok(info);
    }

    // Need to (re)spawn; keep tokens (if any) so the frontend's cached bearer
    // remains valid across the respawn.
    let previous_client_token = state.client_token.clone();
    let previous_host_token = state.host_token.clone();
    VesloServerManager::stop_locked(&mut state);

    let host = "0.0.0.0".to_string();
    let port = resolve_veslo_port_after_restart()?;
    let client_token = previous_client_token.unwrap_or_else(generate_token);
    let host_token = previous_host_token.unwrap_or_else(generate_token);
    let active_workspace = workspace_paths
        .first()
        .map(|path| path.as_str())
        .unwrap_or("");
    let workspace_ids = resolve_workspace_ids(app, workspace_paths);

    let (rx, child) = spawn_veslo_server(
        app,
        &host,
        port,
        workspace_paths,
        &workspace_ids,
        &client_token,
        &host_token,
        opencode_base_url,
        if active_workspace.is_empty() {
            None
        } else {
            Some(active_workspace)
        },
        opencode_username,
        opencode_password,
        opencode_router_health_port,
    )?;

    state.child = Some(child);
    state.child_exited = false;
    state.host = Some(host.clone());
    state.port = Some(port);
    state.base_url = Some(format!("http://127.0.0.1:{port}"));
    let (connect_url, mdns_url, lan_url) = build_urls(port);
    state.connect_url = connect_url;
    state.mdns_url = mdns_url;
    state.lan_url = lan_url;
    state.client_token = Some(client_token);
    state.host_token = Some(host_token);
    state.workspace_paths = workspace_paths.to_vec();
    state.last_stdout = None;
    state.last_stderr = None;

    let forwarder = app
        .try_state::<Arc<DebugLogsForwarder>>()
        .map(|s| (s.inner().clone(), "veslo-server-shell"));
    spawn_output_collector_with_forwarder(rx, manager.inner.clone(), "Veslo server", forwarder);

    let info = VesloServerManager::snapshot_locked(&mut state);
    drop(state);

    if let Err(error) = persist_veslo_server_info(app, &info) {
        eprintln!("[veslo-server] Failed to persist connection state: {error}");
    }

    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::{
        persist_veslo_server_plugin_state, persisted_veslo_server_plugin_state_path_from_override,
        persisted_veslo_server_state_path_from_override, read_persisted_veslo_server_info,
        read_persisted_veslo_server_info_with_cleanup, PersistedVesloServerState,
    };
    use crate::types::VesloServerInfo;
    use std::fs;
    use std::io::ErrorKind;
    use std::io::Read;
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::{Mutex, OnceLock};
    use std::thread;
    use uuid::Uuid;

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    struct EnvGuard {
        key: &'static str,
        prev: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: String) -> Self {
            let prev = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, prev }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match self.prev.take() {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn persisted_server_state_path_uses_app_local_data_override() {
        let _lock = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = std::env::temp_dir().join(format!("veslo-server-state-path-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test dir");
        let _guard = EnvGuard::set(
            "VESLO_APP_LOCAL_DATA_DIR",
            dir.to_string_lossy().to_string(),
        );

        let path =
            persisted_veslo_server_state_path_from_override().expect("resolve override state path");

        assert_eq!(path, dir.join("veslo-server-state.json"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn persisted_plugin_state_path_uses_app_local_data_override() {
        let _lock = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir =
            std::env::temp_dir().join(format!("veslo-server-plugin-state-path-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test dir");
        let _guard = EnvGuard::set(
            "VESLO_APP_LOCAL_DATA_DIR",
            dir.to_string_lossy().to_string(),
        );

        let path = persisted_veslo_server_plugin_state_path_from_override()
            .expect("resolve plugin state path");

        assert_eq!(path, dir.join("veslo-server-plugin-state.json"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn persist_plugin_state_writes_only_base_url_and_client_token() {
        let dir =
            std::env::temp_dir().join(format!("veslo-server-plugin-state-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test dir");
        let info = VesloServerInfo {
            running: true,
            host: Some("0.0.0.0".to_string()),
            port: Some(8787),
            base_url: Some("http://127.0.0.1:8787".to_string()),
            connect_url: Some("http://127.0.0.1:8787".to_string()),
            mdns_url: None,
            lan_url: None,
            client_token: Some("client-token".to_string()),
            host_token: Some("host-token".to_string()),
            pid: Some(12345),
            last_stdout: None,
            last_stderr: None,
        };

        persist_veslo_server_plugin_state(&dir, &info).expect("persist plugin state");

        let path = dir.join("veslo-server-plugin-state.json");
        let payload = fs::read_to_string(&path).expect("read plugin state");
        let parsed: serde_json::Value = serde_json::from_str(&payload).expect("parse plugin state");
        assert_eq!(parsed["baseUrl"], "http://127.0.0.1:8787");
        assert_eq!(parsed["clientToken"], "client-token");
        assert!(parsed.get("hostToken").is_none());
        assert!(!payload.contains("host-token"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path)
                .expect("plugin state metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn persisted_server_state_serialization_omits_host_token() {
        let state = PersistedVesloServerState {
            host: Some("0.0.0.0".to_string()),
            port: Some(8787),
            base_url: Some("http://127.0.0.1:8787".to_string()),
            connect_url: Some("http://127.0.0.1:8787".to_string()),
            mdns_url: None,
            lan_url: None,
            client_token: Some("client-token".to_string()),
            pid: Some(12345),
        };

        let payload = serde_json::to_string_pretty(&state).expect("serialize state");

        assert!(payload.contains("clientToken"));
        assert!(payload.contains("client-token"));
        assert!(!payload.contains("hostToken"));
        assert!(!payload.contains("host-token"));
    }

    #[test]
    fn read_persisted_server_info_returns_none_without_state() {
        let dir =
            std::env::temp_dir().join(format!("veslo-server-state-missing-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test dir");

        let recovered = read_persisted_veslo_server_info(&dir).expect("read persisted state");
        assert!(recovered.is_none());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_persisted_server_info_recovers_live_server() {
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => listener,
            Err(error) if error.kind() == ErrorKind::PermissionDenied => {
                eprintln!("skipping health recovery test: local TCP bind not permitted ({error})");
                return;
            }
            Err(error) => panic!("bind health listener: {error}"),
        };
        let port = listener.local_addr().expect("listener addr").port();

        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept health request");
            let mut buffer = [0u8; 2048];
            let bytes = stream.read(&mut buffer).expect("read health request");
            let request = String::from_utf8_lossy(&buffer[..bytes]);
            assert!(request.starts_with("GET /health "));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
                )
                .expect("write health response");
        });

        let dir = std::env::temp_dir().join(format!("veslo-server-state-live-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test dir");
        let state = PersistedVesloServerState {
            host: Some("0.0.0.0".to_string()),
            port: Some(port),
            base_url: Some(format!("http://127.0.0.1:{port}")),
            connect_url: Some(format!("http://127.0.0.1:{port}")),
            mdns_url: None,
            lan_url: None,
            client_token: Some("client-token".to_string()),
            pid: Some(12345),
        };
        let mut payload = serde_json::to_value(&state).expect("serialize state to legacy payload");
        payload["hostToken"] = serde_json::Value::String("host-token".to_string());
        fs::write(
            dir.join("veslo-server-state.json"),
            serde_json::to_string_pretty(&payload).expect("serialize legacy state"),
        )
        .expect("write state file");

        let expected_base_url = format!("http://127.0.0.1:{port}");
        let recovered = read_persisted_veslo_server_info(&dir)
            .expect("read persisted state")
            .expect("recover live server info");
        assert_eq!(
            recovered.base_url.as_deref(),
            Some(expected_base_url.as_str())
        );
        assert_eq!(recovered.client_token.as_deref(), Some("client-token"));
        assert_eq!(recovered.host_token.as_deref(), None);
        assert!(recovered.running);

        handle.join().expect("health thread");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_persisted_server_info_recycles_unhealthy_pid() {
        let dir = std::env::temp_dir().join(format!("veslo-server-state-stale-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test dir");
        let state = PersistedVesloServerState {
            host: Some("0.0.0.0".to_string()),
            port: Some(8787),
            base_url: Some("http://127.0.0.1:8787".to_string()),
            connect_url: Some("http://127.0.0.1:8787".to_string()),
            mdns_url: None,
            lan_url: None,
            client_token: Some("client-token".to_string()),
            pid: Some(4242),
        };
        fs::write(
            dir.join("veslo-server-state.json"),
            serde_json::to_string_pretty(&state).expect("serialize state"),
        )
        .expect("write state file");
        fs::write(
            dir.join("veslo-server-plugin-state.json"),
            r#"{"baseUrl":"http://127.0.0.1:8787","clientToken":"client-token"}"#,
        )
        .expect("write plugin state file");

        let mut recycled_pids = Vec::new();
        let recovered = read_persisted_veslo_server_info_with_cleanup(
            &dir,
            |_| false,
            |pid| {
                recycled_pids.push(pid);
                Ok(())
            },
        )
        .expect("read persisted state");

        assert!(recovered.is_none());
        assert_eq!(recycled_pids, vec![4242]);
        assert!(!dir.join("veslo-server-state.json").exists());
        assert!(!dir.join("veslo-server-plugin-state.json").exists());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_persisted_server_info_removes_stale_state_when_pid_recycle_fails() {
        let dir =
            std::env::temp_dir().join(format!("veslo-server-state-stale-fail-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test dir");
        let state = PersistedVesloServerState {
            host: Some("0.0.0.0".to_string()),
            port: Some(8787),
            base_url: Some("http://127.0.0.1:8787".to_string()),
            connect_url: Some("http://127.0.0.1:8787".to_string()),
            mdns_url: None,
            lan_url: None,
            client_token: Some("client-token".to_string()),
            pid: Some(4242),
        };
        fs::write(
            dir.join("veslo-server-state.json"),
            serde_json::to_string_pretty(&state).expect("serialize state"),
        )
        .expect("write state file");
        fs::write(
            dir.join("veslo-server-plugin-state.json"),
            r#"{"baseUrl":"http://127.0.0.1:8787","clientToken":"client-token"}"#,
        )
        .expect("write plugin state file");

        let recovered = read_persisted_veslo_server_info_with_cleanup(
            &dir,
            |_| false,
            |_| Err("taskkill failed".to_string()),
        )
        .expect("cleanup failure should not stop stale state recovery");

        assert!(recovered.is_none());
        assert!(!dir.join("veslo-server-state.json").exists());
        assert!(!dir.join("veslo-server-plugin-state.json").exists());

        let _ = fs::remove_dir_all(dir);
    }
}
