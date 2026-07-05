use std::env;
use std::fs;
use std::net::TcpListener;
use std::path::PathBuf;

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
const PORT_RESTART_RETRY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const PORT_RESTART_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

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
    let port = configured_veslo_port()?;
    bind_veslo_port(&host, port)
}

fn bind_veslo_port(host: &str, port: u16) -> Result<u16, String> {
    TcpListener::bind((host, port))
        .map(|_| port)
        .map_err(|error| format!("Veslo server port {port} on {host} is unavailable: {error}"))
}

pub fn resolve_veslo_port_after_restart(host: &str) -> Result<u16, String> {
    let port = configured_veslo_port()?;
    let deadline = std::time::Instant::now() + PORT_RESTART_RETRY_TIMEOUT;
    loop {
        match bind_veslo_port(host, port) {
            Ok(resolved) => return Ok(resolved),
            Err(error) if std::time::Instant::now() < deadline => {
                std::thread::sleep(PORT_RESTART_RETRY_INTERVAL);
                if std::time::Instant::now() >= deadline {
                    return Err(error);
                }
            }
            Err(error) => return Err(error),
        }
    }
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

fn configured_veslo_port() -> Result<u16, String> {
    let raw = match env::var(VESLO_DESKTOP_SERVER_PORT_ENV) {
        Ok(value) => value,
        Err(_) => return Ok(DEFAULT_VESLO_PORT),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(DEFAULT_VESLO_PORT);
    }
    let port = trimmed.parse::<u16>().map_err(|_| {
        format!("Invalid {VESLO_DESKTOP_SERVER_PORT_ENV}: expected TCP port, got {trimmed}")
    })?;
    if port == 0 {
        return Err(format!(
            "Invalid {VESLO_DESKTOP_SERVER_PORT_ENV}: desktop server port must be greater than 0"
        ));
    }
    Ok(port)
}

pub fn build_veslo_args(
    host: &str,
    port: u16,
    workspace_paths: &[String],
    workspace_ids: &[Option<String>],
    token: &str,
    host_token: &str,
    opencode_base_url: Option<&str>,
    opencode_directory: Option<&str>,
    orchestrator_daemon_url: Option<&str>,
    orchestrator_lifecycle_token: Option<&str>,
    bridge_host: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "--host".to_string(),
        host.to_string(),
        "--port".to_string(),
        port.to_string(),
        "--token".to_string(),
        token.to_string(),
        "--host-token".to_string(),
        host_token.to_string(),
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

    if let Some(token) = orchestrator_lifecycle_token {
        if !token.trim().is_empty() {
            args.push("--orchestrator-lifecycle-token".to_string());
            args.push(token.to_string());
        }
    }

    args
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
    if cfg!(windows) {
        "windows-wsl2"
    } else if cfg!(target_os = "macos") {
        "mac-sandbox-exec"
    } else {
        "none"
    }
}

fn resolve_server_sandbox_backend_from_env(
    explicit_backend: Option<&str>,
    disable_sandbox: Option<&str>,
) -> String {
    if parse_env_flag(disable_sandbox) {
        return "none".to_string();
    }

    if let Some(value) = explicit_backend
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return value.to_string();
    }

    default_server_sandbox_backend_for_platform().to_string()
}

pub fn resolve_server_sandbox_backend() -> String {
    resolve_server_sandbox_backend_from_env(
        env::var(VESLO_SANDBOX_BACKEND_ENV).ok().as_deref(),
        env::var(VESLO_DISABLE_SANDBOX_ENV).ok().as_deref(),
    )
}

pub fn resolve_server_sandbox_backend_for_runtime_preference(
    shared_unsandboxed_engine: Option<bool>,
) -> String {
    match shared_unsandboxed_engine {
        Some(true) => "none".to_string(),
        Some(false) => resolve_server_sandbox_backend_from_env(
            env::var(VESLO_SANDBOX_BACKEND_ENV).ok().as_deref(),
            Some("0"),
        ),
        None => resolve_server_sandbox_backend(),
    }
}

