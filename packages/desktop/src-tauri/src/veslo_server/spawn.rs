use std::net::TcpListener;
use std::path::Path;

use tauri::async_runtime::Receiver;
use tauri::AppHandle;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DEFAULT_VESLO_PORT: u16 = 8787;
const DEFAULT_MANAGED_AI_BASE_URL: &str = "https://veslo-ai-gateway-dev.onrender.com";

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
    token: &str,
    host_token: &str,
    opencode_base_url: Option<&str>,
    opencode_directory: Option<&str>,
    opencode_username: Option<&str>,
    opencode_password: Option<&str>,
    opencode_router_health_port: Option<u16>,
) -> Result<(Receiver<CommandEvent>, CommandChild), String> {
    let command = match app.shell().sidecar("veslo-server") {
        Ok(command) => command,
        Err(_) => app.shell().command("veslo-server"),
    };

    let args = build_veslo_args(
        host,
        port,
        workspace_paths,
        token,
        host_token,
        opencode_base_url,
        opencode_directory,
    );
    let cwd = workspace_paths
        .first()
        .map(|path| Path::new(path))
        .unwrap_or_else(|| Path::new("."));
    let mut command = command
        .args(args)
        .current_dir(cwd)
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

    command
        .spawn()
        .map_err(|e| format!("Failed to start Veslo server: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{resolve_managed_ai_base_url_from_env, DEFAULT_MANAGED_AI_BASE_URL};

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
        let resolved = resolve_managed_ai_base_url_from_env(None, Some("https://legacy.example.test/"));

        assert_eq!(resolved, "https://legacy.example.test");
    }

    #[test]
    fn managed_ai_base_url_defaults_to_hosted_den() {
        let resolved = resolve_managed_ai_base_url_from_env(None, None);

        assert_eq!(resolved, DEFAULT_MANAGED_AI_BASE_URL);
    }
}
