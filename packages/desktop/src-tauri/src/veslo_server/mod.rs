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
use tauri::Manager;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::debug_logs_forwarder::DebugLogsForwarder;
#[cfg(windows)]
use crate::platform::configure_hidden;
use crate::process_supervisor::spawn_output_collector_with_forwarder_and_ready;
use crate::types::{
    VesloServerInfo, VesloServerLifecycleReason, VesloServerLifecycleStatus, WorkspaceType,
};
use crate::utils::truncate_output;
use crate::workspace::state::load_workspace_state;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

pub mod manager;
pub mod spawn;

use manager::{VesloServerManager, VesloServerState};
use spawn::{
    host_from_http_url, resolve_veslo_host, resolve_veslo_port_after_restart_detailed,
    spawn_veslo_server,
};

const PERSISTED_STATE_FILE_NAME: &str = "veslo-server-state.json";
const PERSISTED_PLUGIN_STATE_FILE_NAME: &str = "veslo-server-plugin-state.json";
const RUNTIME_DESCRIPTOR_FILE_NAME: &str = "veslo-server-runtime.json";
const SERVER_SECRETS_FILE_NAME: &str = "veslo-server-secrets.json";
const VESLO_SERVER_READY_MARKER: &str = "VESLO_SERVER_READY ";
const VESLO_SERVER_READINESS_TIMEOUT: Duration = Duration::from_secs(12);
const VESLO_SERVER_STATE_EVENT: &str = "veslo://server-state";

fn append_veslo_server_launch_diagnostic(
    app: &AppHandle,
    event_type: &str,
    payload: serde_json::Value,
) {
    if let Some(forwarder) = app.try_state::<Arc<DebugLogsForwarder>>() {
        let _ = forwarder.append_bootstrap_diagnostic(event_type, payload);
    }
}

fn veslo_server_state_event_payload(info: &VesloServerInfo) -> VesloServerInfo {
    let mut payload = info.clone();
    payload.host_token = None;
    payload.last_stdout = None;
    payload.last_stderr = None;
    payload
}

fn emit_veslo_server_state(app: &AppHandle, info: &VesloServerInfo) {
    let _ = app.emit(
        VESLO_SERVER_STATE_EVENT,
        veslo_server_state_event_payload(info),
    );
}

fn snapshot_and_emit_veslo_server_state(
    app: &AppHandle,
    state: &mut manager::VesloServerState,
) -> VesloServerInfo {
    let info = VesloServerManager::snapshot_locked(state);
    emit_veslo_server_state(app, &info);
    info
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
    pub instance_id: Option<String>,
    pub base_url: Option<String>,
    pub connect_url: Option<String>,
    pub mdns_url: Option<String>,
    pub lan_url: Option<String>,
    pub client_token: Option<String>,
    pub host_token: Option<String>,
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
            candidates.extend(resolve_engine_urls_from_interfaces(port, interfaces));
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

#[cfg(all(windows, test))]
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

// Parked for now: server state resolution now goes through build_urls_for_host.
// pub fn resolve_connect_url(port: u16) -> Option<String> {
//     let (connect_url, _mdns_url, _lan_url, _engine_url) = build_urls_for_host("0.0.0.0", port);
//     connect_url
// }

fn persisted_state_path(dir: &Path) -> PathBuf {
    dir.join(PERSISTED_STATE_FILE_NAME)
}

fn persisted_plugin_state_path(dir: &Path) -> PathBuf {
    dir.join(PERSISTED_PLUGIN_STATE_FILE_NAME)
}

fn runtime_descriptor_path(dir: &Path) -> PathBuf {
    dir.join(RUNTIME_DESCRIPTOR_FILE_NAME)
}

fn server_secrets_path(dir: &Path) -> PathBuf {
    dir.join(SERVER_SECRETS_FILE_NAME)
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
    pub instance_id: Option<String>,
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
        instance_id: Option<String>,
        #[serde(default)]
        token: Option<String>,
        #[serde(default)]
        pid: Option<u32>,
    }

    let body: HealthResponse = response.into_json().ok()?;
    Some(HealthIdentity {
        instance_id: body.instance_id,
        token: body.token,
        pid: body.pid,
    })
}