fn server_cwd_for_workspace_paths(app: &AppHandle, workspace_paths: &[String]) -> PathBuf {
    if let Some(path) = workspace_paths
        .first()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty())
    {
        return PathBuf::from(path);
    }

    if let Ok(app_data_dir) = app.path().app_data_dir() {
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

pub fn spawn_veslo_server(
    app: &AppHandle,
    host: &str,
    port: u16,
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

    let server_args = build_veslo_args(
        host,
        port,
        workspace_paths,
        workspace_ids,
        token,
        host_token,
        opencode_base_url,
        opencode_directory,
        orchestrator_daemon_url,
        orchestrator_lifecycle_token,
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
    command = command.env(VESLO_SANDBOX_BACKEND_ENV, sandbox_backend);
    for (key, value) in crate::runtime_preferences::shared_unsandboxed_engine_env_overrides(
        shared_unsandboxed_engine,
    ) {
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

    command.spawn().map_err(|e| {
        if use_dev_watch {
            format!("Failed to start Veslo server in dev watch mode: {e}")
        } else {
            format!("Failed to start Veslo server: {e}")
        }
    })
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
    fn resolve_veslo_port_reports_fixed_port_contention() {
        let _lock = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _guard = EnvGuard::unset(VESLO_DESKTOP_SERVER_PORT_ENV);
        let fixed_port_guard =
            TcpListener::bind((resolve_veslo_host().as_str(), DEFAULT_VESLO_PORT)).ok();

        let error = resolve_veslo_port()
            .expect_err("Veslo desktop must not fall back to a dynamic server port");

        drop(fixed_port_guard);

        assert!(
            error.contains(&DEFAULT_VESLO_PORT.to_string()),
            "fixed-port contention errors should name the configured Veslo server port: {error}"
        );
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
            "client-token",
            "host-token",
            None,
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
    fn build_args_includes_bridge_host_when_distinct_from_host() {
        let args = build_veslo_args(
            "127.0.0.1",
            8787,
            &["/tmp/workspace-a".to_string()],
            &[None],
            "client-token",
            "host-token",
            None,
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
            "client-token",
            "host-token",
            None,
            None,
            None,
            None,
            Some("0.0.0.0"),
        );

        assert!(!args.iter().any(|arg| arg == "--bridge-host"));
    }

    #[test]
    fn build_args_includes_orchestrator_lifecycle_config() {
        let args = build_veslo_args(
            "0.0.0.0",
            8787,
            &["/tmp/workspace-a".to_string()],
            &[Some("app-workspace-a".to_string())],
            "client-token",
            "host-token",
            Some("http://127.0.0.1:12345/workspace/ws-a/opencode"),
            Some("/tmp/workspace-a"),
            Some("http://127.0.0.1:12345"),
            Some("lifecycle-token"),
            None,
        );

        assert!(args
            .windows(2)
            .any(|pair| pair == ["--orchestrator-url", "http://127.0.0.1:12345"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--orchestrator-lifecycle-token", "lifecycle-token"]));
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
        let resolved =
            resolve_managed_ai_base_url_from_env(None, None, Some(staging_domain));

        assert_eq!(resolved, format!("https://ai.{}", staging_domain));
    }

    #[test]
    fn sandbox_backend_prefers_explicit_env() {
        let resolved = resolve_server_sandbox_backend_from_env(Some(" windows-wsl2 "), None);

        assert_eq!(resolved, "windows-wsl2");
    }

    #[test]
    fn sandbox_backend_disable_flag_wins() {
        let resolved = resolve_server_sandbox_backend_from_env(Some("windows-wsl2"), Some("true"));

        assert_eq!(resolved, "none");
    }

    #[test]
    fn sandbox_backend_defaults_by_platform() {
        let resolved = resolve_server_sandbox_backend_from_env(None, None);

        if cfg!(windows) {
            assert_eq!(resolved, "windows-wsl2");
        } else if cfg!(target_os = "macos") {
            assert_eq!(resolved, "mac-sandbox-exec");
        } else {
            assert_eq!(resolved, "none");
        }
    }

    #[test]
    fn sandbox_backend_runtime_preference_disables_sandbox() {
        let resolved = resolve_server_sandbox_backend_for_runtime_preference(Some(true));

        assert_eq!(resolved, "none");
    }

    #[test]
    fn sandbox_backend_runtime_preference_false_ignores_disable_env() {
        let _lock = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _disable_guard = EnvGuard::set(VESLO_DISABLE_SANDBOX_ENV, "1".to_string());
        let _backend_guard = EnvGuard::set(VESLO_SANDBOX_BACKEND_ENV, "windows-wsl2".to_string());

        let resolved = resolve_server_sandbox_backend_for_runtime_preference(Some(false));

        assert_eq!(resolved, "windows-wsl2");
    }
}
