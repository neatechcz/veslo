use std::env;
use std::fmt;
use std::fs;
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};

use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Manager};

use crate::supervised_process::{self, CommandEvent, SupervisedCommandChild};

const DEFAULT_VESLO_PORT: u16 = 8787;
const DEFAULT_VESLO_HOST: &str = "127.0.0.1";
const DEFAULT_VESLO_DEPLOYMENT_DOMAIN: &str = "veslo.work";
const VESLO_DEPLOYMENT_DOMAIN_ENV: &str = "VESLO_DEPLOYMENT_DOMAIN";
const VESLO_SERVER_DEV_WATCH_ENV: &str = "VESLO_SERVER_DEV_WATCH";
const VESLO_SERVER_DEV_DIR_ENV: &str = "VESLO_SERVER_DEV_DIR";
const VESLO_DESKTOP_SERVER_HOST_ENV: &str = "VESLO_DESKTOP_SERVER_HOST";
const VESLO_DESKTOP_SERVER_PORT_ENV: &str = "VESLO_DESKTOP_SERVER_PORT";
const VESLO_SANDBOX_BACKEND_ENV: &str = "VESLO_SANDBOX_BACKEND";
const VESLO_DISABLE_SANDBOX_ENV: &str = "VESLO_DISABLE_SANDBOX";
const VESLO_RUNTIME_FILE_ENV: &str = "VESLO_RUNTIME_FILE";
const VESLO_RUNTIME_DESCRIPTOR_PATH_ENV: &str = "VESLO_RUNTIME_DESCRIPTOR_PATH";
const VESLO_SECRETS_FILE_ENV: &str = "VESLO_SECRETS_FILE";
const VESLO_LOG_FORMAT_ENV: &str = "VESLO_LOG_FORMAT";
const PORT_RESTART_RETRY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const PORT_RESTART_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

