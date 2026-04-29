use std::sync::{Arc, Mutex};

use tauri::async_runtime::Receiver;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

use crate::utils::truncate_output;

const OUTPUT_BUFFER_LIMIT: usize = 8000;

pub trait SupervisedChild {
    fn child(&self) -> &Option<CommandChild>;
    fn take_child(&mut self) -> Option<CommandChild>;
    fn child_exited(&self) -> bool;
    fn set_child_exited(&mut self, value: bool);
    fn last_stdout(&self) -> Option<&str>;
    fn set_last_stdout(&mut self, value: Option<String>);
    fn last_stderr(&self) -> Option<&str>;
    fn set_last_stderr(&mut self, value: Option<String>);
}

pub fn resolve_running_pid<S: SupervisedChild>(state: &mut S) -> (bool, Option<u32>) {
    match state.child() {
        None => (false, None),
        Some(_) if state.child_exited() => {
            let _ = state.take_child();
            (false, None)
        }
        Some(child) => (true, Some(child.pid())),
    }
}

pub fn kill_running_child<S: SupervisedChild>(state: &mut S) {
    if let Some(child) = state.take_child() {
        let _ = child.kill();
    }
    state.set_child_exited(true);
    state.set_last_stdout(None);
    state.set_last_stderr(None);
}

fn append_to(slot: Option<&str>, line: &str) -> String {
    let next = format!("{}{}", slot.unwrap_or_default(), line);
    truncate_output(&next, OUTPUT_BUFFER_LIMIT)
}

pub fn append_stdout<S: SupervisedChild>(state: &mut S, line: &str) {
    let combined = append_to(state.last_stdout(), line);
    state.set_last_stdout(Some(combined));
}

pub fn append_stderr<S: SupervisedChild>(state: &mut S, line: &str) {
    let combined = append_to(state.last_stderr(), line);
    state.set_last_stderr(Some(combined));
}

pub fn spawn_output_collector<S>(
    mut rx: Receiver<CommandEvent>,
    state_handle: Arc<Mutex<S>>,
    terminated_label: &'static str,
) where
    S: SupervisedChild + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    if let Ok(mut state) = state_handle.try_lock() {
                        append_stdout(&mut *state, &line);
                    }
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    if let Ok(mut state) = state_handle.try_lock() {
                        append_stderr(&mut *state, &line);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    if let Ok(mut state) = state_handle.try_lock() {
                        state.set_child_exited(true);
                        if let Some(code) = payload.code {
                            let message = format!("{terminated_label} exited (code {code}).");
                            state.set_last_stderr(Some(truncate_output(
                                &message,
                                OUTPUT_BUFFER_LIMIT,
                            )));
                        }
                    }
                }
                CommandEvent::Error(message) => {
                    if let Ok(mut state) = state_handle.try_lock() {
                        state.set_child_exited(true);
                        append_stderr(&mut *state, &message);
                    }
                }
                _ => {}
            }
        }
    });
}
