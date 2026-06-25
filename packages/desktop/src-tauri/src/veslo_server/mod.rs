use std::fs;
#[cfg(windows)]
use std::net::IpAddr;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Command;

use gethostname::gethostname;
#[cfg(windows)]
use local_ip_address::list_afinet_netifas;
use local_ip_address::local_ip;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::Manager;
use uuid::Uuid;

use crate::debug_logs_forwarder::DebugLogsForwarder;
#[cfg(windows)]
use crate::platform::configure_hidden;
use crate::process_supervisor::spawn_output_collector_with_forwarder;
use crate::types::{VesloServerInfo, WorkspaceType};
use crate::workspace::state::load_workspace_state;
use std::sync::Arc;

pub mod manager;
pub mod spawn;

use manager::VesloServerManager;
use spawn::{
    host_from_http_url, resolve_veslo_host, resolve_veslo_port_after_restart, spawn_veslo_server,
};

const PERSISTED_STATE_FILE_NAME: &str = "veslo-server-state.json";
const PERSISTED_PLUGIN_STATE_FILE_NAME: &str = "veslo-server-plugin-state.json";

fn append_veslo_server_launch_diagnostic(
    app: &AppHandle,
    event_type: &str,
    payload: serde_json::Value,
) {
    if let Some(forwarder) = app.try_state::<Arc<DebugLogsForwarder>>() {
        forwarder.append_bootstrap_diagnostic(event_type, payload);
    }
}

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

pub(crate) fn resolve_engine_url(port: u16) -> Option<String> {
    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        if let Ok(interfaces) = list_afinet_netifas() {
            candidates.extend(resolve_engine_urls_from_interfaces(
                port,
                interfaces.into_iter(),
            ));
        }
        if let Some(url) = resolve_engine_url_from_wsl_interface(port) {
            candidates.push(url);
        }
        resolve_engine_url_from_candidates(candidates, probe_engine_url_from_wsl)
    }

    #[cfg(not(windows))]
    {
        let _ = port;
        None
    }
}

/// Discover a WSL-reachable bind address (the WSL virtual adapter IP) WITHOUT
/// probing it. Used before spawn to decide the `--bridge-host` the server
/// should additionally listen on. The probe in `resolve_engine_url_for_bridge_host`
/// only succeeds once the server is actually listening there, so discovery must
/// be probe-free. See VSLO-250.
#[cfg(windows)]
pub(crate) fn resolve_wsl_bridge_host() -> Option<String> {
    if let Ok(interfaces) = list_afinet_netifas() {
        for (name, ip) in interfaces {
            if name.to_ascii_lowercase().contains("wsl") && ip.is_ipv4() && !ip.is_loopback() {
                return Some(ip.to_string());
            }
        }
    }
    resolve_wsl_bridge_host_from_powershell()
}

#[cfg(not(windows))]
pub(crate) fn resolve_wsl_bridge_host() -> Option<String> {
    None
}

#[cfg(windows)]
fn resolve_wsl_bridge_host_from_powershell() -> Option<String> {
    let mut command = Command::new("powershell");
    configure_hidden(&mut command);
    let output = command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            "Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias '*WSL*' | Select-Object -ExpandProperty IPAddress",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_wsl_bridge_host_from_powershell_output(&stdout)
}

#[cfg(windows)]
fn parse_wsl_bridge_host_from_powershell_output(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let value = line.trim().trim_matches('"').trim_matches('\'');
        let ip = value.parse::<IpAddr>().ok()?;
        if ip.is_ipv4() && !ip.is_loopback() {
            Some(ip.to_string())
        } else {
            None
        }
    })
}

/// Build and validate the engineUrl for an already-chosen bridge host by probing
/// `<url>/health` from inside WSL. Returns `Some(url)` only when WSL can actually
/// reach it, so a published engineUrl is always proven reachable. See VSLO-250.
#[cfg(windows)]
pub(crate) fn resolve_engine_url_for_bridge_host(bridge_host: &str, port: u16) -> Option<String> {
    let host = bridge_host.trim();
    if host.is_empty() || is_loopback_bind_host(host) {
        return None;
    }
    let url = format!("http://{host}:{port}");
    if probe_engine_url_from_wsl(&url) {
        Some(url)
    } else {
        None
    }
}