fn desktop_server_observability_env_overrides() -> [(&'static str, &'static str); 1] {
    // The native feedback capture receives the server's stdout. JSON preserves
    // redacted log attributes (for example the skill reload reason and retry
    // budget); pretty output would retain only the human message.
    [(VESLO_LOG_FORMAT_ENV, "json")]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VesloPortConflict {
    pub host: String,
    pub port: u16,
    pub source: String,
    fallback_policy: VesloPortFallbackPolicy,
}

impl VesloPortConflict {
    pub fn is_default_port(&self) -> bool {
        self.port == DEFAULT_VESLO_PORT
    }

    pub fn fallback_policy(&self) -> &'static str {
        self.fallback_policy.as_str()
    }

    pub fn message(&self) -> String {
        if self.fallback_policy == VesloPortFallbackPolicy::Ephemeral {
            format!(
                "port_conflict: Veslo server port {} on {} is unavailable: {}; using an ephemeral fallback port.",
                self.port, self.host, self.source
            )
        } else {
            format!(
                "port_conflict: Veslo server port {} on {} is unavailable: {}; ephemeral fallback is disabled, so local mode is blocked until the occupant exits or the port is changed.",
                self.port, self.host, self.source
            )
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VesloPortFallbackPolicy {
    Disabled,
    Ephemeral,
}

impl VesloPortFallbackPolicy {
    fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Ephemeral => "ephemeral",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ConfiguredVesloPort {
    port: u16,
    source: VesloPortSource,
}

impl ConfiguredVesloPort {
    fn fallback_policy(self) -> VesloPortFallbackPolicy {
        if self.source == VesloPortSource::Default && self.port == DEFAULT_VESLO_PORT {
            VesloPortFallbackPolicy::Ephemeral
        } else {
            VesloPortFallbackPolicy::Disabled
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VesloPortSource {
    Default,
    Explicit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VesloPortResolution {
    pub requested_port: u16,
    pub bind_port: u16,
    pub fallback_conflict: Option<VesloPortConflict>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VesloPortResolveError {
    InvalidConfig(String),
    Conflict(VesloPortConflict),
}

impl VesloPortResolveError {
    pub fn message(&self) -> String {
        match self {
            Self::InvalidConfig(message) => message.clone(),
            Self::Conflict(conflict) => conflict.message(),
        }
    }

    pub fn conflict(&self) -> Option<&VesloPortConflict> {
        match self {
            Self::Conflict(conflict) => Some(conflict),
            Self::InvalidConfig(_) => None,
        }
    }
}

impl fmt::Display for VesloPortResolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message())
    }
}

fn parse_env_flag(value: Option<&str>) -> bool {
    matches!(
        value.map(|raw| raw.trim().to_ascii_lowercase()),
        Some(flag) if matches!(flag.as_str(), "1" | "true" | "yes" | "on")
    )
}

fn parse_dev_watch_flag(value: Option<&str>) -> bool {
    parse_env_flag(value)
}

fn should_use_dev_watch_mode_from_env(
    value: Option<&str>,
    external_runtime_binaries_allowed: bool,
) -> Result<bool, String> {
    let requested = parse_dev_watch_flag(value);
    if requested && !external_runtime_binaries_allowed {
        return Err(format!(
            "{VESLO_SERVER_DEV_WATCH_ENV}=1 requires {}=1 in release builds because it starts Bun from PATH",
            supervised_process::ALLOW_EXTERNAL_RUNTIME_BINARIES_ENV
        ));
    }
    Ok(requested)
}

fn should_use_dev_watch_mode() -> Result<bool, String> {
    should_use_dev_watch_mode_from_env(
        env::var(VESLO_SERVER_DEV_WATCH_ENV).ok().as_deref(),
        supervised_process::external_runtime_binaries_allowed(),
    )
}

fn resolve_dev_watch_dir() -> PathBuf {
    let dir = env::var(VESLO_SERVER_DEV_DIR_ENV)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .unwrap_or_else(|| ".".to_string());
    PathBuf::from(dir)
}

fn build_veslo_server_dev_watch_args(mut server_args: Vec<String>) -> Vec<String> {
    let mut args = vec![
        "--watch".to_string(),
        "src/cli.ts".to_string(),
        "--".to_string(),
    ];
    args.append(&mut server_args);
    args
}

pub(crate) fn host_from_http_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let without_scheme = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))?;
    let authority = without_scheme.split('/').next().unwrap_or("");
    if let Some(rest) = authority.strip_prefix('[') {
        return rest.split(']').next().map(|host| host.to_string());
    }
    authority.split(':').next().map(|host| host.to_string())
}

fn is_loopback_http_url(raw: &str) -> bool {
    let Some(host) = host_from_http_url(raw) else {
        return false;
    };
    let normalized = host.trim().to_ascii_lowercase();
    normalized == "localhost" || normalized == "::1" || normalized.starts_with("127.")
}

fn validate_managed_opencode_base_url(opencode_base_url: Option<&str>) -> Result<(), String> {
    let Some(raw) = opencode_base_url else {
        return Ok(());
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || is_loopback_http_url(trimmed) {
        return Ok(());
    }
    Err(format!(
        "Refusing to start local Veslo server with non-loopback OpenCode base URL: {trimmed}"
    ))
}

#[cfg(test)]
pub fn resolve_veslo_port() -> Result<u16, String> {
    let host = resolve_veslo_host();
    let configured = configured_veslo_port()?;
    if configured.port == 0 {
        return Ok(0);
    }
    bind_veslo_port(&host, configured.port, configured.fallback_policy())
        .map_err(|error| error.message())
}

fn bind_veslo_port(
    host: &str,
    port: u16,
    fallback_policy: VesloPortFallbackPolicy,
) -> Result<u16, VesloPortConflict> {
    TcpListener::bind((host, port))
        .map(|listener| {
            listener
                .local_addr()
                .map(|addr| addr.port())
                .unwrap_or(port)
        })
        .map_err(|error| VesloPortConflict {
            host: host.to_string(),
            port,
            source: error.to_string(),
            fallback_policy,
        })
}

pub fn resolve_veslo_port_after_restart_detailed(
    host: &str,
) -> Result<VesloPortResolution, VesloPortResolveError> {
    let configured = configured_veslo_port().map_err(VesloPortResolveError::InvalidConfig)?;
    let port = configured.port;
    if port == 0 {
        return Ok(VesloPortResolution {
            requested_port: port,
            bind_port: port,
            fallback_conflict: None,
        });
    }
    let fallback_policy = configured.fallback_policy();
    let deadline = std::time::Instant::now() + PORT_RESTART_RETRY_TIMEOUT;
    loop {
        match bind_veslo_port(host, port, fallback_policy) {
            Ok(resolved) => {
                return Ok(VesloPortResolution {
                    requested_port: port,
                    bind_port: resolved,
                    fallback_conflict: None,
                });
            }
            Err(error) if std::time::Instant::now() < deadline => {
                std::thread::sleep(PORT_RESTART_RETRY_INTERVAL);
                if std::time::Instant::now() >= deadline {
                    if fallback_policy == VesloPortFallbackPolicy::Ephemeral {
                        return Ok(VesloPortResolution {
                            requested_port: port,
                            bind_port: 0,
                            fallback_conflict: Some(error),
                        });
                    }
                    return Err(VesloPortResolveError::Conflict(error));
                }
            }
            Err(error) => {
                if fallback_policy == VesloPortFallbackPolicy::Ephemeral {
                    return Ok(VesloPortResolution {
                        requested_port: port,
                        bind_port: 0,
                        fallback_conflict: Some(error),
                    });
                }
                return Err(VesloPortResolveError::Conflict(error));
            }
        }
    }
}

#[cfg(test)]
pub fn resolve_veslo_port_after_restart(host: &str) -> Result<u16, String> {
    resolve_veslo_port_after_restart_detailed(host)
        .map(|resolution| resolution.bind_port)
        .map_err(|error| error.message())
}

fn resolve_veslo_host_from_env(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_VESLO_HOST)
        .to_string()
}

pub fn resolve_veslo_host() -> String {
    resolve_veslo_host_from_env(env::var(VESLO_DESKTOP_SERVER_HOST_ENV).ok().as_deref())
}

fn configured_veslo_port() -> Result<ConfiguredVesloPort, String> {
    let raw = match env::var(VESLO_DESKTOP_SERVER_PORT_ENV) {
        Ok(value) => value,
        Err(_) => {
            return Ok(ConfiguredVesloPort {
                port: DEFAULT_VESLO_PORT,
                source: VesloPortSource::Default,
            });
        }
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(ConfiguredVesloPort {
            port: DEFAULT_VESLO_PORT,
            source: VesloPortSource::Default,
        });
    }
    let port = trimmed.parse::<u16>().map_err(|_| {
        format!("Invalid {VESLO_DESKTOP_SERVER_PORT_ENV}: expected TCP port, got {trimmed}")
    })?;
    Ok(ConfiguredVesloPort {
        port,
        source: VesloPortSource::Explicit,
    })
}

#[expect(
    clippy::too_many_arguments,
    reason = "The sidecar argument builder keeps each security-sensitive launch input explicit."
)]
pub fn build_veslo_args(
    host: &str,
    port: u16,
    workspace_paths: &[String],
    workspace_ids: &[Option<String>],
    opencode_base_url: Option<&str>,
    opencode_directory: Option<&str>,
    orchestrator_daemon_url: Option<&str>,
    bridge_host: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "--host".to_string(),
        host.to_string(),
        "--port".to_string(),
        port.to_string(),
        // Always allow all origins since the Veslo server is designed to accept
        // remote connections from client devices (phones, laptops) which may use
        // different origins (localhost dev servers, tauri apps, web browsers).
        "--cors".to_string(),
        "*".to_string(),
        // Auto-approve write operations when running from the desktop app.
        // The user is already authenticated as host and in control of the UI.
        "--approval".to_string(),
        "auto".to_string(),
    ];

    // VSLO-250 — extra WSL-reachable listener so OpenCode inside WSL can reach
    // the managed AI gateway while the primary listener stays on loopback.
    if let Some(bridge_host) = bridge_host {
        let trimmed = bridge_host.trim();
        if !trimmed.is_empty() && trimmed != host {
            args.push("--bridge-host".to_string());
            args.push(trimmed.to_string());
        }
    }

    for (index, workspace_path) in workspace_paths.iter().enumerate() {
        if !workspace_path.trim().is_empty() {
            args.push("--workspace".to_string());
            args.push(workspace_path.to_string());
            if let Some(workspace_id) = workspace_ids.get(index).and_then(|id| id.as_ref()) {
                if !workspace_id.trim().is_empty() {
                    args.push("--workspace-id".to_string());
                    args.push(workspace_id.to_string());
                }
            }
        }
    }

    if let Some(base_url) = opencode_base_url {
        if !base_url.trim().is_empty() {
            args.push("--opencode-base-url".to_string());
            args.push(base_url.to_string());
        }
    }

    if let Some(directory) = opencode_directory {
        if !directory.trim().is_empty() {
            args.push("--opencode-directory".to_string());
            args.push(directory.to_string());
        }
    }

    if let Some(url) = orchestrator_daemon_url {
        if !url.trim().is_empty() {
            args.push("--orchestrator-url".to_string());
            args.push(url.to_string());
        }
    }

    args
}

