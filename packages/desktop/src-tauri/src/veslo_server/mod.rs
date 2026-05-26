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

#[derive(Debug, Clone, Default)]
pub(crate) struct HealthIdentity {
    pub token: Option<String>,
    pub pid: Option<u32>,
}

pub(crate) fn server_health_identity(base_url: &str) -> Option<HealthIdentity> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }

    let url = format!("{trimmed}/health");
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_millis(1200))
        .build();

    let response = agent.get(&url).call().ok()?;
    if response.status() != 200 {
        return None;
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HealthResponse {
        #[serde(default)]
        token: Option<String>,
        #[serde(default)]
        pid: Option<u32>,
    }

    let body: HealthResponse = response.into_json().ok()?;
    Some(HealthIdentity {
        token: body.token,
        pid: body.pid,
    })
}

fn persisted_state_to_info_with_health(
    state: &PersistedVesloServerState,
    health_check: impl Fn(&str) -> Option<HealthIdentity>,
) -> Option<VesloServerInfo> {
    let base_url = state
        .base_url
        .clone()
        .filter(|value| !value.trim().is_empty())?;

    let identity = health_check(&base_url)?;

    // Identity validation — reject if persisted token/pid doesn't match what the
    // server on this port actually reports. Tolerate None fields on either side
    // for backward compatibility with legacy servers that don't yet expose identity.
    if let (Some(expected), Some(actual)) =
        (state.client_token.as_deref(), identity.token.as_deref())
    {
        if expected != actual {
            eprintln!(
                "[veslo-server] identity mismatch — token on {base_url} does not match persisted state, rejecting"
            );
            return None;
        }
    }
    if let (Some(expected), Some(actual)) = (state.pid, identity.pid) {
        if expected != actual {
            eprintln!(
                "[veslo-server] identity mismatch — pid on {base_url} is {actual}, expected {expected}, rejecting"
            );
            return None;
        }
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
    health_check: impl Fn(&str) -> Option<HealthIdentity>,
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
    }
    Ok(info)
}

