use std::path::Path;

use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Manager};

use crate::paths::{candidate_xdg_config_dirs, candidate_xdg_data_dirs, maybe_infer_xdg_home};
use crate::paths::{prepended_path_env, sidecar_path_candidates};
use crate::supervised_process::{self, CommandEvent, SupervisedCommandChild};
use crate::veslo_server::persisted_veslo_server_plugin_state_path;

pub fn find_free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port)
}

pub fn build_engine_args(bind_host: &str, port: u16) -> Vec<String> {
    vec![
        "serve".to_string(),
        "--hostname".to_string(),
        bind_host.to_string(),
        "--port".to_string(),
        port.to_string(),
        // Allow all origins since the engine may be accessed remotely from client
        // devices or from the dev UI running on localhost:5173.
        "--cors".to_string(),
        "*".to_string(),
    ]
}

pub fn build_engine_env_overrides(
    veslo_server_state_path: Option<&Path>,
    veslo_server_client_token: Option<&str>,
) -> Vec<(String, String)> {
    let mut env = vec![
        ("OPENCODE_CLIENT".to_string(), "veslo".to_string()),
        ("VESLO".to_string(), "1".to_string()),
    ];

    if let Some(path) = veslo_server_state_path {
        env.push((
            "VESLO_SERVER_STATE_PATH".to_string(),
            path.to_string_lossy().to_string(),
        ));
    }

    if let Some(token) = veslo_server_client_token
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        env.push((
            "VESLO_OPENCODE_SERVER_CLIENT_TOKEN".to_string(),
            token.to_string(),
        ));
    }

    env
}

pub fn spawn_engine(
    app: &AppHandle,
    program: &Path,
    hostname: &str,
    port: u16,
    project_dir: &str,
    use_sidecar: bool,
    opencode_username: Option<&str>,
    opencode_password: Option<&str>,
    veslo_server_client_token: Option<&str>,
) -> Result<(Receiver<CommandEvent>, SupervisedCommandChild), String> {
    let args = build_engine_args(hostname, port);

    let command = if use_sidecar {
        supervised_process::sidecar(app, "opencode")
            .map_err(|e| format!("Failed to locate bundled OpenCode sidecar: {e}"))?
    } else {
        supervised_process::command(app, program)
    };

    let mut command = command.args(args).current_dir(project_dir);

    if let Some(xdg_data_home) = maybe_infer_xdg_home(
        "XDG_DATA_HOME",
        candidate_xdg_data_dirs(),
        Path::new("opencode/auth.json"),
    ) {
        command = command.env("XDG_DATA_HOME", xdg_data_home);
    }

    let xdg_config_home = maybe_infer_xdg_home(
        "XDG_CONFIG_HOME",
        candidate_xdg_config_dirs(),
        Path::new("opencode/opencode.jsonc"),
    )
    .or_else(|| {
        maybe_infer_xdg_home(
            "XDG_CONFIG_HOME",
            candidate_xdg_config_dirs(),
            Path::new("opencode/opencode.json"),
        )
    });

    if let Some(xdg_config_home) = xdg_config_home {
        command = command.env("XDG_CONFIG_HOME", xdg_config_home);
    }

    let veslo_server_state_path = persisted_veslo_server_plugin_state_path(app).ok();
    for (key, value) in build_engine_env_overrides(
        veslo_server_state_path.as_deref(),
        veslo_server_client_token,
    ) {
        command = command.env(key, value);
    }

    for (key, value) in crate::bun_env::bun_env_overrides() {
        command = command.env(key, value);
    }

    let resource_dir = app.path().resource_dir().ok();
    let current_bin_dir = tauri::process::current_binary(&app.env())
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));
    let sidecar_paths =
        sidecar_path_candidates(resource_dir.as_deref(), current_bin_dir.as_deref());
    if let Some(path_env) = prepended_path_env(&sidecar_paths) {
        command = command.env("PATH", path_env);
    }

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

    command
        .spawn()
        .map_err(|e| format!("Failed to start opencode: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_env_overrides_include_veslo_server_state_path_when_available() {
        let state_path = std::env::temp_dir()
            .join("veslo-engine-env-test")
            .join("veslo-server-plugin-state.json");

        let env = build_engine_env_overrides(Some(&state_path), None);

        assert!(env.iter().any(|(key, value)| {
            key == "VESLO_SERVER_STATE_PATH" && value == state_path.to_string_lossy().as_ref()
        }));
    }

    #[test]
    fn engine_env_overrides_include_veslo_opencode_server_client_token_when_available() {
        let env = build_engine_env_overrides(None, Some(" client-token "));

        assert!(env.iter().any(|(key, value)| {
            key == "VESLO_OPENCODE_SERVER_CLIENT_TOKEN" && value == "client-token"
        }));
    }
}
