use std::env;
use std::net::TcpListener;
use std::path::{Path, PathBuf};

use tauri::async_runtime::Receiver;
use tauri::AppHandle;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DEFAULT_VESLO_PORT: u16 = 8787;
const VESLO_SERVER_DEV_WATCH_ENV: &str = "VESLO_SERVER_DEV_WATCH";
const VESLO_SERVER_DEV_DIR_ENV: &str = "VESLO_SERVER_DEV_DIR";

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
    let mut args = vec!["--watch".to_string(), "src/cli.ts".to_string(), "--".to_string()];
    args.append(&mut server_args);
    args
}

pub fn resolve_veslo_port() -> Result<u16, String> {
    if TcpListener::bind(("0.0.0.0", DEFAULT_VESLO_PORT)).is_ok() {
        return Ok(DEFAULT_VESLO_PORT);
    }
    let listener = TcpListener::bind(("0.0.0.0", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port)
}

pub fn build_veslo_args(
    host: &str,
    port: u16,
    workspace_paths: &[String],
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

    for workspace_path in workspace_paths {
        if !workspace_path.trim().is_empty() {
            args.push("--workspace".to_string());
            args.push(workspace_path.to_string());
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

pub fn spawn_veslo_server(
    app: &AppHandle,
    host: &str,
    port: u16,
    workspace_paths: &[String],
    token: &str,
    host_token: &str,
    opencode_base_url: Option<&str>,
    opencode_directory: Option<&str>,
    opencode_username: Option<&str>,
    opencode_password: Option<&str>,
    opencode_router_health_port: Option<u16>,
) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
    let server_args = build_veslo_args(
        host,
        port,
        workspace_paths,
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
    };

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

    command
        .spawn()
        .map_err(|e| {
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
}
