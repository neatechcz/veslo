use std::env;
use std::net::TcpListener;
use std::path::{Path, PathBuf};

use tauri::async_runtime::Receiver;
use tauri::AppHandle;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DEFAULT_VESLO_PORT: u16 = 8787;
const DEFAULT_MANAGED_AI_BASE_URL: &str = "https://ai.veslo.work";
const VESLO_SERVER_DEV_WATCH_ENV: &str = "VESLO_SERVER_DEV_WATCH";
const VESLO_SERVER_DEV_DIR_ENV: &str = "VESLO_SERVER_DEV_DIR";
const VESLO_DESKTOP_SERVER_PORT_ENV: &str = "VESLO_DESKTOP_SERVER_PORT";
const PORT_RESTART_RETRY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const PORT_RESTART_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

fn parse_dev_watch_flag(value: Option<&str>) -> bool {
    matches!(
        value.map(|raw| raw.trim().to_ascii_lowercase()),
        Some(flag) if matches!(flag.as_str(), "1" | "true" | "yes" | "on")
    )
}

fn should_use_dev_watch_mode() -> bool {
    parse_dev_watch_flag(env::var(VESLO_SERVER_DEV_WATCH_ENV).ok().as_deref())
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

fn host_from_http_url(raw: &str) -> Option<String> {
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
    let port = configured_veslo_port()?;
    bind_veslo_port(port)
}

fn bind_veslo_port(port: u16) -> Result<u16, String> {
    TcpListener::bind(("0.0.0.0", port))
        .map(|_| port)
        .map_err(|error| format!("Veslo server port {port} is unavailable: {error}"))
}

pub fn resolve_veslo_port_after_restart() -> Result<u16, String> {
    let port = configured_veslo_port()?;
    let deadline = std::time::Instant::now() + PORT_RESTART_RETRY_TIMEOUT;
    loop {
        match bind_veslo_port(port) {
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

    args
}

fn resolve_managed_ai_base_url_from_env(
    managed_ai_base_url: Option<&str>,
    legacy_ai_gateway_base_url: Option<&str>,
) -> String {
    managed_ai_base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            legacy_ai_gateway_base_url
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or(DEFAULT_MANAGED_AI_BASE_URL)
        .trim_end_matches('/')
        .to_string()
}

fn resolve_managed_ai_base_url() -> String {
    resolve_managed_ai_base_url_from_env(
        std::env::var("VESLO_MANAGED_AI_BASE_URL").ok().as_deref(),
        std::env::var("VESLO_AI_GATEWAY_BASE_URL").ok().as_deref(),
    )
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
) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
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
    );
    let use_dev_watch = should_use_dev_watch_mode();

    let mut command = if use_dev_watch {
        let dev_watch_dir = resolve_dev_watch_dir();
        app.shell()
            .command("bun")
            .args(build_veslo_server_dev_watch_args(server_args))
            .current_dir(&dev_watch_dir)
    } else {
        let command = match app.shell().sidecar("veslo-server") {
            Ok(command) => command,
            Err(_) => app.shell().command("veslo-server"),
        };
        let cwd = workspace_paths
            .first()
            .map(|path| Path::new(path))
            .unwrap_or_else(|| Path::new("."));
        command.args(server_args).current_dir(cwd)
    }
    .env("VESLO_MANAGED_AI_BASE_URL", resolve_managed_ai_base_url());

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
        let fixed_port_guard = TcpListener::bind(("0.0.0.0", DEFAULT_VESLO_PORT)).ok();

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
            resolve_veslo_port_after_restart().expect("resolve released restart port"),
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
        );

        assert!(args
            .windows(2)
            .any(|pair| pair == ["--workspace", "/tmp/workspace-a"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--workspace-id", "app-workspace-a"]));
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
        );

        assert_eq!(resolved, "https://managed.example.test");
    }

    #[test]
    fn managed_ai_base_url_falls_back_to_legacy_env() {
        let resolved =
            resolve_managed_ai_base_url_from_env(None, Some("https://legacy.example.test/"));

        assert_eq!(resolved, "https://legacy.example.test");
    }

    #[test]
    fn managed_ai_base_url_defaults_to_owned_gateway() {
        let resolved = resolve_managed_ai_base_url_from_env(None, None);

        assert_eq!(resolved, "https://ai.veslo.work");
    }
}
