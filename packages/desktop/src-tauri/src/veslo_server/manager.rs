use std::sync::{Arc, Mutex};

use tauri_plugin_shell::process::CommandChild;

use crate::process_supervisor::{kill_running_child, resolve_running_pid, SupervisedChild};
use crate::types::VesloServerInfo;

#[derive(Default)]
pub struct VesloServerManager {
    pub inner: Arc<Mutex<VesloServerState>>,
}

#[derive(Default)]
pub struct VesloServerState {
    pub child: Option<CommandChild>,
    pub child_exited: bool,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub base_url: Option<String>,
    pub connect_url: Option<String>,
    pub mdns_url: Option<String>,
    pub lan_url: Option<String>,
    pub engine_url: Option<String>,
    pub client_token: Option<String>,
    pub host_token: Option<String>,
    pub last_stdout: Option<String>,
    pub last_stderr: Option<String>,
    // Set of workspace paths the running child was spawned with. Used to:
    // (a) skip respawn when start_veslo_server is called with an equivalent
    //     set (idempotent — preserves the running child + tokens), and
    // (b) carry tokens across an unavoidable respawn so the frontend's cached
    //     bearer keeps working (VSLO-171: token rotation was causing 401s).
    pub workspace_paths: Vec<String>,
}

impl SupervisedChild for VesloServerState {
    fn child(&self) -> &Option<CommandChild> {
        &self.child
    }
    fn take_child(&mut self) -> Option<CommandChild> {
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

impl VesloServerManager {
    pub fn snapshot_locked(state: &mut VesloServerState) -> VesloServerInfo {
        let (running, pid) = resolve_running_pid(state);

        VesloServerInfo {
            running,
            host: state.host.clone(),
            port: state.port,
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
        state.port = None;
        state.base_url = None;
        state.connect_url = None;
        state.mdns_url = None;
        state.lan_url = None;
        state.engine_url = None;
        // Intentionally keep client_token / host_token / workspace_paths so a
        // subsequent start_veslo_server can decide whether to skip respawn or
        // reuse the existing tokens (avoids the 401 "Invalid bearer token"
        // race documented in docs/handoffs/vslo-171-auth-and-switch.md).
    }
}
