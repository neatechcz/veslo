use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::process_supervisor::{kill_running_child, resolve_running_pid, SupervisedChild};
use crate::supervised_process::SupervisedCommandChild;
use crate::types::{VesloServerInfo, VesloServerLifecycleReason, VesloServerLifecycleStatus};

#[derive(Default)]
pub struct VesloServerManager {
    pub inner: Arc<Mutex<VesloServerState>>,
    pub start_queue: Arc<Mutex<()>>,
}

#[derive(Default)]
pub struct VesloServerState {
    pub child: Option<SupervisedCommandChild>,
    pub child_exited: bool,
    pub external_info: Option<VesloServerInfo>,
    pub host: Option<String>,
    /// Optional secondary WSL-reachable bind address (the WSL virtual adapter
    /// IP) the server also listens on. Drives engineUrl publication for WSL
    /// runtimes without binding the primary listener to 0.0.0.0. See VSLO-250.
    pub bridge_host: Option<String>,
    pub port: Option<u16>,
    pub instance_id: Option<String>,
    pub base_url: Option<String>,
    pub connect_url: Option<String>,
    pub mdns_url: Option<String>,
    pub lan_url: Option<String>,
    pub engine_url: Option<String>,
    pub engine_url_checked_at: Option<Instant>,
    pub engine_url_refresh_started_at: Option<Instant>,
    pub engine_url_refresh_generation: u64,
    pub client_token: Option<String>,
    pub host_token: Option<String>,
    pub last_stdout: Option<String>,
    pub last_stderr: Option<String>,
    pub lifecycle_status: VesloServerLifecycleStatus,
    pub lifecycle_reason: VesloServerLifecycleReason,
    // Set of workspace paths the running child was spawned with. Used to:
    // (a) skip respawn when start_veslo_server is called with an equivalent
    //     set (idempotent — preserves the running child + tokens), and
    // (b) carry tokens across an unavoidable respawn so the frontend's cached
    //     bearer keeps working (VSLO-171: token rotation was causing 401s).
    pub workspace_paths: Vec<String>,
    pub opencode_base_url: Option<String>,
    pub orchestrator_daemon_url: Option<String>,
    pub orchestrator_lifecycle_token: Option<String>,
    pub sandbox_backend: Option<String>,
}

impl SupervisedChild for VesloServerState {
    fn child(&self) -> &Option<SupervisedCommandChild> {
        &self.child
    }
    fn take_child(&mut self) -> Option<SupervisedCommandChild> {
        self.child.take()
    }
    fn child_exited(&self) -> bool {
        self.child_exited
    }
    fn set_child_exited(&mut self, value: bool) {
        self.child_exited = value;
    }
    fn last_stdout(&self) -> Option<&str> {
        self.last_stdout.as_deref()
    }
    fn set_last_stdout(&mut self, value: Option<String>) {
        self.last_stdout = value;
    }
    fn last_stderr(&self) -> Option<&str> {
        self.last_stderr.as_deref()
    }
    fn set_last_stderr(&mut self, value: Option<String>) {
        self.last_stderr = value;
    }
}

fn reports_ready_running(child_running: bool, status: VesloServerLifecycleStatus) -> bool {
    child_running && status == VesloServerLifecycleStatus::Running
}

impl VesloServerManager {
    pub fn snapshot_locked(state: &mut VesloServerState) -> VesloServerInfo {
        let (child_running, pid) = resolve_running_pid(state);
        if child_running {
            state.external_info = None;
            if !matches!(
                state.lifecycle_status,
                VesloServerLifecycleStatus::Starting
                    | VesloServerLifecycleStatus::WaitingReady
                    | VesloServerLifecycleStatus::Blocked
            ) {
                state.lifecycle_status = VesloServerLifecycleStatus::Running;
                state.lifecycle_reason = VesloServerLifecycleReason::None;
            }
        } else if state.child_exited
            && matches!(
                state.lifecycle_status,
                VesloServerLifecycleStatus::Running
                    | VesloServerLifecycleStatus::Starting
                    | VesloServerLifecycleStatus::WaitingReady
            )
        {
            state.lifecycle_status = VesloServerLifecycleStatus::Exited;
            state.lifecycle_reason = VesloServerLifecycleReason::ChildExited;
        }
        if !child_running {
            if let Some(info) = state.external_info.clone() {
                return info;
            }
        }
        let ready_running = reports_ready_running(child_running, state.lifecycle_status);

        VesloServerInfo {
            running: ready_running,
            lifecycle_status: state.lifecycle_status,
            lifecycle_reason: state.lifecycle_reason,
            host: state.host.clone(),
            port: state.port,
            instance_id: state.instance_id.clone(),
            base_url: state.base_url.clone(),
            connect_url: state.connect_url.clone(),
            mdns_url: state.mdns_url.clone(),
            lan_url: state.lan_url.clone(),
            engine_url: state.engine_url.clone(),
            client_token: state.client_token.clone(),
            host_token: state.host_token.clone(),
            pid,
            last_stdout: state.last_stdout.clone(),
            last_stderr: state.last_stderr.clone(),
        }
    }