fn health_identity_matches_instance(identity: &HealthIdentity, instance_id: &str) -> bool {
    identity
        .instance_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        == Some(instance_id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadySignalPayload {
    #[serde(rename = "type")]
    event_type: Option<String>,
    instance_id: Option<String>,
    port: Option<u16>,
}

fn ready_signal_payload(line: &str) -> Option<ReadySignalPayload> {
    let marker_start = line.find(VESLO_SERVER_READY_MARKER)?;
    let json_start = marker_start + VESLO_SERVER_READY_MARKER.len();
    let payload: ReadySignalPayload = serde_json::from_str(line[json_start..].trim()).ok()?;
    if payload.event_type.as_deref() != Some("veslo.server.ready") {
        return None;
    }
    Some(payload)
}

#[cfg(test)]
fn ready_signal_instance_id(line: &str) -> Option<String> {
    let payload = ready_signal_payload(line)?;
    payload
        .instance_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
fn ready_signal_bound_port(line: &str) -> Option<u16> {
    ready_signal_payload(line)?.port.filter(|port| *port > 0)
}

fn wait_for_veslo_server_ready_signal(
    ready_rx: &mpsc::Receiver<String>,
    base_url: &str,
    instance_id: &str,
) -> Option<ReadySignalPayload> {
    let started_at = Instant::now();
    loop {
        let elapsed = started_at.elapsed();
        if elapsed >= VESLO_SERVER_READINESS_TIMEOUT {
            break;
        }
        let remaining = VESLO_SERVER_READINESS_TIMEOUT
            .checked_sub(elapsed)
            .unwrap_or_default();
        match ready_rx.recv_timeout(remaining) {
            Ok(line) => {
                if let Some(payload) = ready_signal_payload(&line) {
                    let payload_instance_id = payload
                        .instance_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty());
                    if payload_instance_id == Some(instance_id) {
                        return Some(payload);
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => break,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    server_health_identity(base_url)
        .as_ref()
        .filter(|identity| health_identity_matches_instance(identity, instance_id))
        .map(|_| ReadySignalPayload {
            event_type: Some("veslo.server.ready".to_string()),
            instance_id: Some(instance_id.to_string()),
            port: None,
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
    let expected_instance_id = state
        .instance_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let actual_instance_id = identity
        .instance_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    if expected_instance_id != actual_instance_id {
        eprintln!(
            "[veslo-server] identity mismatch - instanceId on {base_url} does not match persisted state, rejecting"
        );
        return None;
    }

    // A matching bearer token is stronger than a PID match. In dev watch mode,
    // the managed Bun watcher PID can differ from the HTTP server PID.
    let token_verified = matches!(
        (state.client_token.as_deref(), identity.token.as_deref()),
        (Some(expected), Some(actual)) if expected == actual
    );

    // Identity validation: legacy servers may still return the bearer token and
    // can be rejected on mismatch. Current servers omit the token from /health,
    // so PID is only authoritative for tokenless persisted state.
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
    if !token_verified && state.client_token.is_none() {
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
        lifecycle_status: VesloServerLifecycleStatus::Running,
        lifecycle_reason: VesloServerLifecycleReason::None,
        host: state.host.clone(),
        port: state.port,
        instance_id: state.instance_id.clone(),
        base_url: Some(base_url),
        connect_url: state.connect_url.clone(),
        mdns_url: state.mdns_url.clone(),
        lan_url: state.lan_url.clone(),
        engine_url: resolve_engine_url_for_bind_host(state.host.as_deref(), state.port),
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
    mut report_cleanup_error: impl FnMut(u32, &str),
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
                report_cleanup_error(pid, &error);
            }
        }
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(persisted_plugin_state_path(dir));
        let _ = fs::remove_file(runtime_descriptor_path(dir));
        let _ = fs::remove_file(server_secrets_path(dir));
    }
    Ok(info)
}

#[cfg(test)]
pub fn read_persisted_veslo_server_info(dir: &Path) -> Result<Option<VesloServerInfo>, String> {
    read_persisted_veslo_server_info_with_cleanup(
        dir,
        server_health_identity,
        kill_stale_veslo_server_process,
        |_, _| {},
    )
}

fn kill_stale_veslo_server_process(pid: u32) -> Result<(), String> {
    terminate_stale_veslo_server_process(pid)
        .map_err(|error| format!("Failed to terminate stale persisted PID {pid}: {error}"))
}

#[cfg(any(not(windows), test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct StaleProcessMetadata {
    executable: String,
    command_line: String,
    current_dir: Option<String>,
}

#[cfg(any(not(windows), test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StaleProcessOwner {
    VesloServerBinary,
    BunDevWatchServer,
}

#[cfg(any(not(windows), test))]
fn normalize_process_text(value: &str) -> String {
    value.trim().replace('\\', "/").to_ascii_lowercase()
}

#[cfg(any(not(windows), test))]
fn process_basename(value: &str) -> String {
    normalize_process_text(value)
        .trim_matches(|character| character == '"' || character == '\'')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string()
}

#[cfg(any(not(windows), test))]
fn is_known_target_triple_suffix(value: &str) -> bool {
    let suffix = value.strip_suffix(".exe").unwrap_or(value);
    suffix.contains("-unknown-linux-")
        || suffix.ends_with("-apple-darwin")
        || suffix.ends_with("-pc-windows-msvc")
        || suffix.ends_with("-linux-gnu")
        || suffix.ends_with("-linux-musl")
}

#[cfg(any(not(windows), test))]
fn is_veslo_server_binary_name(value: &str) -> bool {
    let name = value.strip_suffix(".exe").unwrap_or(value);
    if name == "veslo-server" {
        return true;
    }
    name.strip_prefix("veslo-server-")
        .is_some_and(is_known_target_triple_suffix)
}

#[cfg(any(not(windows), test))]
fn text_mentions_veslo_server_binary(value: &str) -> bool {
    normalize_process_text(value)
        .split_whitespace()
        .any(|part| is_veslo_server_binary_name(&process_basename(part)))
}

#[cfg(any(not(windows), test))]
fn path_mentions_server_cli(value: &str) -> bool {
    let normalized = normalize_process_text(value);
    normalized.contains("packages/server/src/cli.ts")
        || normalized.contains("packages/server\\src\\cli.ts")
}

#[cfg(any(not(windows), test))]
fn path_is_server_package_dir(value: &str) -> bool {
    let normalized = normalize_process_text(value)
        .trim_end_matches('/')
        .to_string();
    normalized.ends_with("/packages/server") || normalized.ends_with("/packages/server/.")
}

#[cfg(any(not(windows), test))]
fn classify_stale_veslo_server_process(
    metadata: &StaleProcessMetadata,
) -> Option<StaleProcessOwner> {
    let executable = normalize_process_text(&metadata.executable);
    let executable_name = process_basename(&metadata.executable);
    let command_line = normalize_process_text(&metadata.command_line);
    if is_veslo_server_binary_name(&executable_name)
        || executable.ends_with("/dist/bin/veslo-server")
        || executable.ends_with("/dist/bin/veslo-server.exe")
        || command_line.contains("/dist/bin/veslo-server")
        || text_mentions_veslo_server_binary(&metadata.command_line)
    {
        return Some(StaleProcessOwner::VesloServerBinary);
    }

    let looks_like_bun = executable_name == "bun" || executable_name == "bun.exe";
    let command_mentions_dev_cli = path_mentions_server_cli(&command_line)
        || (command_line.contains("src/cli.ts")
            && metadata
                .current_dir
                .as_deref()
                .is_some_and(path_is_server_package_dir));
    if looks_like_bun && command_line.contains("--watch") && command_mentions_dev_cli {
        return Some(StaleProcessOwner::BunDevWatchServer);
    }

    None
}

#[cfg(any(windows, test))]
fn windows_taskkill_args(pid: u32) -> Vec<String> {
    vec![
        "/PID".to_string(),
        pid.to_string(),
        "/T".to_string(),
        "/F".to_string(),
        "/FI".to_string(),
        "IMAGENAME eq veslo-server.exe".to_string(),
    ]
}

#[cfg(any(not(windows), test))]
fn unix_kill_term_args(pid: u32) -> Vec<String> {
    vec!["-TERM".to_string(), pid.to_string()]
}

#[cfg(windows)]
fn terminate_stale_veslo_server_process(pid: u32) -> Result<(), String> {
    use std::process::Stdio;

    use crate::platform::configure_hidden;

    let mut command = std::process::Command::new("taskkill");
    command
        .args(windows_taskkill_args(pid))
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
fn terminate_stale_veslo_server_process(pid: u32) -> Result<(), String> {
    use std::process::Stdio;

    let metadata = read_unix_process_metadata(pid)?;
    let Some(owner) = classify_stale_veslo_server_process(&metadata) else {
        return Err(format!(
            "stale_process_owner rejected pid {pid}: executable={:?} command_line={:?} current_dir={:?}",
            metadata.executable, metadata.command_line, metadata.current_dir
        ));
    };

    let status = std::process::Command::new("kill")
        .args(unix_kill_term_args(pid))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("failed to launch kill -TERM for {owner:?}: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "kill -TERM exited with status {status} for {owner:?}"
        ))
    }
}

#[cfg(not(windows))]
fn read_unix_process_metadata(pid: u32) -> Result<StaleProcessMetadata, String> {
    let pid_arg = pid.to_string();
    let output = std::process::Command::new("ps")
        .args(["-p", pid_arg.as_str(), "-o", "comm=", "-o", "args="])
        .output()
        .map_err(|error| format!("failed to launch ps for pid {pid}: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "ps exited with status {} for pid {pid}",
            output.status
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .ok_or_else(|| format!("ps returned no process metadata for pid {pid}"))?;
    let split_at = line.find(char::is_whitespace);
    let (executable, command_line) = split_at
        .map(|index| {
            (
                line[..index].trim().to_string(),
                line[index..].trim().to_string(),
            )
        })
        .unwrap_or_else(|| (line.to_string(), line.to_string()));

    Ok(StaleProcessMetadata {
        executable,
        command_line,
        current_dir: read_process_current_dir(pid),
    })
}

#[cfg(all(not(windows), target_os = "linux"))]
fn read_process_current_dir(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|path| path.to_string_lossy().to_string())
}

#[cfg(any(target_os = "macos", test))]
fn parse_macos_lsof_current_dir(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix('n')
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_string)
    })
}

#[cfg(all(not(windows), target_os = "macos"))]
fn read_process_current_dir(pid: u32) -> Option<String> {
    let pid_arg = pid.to_string();
    let output = std::process::Command::new("lsof")
        .args(["-a", "-p", pid_arg.as_str(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_macos_lsof_current_dir(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(all(not(windows), not(any(target_os = "linux", target_os = "macos"))))]
fn read_process_current_dir(_pid: u32) -> Option<String> {
    None
}

pub fn recover_persisted_veslo_server_info(
    app: &AppHandle,
) -> Result<Option<VesloServerInfo>, String> {
    let dir = persisted_state_dir(app)?;
    let from_disk = read_persisted_veslo_server_info_with_cleanup(
        &dir,
        server_health_identity,
        kill_stale_veslo_server_process,
        |pid, error| {
            append_veslo_server_launch_diagnostic(
                app,
                "veslo_server_stale_cleanup_skipped",
                serde_json::json!({
                    "pid": pid,
                    "reason": "stale_process_cleanup_failed",
                    "message": error,
                }),
            );
        },
    )?;
    if from_disk.is_some() {
        return Ok(from_disk);
    }

    // Dev fallback: a `pnpm dev` workflow can spawn veslo-server outside of
    // Rust (via `bun --watch`), in which case Tauri never wrote state.json.
    // If the dev scripts expose `VESLO_DEV_SERVER_URL` we probe it and persist
    // explicit env auth so subsequent reads stay consistent. Skipped in release
    // builds (env var unset by default).
    if !crate::supervised_process::packaged_smoke_mode() {
        if let Some(info) = discover_external_veslo_server() {
            let _ = persist_veslo_server_info(app, &info);
            return Ok(Some(info));
        }
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
    let client_token = std::env::var("VESLO_DEV_SERVER_TOKEN")
        .ok()
        .or_else(|| std::env::var("VESLO_TOKEN").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or(identity.token);
    let host_token = discover_external_host_token(|name| std::env::var(name).ok());
    Some(VesloServerInfo {
        running: true,
        lifecycle_status: VesloServerLifecycleStatus::Running,
        lifecycle_reason: VesloServerLifecycleReason::None,
        host: Some(host),
        port,
        instance_id: identity.instance_id,
        base_url: Some(trimmed.to_string()),
        connect_url,
        mdns_url,
        lan_url,
        engine_url,
        client_token,
        host_token,
        pid: identity.pid,
        last_stdout: None,
        last_stderr: None,
    })
}

fn discover_external_host_token(read_env: impl Fn(&str) -> Option<String>) -> Option<String> {
    read_env("VESLO_HOST_TOKEN")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn clear_persisted_veslo_server_info(app: &AppHandle) -> Result<(), String> {
    let dir = persisted_state_dir(app)?;
    let path = persisted_state_path(&dir);
    let plugin_path = persisted_plugin_state_path(&dir);
    let runtime_path = runtime_descriptor_path(&dir);
    let secrets_path = server_secrets_path(&dir);
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
    }?;
    match fs::remove_file(&runtime_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to remove {}: {error}",
            runtime_path.display()
        )),
    }?;
    match fs::remove_file(&secrets_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to remove {}: {error}",
            secrets_path.display()
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
        Ok(())
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
        instance_id: info.instance_id.clone(),
        base_url: info.base_url.clone(),
        connect_url: info.connect_url.clone(),
        mdns_url: info.mdns_url.clone(),
        lan_url: info.lan_url.clone(),
        client_token: info.client_token.clone(),
        host_token: info.host_token.clone(),
        pid: info.pid,
    };
    let payload = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("Failed to serialize {}: {e}", path.display()))?;
    write_token_state_file(&path, &payload)?;
    persist_veslo_server_plugin_state(&dir, info)
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

fn client_token_for_spawn(previous: Option<String>, requested: Option<String>) -> String {
    previous.or(requested).unwrap_or_else(generate_token)
}

fn persisted_client_token_matches_request(
    requested_client_token: Option<&str>,
    persisted_client_token: Option<&str>,
) -> bool {
    let Some(requested_client_token) = normalize_launch_token(requested_client_token) else {
        return true;
    };

    normalize_launch_token(persisted_client_token).as_deref()
        == Some(requested_client_token.as_str())
}

#[cfg(test)]
#[expect(
    clippy::too_many_arguments,
    reason = "The test helper mirrors the launch-configuration comparison inputs."
)]
fn launch_config_matches(
    state: &manager::VesloServerState,
    _workspace_paths: &[String],
    host: &str,
    bridge_host: &Option<String>,
    sandbox_backend: &str,
    opencode_base_url: &Option<String>,
    orchestrator_daemon_url: &Option<String>,
    orchestrator_lifecycle_token: &Option<String>,
) -> bool {
    launch_config_mismatch_reasons(
        state,
        _workspace_paths,
        host,
        bridge_host,
        sandbox_backend,
        opencode_base_url,
        orchestrator_daemon_url,
        orchestrator_lifecycle_token,
    )
    .is_empty()
}

/// Whether the running Veslo server was spawned with the lifecycle
/// credentials of the admission daemon that is currently ready.  This is an
/// observation only: the server lifecycle owner still decides whether a
/// mismatch may be repaired.
pub(crate) fn control_plane_binding_matches(
    state: &VesloServerState,
    orchestrator_daemon_url: &str,
    orchestrator_lifecycle_token: &str,
) -> bool {
    control_plane_binding_reason(state, orchestrator_daemon_url, orchestrator_lifecycle_token)
        == "matched"
}

/// Stable, non-secret explanation of the current server-to-daemon binding.
pub(crate) fn control_plane_binding_reason(
    state: &VesloServerState,
    orchestrator_daemon_url: &str,
    orchestrator_lifecycle_token: &str,
) -> &'static str {
    if state.orchestrator_daemon_url.is_none() || state.orchestrator_lifecycle_token.is_none() {
        return "server-unbound";
    }
    if state.orchestrator_daemon_url.as_deref() != Some(orchestrator_daemon_url) {
        return "stale-daemon-url";
    }
    if state.orchestrator_lifecycle_token.as_deref() != Some(orchestrator_lifecycle_token) {
        return "stale-lifecycle-token";
    }
    "matched"
}

#[expect(
    clippy::too_many_arguments,
    reason = "Each launch input is compared independently to produce actionable restart reasons."
)]
fn launch_config_mismatch_reasons(
    state: &manager::VesloServerState,
    _workspace_paths: &[String],
    host: &str,
    bridge_host: &Option<String>,
    sandbox_backend: &str,
    opencode_base_url: &Option<String>,
    orchestrator_daemon_url: &Option<String>,
    orchestrator_lifecycle_token: &Option<String>,
) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if state.host.as_deref() != Some(host) {
        reasons.push("host");
    }
    if state.bridge_host != *bridge_host {
        reasons.push("bridge_host");
    }
    if state.sandbox_backend.as_deref() != Some(sandbox_backend) {
        reasons.push("sandbox_backend");
    }
    if state.opencode_base_url != *opencode_base_url {
        reasons.push("opencode_base_url");
    }
    if state.orchestrator_daemon_url != *orchestrator_daemon_url {
        reasons.push("orchestrator_daemon_url");
    }
    if state.orchestrator_lifecycle_token != *orchestrator_lifecycle_token {
        reasons.push("orchestrator_lifecycle_token");
    }
    reasons
}