pub fn read_persisted_veslo_server_info(dir: &Path) -> Result<Option<VesloServerInfo>, String> {
    read_persisted_veslo_server_info_with_cleanup(dir, server_health_identity, |pid| {
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
    let from_disk = read_persisted_veslo_server_info(&dir)?;
    if from_disk.is_some() {
        return Ok(from_disk);
    }

    // Dev fallback: a `pnpm dev` workflow can spawn veslo-server outside of
    // Rust (via `bun --watch`), in which case Tauri never wrote state.json.
    // If the dev scripts expose `VESLO_DEV_SERVER_URL` we probe it, adopt
    // the live token+pid from /health, and persist so subsequent reads stay
    // consistent. Skipped in release builds (env var unset by default).
    if let Some(info) = discover_external_veslo_server() {
        let _ = persist_veslo_server_info(app, &info);
        return Ok(Some(info));
    }

    Ok(None)
}

fn discover_external_veslo_server() -> Option<VesloServerInfo> {
    let base_url = std::env::var("VESLO_DEV_SERVER_URL").ok()?;
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let identity = server_health_identity(trimmed)?;
    let port = trimmed
        .rsplit_once(':')
        .and_then(|(_, tail)| tail.split('/').next())
        .and_then(|p| p.parse::<u16>().ok());
    let (connect_url, mdns_url, lan_url) = match port {
        Some(p) => build_urls(p),
        None => (None, None, None),
    };
    Some(VesloServerInfo {
        running: true,
        host: Some("0.0.0.0".to_string()),
        port,
        base_url: Some(trimmed.to_string()),
        connect_url,
        mdns_url,
        lan_url,
        client_token: identity.token,
        host_token: None,
        pid: identity.pid,
        last_stdout: None,
        last_stderr: None,
    })
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
    // VSLO-86 — extend caller-supplied workspaces with every local workspace
    // from veslo-workspaces.json before spawn. The frontend passes only the
    // current/active workspace in engine_start, so a freshly-spawned veslo-
    // server otherwise only knows about that one entry. A sidebar click on
    // any other locally-registered workspace then 404s on /workspaces/:id/
    // activate and the activate handler times out at 12s, leaving the user
    // staring at "Opening conversation…". Pulling the local store now means
    // veslo-server's --workspace args mirror what the sidebar shows.
    let mut workspace_paths_owned: Vec<String> = workspace_paths.to_vec();
    if let Ok(state) = crate::workspace::state::load_workspace_state(app) {
        for ws in state.workspaces.iter() {
            if !matches!(ws.workspace_type, crate::types::WorkspaceType::Local) {
                continue;
            }
            let trimmed = ws.path.trim();
            if trimmed.is_empty() {
                continue;
            }
            if !workspace_paths_owned.iter().any(|p| p.trim() == trimmed) {
                workspace_paths_owned.push(trimmed.to_string());
            }
        }
    }
    let workspace_paths: &[String] = &workspace_paths_owned;

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
        HealthIdentity, PersistedVesloServerState,
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
            |_| None,
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
            host_token: Some("host-token".to_string()),
            pid: Some(4242),
        };
        fs::write(
            dir.join("veslo-server-state.json"),
            serde_json::to_string_pretty(&state).expect("serialize state"),
        )
        .expect("write state file");

        let recovered = read_persisted_veslo_server_info_with_cleanup(
            &dir,
            |_| None,
            |_| Err("taskkill failed".to_string()),
        )
        .expect("cleanup failure should not stop stale state recovery");

        assert!(recovered.is_none());
        assert!(!dir.join("veslo-server-state.json").exists());

        let _ = fs::remove_dir_all(dir);
    }

    fn write_persisted_state(dir: &std::path::Path, state: &PersistedVesloServerState) {
        fs::write(
            dir.join("veslo-server-state.json"),
            serde_json::to_string_pretty(state).expect("serialize state"),
        )
        .expect("write state file");
    }

    fn sample_state(token: &str, pid: u32) -> PersistedVesloServerState {
        PersistedVesloServerState {
            host: Some("0.0.0.0".to_string()),
            port: Some(8787),
            base_url: Some("http://127.0.0.1:8787".to_string()),
            connect_url: Some("http://127.0.0.1:8787".to_string()),
            mdns_url: None,
            lan_url: None,
            client_token: Some(token.to_string()),
            host_token: Some("host-token".to_string()),
            pid: Some(pid),
        }
    }

    #[test]
    fn read_persisted_server_info_rejects_token_mismatch() {
        let dir =
            std::env::temp_dir().join(format!("veslo-server-state-token-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test dir");
        write_persisted_state(&dir, &sample_state("our-token", 4242));

        let recovered = read_persisted_veslo_server_info_with_cleanup(
            &dir,
            |_| {
                Some(HealthIdentity {
                    token: Some("foreign-token".to_string()),
                    pid: Some(4242),
                })
            },
            |_| Ok(()),
        )
        .expect("read persisted state");

        assert!(recovered.is_none(), "token mismatch must reject persisted state");
        assert!(
            !dir.join("veslo-server-state.json").exists(),
            "stale state file must be removed when identity check fails"
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_persisted_server_info_rejects_pid_mismatch() {
        let dir =
            std::env::temp_dir().join(format!("veslo-server-state-pid-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test dir");
        write_persisted_state(&dir, &sample_state("our-token", 4242));

        let recovered = read_persisted_veslo_server_info_with_cleanup(
            &dir,
            |_| {
                Some(HealthIdentity {
                    token: Some("our-token".to_string()),
                    pid: Some(9999),
                })
            },
            |_| Ok(()),
        )
        .expect("read persisted state");

        assert!(recovered.is_none(), "pid mismatch must reject persisted state");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_persisted_server_info_tolerates_legacy_server_without_identity() {
        let dir =
            std::env::temp_dir().join(format!("veslo-server-state-legacy-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test dir");
        write_persisted_state(&dir, &sample_state("our-token", 4242));

        let recovered = read_persisted_veslo_server_info_with_cleanup(
            &dir,
            |_| Some(HealthIdentity::default()),
            |_| Ok(()),
        )
        .expect("read persisted state")
        .expect("legacy server response must still recover persisted state");

        assert_eq!(recovered.client_token.as_deref(), Some("our-token"));
        assert_eq!(recovered.pid, Some(4242));
        assert!(recovered.running);

        let _ = fs::remove_dir_all(dir);
    }
}
