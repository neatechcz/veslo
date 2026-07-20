use std::path::Path;
#[cfg(any(target_os = "macos", test))]
use std::path::PathBuf;
#[cfg(any(target_os = "macos", test))]
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::types::UpdaterEnvironment;

pub const MANAGED_PROCESS_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);
const MANAGED_PROCESS_SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedProcessShutdownTimeout {
    pub running_pids: Vec<u32>,
}

fn is_mac_dmg_or_translocated(path: &Path) -> bool {
    let path_str = path.to_string_lossy();
    path_str.contains("/Volumes/") || path_str.contains("AppTranslocation")
}

pub fn wait_for_managed_process_shutdown<F>(
    pids: &[u32],
    timeout: Duration,
    poll_interval: Duration,
    mut is_running: F,
) -> Result<(), ManagedProcessShutdownTimeout>
where
    F: FnMut(u32) -> bool,
{
    let deadline = Instant::now() + timeout;

    loop {
        let running_pids = pids
            .iter()
            .copied()
            .filter(|pid| is_running(*pid))
            .collect::<Vec<_>>();

        if running_pids.is_empty() {
            return Ok(());
        }

        if Instant::now() >= deadline {
            return Err(ManagedProcessShutdownTimeout { running_pids });
        }

        std::thread::sleep(poll_interval);
    }
}

#[cfg(windows)]
fn is_process_running(pid: u32) -> bool {
    let filter = format!("PID eq {pid}");
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &filter, "/FO", "CSV", "/NH"])
        .output();

    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }

    String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
}

#[cfg(all(unix, not(windows)))]
fn is_process_running(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(any(unix, windows)))]
fn is_process_running(_pid: u32) -> bool {
    false
}

pub fn prepare_update_install(app: &tauri::AppHandle) -> Result<(), String> {
    let pids = crate::stop_managed_services(app);
    if pids.is_empty() {
        return Ok(());
    }

    wait_for_managed_process_shutdown(
        &pids,
        MANAGED_PROCESS_SHUTDOWN_TIMEOUT,
        MANAGED_PROCESS_SHUTDOWN_POLL_INTERVAL,
        is_process_running,
    )
    .map_err(|error| {
        format!(
            "Timed out waiting {:?} for managed Veslo processes to stop before installing update: {:?}",
            MANAGED_PROCESS_SHUTDOWN_TIMEOUT,
            error.running_pids
        )
    })
}

#[cfg(any(target_os = "macos", test))]
pub fn macos_app_bundle_path_from_executable(executable_path: &Path) -> Option<PathBuf> {
    let macos_dir = executable_path.parent()?;
    if macos_dir.file_name()? != "MacOS" {
        return None;
    }

    let contents_dir = macos_dir.parent()?;
    if contents_dir.file_name()? != "Contents" {
        return None;
    }

    let bundle_dir = contents_dir.parent()?;
    if bundle_dir.extension()? != "app" {
        return None;
    }

    Some(bundle_dir.to_path_buf())
}

#[cfg(any(target_os = "macos", test))]
pub fn macos_relaunch_after_exit_command(current_pid: u32, app_bundle_path: &Path) -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(
            "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done\n\
             exec /usr/bin/open -n \"$2\"",
        )
        .arg("veslo-relaunch-after-update")
        .arg(current_pid.to_string())
        .arg(app_bundle_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(target_os = "macos")]
fn spawn_macos_relaunch_after_exit(current_pid: u32, app_bundle_path: &Path) -> Result<(), String> {
    macos_relaunch_after_exit_command(current_pid, app_bundle_path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to schedule Veslo relaunch after update: {error}"))
}

pub fn relaunch_after_update_install(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let executable_path = std::env::current_exe()
            .map_err(|error| format!("Failed to resolve current Veslo executable: {error}"))?;
        let app_bundle_path =
            macos_app_bundle_path_from_executable(&executable_path).ok_or_else(|| {
                format!(
                    "Failed to resolve Veslo app bundle from executable path: {}",
                    executable_path.display()
                )
            })?;

        spawn_macos_relaunch_after_exit(std::process::id(), &app_bundle_path)?;
        app.exit(0);
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        app.request_restart();
        Ok(())
    }
}

