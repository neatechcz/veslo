use std::sync::{Arc, Mutex};

use crate::orchestrator;
use crate::orchestrator::OrchestratorShutdownAttribution;
use crate::supervised_process::SupervisedCommandChild;

#[derive(Default)]
pub struct OrchestratorManager {
    pub inner: Arc<Mutex<OrchestratorState>>,
}

#[derive(Default)]
pub struct OrchestratorState {
    pub child: Option<SupervisedCommandChild>,
    pub child_exited: bool,
    pub last_exit_code: Option<i32>,
    pub data_dir: Option<String>,
    pub last_stdout: Option<String>,
    pub last_stderr: Option<String>,
}

impl OrchestratorManager {
    pub fn stop_locked(
        state: &mut OrchestratorState,
        attribution: OrchestratorShutdownAttribution,
    ) {
        let data_dir = state
            .data_dir
            .clone()
            .unwrap_or_else(orchestrator::resolve_orchestrator_data_dir);

        let shutdown_requested =
            match orchestrator::request_orchestrator_shutdown(&data_dir, &attribution) {
                Ok(requested) => requested,
                Err(error) => {
                    eprintln!("[orchestrator] Failed to request shutdown: {error}");
                    false
                }
            };

        if let Some(child) = state.child.take() {
            // Prefer daemon-owned graceful shutdown so veslo-orchestrator can
            // terminate its managed OpenCode child before exiting.
            if !shutdown_requested {
                let _ = child.kill();
            }
        }

        orchestrator::clear_orchestrator_auth(&data_dir);
        state.child_exited = true;
        state.last_exit_code = None;
        state.data_dir = None;
        state.last_stdout = None;
        state.last_stderr = None;
    }
}
