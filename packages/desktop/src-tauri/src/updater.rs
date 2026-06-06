use std::path::Path;
use std::time::{Duration, Instant};

use crate::types::UpdaterEnvironment;

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
        Duration::from_secs(5),
        Duration::from_millis(100),
        is_process_running,
    )
    .map_err(|error| {
        format!(
            "Timed out waiting for managed Veslo processes to stop before installing update: {:?}",
            error.running_pids
        )
    })
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
}