#[cfg(not(windows))]
pub(crate) fn resolve_engine_url_for_bridge_host(_bridge_host: &str, _port: u16) -> Option<String> {
    None
}

/// The WSL bridge listener is only meaningful when the active sandbox backend is
/// `windows-wsl2` and the primary bind stays on loopback. With sandboxing
/// disabled — e.g. a shared unsandboxed engine, which requires
/// `VESLO_DISABLE_SANDBOX=1` — OpenCode runs directly on Windows and reaches the
/// gateway over loopback, so a WSL bridge would be unused and would wrongly pin a
/// direct engine to the WSL adapter IP. A non-loopback primary bind already
/// covers WSL. See VSLO-250.
fn should_bind_wsl_bridge(host: &str, sandbox_backend: &str) -> bool {
    is_loopback_bind_host(host) && sandbox_backend == "windows-wsl2"
}

#[cfg(windows)]
fn format_engine_url_from_ip(ip: IpAddr, port: u16) -> Option<String> {
    if !ip.is_ipv4() || ip.is_loopback() {
        return None;
    }
    Some(format!("http://{ip}:{port}"))
}

#[cfg(windows)]
fn resolve_engine_urls_from_interfaces(
    port: u16,
    interfaces: impl IntoIterator<Item = (String, IpAddr)>,
) -> Vec<String> {
    interfaces
        .into_iter()
        .filter_map(|(name, ip)| {
            let name = name.to_ascii_lowercase();
            if !name.contains("wsl") {
                return None;
            }
            format_engine_url_from_ip(ip, port)
        })
        .collect()
}

#[cfg(windows)]
fn resolve_engine_url_from_interfaces(
    port: u16,
    interfaces: impl IntoIterator<Item = (String, IpAddr)>,
) -> Option<String> {
    resolve_engine_urls_from_interfaces(port, interfaces)
        .into_iter()
        .next()
}

#[cfg(windows)]
fn resolve_engine_url_from_candidates(
    candidates: impl IntoIterator<Item = String>,
    mut probe: impl FnMut(&str) -> bool,
) -> Option<String> {
    let mut seen = Vec::<String>::new();
    for candidate in candidates {
        let trimmed = candidate.trim().trim_end_matches('/').to_string();
        if trimmed.is_empty() || seen.iter().any(|value| value == &trimmed) {
            continue;
        }
        seen.push(trimmed.clone());
        if probe(&trimmed) {
            return Some(trimmed);
        }
    }
    None
}

#[cfg(windows)]
fn parse_wsl_engine_url_from_powershell_output(output: &str, port: u16) -> Option<String> {
    output.lines().find_map(|line| {
        let value = line.trim().trim_matches('"').trim_matches('\'');
        let ip = value.parse::<IpAddr>().ok()?;
        format_engine_url_from_ip(ip, port)
    })
}

#[cfg(windows)]
fn resolve_engine_url_from_wsl_interface(port: u16) -> Option<String> {
    let mut command = Command::new("powershell");
    configure_hidden(&mut command);
    let output = command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            "Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias '*WSL*' | Select-Object -ExpandProperty IPAddress",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_wsl_engine_url_from_powershell_output(&stdout, port)
}