    pub fn stop_locked(state: &mut VesloServerState) {
        kill_running_child(state);
        state.host = None;
        state.bridge_host = None;
        state.port = None;
        state.instance_id = None;
        state.external_info = None;
        state.base_url = None;
        state.connect_url = None;
        state.mdns_url = None;
        state.lan_url = None;
        state.engine_url = None;
        state.engine_url_checked_at = None;
        state.engine_url_refresh_started_at = None;
        state.engine_url_refresh_generation = state.engine_url_refresh_generation.wrapping_add(1);
        state.lifecycle_status = VesloServerLifecycleStatus::Stopped;
        state.lifecycle_reason = VesloServerLifecycleReason::None;
        // Intentionally keep client_token / host_token / workspace_paths so a
        // subsequent start_veslo_server can decide whether to skip respawn or
        // reuse the existing tokens (avoids the 401 "Invalid bearer token"
        // race documented in docs/handoffs/vslo-171-auth-and-switch.md).
        state.opencode_base_url = None;
        state.orchestrator_daemon_url = None;
        state.orchestrator_lifecycle_token = None;
        state.sandbox_backend = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_marks_exited_child_as_lifecycle_exited() {
        let mut state = VesloServerState {
            child_exited: true,
            lifecycle_status: VesloServerLifecycleStatus::Running,
            lifecycle_reason: VesloServerLifecycleReason::None,
            last_stderr: Some("Veslo server exited (code 1).".to_string()),
            ..Default::default()
        };

        let info = VesloServerManager::snapshot_locked(&mut state);

        assert!(!info.running);
        assert_eq!(info.lifecycle_status, VesloServerLifecycleStatus::Exited);
        assert_eq!(
            info.lifecycle_reason,
            VesloServerLifecycleReason::ChildExited
        );
        assert_eq!(
            info.last_stderr.as_deref(),
            Some("Veslo server exited (code 1).")
        );
    }

    #[test]
    fn stop_locked_reports_intentional_stop_not_child_exit() {
        let mut state = VesloServerState {
            child_exited: true,
            lifecycle_status: VesloServerLifecycleStatus::Running,
            lifecycle_reason: VesloServerLifecycleReason::None,
            ..Default::default()
        };

        VesloServerManager::stop_locked(&mut state);
        let info = VesloServerManager::snapshot_locked(&mut state);

        assert!(!info.running);
        assert_eq!(info.lifecycle_status, VesloServerLifecycleStatus::Stopped);
        assert_eq!(info.lifecycle_reason, VesloServerLifecycleReason::None);
    }

    #[test]
    fn snapshot_preserves_blocked_port_reason() {
        let mut state = VesloServerState {
            lifecycle_status: VesloServerLifecycleStatus::Blocked,
            lifecycle_reason: VesloServerLifecycleReason::PortUnavailable,
            last_stderr: Some("Veslo server port 8787 on 127.0.0.1 is unavailable".to_string()),
            ..Default::default()
        };

        let info = VesloServerManager::snapshot_locked(&mut state);

        assert!(!info.running);
        assert_eq!(info.lifecycle_status, VesloServerLifecycleStatus::Blocked);
        assert_eq!(
            info.lifecycle_reason,
            VesloServerLifecycleReason::PortUnavailable
        );
        assert!(info
            .last_stderr
            .as_deref()
            .unwrap_or_default()
            .contains("port 8787"));
    }

    #[test]
    fn snapshot_running_flag_requires_ready_lifecycle() {
        assert!(reports_ready_running(
            true,
            VesloServerLifecycleStatus::Running
        ));
        assert!(!reports_ready_running(
            true,
            VesloServerLifecycleStatus::WaitingReady
        ));
        assert!(!reports_ready_running(
            true,
            VesloServerLifecycleStatus::Blocked
        ));
        assert!(!reports_ready_running(
            false,
            VesloServerLifecycleStatus::Running
        ));
    }

    #[test]
    fn snapshot_returns_adopted_external_info_without_child() {
        let external = VesloServerInfo {
            running: true,
            lifecycle_status: VesloServerLifecycleStatus::Running,
            lifecycle_reason: VesloServerLifecycleReason::None,
            host: Some("127.0.0.1".to_string()),
            port: Some(8787),
            instance_id: Some("instance-external".to_string()),
            base_url: Some("http://127.0.0.1:8787".to_string()),
            connect_url: None,
            mdns_url: None,
            lan_url: None,
            engine_url: None,
            client_token: Some("client-token".to_string()),
            host_token: Some("host-token".to_string()),
            pid: Some(12345),
            last_stdout: None,
            last_stderr: None,
        };
        let mut state = VesloServerState {
            external_info: Some(external.clone()),
            ..Default::default()
        };

        let info = VesloServerManager::snapshot_locked(&mut state);

        assert_eq!(info.base_url, external.base_url);
        assert_eq!(info.instance_id, external.instance_id);
        assert!(info.running);
    }
}
