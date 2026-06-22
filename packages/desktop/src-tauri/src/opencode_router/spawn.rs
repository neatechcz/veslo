use std::path::Path;

use std::net::TcpListener;

use tauri::async_runtime::Receiver;
use tauri::AppHandle;

use crate::supervised_process::{self, CommandEvent, SupervisedCommandChild};

pub const DEFAULT_OPENCODE_ROUTER_HEALTH_PORT: u16 = 3005;

pub fn resolve_opencode_router_health_port() -> Result<u16, String> {
    // Pick an ephemeral localhost port by default to avoid conflicts when
    // multiple Veslo desktop instances run on the same machine.
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port)
}

pub fn build_opencode_router_args(workspace_path: &str, opencode_url: Option<&str>) -> Vec<String> {
    let mut args = vec!["serve".to_string(), workspace_path.to_string()];

    if let Some(url) = opencode_url {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            args.push("--opencode-url".to_string());
            args.push(trimmed.to_string());
        }
    }

    args
}

pub fn spawn_opencode_router(
    app: &AppHandle,
    workspace_path: &str,
    opencode_url: Option<&str>,
    opencode_username: Option<&str>,
    opencode_password: Option<&str>,
    health_port: u16,
) -> Result<(Receiver<CommandEvent>, SupervisedCommandChild), String> {
    let command = match supervised_process::sidecar(app, "veslo-code-router") {
        Ok(command) => command,
        Err(_) => match supervised_process::sidecar(app, "opencode-router") {
            Ok(command) => command,
            Err(error) => supervised_process::command_fallback_for_missing_sidecar(
                app,
                "veslo-code-router",
                "opencode-router",
                error,
            )?,
        },
    };

    let args = build_opencode_router_args(workspace_path, opencode_url);

    let mut command = command
        .args(args)
        .current_dir(Path::new(workspace_path))
        .env("OPENCODE_ROUTER_HEALTH_PORT", health_port.to_string());

    if let Some(username) = opencode_username {
        if !username.trim().is_empty() {
            command = command.env("OPENCODE_SERVER_USERNAME", username);
        }
    }

    if let Some(password) = opencode_password {
        if !password.trim().is_empty() {
            command = command.env("OPENCODE_SERVER_PASSWORD", password);
        }
    }

    for (key, value) in crate::bun_env::bun_env_overrides() {
        command = command.env(key, value);
    }

    command
        .spawn()
        .map_err(|e| format!("Failed to start opencodeRouter: {e}"))
}