#[cfg(windows)]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(windows)]
fn probe_engine_url_from_wsl_once(url: &str) -> bool {
    let health_url = format!("{}/health", url.trim_end_matches('/'));
    let script = format!(
        "URL={}; \
         if command -v curl >/dev/null 2>&1; then \
           curl --connect-timeout 1 --max-time 1 -fsS \"$URL\" >/dev/null; \
         elif command -v wget >/dev/null 2>&1; then \
           wget --timeout=1 --tries=1 -q -O /dev/null \"$URL\"; \
         else \
           exit 127; \
         fi",
        shell_quote(&health_url)
    );
    let mut command = Command::new("wsl.exe");
    configure_hidden(&mut command);
    command
        .args(["-e", "sh", "-c", &script])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn probe_engine_url_from_wsl(url: &str) -> bool {
    for attempt in 0..2 {
        if probe_engine_url_from_wsl_once(url) {
            return true;
        }
        if attempt == 0 {
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    }
    eprintln!("[veslo-server] WSL engineUrl probe failed for {url}");
    false
}

fn is_loopback_bind_host(host: &str) -> bool {
    let normalized = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    normalized.is_empty()
        || normalized == "localhost"
        || normalized == "::1"
        || normalized.starts_with("127.")
}

pub(crate) fn publishes_external_urls(host: Option<&str>) -> bool {
    host.map(|value| !is_loopback_bind_host(value))
        .unwrap_or(false)
}

pub(crate) fn resolve_engine_url_for_bind_host(
    host: Option<&str>,
    port: Option<u16>,
) -> Option<String> {
    if !publishes_external_urls(host) {
        return None;
    }
    port.and_then(resolve_engine_url)
}

fn build_urls_for_host_with_engine_resolver(
    host: &str,
    port: u16,
    mut engine_url_resolver: impl FnMut(u16) -> Option<String>,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    if is_loopback_bind_host(host) {
        return (None, None, None, None);
    }

    let hostname = gethostname().to_string_lossy().trim().to_string();
    let mdns_url = if hostname.is_empty() {
        None
    } else {
        let trimmed = hostname.trim_end_matches(".local");
        Some(format!("http://{trimmed}.local:{port}"))
    };

    let lan_url = local_ip().ok().map(|ip| format!("http://{ip}:{port}"));

    let connect_url = lan_url.clone().or(mdns_url.clone());
    let engine_url = engine_url_resolver(port);

    (connect_url, mdns_url, lan_url, engine_url)
}

fn build_urls_for_host(
    host: &str,
    port: u16,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    build_urls_for_host_with_engine_resolver(host, port, resolve_engine_url)
}

pub fn resolve_connect_url(port: u16) -> Option<String> {
    let (connect_url, _mdns_url, _lan_url, _engine_url) = build_urls_for_host("0.0.0.0", port);
    connect_url
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
    // A matching bearer token is stronger than a PID match. In dev watch mode,
    // the managed Bun watcher PID can differ from the HTTP server PID.
    let token_verified = matches!(
        (state.client_token.as_deref(), identity.token.as_deref()),
        (Some(expected), Some(actual)) if expected == actual
    );

    // Identity validation: the bearer token is the strongest signal. PID checks
    // still protect older persisted state that cannot verify a token.
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
    if !token_verified {
        if let (Some(expected), Some(actual)) = (state.pid, identity.pid) {
            if expected != actual {
                eprintln!(
                "[veslo-server] identity mismatch — pid on {base_url} is {actual}, expected {expected}, rejecting"
            );
                return None;
            }
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
        engine_url: resolve_engine_url_for_bind_host(state.host.as_deref(), state.port),
        client_token: state.client_token.clone(),
        host_token: None,
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
        let _ = fs::remove_file(persisted_plugin_state_path(dir));
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
    let host = host_from_http_url(trimmed).unwrap_or_else(|| "127.0.0.1".to_string());
    let (connect_url, mdns_url, lan_url, engine_url) = match port {
        Some(p) => build_urls_for_host(&host, p),
        None => (None, None, None, None),
    };
    Some(VesloServerInfo {
        running: true,
        host: Some(host),
        port,
        base_url: Some(trimmed.to_string()),
        connect_url,
        mdns_url,
        lan_url,
        engine_url,
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

fn normalize_workspace_paths(paths: &[String]) -> Vec<String> {
    let mut normalized: Vec<String> = paths
        .iter()
        .map(|path| path.trim().trim_end_matches('/').to_string())
        .filter(|path| !path.is_empty())
        .collect();
    normalized.sort();
    normalized.dedup();
    normalized
}

fn normalize_launch_url(value: Option<&str>) -> Option<String> {
    value
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_launch_token(value: Option<&str>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn launch_config_matches(
    state: &manager::VesloServerState,
    workspace_paths: &[String],
    host: &str,
    bridge_host: &Option<String>,
    opencode_base_url: &Option<String>,
    orchestrator_daemon_url: &Option<String>,
    orchestrator_lifecycle_token: &Option<String>,
) -> bool {
    normalize_workspace_paths(workspace_paths) == normalize_workspace_paths(&state.workspace_paths)
        && state.host.as_deref() == Some(host)
        && state.bridge_host == *bridge_host
        && state.opencode_base_url == *opencode_base_url
        && state.orchestrator_daemon_url == *orchestrator_daemon_url
        && state.orchestrator_lifecycle_token == *orchestrator_lifecycle_token
}

pub fn start_veslo_server(
    app: &AppHandle,
    manager: &VesloServerManager,
    workspace_paths: &[String],
    opencode_base_url: Option<&str>,
    opencode_username: Option<&str>,
    opencode_password: Option<&str>,
    opencode_router_health_port: Option<u16>,
    orchestrator_daemon_url: Option<&str>,
    orchestrator_lifecycle_token: Option<&str>,
    veslo_server_client_token: Option<&str>,
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
    let normalized_opencode_base_url = normalize_launch_url(opencode_base_url);
    let normalized_orchestrator_daemon_url = normalize_launch_url(orchestrator_daemon_url);
    let normalized_orchestrator_lifecycle_token =
        normalize_launch_token(orchestrator_lifecycle_token);
    let requested_client_token = normalize_launch_token(veslo_server_client_token);
    let host = resolve_veslo_host();
    // VSLO-250: determine the expected WSL bridge before idempotent reuse, so a
    // previous loopback-only server cannot be reused while we publish bridge URLs.
    // Gate on the active sandbox backend (the same source the server is told via
    // VESLO_SANDBOX_BACKEND): with sandboxing disabled the engine is direct and
    // routes over loopback, so no WSL bridge is set up.
    let bridge_host = if should_bind_wsl_bridge(&host, &spawn::resolve_server_sandbox_backend()) {
        resolve_wsl_bridge_host()
    } else {
        None
    };
    let client_token_matches_request = requested_client_token.as_ref().map_or(true, |token| {
        state.client_token.as_deref() == Some(token.as_str())
    });
    if state.child.is_some()
        && !state.child_exited
        && state.client_token.is_some()
        && client_token_matches_request
        && state.host_token.is_some()
        && state.port.is_some()
        && launch_config_matches(
            &state,
            workspace_paths,
            &host,
            &bridge_host,
            &normalized_opencode_base_url,
            &normalized_orchestrator_daemon_url,
            &normalized_orchestrator_lifecycle_token,
        )
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

    let port = match resolve_veslo_port_after_restart(&host) {
        Ok(port) => port,
        Err(error) => {
            append_veslo_server_launch_diagnostic(
                app,
                "veslo-server-launch:port-resolve-failed",
                serde_json::json!({ "error": error }),
            );
            return Err(error);
        }
    };
    let client_token = requested_client_token
        .or(previous_client_token)
        .unwrap_or_else(generate_token);
    let host_token = previous_host_token.unwrap_or_else(generate_token);
    let active_workspace = workspace_paths
        .first()
        .map(|path| path.as_str())
        .unwrap_or("");
    let workspace_ids = resolve_workspace_ids(app, workspace_paths);

    append_veslo_server_launch_diagnostic(
        app,
        "veslo-server-launch:spawn-start",
        serde_json::json!({
            "port": port,
            "workspaceCount": workspace_paths.len(),
            "workspaceIds": workspace_ids.clone(),
            "hasOpencodeBaseUrl": normalized_opencode_base_url.is_some(),
            "hasOpencodeRouterHealthPort": opencode_router_health_port.is_some(),
            "hasOrchestratorDaemonUrl": normalized_orchestrator_daemon_url.is_some(),
            "hasOrchestratorLifecycleToken": normalized_orchestrator_lifecycle_token.is_some(),
        }),
    );

    let (rx, child) = match spawn_veslo_server(
        app,
        &host,
        port,
        workspace_paths,
        &workspace_ids,
        &client_token,
        &host_token,
        normalized_opencode_base_url.as_deref(),
        if active_workspace.is_empty() {
            None
        } else {
            Some(active_workspace)
        },
        opencode_username,
        opencode_password,
        opencode_router_health_port,
        normalized_orchestrator_daemon_url.as_deref(),
        normalized_orchestrator_lifecycle_token.as_deref(),
        bridge_host.as_deref(),
    ) {
        Ok(result) => {
            append_veslo_server_launch_diagnostic(
                app,
                "veslo-server-launch:spawn-succeeded",
                serde_json::json!({
                    "port": port,
                    "workspaceCount": workspace_paths.len(),
                }),
            );
            result
        }
        Err(error) => {
            append_veslo_server_launch_diagnostic(
                app,
                "veslo-server-launch:spawn-failed",
                serde_json::json!({
                    "port": port,
                    "workspaceCount": workspace_paths.len(),
                    "error": error,
                }),
            );
            return Err(error);
        }
    };

    state.child = Some(child);
    state.child_exited = false;
    state.host = Some(host.clone());
    state.bridge_host = bridge_host.clone();
    state.port = Some(port);
    state.base_url = Some(format!("http://127.0.0.1:{port}"));
    let (connect_url, mdns_url, lan_url, engine_url) = build_urls_for_host(&host, port);
    state.connect_url = connect_url;
    state.mdns_url = mdns_url;
    state.lan_url = lan_url;
    state.engine_url = engine_url;
    // With a WSL bridge the engineUrl is published lazily, only after a WSL-side
    // /health probe proves reachability. Leave the checked-at timestamp unset so
    // the next veslo_server_info poll refreshes immediately instead of waiting
    // out the TTL; a non-loopback primary bind keeps the original behavior.
    state.engine_url_checked_at = if bridge_host.is_some() {
        None
    } else {
        Some(std::time::Instant::now())
    };
    state.engine_url_refresh_started_at = None;
    state.client_token = Some(client_token);
    state.host_token = Some(host_token);
    state.workspace_paths = workspace_paths.to_vec();
    state.opencode_base_url = normalized_opencode_base_url;
    state.orchestrator_daemon_url = normalized_orchestrator_daemon_url;
    state.orchestrator_lifecycle_token = normalized_orchestrator_lifecycle_token;
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
        append_veslo_server_launch_diagnostic(
            app,
            "veslo-server-launch:persist-state-failed",
            serde_json::json!({ "error": error }),
        );
    }

    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::manager::VesloServerState;
    use super::{
        build_urls_for_host_with_engine_resolver, launch_config_matches, normalize_launch_token,
        normalize_launch_url, publishes_external_urls, read_persisted_veslo_server_info,
        read_persisted_veslo_server_info_with_cleanup, resolve_engine_url_for_bind_host,
        should_bind_wsl_bridge, HealthIdentity, PersistedVesloServerState,
    };
    #[cfg(windows)]
    use super::{
        parse_wsl_engine_url_from_powershell_output, resolve_engine_url_from_candidates,
        resolve_engine_url_from_interfaces,
    };
    use std::fs;
    use std::io::ErrorKind;
    use std::io::Read;
    use std::io::Write;
    use std::net::TcpListener;
    #[cfg(windows)]
    use std::net::{IpAddr, Ipv4Addr};
    use std::thread;
    use uuid::Uuid;

    #[cfg(windows)]
    #[test]
    fn resolve_engine_url_uses_wsl_interface_address() {
        let interfaces = vec![
            (
                "vEthernet (Default Switch)".to_string(),
                IpAddr::V4(Ipv4Addr::new(172, 18, 16, 1)),
            ),
            (
                "vEthernet (WSL (Hyper-V firewall))".to_string(),
                IpAddr::V4(Ipv4Addr::new(172, 29, 64, 1)),
            ),
        ];

        assert_eq!(
            resolve_engine_url_from_interfaces(8787, interfaces).as_deref(),
            Some("http://172.29.64.1:8787")
        );
    }

    #[cfg(windows)]
    #[test]
    fn parse_wsl_engine_url_from_powershell_output_skips_loopback() {
        let output = "\r\n127.0.0.1\r\n172.29.64.1\r\n";

        assert_eq!(
            parse_wsl_engine_url_from_powershell_output(output, 8787).as_deref(),
            Some("http://172.29.64.1:8787")
        );
    }

    #[cfg(windows)]
    #[test]
    fn resolve_engine_url_from_candidates_requires_probe_success() {
        let candidates = vec![
            "http://172.29.64.1:8787".to_string(),
            "http://172.30.64.1:8787".to_string(),
        ];

        assert_eq!(
            resolve_engine_url_from_candidates(candidates, |url| {
                url == "http://172.30.64.1:8787"
            })
            .as_deref(),
            Some("http://172.30.64.1:8787")
        );
    }

    #[cfg(windows)]
    #[test]
    fn resolve_engine_url_from_candidates_dedupes_candidates() {
        let mut probes = 0;
        let candidates = vec![
            "http://172.29.64.1:8787".to_string(),
            "http://172.29.64.1:8787/".to_string(),
        ];

        assert_eq!(
            resolve_engine_url_from_candidates(candidates, |_| {
                probes += 1;
                false
            }),
            None
        );
        assert_eq!(probes, 1);
    }

    #[test]
    fn loopback_bind_does_not_publish_external_or_engine_urls() {
        let mut engine_probe_called = false;
        let (connect_url, mdns_url, lan_url, engine_url) =
            build_urls_for_host_with_engine_resolver("127.0.0.1", 8787, |_| {
                engine_probe_called = true;
                Some("http://172.29.64.1:8787".to_string())
            });

        assert_eq!(connect_url, None);
        assert_eq!(mdns_url, None);
        assert_eq!(lan_url, None);
        assert_eq!(engine_url, None);
        assert!(!engine_probe_called);
        assert!(!publishes_external_urls(Some("127.0.0.1")));
        assert!(!publishes_external_urls(Some("localhost")));
        assert!(!publishes_external_urls(None));
    }

    #[test]
    fn external_bind_preserves_engine_url_resolution() {
        let (_connect_url, _mdns_url, _lan_url, engine_url) =
            build_urls_for_host_with_engine_resolver("0.0.0.0", 8787, |_| {
                Some("http://172.29.64.1:8787".to_string())
            });

        assert_eq!(engine_url.as_deref(), Some("http://172.29.64.1:8787"));
        assert!(publishes_external_urls(Some("0.0.0.0")));
    }

    #[test]
    fn engine_url_resolution_is_gated_by_bind_host() {
        assert_eq!(
            resolve_engine_url_for_bind_host(Some("127.0.0.1"), Some(8787)),
            None
        );
        assert_eq!(resolve_engine_url_for_bind_host(None, Some(8787)), None);
    }

    #[test]
    fn wsl_bridge_only_binds_for_loopback_wsl2_backend() {
        assert!(should_bind_wsl_bridge("127.0.0.1", "windows-wsl2"));
        assert!(should_bind_wsl_bridge("localhost", "windows-wsl2"));
        // A non-loopback primary bind already reaches WSL; no extra bridge.
        assert!(!should_bind_wsl_bridge("0.0.0.0", "windows-wsl2"));
        // Sandbox disabled (shared unsandboxed engine) -> direct engine, loopback.
        assert!(!should_bind_wsl_bridge("127.0.0.1", "none"));
        assert!(!should_bind_wsl_bridge("127.0.0.1", "windows-job-object"));
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
    fn launch_config_restarts_when_opencode_base_url_changes() {
        let state = VesloServerState {
            workspace_paths: vec!["/workspace/project".to_string()],
            host: Some("127.0.0.1".to_string()),
            bridge_host: Some("172.29.64.1".to_string()),
            opencode_base_url: normalize_launch_url(Some(
                "http://127.0.0.1:59104/workspace//opencode/",
            )),
            orchestrator_daemon_url: normalize_launch_url(Some("http://127.0.0.1:59104/")),
            orchestrator_lifecycle_token: normalize_launch_token(Some("lifecycle-token")),
            ..Default::default()
        };
        let workspace_paths = vec!["/workspace/project/".to_string()];
        let bridge_host = Some("172.29.64.1".to_string());
        let daemon_url = normalize_launch_url(Some("http://127.0.0.1:59104"));
        let lifecycle_token = normalize_launch_token(Some(" lifecycle-token "));

        assert!(
            launch_config_matches(
                &state,
                &workspace_paths,
                "127.0.0.1",
                &bridge_host,
                &normalize_launch_url(Some("http://127.0.0.1:59104/workspace//opencode")),
                &daemon_url,
                &lifecycle_token,
            ),
            "equivalent launch config should still reuse the server"
        );
        assert!(
            !launch_config_matches(
                &state,
                &workspace_paths,
                "127.0.0.1",
                &bridge_host,
                &normalize_launch_url(Some(
                    "http://127.0.0.1:59104/workspace/ws-278d2edc94b7/opencode",
                )),
                &daemon_url,
                &lifecycle_token,
            ),
            "correcting workspace//opencode to a workspace-scoped URL must respawn veslo-server"
        );
    }

    #[test]
    fn launch_config_restarts_when_bridge_host_changes() {
        let state = VesloServerState {
            workspace_paths: vec!["/workspace/project".to_string()],
            host: Some("127.0.0.1".to_string()),
            bridge_host: None,
            ..Default::default()
        };
        let workspace_paths = vec!["/workspace/project".to_string()];
        let bridge_host = Some("172.29.64.1".to_string());

        assert!(
            !launch_config_matches(
                &state,
                &workspace_paths,
                "127.0.0.1",
                &bridge_host,
                &None,
                &None,
                &None,
            ),
            "a loopback-only server must not be reused once a WSL bridge listener is expected"
        );
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
            |_| None,
            |_| Err("taskkill failed".to_string()),
        )
        .expect("cleanup failure should not stop stale state recovery");

        assert!(recovered.is_none());
        assert!(!dir.join("veslo-server-state.json").exists());
        assert!(!dir.join("veslo-server-plugin-state.json").exists());

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
            pid: Some(pid),
        }
    }

    #[test]
    fn read_persisted_server_info_rejects_token_mismatch() {
        let dir = std::env::temp_dir().join(format!("veslo-server-state-token-{}", Uuid::new_v4()));
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

        assert!(
            recovered.is_none(),
            "token mismatch must reject persisted state"
        );
        assert!(
            !dir.join("veslo-server-state.json").exists(),
            "stale state file must be removed when identity check fails"
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_persisted_server_info_tolerates_pid_mismatch_when_token_matches() {
        let dir = std::env::temp_dir().join(format!("veslo-server-state-pid-{}", Uuid::new_v4()));
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
        .expect("read persisted state")
        .expect("matching token must recover persisted state");

        assert!(recovered.running);
        assert_eq!(recovered.client_token.as_deref(), Some("our-token"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_persisted_server_info_rejects_pid_mismatch_without_token_match() {
        let dir = std::env::temp_dir().join(format!(
            "veslo-server-state-pid-no-token-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create test dir");
        write_persisted_state(&dir, &sample_state("our-token", 4242));

        let recovered = read_persisted_veslo_server_info_with_cleanup(
            &dir,
            |_| {
                Some(HealthIdentity {
                    token: None,
                    pid: Some(9999),
                })
            },
            |_| Ok(()),
        )
        .expect("read persisted state");

        assert!(
            recovered.is_none(),
            "pid mismatch must reject persisted state when token was not verified"
        );

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