fn build_veslo_secrets_json(
    token: &str,
    host_token: &str,
    orchestrator_lifecycle_token: Option<&str>,
) -> Result<String, String> {
    let mut secrets = serde_json::json!({
        "clientToken": token,
        "hostToken": host_token,
    });

    if let Some(token) = orchestrator_lifecycle_token
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        secrets["orchestratorLifecycleToken"] = serde_json::Value::String(token.to_string());
    }

    serde_json::to_string_pretty(&secrets)
        .map(|contents| format!("{contents}\n"))
        .map_err(|error| format!("failed to serialize Veslo server secrets: {error}"))
}

#[cfg(unix)]
fn write_private_file(path: &Path, contents: &str) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("failed to create private file {}: {error}", path.display()))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("failed to write private file {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn write_private_file(path: &Path, contents: &str) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("failed to create private file {}: {error}", path.display()))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("failed to write private file {}: {error}", path.display()))
}

fn write_veslo_secrets_file(
    path: &Path,
    token: &str,
    host_token: &str,
    orchestrator_lifecycle_token: Option<&str>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create Veslo server secrets directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let contents = build_veslo_secrets_json(token, host_token, orchestrator_lifecycle_token)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("veslo-server.secrets.json");
    let temp_path = path.with_file_name(format!("{file_name}.{}.tmp", std::process::id()));

    let _ = fs::remove_file(&temp_path);
    if let Err(error) = write_private_file(&temp_path, &contents) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    let _ = fs::remove_file(path);
    fs::rename(&temp_path, path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        format!(
            "failed to publish Veslo server secrets file {}: {error}",
            path.display()
        )
    })
}

