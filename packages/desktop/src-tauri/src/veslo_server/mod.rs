use std::fs;
use std::path::{Path, PathBuf};

use gethostname::gethostname;
use local_ip_address::local_ip;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_shell::process::CommandEvent;
use uuid::Uuid;

use crate::types::VesloServerInfo;
use crate::utils::truncate_output;

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
    app.path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to resolve app local data dir: {e}"))
}

fn server_health_ok(base_url: &str) -> bool {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return false;
    }

    let url = format!("{trimmed}/health");
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_millis(1200))
        .build();

    agent.get(&url).call().map(|response| response.status() == 200).unwrap_or(false)
}

fn persisted_state_to_info(state: PersistedVesloServerState) -> Option<VesloServerInfo> {
    let base_url = state.base_url.clone().filter(|value| !value.trim().is_empty())?;
    if !server_health_ok(&base_url) {
        return None;
    }

    Some(VesloServerInfo {
        running: true,
        host: state.host,
        port: state.port,
        base_url: Some(base_url),
        connect_url: state.connect_url,
        mdns_url: state.mdns_url,
        lan_url: state.lan_url,
        client_token: state.client_token,
        host_token: state.host_token,
        pid: state.pid,
        last_stdout: None,
        last_stderr: None,
    })
}

pub fn read_persisted_veslo_server_info(dir: &Path) -> Result<Option<VesloServerInfo>, String> {
    let path = persisted_state_path(dir);
    if !path.exists() {
        return Ok(None);
    }

    let payload =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let state: PersistedVesloServerState = serde_json::from_str(&payload)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;

    let info = persisted_state_to_info(state);
    if info.is_none() {
        let _ = fs::remove_file(&path);
    }
    Ok(info)
}

pub fn recover_persisted_veslo_server_info(app: &AppHandle) -> Result<Option<VesloServerInfo>, String> {
    let dir = persisted_state_dir(app)?;
    read_persisted_veslo_server_info(&dir)
}

fn persist_veslo_server_info(app: &AppHandle, info: &VesloServerInfo) -> Result<(), String> {
    let dir = persisted_state_dir(app)?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create persisted state dir {}: {e}", dir.display()))?;
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
    VesloServerManager::stop_locked(&mut state);

    let host = "0.0.0.0".to_string();
    let port = resolve_veslo_port()?;
    let client_token = generate_token();
    let host_token = generate_token();
    let active_workspace = workspace_paths
        .first()
        .map(|path| path.as_str())
        .unwrap_or("");

    let (mut rx, child) = spawn_veslo_server(
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
    state.last_stdout = None;
    state.last_stderr = None;

    let state_handle = manager.inner.clone();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    if let Ok(mut state) = state_handle.try_lock() {
                        let next =
                            state.last_stdout.as_deref().unwrap_or_default().to_string() + &line;
                        state.last_stdout = Some(truncate_output(&next, 8000));
                    }
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    if let Ok(mut state) = state_handle.try_lock() {
                        let next =
                            state.last_stderr.as_deref().unwrap_or_default().to_string() + &line;
                        state.last_stderr = Some(truncate_output(&next, 8000));
                    }
                }
                CommandEvent::Terminated(payload) => {
                    if let Ok(mut state) = state_handle.try_lock() {
                        state.child_exited = true;
                        if let Some(code) = payload.code {
                            let next = format!("Veslo server exited (code {code}).");
                            state.last_stderr = Some(truncate_output(&next, 8000));
                        }
                    }
                }
                CommandEvent::Error(message) => {
                    if let Ok(mut state) = state_handle.try_lock() {
                        state.child_exited = true;
                        let next =
                            state.last_stderr.as_deref().unwrap_or_default().to_string() + &message;
                        state.last_stderr = Some(truncate_output(&next, 8000));
                    }
                }
                _ => {}
            }
        }
    });

    let info = VesloServerManager::snapshot_locked(&mut state);
    drop(state);

    if let Err(error) = persist_veslo_server_info(app, &info) {
        eprintln!("[veslo-server] Failed to persist connection state: {error}");
    }

    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::{read_persisted_veslo_server_info, PersistedVesloServerState};
    use std::fs;
    use std::io::Read;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;
    use uuid::Uuid;

    #[test]
    fn read_persisted_server_info_returns_none_without_state() {
        let dir = std::env::temp_dir().join(format!("veslo-server-state-missing-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test dir");

        let recovered = read_persisted_veslo_server_info(&dir).expect("read persisted state");
        assert!(recovered.is_none());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_persisted_server_info_recovers_live_server() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind health listener");
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
        assert_eq!(recovered.base_url.as_deref(), Some(expected_base_url.as_str()));
        assert_eq!(recovered.client_token.as_deref(), Some("client-token"));
        assert_eq!(recovered.host_token.as_deref(), Some("host-token"));
        assert!(recovered.running);

        handle.join().expect("health thread");
        let _ = fs::remove_dir_all(dir);
    }
}
