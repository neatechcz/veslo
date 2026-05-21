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
use crate::types::VesloServerInfo;
use std::sync::Arc;

pub mod manager;
pub mod spawn;

use manager::VesloServerManager;
use spawn::{resolve_veslo_port, spawn_veslo_server};

const PERSISTED_STATE_FILE_NAME: &str = "veslo-server-state.json";

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
    pub host_token: Option<String>,
    pub pid: Option<u32>,
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

pub fn resolve_connect_url(port: u16) -> Option<String> {
    let (connect_url, _mdns_url, _lan_url) = build_urls(port);
    connect_url
}

fn persisted_state_path(dir: &Path) -> PathBuf {
    dir.join(PERSISTED_STATE_FILE_NAME)
}

fn persisted_state_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(override_dir) = crate::paths::app_local_data_dir_override() {
        return Ok(override_dir);
    }

    app.path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to resolve app local data dir: {e}"))
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
        host_token: state.host_token.clone(),
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
            cleanup_stale_pid(pid)?;
        }
        let _ = fs::remove_file(&path);
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
    let pid_arg = pid.to_string();
    let status = std::process::Command::new("taskkill")
        .args([
            "/PID",
            pid_arg.as_str(),
            "/T",
            "/F",
            "/FI",
            "IMAGENAME eq veslo-server.exe",
        ])
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
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove {}: {error}", path.display())),
    }
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
        host_token: info.host_token.clone(),
        pid: info.pid,
    };
    fs::write(
        &path,
        serde_json::to_string_pretty(&state)
            .map_err(|e| format!("Failed to serialize {}: {e}", path.display()))?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", path.display()))
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
    let port = resolve_veslo_port()?;
    let client_token = previous_client_token.unwrap_or_else(generate_token);
    let host_token = previous_host_token.unwrap_or_else(generate_token);
    let active_workspace = workspace_paths
        .first()
        .map(|path| path.as_str())
        .unwrap_or("");

    let (rx, child) = spawn_veslo_server(
        app,
        &host,
        port,
        workspace_paths,
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
        read_persisted_veslo_server_info, read_persisted_veslo_server_info_with_cleanup,
        PersistedVesloServerState,
    };
    use std::fs;
    use std::io::ErrorKind;
    use std::io::Read;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;
    use uuid::Uuid;

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
            host_token: Some("host-token".to_string()),
            pid: Some(12345),
        };
        fs::write(
            dir.join("veslo-server-state.json"),
            serde_json::to_string_pretty(&state).expect("serialize state"),
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
        assert_eq!(recovered.host_token.as_deref(), Some("host-token"));
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
            host_token: Some("host-token".to_string()),
            pid: Some(4242),
        };
        fs::write(
            dir.join("veslo-server-state.json"),
            serde_json::to_string_pretty(&state).expect("serialize state"),
        )
        .expect("write state file");

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

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_persisted_server_info_keeps_state_when_pid_recycle_fails() {
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
            host_token: Some("host-token".to_string()),
            pid: Some(4242),
        };
        fs::write(
            dir.join("veslo-server-state.json"),
            serde_json::to_string_pretty(&state).expect("serialize state"),
        )
        .expect("write state file");

        let error = read_persisted_veslo_server_info_with_cleanup(
            &dir,
            |_| false,
            |_| Err("taskkill failed".to_string()),
        )
        .expect_err("cleanup failure should stop recovery");

        assert!(error.contains("taskkill failed"));
        assert!(dir.join("veslo-server-state.json").exists());

        let _ = fs::remove_dir_all(dir);
    }
}
