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
use crate::workspace::validation::{validate_workspace_path, ValidationMode};

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
    use std::thread;
    use tauri::Manager;

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

fn register_workspace_with_orchestrator(
    base_url: &str,
    workspace_path: &str,
    name: Option<&str>,
) -> Result<OrchestratorWorkspace, String> {
    let add_url = format!("{}/workspaces", base_url.trim_end_matches('/'));
    let payload = json!({
        "path": workspace_path,
        "name": name,
    });

    crate::flow_log!(
        "[veslo:http] OUT POST {add_url} (orchestrator.add-workspace) path={workspace_path:?}"
    );
    let started = Instant::now();
    let add_response = match ureq::post(&add_url)
        .set("Content-Type", "application/json")
        .send_json(payload)
    {
        Ok(r) => {
            crate::flow_log!(
                "[veslo:http] IN  {} ({}ms) {add_url} (orchestrator.add-workspace)",
                r.status(),
                started.elapsed().as_millis()
            );
            r
        }
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            let excerpt: String = body.chars().take(500).collect();
            crate::flow_log!(
                "[veslo:http] IN  {code} ({}ms) {add_url} (orchestrator.add-workspace) body={excerpt:?}",
                started.elapsed().as_millis()
            );
            return Err(format!("Failed to add workspace: status {code}: {excerpt}"));
        }
        Err(ureq::Error::Transport(t)) => {
            crate::flow_log!(
                "[veslo:http] IN  ERR ({}ms) {add_url} (orchestrator.add-workspace) transport={:?}",
                started.elapsed().as_millis(),
                t.to_string()
            );
            return Err(format!("Failed to add workspace: transport error: {t}"));
        }
    };
    let added: OrchestratorWorkspaceResponse = add_response
        .into_json()
        .map_err(|e| format!("Failed to parse orchestrator response: {e}"))?;
    Ok(added.workspace)
}

/// Push every local workspace from the Tauri-side veslo-workspaces.json into
/// the orchestrator daemon. The daemon is the source of truth for engine
/// lifecycle, but it only learns about a workspace when something explicitly
/// POSTs /workspaces. Until reconciled, a sidebar click on an
/// orchestrator-unknown workspace 404s on /workspaces/:id/activate and the
/// frontend hangs on the 30s activation timeout.
pub fn reconcile_orchestrator_workspaces(
    app: &AppHandle,
    manager: &OrchestratorManager,
) -> Result<usize, String> {
    let base_url = resolve_base_url(manager)?;
    let state = crate::workspace::state::load_workspace_state(app)?;
    let mut registered = 0usize;
    for workspace in state.workspaces.iter() {
        if !matches!(workspace.workspace_type, crate::types::WorkspaceType::Local) {
            continue;
        }
        let path = workspace.path.trim();
        if path.is_empty() {
            continue;
        }
        let display_name = workspace
            .display_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| Some(workspace.name.trim()).filter(|s| !s.is_empty()));
        match register_workspace_with_orchestrator(&base_url, path, display_name) {
            Ok(_) => registered += 1,
            Err(error) => eprintln!("[orchestrator] reconcile failed for {path}: {error}"),
        }
    }
    Ok(registered)
}

#[tauri::command]
pub async fn orchestrator_workspace_activate(
    app: AppHandle,
    manager: State<'_, OrchestratorManager>,
    workspace_path: String,
    name: Option<String>,
) -> Result<OrchestratorWorkspace, String> {
    let workspace_path =
        validate_workspace_path(&app, &workspace_path, ValidationMode::IsRegisteredWorkspace)?
            .to_string_lossy()
            .to_string();
    let base_url = resolve_base_url(&manager)?;

    // VSLO-86 — push the blocking ureq calls onto a dedicated thread so the
    // Tauri command runtime stays responsive. Otherwise consecutive sidebar
    // clicks queue behind the previous synchronous activate IPC and the
    // user sees "kolečko se točí" for 30s+ on every second click while
    // browser.execute / other Tauri invokes wait for their turn.
    tauri::async_runtime::spawn_blocking(move || {
        let added =
            register_workspace_with_orchestrator(&base_url, &workspace_path, name.as_deref())?;
        let activate_url = format!(
            "{}/workspaces/{}/activate",
            base_url.trim_end_matches('/'),
            added.id
        );
        crate::flow_log!(
            "[veslo:http] OUT POST {activate_url} (orchestrator.activate) wsId={:?}",
            added.id
        );
        let started = Instant::now();
        match ureq::post(&activate_url)
            .set("Content-Type", "application/json")
            .send_string("")
        {
            Ok(r) => {
                crate::flow_log!(
                    "[veslo:http] IN  {} ({}ms) {activate_url} (orchestrator.activate)",
                    r.status(),
                    started.elapsed().as_millis()
                );
            }
            Err(ureq::Error::Status(code, response)) => {
                let body = response.into_string().unwrap_or_default();
                let excerpt: String = body.chars().take(500).collect();
                crate::flow_log!(
                    "[veslo:http] IN  {code} ({}ms) {activate_url} (orchestrator.activate) body={excerpt:?}",
                    started.elapsed().as_millis()
                );
                return Err(format!("Failed to activate workspace: status {code}: {excerpt}"));
            }
            Err(ureq::Error::Transport(t)) => {
                crate::flow_log!(
                    "[veslo:http] IN  ERR ({}ms) {activate_url} (orchestrator.activate) transport={:?}",
                    started.elapsed().as_millis(),
                    t.to_string()
                );
                return Err(format!("Failed to activate workspace: transport error: {t}"));
            }
        }
        Ok::<_, String>(added)
    })
    .await
    .map_err(|e| format!("orchestrator_workspace_activate join error: {e}"))?
}

#[tauri::command]
pub fn orchestrator_instance_dispose(
    app: AppHandle,
    manager: State<OrchestratorManager>,
    workspace_path: String,
) -> Result<bool, String> {
    let workspace_path =
        validate_workspace_path(&app, &workspace_path, ValidationMode::IsRegisteredWorkspace)?
            .to_string_lossy()
            .to_string();
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
    let workspace_path =
        validate_workspace_path(&app, &workspace_path, ValidationMode::IsRegisteredWorkspace)?
            .to_string_lossy()
            .to_string();

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