struct SpawnSecretsFileGuard<'a> {
    path: &'a Path,
    armed: bool,
}

impl<'a> SpawnSecretsFileGuard<'a> {
    fn new(path: &'a Path) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for SpawnSecretsFileGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(self.path);
        }
    }
}

fn resolve_managed_ai_base_url_from_env(
    managed_ai_base_url: Option<&str>,
    legacy_ai_gateway_base_url: Option<&str>,
    deployment_domain: Option<&str>,
) -> String {
    managed_ai_base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            legacy_ai_gateway_base_url
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .map(str::to_string)
        .unwrap_or_else(|| deployment_service_url("ai", deployment_domain))
        .trim_end_matches('/')
        .to_string()
}

fn normalize_deployment_domain(raw: Option<&str>) -> String {
    let value = raw.map(str::trim).unwrap_or("");
    if value.is_empty() {
        return DEFAULT_VESLO_DEPLOYMENT_DOMAIN.to_string();
    }

    let without_scheme = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
        .unwrap_or(value);
    let host = without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let labels = ["api.", "ai.", "app.", "admin.", "workers."];
    for label in labels {
        if let Some(rest) = host.strip_prefix(label) {
            if !rest.is_empty() {
                return rest.to_string();
            }
        }
    }

    if host.is_empty() {
        DEFAULT_VESLO_DEPLOYMENT_DOMAIN.to_string()
    } else {
        host
    }
}

fn deployment_service_url(service: &str, deployment_domain: Option<&str>) -> String {
    format!(
        "https://{}.{}",
        service,
        normalize_deployment_domain(deployment_domain)
    )
}

fn resolve_managed_ai_base_url() -> String {
    let deployment_domain = env::var(VESLO_DEPLOYMENT_DOMAIN_ENV)
        .ok()
        .or_else(|| option_env!("VESLO_DEPLOYMENT_DOMAIN").map(str::to_string));
    resolve_managed_ai_base_url_from_env(
        std::env::var("VESLO_MANAGED_AI_BASE_URL").ok().as_deref(),
        std::env::var("VESLO_AI_GATEWAY_BASE_URL").ok().as_deref(),
        deployment_domain.as_deref(),
    )
}

fn default_server_sandbox_backend_for_platform() -> &'static str {
    "none"
}

fn resolve_server_sandbox_backend_from_env(
    _explicit_backend: Option<&str>,
    _disable_sandbox: Option<&str>,
) -> String {
    default_server_sandbox_backend_for_platform().to_string()
}

pub fn resolve_server_sandbox_backend() -> String {
    resolve_server_sandbox_backend_from_env(
        env::var(VESLO_SANDBOX_BACKEND_ENV).ok().as_deref(),
        env::var(VESLO_DISABLE_SANDBOX_ENV).ok().as_deref(),
    )
}

pub fn resolve_server_sandbox_backend_for_runtime_preference(
    _shared_unsandboxed_engine: Option<bool>,
) -> String {
    "none".to_string()
}

fn server_cwd_from_app_data_dir(
    app_data_dir: Option<PathBuf>,
    _workspace_paths: &[String],
) -> PathBuf {
    if let Some(app_data_dir) = app_data_dir {
        if let Err(error) = fs::create_dir_all(&app_data_dir) {
            println!(
                "[veslo-server] warning: failed to create app data cwd {}: {error}",
                app_data_dir.display()
            );
        } else {
            return app_data_dir;
        }
    }

    PathBuf::from(".")
}

