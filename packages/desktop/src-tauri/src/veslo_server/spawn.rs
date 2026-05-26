use std::env;
use std::net::TcpListener;
use std::path::{Path, PathBuf};

use tauri::async_runtime::Receiver;
use tauri::AppHandle;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DEFAULT_VESLO_PORT: u16 = 8787;
const DEFAULT_MANAGED_AI_BASE_URL: &str = "https://veslo-ai-gateway-dev.onrender.com";
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

/// Find PIDs of veslo-server (or `bun --watch src/cli.ts`) processes bound to
/// the given TCP port. Returns only processes that look like our own server,
/// not arbitrary 8787 squatters.
fn detect_zombie_veslo_server_pids(port: u16) -> Vec<u32> {
    use std::process::Command;
    let lsof = Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fp"])
        .arg(format!("-iTCP:{port}"))
        .output();
    let stdout = match lsof {
        Ok(out) if out.status.success() => out.stdout,
        _ => return Vec::new(),
    };
    let mut pids = Vec::new();
    for line in String::from_utf8_lossy(&stdout).lines() {
        if let Some(rest) = line.strip_prefix('p') {
            if let Ok(pid) = rest.trim().parse::<u32>() {
                let ps = Command::new("ps")
                    .args(["-p", &pid.to_string(), "-o", "command="])
                    .output();
                if let Ok(out) = ps {
                    let cmd = String::from_utf8_lossy(&out.stdout);
                    if cmd.contains("veslo-server")
                        || cmd.contains("bun --watch src/cli.ts")
                        || cmd.contains("bun src/cli.ts")
                    {
                        pids.push(pid);
                    }
                }
            }
        }
    }
    pids
}

fn kill_pid(pid: u32) {
    use std::process::Command;
    let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
    // Give the process a moment to clean up, then force-kill if still alive.
    std::thread::sleep(std::time::Duration::from_millis(250));
    let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).status();
}

pub fn resolve_veslo_port() -> Result<u16, String> {
    if TcpListener::bind(("0.0.0.0", DEFAULT_VESLO_PORT)).is_ok() {
        return Ok(DEFAULT_VESLO_PORT);
    }
    // 8787 is busy. If a previous Veslo dev/desktop instance left its server
    // behind (cargo rebuild + Tauri restart drops state.child without killing
    // the bun --watch sidecar), the engines bake stale baseURL/apiKey values
    // into opencode.jsonc and AI inference 401s. Reclaim 8787 from our own
    // zombies before falling back to a random ephemeral port so the next
    // workspace activate writes a stable URL the engine can keep reaching.
    let zombies = detect_zombie_veslo_server_pids(DEFAULT_VESLO_PORT);
    if !zombies.is_empty() {
        for pid in &zombies {
            eprintln!("[veslo-server] reclaiming port {DEFAULT_VESLO_PORT} from stale veslo-server PID {pid}");
            kill_pid(*pid);
        }
        // Give the OS a brief moment to release the socket after SIGKILL.
        std::thread::sleep(std::time::Duration::from_millis(300));
        if TcpListener::bind(("0.0.0.0", DEFAULT_VESLO_PORT)).is_ok() {
            return Ok(DEFAULT_VESLO_PORT);
        }
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