fn start_decision_reasons(
    state: &manager::VesloServerState,
    launch_config_mismatches: &[&'static str],
) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if state.child.is_none() {
        reasons.push("no_child");
    }
    if state.child_exited {
        reasons.push("child_exited");
    }
    if state.lifecycle_status != VesloServerLifecycleStatus::Running {
        reasons.push("lifecycle_not_running");
    }
    if state.client_token.is_none() {
        reasons.push("client_token_missing");
    }
    if state.host_token.is_none() {
        reasons.push("host_token_missing");
    }
    if state.port.is_none() {
        reasons.push("port_missing");
    }
    reasons.extend_from_slice(launch_config_mismatches);
    reasons
}

fn launch_decision_payload(
    decision: &str,
    state: &manager::VesloServerState,
    reasons: &[&'static str],
    workspace_count: usize,
) -> serde_json::Value {
    serde_json::json!({
        "decision": decision,
        "reason": reasons.first().copied().unwrap_or("matching_running_child"),
        "reasons": reasons,
        "previousPid": state.child.as_ref().map(|child| child.pid()),
        "previousInstanceId": state.instance_id.as_deref(),
        "lifecycleStatus": state.lifecycle_status,
        "lifecycleReason": state.lifecycle_reason,
        "workspaceCount": workspace_count,
        "hasClientToken": state.client_token.as_ref().is_some_and(|token| !token.trim().is_empty()),
        "hasHostToken": state.host_token.as_ref().is_some_and(|token| !token.trim().is_empty()),
        "hasOpencodeBaseUrl": state.opencode_base_url.is_some(),
        "hasOrchestratorDaemonUrl": state.orchestrator_daemon_url.is_some(),
        "hasOrchestratorLifecycleToken": state.orchestrator_lifecycle_token.is_some(),
    })
}

#[expect(
    clippy::too_many_arguments,
    reason = "The desktop server owner keeps explicit launch inputs at its process boundary."
)]
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
    let _start_queue = manager
        .start_queue
        .lock()
        .map_err(|_| "veslo server start queue mutex poisoned".to_string())?;
    let requested_client_token = normalize_launch_token(veslo_server_client_token);

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

    let should_try_persisted_recovery = {
        let mut state = manager
            .inner
            .lock()
            .map_err(|_| "veslo server mutex poisoned".to_string())?;
        if state.external_info.is_some() && state.child.is_none() {
            state.external_info = None;
            false
        } else {
            state.child.is_none() && !state.child_exited && state.external_info.is_none()
        }
    };
    if should_try_persisted_recovery {
        if let Ok(Some(info)) = recover_persisted_veslo_server_info(app) {
            let recovered_client_token = normalize_launch_token(info.client_token.as_deref());
            let mut state = manager
                .inner
                .lock()
                .map_err(|_| "veslo server mutex poisoned".to_string())?;
            if state.child.is_none()
                && state.external_info.is_none()
                && persisted_client_token_matches_request(
                    requested_client_token.as_deref(),
                    recovered_client_token.as_deref(),
                )
            {
                state.external_info = Some(info.clone());
                state.client_token = recovered_client_token;
                state.host_token = info.host_token.clone();
                append_veslo_server_launch_diagnostic(
                    app,
                    "veslo-server-launch:persisted-adopted",
                    serde_json::json!({
                        "decision": "adopted",
                        "reason": "matching_persisted_instance",
                        "previousPid": info.pid,
                        "previousInstanceId": info.instance_id.as_deref(),
                        "lifecycleStatus": info.lifecycle_status,
                        "lifecycleReason": info.lifecycle_reason,
                        "hasClientToken": info.client_token.as_ref().is_some_and(|token| !token.trim().is_empty()),
                        "hasHostToken": info.host_token.as_ref().is_some_and(|token| !token.trim().is_empty()),
                    }),
                );
                emit_veslo_server_state(app, &info);
                return Ok(info);
            }
            if state.child.is_none() && state.external_info.is_none() {
                append_veslo_server_launch_diagnostic(
                    app,
                    "veslo-server-launch:persisted-rejected",
                    serde_json::json!({
                        "decision": "rejected",
                        "reason": "requested_client_token_mismatch",
                        "hasRequestedClientToken": requested_client_token.is_some(),
                        "hasRecoveredClientToken": recovered_client_token.is_some(),
                    }),
                );
            }
        }
    }

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
    let host = resolve_veslo_host();
    let shared_unsandboxed_engine =
        crate::runtime_preferences::read_shared_unsandboxed_engine_override(app)?;
    let sandbox_backend =
        spawn::resolve_server_sandbox_backend_for_runtime_preference(shared_unsandboxed_engine);
    // VSLO-250: determine the expected WSL bridge before idempotent reuse, so a
    // previous loopback-only server cannot be reused while we publish bridge URLs.
    // Gate on the active sandbox backend (the same source the server is told via
    // VESLO_SANDBOX_BACKEND): with sandboxing disabled the engine is direct and
    // routes over loopback, so no WSL bridge is set up.
    let mut bridge_host = if should_bind_wsl_bridge(&host, &sandbox_backend) {
        resolve_wsl_bridge_host()
    } else {
        None
    };
    let launch_config_mismatches = launch_config_mismatch_reasons(
        &state,
        workspace_paths,
        &host,
        &bridge_host,
        &sandbox_backend,
        &normalized_opencode_base_url,
        &normalized_orchestrator_daemon_url,
        &normalized_orchestrator_lifecycle_token,
    );
    let start_reasons = start_decision_reasons(&state, &launch_config_mismatches);
    if state.child.is_some()
        && !state.child_exited
        && state.lifecycle_status == VesloServerLifecycleStatus::Running
        && state.client_token.is_some()
        && state.host_token.is_some()
        && state.port.is_some()
        && start_reasons.is_empty()
    {
        append_veslo_server_launch_diagnostic(
            app,
            "veslo-server-launch:start-reused",
            launch_decision_payload("reused", &state, &start_reasons, workspace_paths.len()),
        );
        let info = snapshot_and_emit_veslo_server_state(app, &mut state);
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
    let launch_decision = if state.child.is_some() && !state.child_exited {
        "respawn"
    } else {
        "start"
    };
    append_veslo_server_launch_diagnostic(
        app,
        if launch_decision == "respawn" {
            "veslo-server-launch:start-respawn"
        } else {
            "veslo-server-launch:start-accepted"
        },
        launch_decision_payload(
            launch_decision,
            &state,
            &start_reasons,
            workspace_paths.len(),
        ),
    );
    let previous_client_token = state.client_token.clone();
    let previous_host_token = state.host_token.clone();
    VesloServerManager::stop_locked(&mut state);
    state.lifecycle_status = VesloServerLifecycleStatus::Starting;
    state.lifecycle_reason = VesloServerLifecycleReason::SpawnPending;
    let _ = snapshot_and_emit_veslo_server_state(app, &mut state);

    let port_resolution = match resolve_veslo_port_after_restart_detailed(&host) {
        Ok(resolution) => resolution,
        Err(error) => {
            let message = error.message();
            state.lifecycle_status = VesloServerLifecycleStatus::Blocked;
            state.lifecycle_reason = VesloServerLifecycleReason::PortUnavailable;
            state.last_stderr = Some(truncate_output(&message, 8000));
            let mut payload = serde_json::json!({
                "reason": "port_conflict",
                "error": message,
            });
            if let Some(conflict) = error.conflict() {
                payload["host"] = serde_json::Value::String(conflict.host.clone());
                payload["port"] =
                    serde_json::Value::Number(serde_json::Number::from(conflict.port));
                payload["defaultPort"] = serde_json::Value::Bool(conflict.is_default_port());
                payload["fallbackPolicy"] =
                    serde_json::Value::String(conflict.fallback_policy().to_string());
            }
            append_veslo_server_launch_diagnostic(
                app,
                "veslo-server-launch:port-resolve-failed",
                payload,
            );
            let _ = snapshot_and_emit_veslo_server_state(app, &mut state);
            return Err(message);
        }
    };
    let port = port_resolution.bind_port;
    if let Some(conflict) = port_resolution.fallback_conflict.as_ref() {
        append_veslo_server_launch_diagnostic(
            app,
            "veslo-server-launch:port-conflict-fallback",
            serde_json::json!({
                "reason": "port_conflict",
                "host": conflict.host.clone(),
                "port": conflict.port,
                "requestedPort": port_resolution.requested_port,
                "fallbackPort": port,
                "defaultPort": conflict.is_default_port(),
                "fallbackPolicy": conflict.fallback_policy(),
                "error": conflict.source.clone(),
            }),
        );
    }
    if port == 0 && bridge_host.is_some() {
        append_veslo_server_launch_diagnostic(
            app,
            "veslo-server-launch:bridge-disabled-for-ephemeral-port",
            serde_json::json!({
                "reason": "ephemeral_port_bridge_unsupported",
                "requestedPort": port_resolution.requested_port,
            }),
        );
        bridge_host = None;
    }
    let client_token = client_token_for_spawn(previous_client_token, requested_client_token);
    let host_token = previous_host_token.unwrap_or_else(generate_token);
    let instance_id = Uuid::new_v4().to_string();
    let state_dir = persisted_state_dir(app)?;
    let runtime_descriptor_path = runtime_descriptor_path(&state_dir);
    let secrets_file_path = server_secrets_path(&state_dir);
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
            "requestedPort": port_resolution.requested_port,
            "fallbackPolicy": port_resolution
                .fallback_conflict
                .as_ref()
                .map(|conflict| conflict.fallback_policy()),
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
        &instance_id,
        &runtime_descriptor_path,
        &secrets_file_path,
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
        &sandbox_backend,
        shared_unsandboxed_engine,
    ) {
        Ok(result) => {
            append_veslo_server_launch_diagnostic(
                app,
                "veslo-server-launch:spawn-succeeded",
                serde_json::json!({
                    "port": port,
                    "requestedPort": port_resolution.requested_port,
                    "workspaceCount": workspace_paths.len(),
                }),
            );
            result
        }
        Err(error) => {
            state.lifecycle_status = VesloServerLifecycleStatus::Blocked;
            state.lifecycle_reason = VesloServerLifecycleReason::SpawnFailed;
            state.last_stderr = Some(truncate_output(&error, 8000));
            append_veslo_server_launch_diagnostic(
                app,
                "veslo-server-launch:spawn-failed",
                serde_json::json!({
                    "port": port,
                    "requestedPort": port_resolution.requested_port,
                    "workspaceCount": workspace_paths.len(),
                    "error": error,
                }),
            );
            let _ = snapshot_and_emit_veslo_server_state(app, &mut state);
            return Err(error);
        }
    };

    state.child = Some(child);
    state.child_exited = false;
    state.external_info = None;
    state.host = Some(host.clone());
    state.bridge_host = bridge_host.clone();
    state.port = Some(port);
    state.instance_id = Some(instance_id.clone());
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
    state.sandbox_backend = Some(sandbox_backend);
    state.last_stdout = None;
    state.last_stderr = None;
    state.lifecycle_status = VesloServerLifecycleStatus::WaitingReady;
    state.lifecycle_reason = VesloServerLifecycleReason::SpawnPending;
    let _ = snapshot_and_emit_veslo_server_state(app, &mut state);

    let forwarder = app
        .try_state::<Arc<DebugLogsForwarder>>()
        .map(|s| (s.inner().clone(), "veslo-server-shell"));
    let (ready_tx, ready_rx) = mpsc::channel();
    spawn_output_collector_with_forwarder_and_ready(
        rx,
        manager.inner.clone(),
        "Veslo server",
        forwarder,
        Some((ready_tx, VESLO_SERVER_READY_MARKER)),
    );

    let base_url = state
        .base_url
        .clone()
        .unwrap_or_else(|| format!("http://127.0.0.1:{port}"));
    drop(state);

    let ready = wait_for_veslo_server_ready_signal(&ready_rx, &base_url, &instance_id);
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "veslo server mutex poisoned".to_string())?;
    if state.instance_id.as_deref() == Some(instance_id.as_str()) && state.port == Some(port) {
        if let Some(ready_payload) = ready {
            let bound_port = ready_payload
                .port
                .filter(|ready_port| *ready_port > 0)
                .unwrap_or(port);
            if bound_port != port {
                state.port = Some(bound_port);
                state.base_url = Some(format!("http://127.0.0.1:{bound_port}"));
                let (connect_url, mdns_url, lan_url, engine_url) =
                    build_urls_for_host(&host, bound_port);
                state.connect_url = connect_url;
                state.mdns_url = mdns_url;
                state.lan_url = lan_url;
                state.engine_url = engine_url;
                state.engine_url_checked_at = if bridge_host.is_some() {
                    None
                } else {
                    Some(std::time::Instant::now())
                };
                state.engine_url_refresh_started_at = None;
            }
            state.lifecycle_status = VesloServerLifecycleStatus::Running;
            state.lifecycle_reason = VesloServerLifecycleReason::None;
        } else {
            state.lifecycle_status = VesloServerLifecycleStatus::Blocked;
            state.lifecycle_reason = VesloServerLifecycleReason::HealthUnreachable;
            state.last_stderr = Some(truncate_output(
                &format!(
                    "Veslo server did not report ready instance {instance_id} on {base_url} within 12s."
                ),
                8000,
            ));
            append_veslo_server_launch_diagnostic(
                app,
                "veslo-server-launch:readiness-timeout",
                serde_json::json!({
                    "baseUrl": base_url,
                    "instanceId": instance_id,
                }),
            );
        }
    }

    let info = snapshot_and_emit_veslo_server_state(app, &mut state);
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
        build_urls_for_host_with_engine_resolver, classify_stale_veslo_server_process,
        client_token_for_spawn, control_plane_binding_matches, control_plane_binding_reason,
        discover_external_host_token, launch_config_matches, launch_config_mismatch_reasons,
        launch_decision_payload, normalize_launch_token, normalize_launch_url,
        parse_macos_lsof_current_dir, persisted_client_token_matches_request,
        publishes_external_urls, read_persisted_veslo_server_info,
        read_persisted_veslo_server_info_with_cleanup, ready_signal_bound_port,
        ready_signal_instance_id, resolve_engine_url_for_bind_host, should_bind_wsl_bridge,
        start_decision_reasons, unix_kill_term_args, veslo_server_state_event_payload,
        windows_taskkill_args, HealthIdentity, PersistedVesloServerState, StaleProcessMetadata,
        StaleProcessOwner,
    };
    #[cfg(windows)]
    use super::{
        parse_wsl_engine_url_from_powershell_output, resolve_engine_url_from_candidates,
        resolve_engine_url_from_interfaces,
    };
    use crate::types::{VesloServerInfo, VesloServerLifecycleReason, VesloServerLifecycleStatus};
    use std::fs;
    use std::io::ErrorKind;
    use std::io::Read;
    use std::io::Write;
    use std::net::TcpListener;
    #[cfg(windows)]
    use std::net::{IpAddr, Ipv4Addr};
    use std::thread;
    use uuid::Uuid;

    #[test]
    fn persisted_server_adoption_requires_the_requested_client_token_to_match() {
        assert!(persisted_client_token_matches_request(
            None,
            Some("persisted-token")
        ));
        assert!(persisted_client_token_matches_request(
            Some(" requested-token "),
            Some("requested-token"),
        ));
        assert!(!persisted_client_token_matches_request(
            Some("requested-token"),
            Some("persisted-token"),
        ));
        assert!(!persisted_client_token_matches_request(
            Some("requested-token"),
            None
        ));
    }

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
    fn stale_process_owner_accepts_veslo_server_binary() {
        let metadata = StaleProcessMetadata {
            executable: "/opt/Veslo/veslo-server".to_string(),
            command_line: "/opt/Veslo/veslo-server --port 8787".to_string(),
            current_dir: None,
        };

        assert_eq!(
            classify_stale_veslo_server_process(&metadata),
            Some(StaleProcessOwner::VesloServerBinary)
        );
    }

    #[test]
    fn stale_process_owner_accepts_target_suffixed_veslo_server_sidecar() {
        let metadata = StaleProcessMetadata {
            executable: "/Applications/Veslo.app/Contents/MacOS/veslo-server-aarch64-apple-darwin"
                .to_string(),
            command_line:
                "\"/Applications/Veslo.app/Contents/MacOS/veslo-server-aarch64-apple-darwin\" --port 8787"
                    .to_string(),
            current_dir: None,
        };

        assert_eq!(
            classify_stale_veslo_server_process(&metadata),
            Some(StaleProcessOwner::VesloServerBinary)
        );
    }

    #[test]
    fn stale_process_owner_accepts_bun_watch_server_only_with_server_context() {
        let metadata = StaleProcessMetadata {
            executable: "/usr/local/bin/bun".to_string(),
            command_line: "bun --watch src/cli.ts --port 8787".to_string(),
            current_dir: Some("/repo/packages/server".to_string()),
        };
        let unrelated = StaleProcessMetadata {
            executable: "/usr/local/bin/bun".to_string(),
            command_line: "bun --watch src/cli.ts".to_string(),
            current_dir: Some("/repo/other-package".to_string()),
        };

        assert_eq!(
            classify_stale_veslo_server_process(&metadata),
            Some(StaleProcessOwner::BunDevWatchServer)
        );
        assert_eq!(classify_stale_veslo_server_process(&unrelated), None);
    }

    #[test]
    fn macos_lsof_current_dir_parser_extracts_cwd() {
        let output = "p4242\nfcwd\nn/Users/example/repo/packages/server\n";

        assert_eq!(
            parse_macos_lsof_current_dir(output).as_deref(),
            Some("/Users/example/repo/packages/server")
        );
    }

    #[test]
    fn stale_process_owner_rejects_unrelated_processes() {
        for metadata in [
            StaleProcessMetadata {
                executable: "/usr/bin/node".to_string(),
                command_line: "node server.js".to_string(),
                current_dir: None,
            },
            StaleProcessMetadata {
                executable: "/usr/local/bin/bun".to_string(),
                command_line: "bun --watch app.ts".to_string(),
                current_dir: Some("/repo/packages/server".to_string()),
            },
        ] {
            assert_eq!(classify_stale_veslo_server_process(&metadata), None);
        }
    }

    #[test]
    fn stale_process_cleanup_commands_are_targeted() {
        assert_eq!(
            windows_taskkill_args(4242),
            vec![
                "/PID",
                "4242",
                "/T",
                "/F",
                "/FI",
                "IMAGENAME eq veslo-server.exe"
            ]
        );
        assert_eq!(unix_kill_term_args(4242), vec!["-TERM", "4242"]);
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
            sandbox_backend: Some("windows-wsl2".to_string()),
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
                "windows-wsl2",
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
                "windows-wsl2",
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
    fn launch_config_reuses_server_when_workspace_list_changes() {
        let state = VesloServerState {
            workspace_paths: vec!["/workspace/project".to_string()],
            host: Some("127.0.0.1".to_string()),
            bridge_host: None,
            sandbox_backend: Some("none".to_string()),
            ..Default::default()
        };
        let workspace_paths = vec![
            "/workspace/project".to_string(),
            "/workspace/new-project".to_string(),
        ];

        assert!(
            launch_config_matches(
                &state,
                &workspace_paths,
                "127.0.0.1",
                &None,
                "none",
                &None,
                &None,
                &None,
            ),
            "workspace registry changes are acknowledged through API sync and must not respawn veslo-server"
        );
    }

    #[test]
    fn launch_config_mismatch_reasons_name_respawn_fields() {
        let state = VesloServerState {
            host: Some("127.0.0.1".to_string()),
            bridge_host: None,
            sandbox_backend: Some("none".to_string()),
            opencode_base_url: normalize_launch_url(Some("http://127.0.0.1:5000")),
            orchestrator_daemon_url: normalize_launch_url(Some("http://127.0.0.1:6000")),
            orchestrator_lifecycle_token: normalize_launch_token(Some("old-lifecycle")),
            ..Default::default()
        };

        let reasons = launch_config_mismatch_reasons(
            &state,
            &[],
            "127.0.0.1",
            &Some("172.29.64.1".to_string()),
            "windows-wsl2",
            &normalize_launch_url(Some("http://127.0.0.1:5001")),
            &normalize_launch_url(Some("http://127.0.0.1:6001")),
            &normalize_launch_token(Some("new-lifecycle")),
        );

        assert_eq!(
            reasons,
            vec![
                "bridge_host",
                "sandbox_backend",
                "opencode_base_url",
                "orchestrator_daemon_url",
                "orchestrator_lifecycle_token",
            ]
        );
    }

    #[test]
    fn control_plane_binding_requires_current_daemon_url_and_token() {
        let unbound = VesloServerState::default();
        assert_eq!(
            control_plane_binding_reason(&unbound, "http://127.0.0.1:59104", "current-token"),
            "server-unbound",
        );

        let state = VesloServerState {
            orchestrator_daemon_url: Some("http://127.0.0.1:59104".to_string()),
            orchestrator_lifecycle_token: Some("current-token".to_string()),
            ..Default::default()
        };

        assert!(control_plane_binding_matches(
            &state,
            "http://127.0.0.1:59104",
            "current-token",
        ));
        assert!(!control_plane_binding_matches(
            &state,
            "http://127.0.0.1:59105",
            "current-token",
        ));
        assert!(!control_plane_binding_matches(
            &state,
            "http://127.0.0.1:59104",
            "stale-token",
        ));
        assert_eq!(
            control_plane_binding_reason(&state, "http://127.0.0.1:59104", "stale-token"),
            "stale-lifecycle-token",
        );
    }

    #[test]
    fn launch_decision_payload_reports_state_without_token_values() {
        let state = VesloServerState {
            lifecycle_status: VesloServerLifecycleStatus::WaitingReady,
            lifecycle_reason: VesloServerLifecycleReason::SpawnPending,
            instance_id: Some("instance-1".to_string()),
            client_token: Some("client-secret".to_string()),
            host_token: Some("host-secret".to_string()),
            opencode_base_url: Some("http://127.0.0.1:5000".to_string()),
            ..Default::default()
        };
        let reasons = start_decision_reasons(&state, &["opencode_base_url"]);

        let payload = launch_decision_payload("respawn", &state, &reasons, 2);
        let serialized = serde_json::to_string(&payload).expect("serialize payload");

        assert_eq!(payload["decision"], "respawn");
        assert_eq!(payload["reason"], "no_child");
        assert_eq!(payload["previousInstanceId"], "instance-1");
        assert_eq!(payload["hasClientToken"], true);
        assert_eq!(payload["hasHostToken"], true);
        assert!(serialized.contains("opencode_base_url"));
        assert!(!serialized.contains("client-secret"));
        assert!(!serialized.contains("host-secret"));
    }

    #[test]
    fn client_token_for_spawn_prefers_previous_token_over_parallel_request() {
        assert_eq!(
            client_token_for_spawn(
                Some("live-token".to_string()),
                Some("new-request-token".to_string())
            ),
            "live-token"
        );
        assert_eq!(
            client_token_for_spawn(None, Some("request-token".to_string())),
            "request-token"
        );
    }

    #[test]
    fn server_state_event_payload_redacts_owner_token_and_logs() {
        let info = VesloServerInfo {
            running: true,
            lifecycle_status: VesloServerLifecycleStatus::Running,
            lifecycle_reason: VesloServerLifecycleReason::None,
            host: Some("127.0.0.1".to_string()),
            port: Some(8787),
            instance_id: Some("instance-1".to_string()),
            base_url: Some("http://127.0.0.1:8787".to_string()),
            connect_url: None,
            mdns_url: None,
            lan_url: None,
            engine_url: None,
            client_token: Some("client-token".to_string()),
            host_token: Some("host-token".to_string()),
            pid: Some(123),
            last_stdout: Some("stdout with possible diagnostics".to_string()),
            last_stderr: Some("stderr with possible diagnostics".to_string()),
        };

        let payload = veslo_server_state_event_payload(&info);

        assert_eq!(payload.client_token.as_deref(), Some("client-token"));
        assert_eq!(payload.host_token, None);
        assert_eq!(payload.last_stdout, None);
        assert_eq!(payload.last_stderr, None);
    }

    #[test]
    fn launch_config_restarts_when_bridge_host_changes() {
        let state = VesloServerState {
            workspace_paths: vec!["/workspace/project".to_string()],
            host: Some("127.0.0.1".to_string()),
            bridge_host: None,
            sandbox_backend: Some("none".to_string()),
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
                "windows-wsl2",
                &None,
                &None,
                &None,
            ),
            "a loopback-only server must not be reused once a WSL bridge listener is expected"
        );
    }

    #[test]
    fn launch_config_restarts_when_sandbox_backend_changes() {
        let state = VesloServerState {
            workspace_paths: vec!["/workspace/project".to_string()],
            host: Some("127.0.0.1".to_string()),
            bridge_host: None,
            sandbox_backend: Some("none".to_string()),
            ..Default::default()
        };
        let workspace_paths = vec!["/workspace/project".to_string()];

        assert!(
            !launch_config_matches(
                &state,
                &workspace_paths,
                "127.0.0.1",
                &None,
                "mac-sandbox-exec",
                &None,
                &None,
                &None,
            ),
            "a server started without sandboxing must not be reused after sandbox backend changes"
        );
    }

    #[test]
    fn ready_signal_instance_id_parses_machine_readable_stdout_line() {
        let line = r#"VESLO_SERVER_READY {"schemaVersion":1,"type":"veslo.server.ready","instanceId":"instance-1","host":"127.0.0.1","port":8787,"pid":123,"startedAt":1,"baseUrl":"http://127.0.0.1:8787"}"#;

        assert_eq!(
            ready_signal_instance_id(line).as_deref(),
            Some("instance-1")
        );
        assert_eq!(ready_signal_bound_port(line), Some(8787));
    }

    #[test]
    fn ready_signal_instance_id_rejects_wrong_event_type() {
        let line = r#"VESLO_SERVER_READY {"schemaVersion":1,"type":"other.ready","instanceId":"instance-1"}"#;

        assert_eq!(ready_signal_instance_id(line), None);
    }

    #[test]
    fn discover_external_host_token_reads_explicit_env_token() {
        assert_eq!(
            discover_external_host_token(|name| {
                if name == "VESLO_HOST_TOKEN" {
                    Some(" host-token ".to_string())
                } else {
                    None
                }
            })
            .as_deref(),
            Some("host-token")
        );
        assert_eq!(
            discover_external_host_token(|_| Some("  ".to_string())),
            None
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
            let body = r#"{"ok":true,"instanceId":"instance-live","pid":12345}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write health response");
        });

        let dir = std::env::temp_dir().join(format!("veslo-server-state-live-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test dir");
        let state = PersistedVesloServerState {
            host: Some("0.0.0.0".to_string()),
            port: Some(port),
            instance_id: Some("instance-live".to_string()),
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
        assert_eq!(recovered.instance_id.as_deref(), Some("instance-live"));
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
            instance_id: Some("instance-stale".to_string()),
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
            |_, _| {},
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
            instance_id: Some("instance-stale".to_string()),
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
        fs::write(
            dir.join("veslo-server-plugin-state.json"),
            r#"{"baseUrl":"http://127.0.0.1:8787","clientToken":"client-token"}"#,
        )
        .expect("write plugin state file");

        let mut cleanup_errors = Vec::new();
        let recovered = read_persisted_veslo_server_info_with_cleanup(
            &dir,
            |_| None,
            |_| Err("taskkill failed".to_string()),
            |pid, error| cleanup_errors.push((pid, error.to_string())),
        )
        .expect("cleanup failure should not stop stale state recovery");

        assert!(recovered.is_none());
        assert_eq!(cleanup_errors, vec![(4242, "taskkill failed".to_string())]);
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
            instance_id: Some("instance-test".to_string()),
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
        let dir = std::env::temp_dir().join(format!("veslo-server-state-token-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test dir");
        write_persisted_state(&dir, &sample_state("our-token", 4242));

        let recovered = read_persisted_veslo_server_info_with_cleanup(
            &dir,
            |_| {
                Some(HealthIdentity {
                    instance_id: Some("instance-test".to_string()),
                    token: Some("foreign-token".to_string()),
                    pid: Some(4242),
                })
            },
            |_| Ok(()),
            |_, _| {},
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
                    instance_id: Some("instance-test".to_string()),
                    token: Some("our-token".to_string()),
                    pid: Some(9999),
                })
            },
            |_| Ok(()),
            |_, _| {},
        )
        .expect("read persisted state")
        .expect("matching token must recover persisted state");

        assert!(recovered.running);
        assert_eq!(recovered.client_token.as_deref(), Some("our-token"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_persisted_server_info_recovers_token_state_when_health_omits_token() {
        let dir = std::env::temp_dir().join(format!(
            "veslo-server-state-pid-omitted-token-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create test dir");
        write_persisted_state(&dir, &sample_state("our-token", 4242));

        let recovered = read_persisted_veslo_server_info_with_cleanup(
            &dir,
            |_| {
                Some(HealthIdentity {
                    instance_id: Some("instance-test".to_string()),
                    token: None,
                    pid: Some(9999),
                })
            },
            |_| Ok(()),
            |_, _| {},
        )
        .expect("read persisted state");

        let recovered = recovered.expect("token-bearing state should survive tokenless health");
        assert!(recovered.running);
        assert_eq!(recovered.client_token.as_deref(), Some("our-token"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_persisted_server_info_rejects_tokenless_pid_mismatch() {
        let dir = std::env::temp_dir().join(format!(
            "veslo-server-state-tokenless-pid-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create test dir");
        let mut state = sample_state("our-token", 4242);
        state.client_token = None;
        write_persisted_state(&dir, &state);

        let recovered = read_persisted_veslo_server_info_with_cleanup(
            &dir,
            |_| {
                Some(HealthIdentity {
                    instance_id: Some("instance-test".to_string()),
                    token: None,
                    pid: Some(9999),
                })
            },
            |_| Ok(()),
            |_, _| {},
        )
        .expect("read persisted state");

        assert!(
            recovered.is_none(),
            "pid mismatch must reject tokenless persisted state"
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_persisted_server_info_rejects_legacy_server_without_instance_identity() {
        let dir =
            std::env::temp_dir().join(format!("veslo-server-state-legacy-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create test dir");
        write_persisted_state(&dir, &sample_state("our-token", 4242));

        let recovered = read_persisted_veslo_server_info_with_cleanup(
            &dir,
            |_| Some(HealthIdentity::default()),
            |_| Ok(()),
            |_, _| {},
        )
        .expect("read persisted state");

        assert!(
            recovered.is_none(),
            "persisted adoption must reject health without matching instanceId"
        );

        let _ = fs::remove_dir_all(dir);
    }
}