fn server_cwd_for_workspace_paths(app: &AppHandle, workspace_paths: &[String]) -> PathBuf {
    server_cwd_from_app_data_dir(app.path().app_data_dir().ok(), workspace_paths)
}

#[expect(
    clippy::too_many_arguments,
    reason = "The sidecar owner keeps launch inputs explicit rather than relying on hidden global state."
)]
pub fn spawn_veslo_server(
    app: &AppHandle,
    host: &str,
    port: u16,
    instance_id: &str,
    runtime_descriptor_path: &Path,
    secrets_file_path: &Path,
    workspace_paths: &[String],
    workspace_ids: &[Option<String>],
    token: &str,
    host_token: &str,
    opencode_base_url: Option<&str>,
    opencode_directory: Option<&str>,
    opencode_username: Option<&str>,
    opencode_password: Option<&str>,
    opencode_router_health_port: Option<u16>,
    orchestrator_daemon_url: Option<&str>,
    orchestrator_lifecycle_token: Option<&str>,
    bridge_host: Option<&str>,
    sandbox_backend: &str,
    shared_unsandboxed_engine: Option<bool>,
) -> Result<(Receiver<CommandEvent>, SupervisedCommandChild), String> {
    validate_managed_opencode_base_url(opencode_base_url)?;
    write_veslo_secrets_file(
        secrets_file_path,
        token,
        host_token,
        orchestrator_lifecycle_token,
    )?;
    let mut secrets_file_guard = SpawnSecretsFileGuard::new(secrets_file_path);

    let server_args = build_veslo_args(
        host,
        port,
        workspace_paths,
        workspace_ids,
        opencode_base_url,
        opencode_directory,
        orchestrator_daemon_url,
        bridge_host,
    );
    let use_dev_watch = should_use_dev_watch_mode()?;

    let mut command = if use_dev_watch {
        let dev_watch_dir = resolve_dev_watch_dir();
        supervised_process::command(app, "bun")
            .args(build_veslo_server_dev_watch_args(server_args))
            .current_dir(&dev_watch_dir)
    } else {
        let command = match supervised_process::sidecar(app, "veslo-server") {
            Ok(command) => command,
            Err(error) => supervised_process::command_fallback_for_missing_sidecar(
                app,
                "veslo-server",
                "veslo-server",
                error,
            )?,
        };
        let cwd = server_cwd_for_workspace_paths(app, workspace_paths);
        command.args(server_args).current_dir(cwd)
    }
    .env("VESLO_MANAGED_AI_BASE_URL", resolve_managed_ai_base_url());
    for (key, value) in desktop_server_observability_env_overrides() {
        command = command.env(key, value);
    }
    command = command.env("VESLO_INSTANCE_ID", instance_id);
    command = command.env(
        VESLO_RUNTIME_FILE_ENV,
        runtime_descriptor_path.to_string_lossy().to_string(),
    );
    command = command.env(
        VESLO_RUNTIME_DESCRIPTOR_PATH_ENV,
        runtime_descriptor_path.to_string_lossy().to_string(),
    );
    command = command.env(
        VESLO_SECRETS_FILE_ENV,
        secrets_file_path.to_string_lossy().to_string(),
    );
    command = command.env(VESLO_SANDBOX_BACKEND_ENV, sandbox_backend);
    for (key, value) in
        crate::runtime_preferences::host_runtime_env_overrides(shared_unsandboxed_engine)
    {
        command = command.env(key, value);
    }
    for (key, value) in crate::runtime_preferences::runtime_diagnostics_env_overrides(app)? {
        command = command.env(key, value);
    }

    if let Some(port) = opencode_router_health_port {
        command = command.env("OPENCODE_ROUTER_HEALTH_PORT", port.to_string());
    }

    if let Some(username) = opencode_username {
        if !username.trim().is_empty() {
            command = command.env("VESLO_OPENCODE_USERNAME", username);
        }
    }

    if let Some(password) = opencode_password {
        if !password.trim().is_empty() {
            command = command.env("VESLO_OPENCODE_PASSWORD", password);
        }
    }

    for (key, value) in crate::bun_env::bun_env_overrides() {
        command = command.env(key, value);
    }

    let child = command.spawn().map_err(|e| {
        if use_dev_watch {
            format!("Failed to start Veslo server in dev watch mode: {e}")
        } else {
            format!("Failed to start Veslo server: {e}")
        }
    })?;
    secrets_file_guard.disarm();
    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    struct EnvGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: String) -> Self {
            let previous = env::var(key).ok();
            env::set_var(key, value);
            Self { key, previous }
        }

        fn unset(key: &'static str) -> Self {
            let previous = env::var(key).ok();
            env::remove_var(key);
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => env::set_var(self.key, value),
                None => env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn parses_dev_watch_flag_truthy_values() {
        assert!(parse_dev_watch_flag(Some("1")));
        assert!(parse_dev_watch_flag(Some("true")));
        assert!(parse_dev_watch_flag(Some("TRUE")));
        assert!(!parse_dev_watch_flag(Some("0")));
        assert!(!parse_dev_watch_flag(Some("false")));
        assert!(!parse_dev_watch_flag(Some("")));
        assert!(!parse_dev_watch_flag(None));
    }

    #[test]
    fn release_dev_watch_requires_external_runtime_override() {
        assert!(should_use_dev_watch_mode_from_env(Some("1"), true)
            .expect("debug/developer override allows dev watch"));

        let error = should_use_dev_watch_mode_from_env(Some("1"), false)
            .expect_err("release dev watch must not silently start Bun");
        assert!(error.contains(VESLO_SERVER_DEV_WATCH_ENV));
        assert!(error.contains(supervised_process::ALLOW_EXTERNAL_RUNTIME_BINARIES_ENV));
    }

    #[test]
    fn veslo_server_host_defaults_to_loopback() {
        assert_eq!(resolve_veslo_host_from_env(None), "127.0.0.1");
        assert_eq!(resolve_veslo_host_from_env(Some(" ")), "127.0.0.1");
        assert_eq!(resolve_veslo_host_from_env(Some("0.0.0.0")), "0.0.0.0");
    }

    #[test]
    fn prepends_bun_watch_prefix_for_dev_server() {
        let args = vec!["--host".to_string(), "0.0.0.0".to_string()];
        let expected = vec![
            "--watch".to_string(),
            "src/cli.ts".to_string(),
            "--".to_string(),
            "--host".to_string(),
            "0.0.0.0".to_string(),
        ];
        assert_eq!(build_veslo_server_dev_watch_args(args), expected);
    }

    #[test]
    fn server_cwd_uses_app_data_dir_even_when_workspace_paths_exist() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let app_data_dir = std::env::temp_dir().join(format!(
            "veslo-server-cwd-test-{}-{suffix}",
            std::process::id(),
        ));
        let protected_workspace = "/Users/example/Documents/Denied Project".to_string();

        let cwd = server_cwd_from_app_data_dir(Some(app_data_dir.clone()), &[protected_workspace]);

        assert_eq!(cwd, app_data_dir);
        let _ = fs::remove_dir_all(cwd);
    }

    #[test]
    fn resolve_veslo_port_falls_back_to_ephemeral_for_default_port_contention() {
        let _lock = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _guard = EnvGuard::unset(VESLO_DESKTOP_SERVER_PORT_ENV);
        let fixed_port_guard =
            TcpListener::bind((resolve_veslo_host().as_str(), DEFAULT_VESLO_PORT)).ok();

        let resolution = resolve_veslo_port_after_restart_detailed(resolve_veslo_host().as_str())
            .expect("default-port contention should select an ephemeral bind request");

        drop(fixed_port_guard);

        assert_eq!(resolution.requested_port, DEFAULT_VESLO_PORT);
        assert_eq!(resolution.bind_port, 0);
        let conflict = resolution
            .fallback_conflict
            .expect("fallback should preserve conflict diagnostics");
        assert_eq!(conflict.port, DEFAULT_VESLO_PORT);
        assert_eq!(conflict.fallback_policy(), "ephemeral");
    }

    #[test]
    fn port_conflict_carries_structured_policy_details() {
        let _lock = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let host = resolve_veslo_host();
        let _guard = EnvGuard::unset(VESLO_DESKTOP_SERVER_PORT_ENV);
        let fixed_port_guard = TcpListener::bind((host.as_str(), DEFAULT_VESLO_PORT)).ok();

        let conflict =
            bind_veslo_port(&host, DEFAULT_VESLO_PORT, VesloPortFallbackPolicy::Disabled)
                .expect_err("reserved fixed port should report structured conflict");

        drop(fixed_port_guard);

        assert_eq!(conflict.host, host);
        assert_eq!(conflict.port, DEFAULT_VESLO_PORT);
        assert!(conflict.is_default_port());
        assert_eq!(conflict.fallback_policy(), "disabled");
        assert!(conflict.message().contains("port_conflict"));
    }

    #[test]
    fn resolve_veslo_port_blocks_explicit_port_contention() {
        let _lock = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve explicit port");
        let port = listener.local_addr().expect("read explicit port").port();
        let _guard = EnvGuard::set(VESLO_DESKTOP_SERVER_PORT_ENV, port.to_string());

        let error = resolve_veslo_port_after_restart(resolve_veslo_host().as_str())
            .expect_err("explicit configured port conflict must remain blocking");

        drop(listener);

        assert!(error.contains("port_conflict"));
        assert!(error.contains(&port.to_string()));
        assert!(error.contains("ephemeral fallback is disabled"));
    }

    #[test]
    fn resolve_veslo_port_allows_explicit_ephemeral_request() {
        let _lock = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _guard = EnvGuard::set(VESLO_DESKTOP_SERVER_PORT_ENV, "0".to_string());

        let resolution = resolve_veslo_port_after_restart_detailed(resolve_veslo_host().as_str())
            .expect("explicit ephemeral port should be a valid bind request");

        assert_eq!(resolution.requested_port, 0);
        assert_eq!(resolution.bind_port, 0);
        assert_eq!(resolution.fallback_conflict, None);
    }

    #[test]
    fn resolve_veslo_port_uses_env_override_for_e2e_isolation() {
        let _lock = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve candidate port");
        let port = listener.local_addr().expect("read candidate port").port();
        drop(listener);
        let _guard = EnvGuard::set(VESLO_DESKTOP_SERVER_PORT_ENV, port.to_string());

        assert_eq!(resolve_veslo_port().expect("resolve override port"), port);
    }

    #[test]
    fn resolve_veslo_port_after_restart_waits_for_previous_listener() {
        let _lock = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve candidate port");
        let port = listener.local_addr().expect("read candidate port").port();
        let _guard = EnvGuard::set(VESLO_DESKTOP_SERVER_PORT_ENV, port.to_string());

        let releaser = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            drop(listener);
        });

        assert_eq!(
            resolve_veslo_port_after_restart(resolve_veslo_host().as_str())
                .expect("resolve released restart port"),
            port
        );
        releaser.join().expect("listener releaser joins");
    }

    #[test]
    fn build_args_pairs_workspace_ids_with_workspace_paths() {
        let args = build_veslo_args(
            "0.0.0.0",
            8787,
            &["/tmp/workspace-a".to_string()],
            &[Some("app-workspace-a".to_string())],
            None,
            None,
            None,
            None,
        );

        assert!(args
            .windows(2)
            .any(|pair| pair == ["--workspace", "/tmp/workspace-a"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--workspace-id", "app-workspace-a"]));
    }

    #[test]
    fn desktop_server_uses_structured_logs_for_feedback_diagnostics() {
        assert_eq!(
            desktop_server_observability_env_overrides(),
            [("VESLO_LOG_FORMAT", "json")]
        );
    }

    #[test]
    fn build_args_includes_bridge_host_when_distinct_from_host() {
        let args = build_veslo_args(
            "127.0.0.1",
            8787,
            &["/tmp/workspace-a".to_string()],
            &[None],
            None,
            None,
            None,
            Some("172.29.64.1"),
        );

        assert!(args
            .windows(2)
            .any(|pair| pair == ["--bridge-host", "172.29.64.1"]));
    }

    #[test]
    fn build_args_skips_bridge_host_equal_to_primary_host() {
        let args = build_veslo_args(
            "0.0.0.0",
            8787,
            &["/tmp/workspace-a".to_string()],
            &[None],
            None,
            None,
            None,
            Some("0.0.0.0"),
        );

        assert!(!args.iter().any(|arg| arg == "--bridge-host"));
    }

    #[test]
    fn build_args_includes_orchestrator_url_without_secrets() {
        let args = build_veslo_args(
            "0.0.0.0",
            8787,
            &["/tmp/workspace-a".to_string()],
            &[Some("app-workspace-a".to_string())],
            Some("http://127.0.0.1:12345/workspace/ws-a/opencode"),
            Some("/tmp/workspace-a"),
            Some("http://127.0.0.1:12345"),
            None,
        );

        assert!(args
            .windows(2)
            .any(|pair| pair == ["--orchestrator-url", "http://127.0.0.1:12345"]));
        let forbidden_args =
            ["token", "host-token", "orchestrator-lifecycle-token"].map(|name| format!("--{name}"));
        assert!(!args.iter().any(|arg| forbidden_args.contains(arg)));
    }

    #[test]
    fn secrets_json_contains_tokens_without_argv_flags() {
        let contents =
            build_veslo_secrets_json("client-token", "host-token", Some(" lifecycle-token "))
                .expect("serialize secrets");
        let parsed: serde_json::Value = serde_json::from_str(&contents).expect("parse secrets");

        assert_eq!(parsed["clientToken"], "client-token");
        assert_eq!(parsed["hostToken"], "host-token");
        assert_eq!(parsed["orchestratorLifecycleToken"], "lifecycle-token");
    }

    #[test]
    fn spawn_secrets_guard_removes_file_unless_disarmed() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "veslo-spawn-secrets-guard-{}-{suffix}.json",
            std::process::id()
        ));
        let kept_path = std::env::temp_dir().join(format!(
            "veslo-spawn-secrets-guard-{}-{suffix}.kept.json",
            std::process::id()
        ));
        fs::write(&path, "secret").expect("write guarded file");
        fs::write(&kept_path, "secret").expect("write kept file");

        {
            let _guard = SpawnSecretsFileGuard::new(&path);
        }
        {
            let mut guard = SpawnSecretsFileGuard::new(&kept_path);
            guard.disarm();
        }

        assert!(!path.exists());
        assert!(kept_path.exists());
        let _ = fs::remove_file(kept_path);
    }

    #[test]
    fn managed_opencode_base_url_requires_loopback() {
        assert!(validate_managed_opencode_base_url(Some("http://127.0.0.1:52925")).is_ok());
        assert!(validate_managed_opencode_base_url(Some("http://localhost:52925")).is_ok());
        assert!(validate_managed_opencode_base_url(Some("http://[::1]:52925")).is_ok());
        assert!(validate_managed_opencode_base_url(None).is_ok());

        let error = validate_managed_opencode_base_url(Some("http://172.20.10.2:52925"))
            .expect_err("LAN OpenCode URLs must not be used for local sidecar wiring");
        assert!(error.contains("non-loopback OpenCode base URL"));
    }

    #[test]
    fn managed_ai_base_url_prefers_new_env() {
        let resolved = resolve_managed_ai_base_url_from_env(
            Some(" https://managed.example.test/ "),
            Some("https://legacy.example.test/"),
            Some("staging.veslo.work"),
        );

        assert_eq!(resolved, "https://managed.example.test");
    }

    #[test]
    fn managed_ai_base_url_falls_back_to_legacy_env() {
        let resolved =
            resolve_managed_ai_base_url_from_env(None, Some("https://legacy.example.test/"), None);

        assert_eq!(resolved, "https://legacy.example.test");
    }

    #[test]
    fn managed_ai_base_url_defaults_to_owned_gateway() {
        let resolved = resolve_managed_ai_base_url_from_env(None, None, None);

        assert_eq!(
            resolved,
            format!("https://ai.{}", DEFAULT_VESLO_DEPLOYMENT_DOMAIN)
        );
    }

    #[test]
    fn managed_ai_base_url_derives_from_deployment_domain() {
        let staging_domain = "staging.veslo.work";
        let resolved = resolve_managed_ai_base_url_from_env(None, None, Some(staging_domain));

        assert_eq!(resolved, format!("https://ai.{}", staging_domain));
    }

    #[test]
    fn sandbox_backend_ignores_retired_wsl_env() {
        let resolved = resolve_server_sandbox_backend_from_env(Some(" windows-wsl2 "), None);

        assert_eq!(resolved, "none");
    }

    #[test]
    fn sandbox_backend_disable_flag_wins() {
        let resolved = resolve_server_sandbox_backend_from_env(Some("windows-wsl2"), Some("true"));

        assert_eq!(resolved, "none");
    }

    #[test]
    fn sandbox_backend_defaults_by_platform() {
        let resolved = resolve_server_sandbox_backend_from_env(None, None);

        assert_eq!(resolved, "none");
    }

    #[test]
    fn sandbox_backend_runtime_preference_disables_sandbox() {
        let resolved = resolve_server_sandbox_backend_for_runtime_preference(Some(true));

        assert_eq!(resolved, "none");
    }

    #[test]
    fn sandbox_backend_runtime_preference_false_stays_host_only() {
        let _lock = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _disable_guard = EnvGuard::set(VESLO_DISABLE_SANDBOX_ENV, "1".to_string());
        let _backend_guard = EnvGuard::set(VESLO_SANDBOX_BACKEND_ENV, "windows-wsl2".to_string());

        let resolved = resolve_server_sandbox_backend_for_runtime_preference(Some(false));

        assert_eq!(resolved, "none");
    }
}
