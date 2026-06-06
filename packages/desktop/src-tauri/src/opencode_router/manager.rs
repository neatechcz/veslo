use std::sync::{Arc, Mutex};

use crate::process_supervisor::{kill_running_child, resolve_running_pid, SupervisedChild};
use crate::supervised_process::SupervisedCommandChild;
use crate::types::OpenCodeRouterInfo;

#[derive(Default)]
pub struct OpenCodeRouterManager {
    pub inner: Arc<Mutex<OpenCodeRouterState>>,
}

#[derive(Default)]
pub struct OpenCodeRouterState {
    pub child: Option<SupervisedCommandChild>,
    pub child_exited: bool,
    pub version: Option<String>,
    pub workspace_path: Option<String>,
    pub opencode_url: Option<String>,
    pub health_port: Option<u16>,
    pub last_stdout: Option<String>,
    pub last_stderr: Option<String>,
}

impl SupervisedChild for OpenCodeRouterState {
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

impl OpenCodeRouterManager {
    pub fn snapshot_locked(state: &mut OpenCodeRouterState) -> OpenCodeRouterInfo {
        let (running, pid) = resolve_running_pid(state);

        OpenCodeRouterInfo {
            running,
            version: state.version.clone(),
            workspace_path: state.workspace_path.clone(),
            opencode_url: state.opencode_url.clone(),
            health_port: state.health_port,
            pid,
            last_stdout: state.last_stdout.clone(),
            last_stderr: state.last_stderr.clone(),
        }
    }

    pub fn stop_locked(state: &mut OpenCodeRouterState) {
        kill_running_child(state);
        state.version = None;
        state.workspace_path = None;
        state.opencode_url = None;
        state.health_port = None;
    }
}