pub fn updater_environment() -> UpdaterEnvironment {
    let executable_path = std::env::current_exe().ok();

    let app_bundle_path = executable_path
        .as_ref()
        .and_then(|exe| exe.parent())
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf());

    let mut supported = true;
    let mut reason: Option<String> = None;

    if std::env::var_os("VESLO_DISABLE_UPDATER").is_some()
        || std::env::var_os("VESLO_E2E_DISABLE_UPDATER").is_some()
    {
        supported = false;
        reason = Some("Updates are disabled for this runtime.".to_string());
    }

    if let Some(exe) = executable_path.as_ref() {
        if is_mac_dmg_or_translocated(exe) {
            supported = false;
            reason = Some(
        "Veslo is running from a mounted disk image. Install it to Applications to enable updates."
          .to_string(),
      );
        }
    }

    if supported {
        if let Some(bundle) = app_bundle_path.as_ref() {
            if is_mac_dmg_or_translocated(bundle) {
                supported = false;
                reason = Some(
          "Veslo is running from a mounted disk image. Install it to Applications to enable updates."
            .to_string(),
        );
            }
        }
    }

    UpdaterEnvironment {
        supported,
        reason,
        executable_path: executable_path.map(|p| p.to_string_lossy().to_string()),
        app_bundle_path: app_bundle_path.map(|p| p.to_string_lossy().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::time::Duration;

    #[test]
    fn waits_until_managed_processes_exit_before_update_install() {
        let mut probes: HashMap<u32, usize> = HashMap::from([(101, 0), (202, 0)]);

        let result = wait_for_managed_process_shutdown(
            &[101, 202],
            Duration::from_millis(100),
            Duration::from_millis(1),
            |pid| {
                let count = probes.entry(pid).or_insert(0);
                *count += 1;
                *count == 1
            },
        );

        assert!(result.is_ok());
        assert_eq!(probes.get(&101), Some(&2));
        assert_eq!(probes.get(&202), Some(&2));
    }

    #[test]
    fn reports_managed_process_shutdown_timeout() {
        let result = wait_for_managed_process_shutdown(
            &[303],
            Duration::from_millis(5),
            Duration::from_millis(1),
            |_pid| true,
        );

        assert!(result.is_err());
        assert_eq!(result.unwrap_err().running_pids, vec![303]);
    }

    #[test]
    fn allows_slow_graceful_managed_process_shutdown_before_update_install() {
        assert_eq!(MANAGED_PROCESS_SHUTDOWN_TIMEOUT, Duration::from_secs(15));
    }

    #[test]
    fn resolves_macos_app_bundle_from_bundle_executable() {
        let bundle = macos_app_bundle_path_from_executable(Path::new(
            "/Applications/Veslo.app/Contents/MacOS/Veslo",
        ));

        assert_eq!(
            bundle,
            Some(Path::new("/Applications/Veslo.app").to_path_buf())
        );
    }

    #[test]
    fn rejects_non_bundle_executable_for_macos_relaunch() {
        let bundle =
            macos_app_bundle_path_from_executable(Path::new("/Users/dev/Veslo/target/debug/veslo"));

        assert_eq!(bundle, None);
    }

    #[test]
    fn macos_relaunch_command_waits_for_old_pid_before_opening_bundle() {
        let command = macos_relaunch_after_exit_command(4242, Path::new("/Applications/Veslo.app"));
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert_eq!(command.get_program(), Path::new("/bin/sh").as_os_str());
        assert_eq!(args[0], "-c");
        assert!(args[1].contains("kill -0 \"$1\""));
        assert!(args[1].contains("/usr/bin/open -n \"$2\""));
        assert_eq!(args[2], "veslo-relaunch-after-update");
        assert_eq!(args[3], "4242");
        assert_eq!(args[4], "/Applications/Veslo.app");
    }
}
