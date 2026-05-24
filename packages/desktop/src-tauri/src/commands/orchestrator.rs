use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use std::net::TcpListener;
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::State;
use tauri_plugin_shell::ShellExt;
use uuid::Uuid;

use crate::orchestrator::manager::OrchestratorManager;
use crate::orchestrator::{resolve_orchestrator_data_dir, resolve_orchestrator_status};
use crate::types::{OrchestratorEngineSnapshot, OrchestratorStatus, OrchestratorWorkspace};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorDetachedHost {
    pub veslo_url: String,
    pub token: String,
    pub host_token: String,
    pub port: u16,
}

fn allocate_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to allocate free port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read allocated port: {e}"))?
        .port();
    Ok(port)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrchestratorWorkspaceResponse {
    pub workspace: OrchestratorWorkspace,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrchestratorDisposeResponse {
    pub disposed: bool,
}

fn resolve_data_dir(manager: &OrchestratorManager) -> String {
    manager
        .inner
        .lock()
        .ok()
        .and_then(|state| state.data_dir.clone())
        .unwrap_or_else(resolve_orchestrator_data_dir)
}

fn resolve_base_url(manager: &OrchestratorManager) -> Result<String, String> {
    let data_dir = resolve_data_dir(manager);
    let status = resolve_orchestrator_status(&data_dir, None);
    status
        .daemon
        .map(|daemon| daemon.base_url)
        .ok_or_else(|| "orchestrator daemon is not running".to_string())
}

#[tauri::command]
pub fn orchestrator_status(manager: State<OrchestratorManager>) -> OrchestratorStatus {
    let data_dir = resolve_data_dir(&manager);
    let last_error = manager
        .inner
        .lock()
        .ok()
        .and_then(|state| state.last_stderr.clone());
    resolve_orchestrator_status(&data_dir, last_error)
}

#[tauri::command]
pub fn orchestrator_engines_list(
    manager: State<OrchestratorManager>,
) -> Vec<OrchestratorEngineSnapshot> {
    let data_dir = resolve_data_dir(&manager);
    let last_error = manager
        .inner
        .lock()
        .ok()
        .and_then(|state| state.last_stderr.clone());
    resolve_orchestrator_status(&data_dir, last_error).engines
}

const ENGINE_EVENT_NAME: &str = "veslo://engine-event";
const ENGINE_EVENT_POLL_MS: u64 = 2000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineEvent {
    workspace_id: String,
    event_type: String,
    at: u64,
}

fn diff_engine_events(
    prev: &[OrchestratorEngineSnapshot],
    curr: &[OrchestratorEngineSnapshot],
    at: u64,
) -> Vec<EngineEvent> {
    let mut events = Vec::new();
    for c in curr {
        let p = prev.iter().find(|p| p.workspace_id == c.workspace_id);
        match (p.map(|p| p.state.as_str()), c.state.as_str()) {
            (None, "ready") => events.push(EngineEvent {
                workspace_id: c.workspace_id.clone(),
                event_type: "spawned".into(),
                at,
            }),
            (Some("suspended"), "ready") => events.push(EngineEvent {
                workspace_id: c.workspace_id.clone(),
                event_type: "restored".into(),
                at,
            }),
            (Some("ready"), "suspended") | (Some("idle"), "suspended") => {
                events.push(EngineEvent {
                    workspace_id: c.workspace_id.clone(),
                    event_type: "suspended".into(),
                    at,
                })
            }
            _ => {}
        }
    }
    for p in prev {
        if !curr.iter().any(|c| c.workspace_id == p.workspace_id) {
            events.push(EngineEvent {
                workspace_id: p.workspace_id.clone(),
                event_type: "crashed".into(),
                at,
            });
        }
    }
    events
}

/// Background poll loop that watches orchestrator engine snapshots and emits
/// `veslo://engine-event` on state transitions. Spawned on a dedicated OS
/// thread so it doesn't require a tokio runtime; sleeps when no orchestrator
/// manager state is registered yet.
pub fn spawn_engine_event_poller(app: AppHandle) {
    use tauri::Manager;
    use std::thread;

    thread::spawn(move || {
        let mut last: Vec<OrchestratorEngineSnapshot> = Vec::new();
        loop {
            thread::sleep(Duration::from_millis(ENGINE_EVENT_POLL_MS));
            let Some(manager) = app.try_state::<OrchestratorManager>() else {
                continue;
            };
            let data_dir = resolve_data_dir(&manager);
            let last_error = manager
                .inner
                .lock()
                .ok()
                .and_then(|state| state.last_stderr.clone());
            let status = resolve_orchestrator_status(&data_dir, last_error);
            let curr = status.engines;
            if curr != last {
                for event in diff_engine_events(&last, &curr, now_ms()) {
                    let _ = app.emit(ENGINE_EVENT_NAME, &event);
                }
                last = curr;
            }
        }
    });
}

#[tauri::command]
pub fn orchestrator_workspace_activate(
    manager: State<OrchestratorManager>,
    workspace_path: String,
    name: Option<String>,
) -> Result<OrchestratorWorkspace, String> {
    let base_url = resolve_base_url(&manager)?;
    let add_url = format!("{}/workspaces", base_url.trim_end_matches('/'));
    let payload = json!({
        "path": workspace_path,
        "name": name,
    });

    let add_response = ureq::post(&add_url)
        .set("Content-Type", "application/json")
        .send_json(payload)
        .map_err(|e| format!("Failed to add workspace: {e}"))?;
    let added: OrchestratorWorkspaceResponse = add_response
        .into_json()
        .map_err(|e| format!("Failed to parse orchestrator response: {e}"))?;

    let id = added.workspace.id.clone();
    let activate_url = format!(
        "{}/workspaces/{}/activate",
        base_url.trim_end_matches('/'),
        id
    );
    ureq::post(&activate_url)
        .set("Content-Type", "application/json")
        .send_string("")
        .map_err(|e| format!("Failed to activate workspace: {e}"))?;

    // VSLO-171 fáze 2 F2Ú3: GET /workspaces/:id/path endpoint smazán v
    // orchestratoru. Tady jsme response stejně ignorovali (`let _ = ...`),
    // takže smazání volání = no-op pro caller.

    Ok(added.workspace)
}

#[tauri::command]
pub fn orchestrator_instance_dispose(
    manager: State<OrchestratorManager>,
    workspace_path: String,
) -> Result<bool, String> {
    let base_url = resolve_base_url(&manager)?;
    let add_url = format!("{}/workspaces", base_url.trim_end_matches('/'));
    let payload = json!({
        "path": workspace_path,
    });

    let add_response = ureq::post(&add_url)
        .set("Content-Type", "application/json")
        .send_json(payload)
        .map_err(|e| format!("Failed to ensure workspace: {e}"))?;
    let added: OrchestratorWorkspaceResponse = add_response
        .into_json()
        .map_err(|e| format!("Failed to parse orchestrator response: {e}"))?;

    let id = added.workspace.id;
    let dispose_url = format!(
        "{}/instances/{}/dispose",
        base_url.trim_end_matches('/'),
        id
    );
    let response = ureq::post(&dispose_url)
        .set("Content-Type", "application/json")
        .send_string("")
        .map_err(|e| format!("Failed to dispose instance: {e}"))?;
    let result: OrchestratorDisposeResponse = response
        .into_json()
        .map_err(|e| format!("Failed to parse orchestrator response: {e}"))?;

    Ok(result.disposed)
}

#[tauri::command]
pub fn orchestrator_start_detached(
    app: AppHandle,
    workspace_path: String,
    run_id: Option<String>,
    veslo_token: Option<String>,
    veslo_host_token: Option<String>,
) -> Result<OrchestratorDetachedHost, String> {
    let start_ts = now_ms();
    let workspace_path = workspace_path.trim().to_string();
    if workspace_path.is_empty() {
        return Err("workspacePath is required".to_string());
    }

    let host_run_id = run_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    eprintln!(
        "[orchestrator-detached][at={start_ts}][runId={host_run_id}][stage=entry] workspacePath={workspace_path}"
    );

    let port = allocate_free_port()?;
    let token = veslo_token
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let host_token = veslo_host_token
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let veslo_url = format!("http://127.0.0.1:{port}");

    let command = match app.shell().sidecar("veslo-orchestrator") {
        Ok(command) => command,
        Err(_) => app.shell().command("veslo"),
    };

    // Start a dedicated host stack for this workspace.
    // We pass explicit tokens and a free port so the UI can connect deterministically.
    {
        let args: Vec<String> = vec![
            "start".to_string(),
            "--workspace".to_string(),
            workspace_path.clone(),
            "--approval".to_string(),
            "auto".to_string(),
            "--no-opencode-auth".to_string(),
            "--opencode-router".to_string(),
            "true".to_string(),
            "--detach".to_string(),
            "--veslo-host".to_string(),
            "0.0.0.0".to_string(),
            "--veslo-port".to_string(),
            port.to_string(),
            "--veslo-token".to_string(),
            token.clone(),
            "--veslo-host-token".to_string(),
            host_token.clone(),
            "--run-id".to_string(),
            host_run_id.clone(),
        ];

        let mut str_args: Vec<&str> = Vec::with_capacity(args.len());
        for arg in &args {
            str_args.push(arg.as_str());
        }

        command
            .args(str_args)
            .spawn()
            .map_err(|e| format!("Failed to start veslo orchestrator: {e}"))?;
        eprintln!(
            "[orchestrator-detached][at={}][runId={host_run_id}][stage=spawn] launched veslo sidecar",
            now_ms()
        );
    }

    let health_timeout_ms: u64 = 12_000;
    let start = Instant::now();
    let mut last_error: Option<String> = None;

    while start.elapsed() < Duration::from_millis(health_timeout_ms) {
        match ureq::get(&format!("{}/health", veslo_url.trim_end_matches('/'))).call() {
            Ok(response) if response.status() >= 200 && response.status() < 300 => {
                last_error = None;
                break;
            }
            Ok(response) => {
                last_error = Some(format!("HTTP {}", response.status()));
            }
            Err(err) => {
                last_error = Some(err.to_string());
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    if start.elapsed() >= Duration::from_millis(health_timeout_ms) {
        let elapsed_ms = start.elapsed().as_millis() as u64;
        let message = format!(
            "Timed out waiting for Veslo server (stage=veslo.healthcheck, elapsed_ms={elapsed_ms}, url={veslo_url}, last_error={})",
            last_error.as_deref().unwrap_or("none")
        );
        eprintln!(
            "[orchestrator-detached][at={}][runId={host_run_id}][stage=timeout] health wait timed out after {elapsed_ms}ms error={message}",
            now_ms()
        );
        return Err(message);
    }

    eprintln!(
        "[orchestrator-detached][at={}][runId={host_run_id}][stage=complete] detached host ready in {}ms url={veslo_url}",
        now_ms(),
        start.elapsed().as_millis()
    );

    Ok(OrchestratorDetachedHost {
        veslo_url,
        token,
        host_token,
        port,
    })
}


