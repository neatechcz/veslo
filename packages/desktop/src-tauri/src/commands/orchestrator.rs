use serde::Deserialize;
use serde::Serialize;
use serde_json::{json, Value};
use std::net::TcpListener;
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::State;
use uuid::Uuid;

use crate::orchestrator::manager::OrchestratorManager;
use crate::orchestrator::{resolve_orchestrator_data_dir, resolve_orchestrator_status};
use crate::supervised_process;
use crate::types::{OrchestratorEngineSnapshot, OrchestratorStatus, OrchestratorWorkspace};
use crate::workspace::validation::{validate_workspace_path, ValidationMode};

const DEFAULT_DETACHED_VESLO_HOST: &str = "127.0.0.1";
/// Must stay above the orchestrator's own worst-case activation budget,
/// otherwise a healthy-but-slow activation is reported to the user as a
/// failure while it keeps running inside the daemon. The daemon can spend up
/// to 30s waiting for the cross-process workspace skill lease and up to 60s on
/// an OpenCode cold start; this leaves a small margin on top. Activation runs
/// on `spawn_blocking`, so the longer ceiling does not stall the Tauri command
/// runtime.
const ORCHESTRATOR_WORKSPACE_ACTIVATE_TIMEOUT_MS: u64 = 95_000;
const DETACHED_VESLO_READY_TIMEOUT_MS: u64 = 30_000;
const DETACHED_VESLO_READY_POLL_MS: u64 = 200;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSkillBindingInput {
    pub revision: String,
    pub authorization_revision: String,
}

#[derive(Clone, Copy)]
pub struct WorkspaceActivationTrace<'a> {
    pub trace_id: &'a str,
    pub workspace_id: Option<&'a str>,
    pub reason: &'a str,
    pub requested_action: &'a str,
}

impl WorkspaceActivationTrace<'_> {
    pub(crate) fn record(&self, app: &AppHandle, event: &str, duration_ms: Option<u128>) {
        let mut payload = serde_json::json!({
            "traceId": self.trace_id,
            "workspaceId": self.workspace_id,
            "reason": self.reason,
            "requestedAction": self.requested_action,
        });
        if let Some(duration_ms) = duration_ms {
            payload["durationMs"] = serde_json::Value::from(duration_ms as u64);
        }
        crate::commands::misc::record_desktop_runtime_trace(app, event, payload);
    }
}

impl RuntimeSkillBindingInput {
    fn normalized(&self) -> Option<(&str, &str)> {
        let revision = self.revision.trim();
        let authorization_revision = self.authorization_revision.trim();
        if revision.is_empty() || authorization_revision.is_empty() {
            return None;
        }
        Some((revision, authorization_revision))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DetachedVesloReadyProbe {
    stage: &'static str,
    path: &'static str,
    bearer_auth: bool,
}

const DETACHED_VESLO_REQUIRED_READY_PROBES: [DetachedVesloReadyProbe; 2] = [
    DetachedVesloReadyProbe {
        stage: "health",
        path: "/health",
        bearer_auth: false,
    },
    DetachedVesloReadyProbe {
        stage: "capabilities",
        path: "/capabilities",
        bearer_auth: true,
    },
];

const DETACHED_VESLO_OPTIONAL_READY_PROBES: [DetachedVesloReadyProbe; 1] =
    [DetachedVesloReadyProbe {
        stage: "opencode-router.health",
        path: "/opencode-router/health",
        bearer_auth: true,
    }];

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

fn detached_veslo_ready_probes() -> &'static [DetachedVesloReadyProbe] {
    &DETACHED_VESLO_REQUIRED_READY_PROBES
}

fn detached_veslo_optional_ready_probes() -> &'static [DetachedVesloReadyProbe] {
    &DETACHED_VESLO_OPTIONAL_READY_PROBES
}

fn detached_veslo_probe_url(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

fn probe_detached_veslo_endpoint(
    base_url: &str,
    token: &str,
    probe: DetachedVesloReadyProbe,
) -> Result<(), String> {
    let url = detached_veslo_probe_url(base_url, probe.path);
    let mut request = ureq::get(&url).set("Accept", "application/json");
    if probe.bearer_auth {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }

    match request.call() {
        Ok(response) if response.status() >= 200 && response.status() < 300 => Ok(()),
        Ok(response) => Err(format!("{} HTTP {}", probe.stage, response.status())),
        Err(error) => Err(format!("{} {}", probe.stage, error)),
    }
}

fn probe_detached_veslo_ready(base_url: &str, token: &str) -> Result<(), String> {
    for probe in detached_veslo_ready_probes() {
        probe_detached_veslo_endpoint(base_url, token, *probe)?;
    }
    Ok(())
}

fn probe_detached_veslo_optional_ready(base_url: &str, token: &str) -> Vec<String> {
    let mut warnings = Vec::new();
    for probe in detached_veslo_optional_ready_probes() {
        if let Err(error) = probe_detached_veslo_endpoint(base_url, token, *probe) {
            warnings.push(error);
        }
    }
    warnings
}

fn wait_for_detached_veslo_ready(
    base_url: &str,
    token: &str,
    timeout_ms: u64,
    poll_ms: u64,
) -> Result<u128, String> {
    let start = Instant::now();
    let mut last_error: Option<String> = None;

    while start.elapsed() < Duration::from_millis(timeout_ms) {
        match probe_detached_veslo_ready(base_url, token) {
            Ok(()) => return Ok(start.elapsed().as_millis()),
            Err(error) => last_error = Some(error),
        }
        std::thread::sleep(Duration::from_millis(poll_ms));
    }

    let elapsed_ms = start.elapsed().as_millis();
    Err(format!(
        "Timed out waiting for Veslo server (stage=veslo.readycheck, elapsed_ms={elapsed_ms}, url={base_url}, last_error={})",
        last_error.as_deref().unwrap_or("none")
    ))
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
    resolve_live_base_url_from_status(&status)
}

fn resolve_live_base_url_from_status(status: &OrchestratorStatus) -> Result<String, String> {
    if !status.running {
        let detail = status
            .daemon
            .as_ref()
            .map(|daemon| format!("; staleBaseUrl={}", daemon.base_url))
            .unwrap_or_default();
        return Err(format!("orchestrator daemon is not running{detail}"));
    }
    status
        .daemon
        .as_ref()
        .map(|daemon| daemon.base_url.clone())
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| "orchestrator daemon is not running".to_string())
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RegisteredWorkspaceIdentity {
    app_workspace_id: Option<String>,
    server_workspace_id: Option<String>,
}

fn non_empty_trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn workspace_identity_for_registered_path(
    app: &AppHandle,
    workspace_path: &str,
) -> RegisteredWorkspaceIdentity {
    let needle = workspace_path.trim();
    if needle.is_empty() {
        return RegisteredWorkspaceIdentity::default();
    }
    crate::workspace::state::load_workspace_state(app)
        .ok()
        .and_then(|state| {
            state.workspaces.into_iter().find(|workspace| {
                matches!(workspace.workspace_type, crate::types::WorkspaceType::Local)
                    && workspace.path.trim() == needle
            })
        })
        .map(|workspace| RegisteredWorkspaceIdentity {
            app_workspace_id: non_empty_trimmed(Some(workspace.id.as_str())).map(ToOwned::to_owned),
            server_workspace_id: non_empty_trimmed(workspace.veslo_workspace_id.as_deref())
                .map(ToOwned::to_owned),
        })
        .unwrap_or_default()
}

fn orchestrator_workspace_registration_payload(
    workspace_path: &str,
    app_workspace_id: Option<&str>,
    server_workspace_id: Option<&str>,
    name: Option<&str>,
) -> Value {
    let app_workspace_id = non_empty_trimmed(app_workspace_id);
    let server_workspace_id = non_empty_trimmed(server_workspace_id);
    json!({
        "path": workspace_path,
        "id": app_workspace_id,
        "appWorkspaceId": app_workspace_id,
        "serverWorkspaceId": server_workspace_id,
        "vesloWorkspaceId": server_workspace_id,
        "name": non_empty_trimmed(name),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        detached_veslo_optional_ready_probes, detached_veslo_probe_url,
        detached_veslo_ready_probes, orchestrator_workspace_registration_payload,
        resolve_live_base_url_from_status, DetachedVesloReadyProbe, RuntimeSkillBindingInput,
    };
    use crate::types::{OrchestratorDaemonState, OrchestratorStatus};

    fn status(running: bool, base_url: Option<&str>) -> OrchestratorStatus {
        OrchestratorStatus {
            running,
            data_dir: "/tmp/veslo-orchestrator".to_string(),
            daemon: base_url.map(|base_url| OrchestratorDaemonState {
                pid: 123,
                port: 52008,
                base_url: base_url.to_string(),
                started_at: 1,
            }),
            opencode: None,
            engine_topology: None,
            cli_version: None,
            sidecar: None,
            binaries: None,
            active_id: None,
            workspace_count: 0,
            workspaces: Vec::new(),
            engines: Vec::new(),
            shared_engine: None,
            last_error: None,
        }
    }

    #[test]
    fn stale_daemon_base_url_is_not_actionable() {
        let result =
            resolve_live_base_url_from_status(&status(false, Some("http://127.0.0.1:52008")));

        let error = result.expect_err("stale daemon should not be usable");
        assert!(error.contains("orchestrator daemon is not running"));
        assert!(error.contains("staleBaseUrl=http://127.0.0.1:52008"));
    }

    #[test]
    fn running_daemon_base_url_is_returned() {
        let result =
            resolve_live_base_url_from_status(&status(true, Some("http://127.0.0.1:52008")));

        assert_eq!(result.as_deref(), Ok("http://127.0.0.1:52008"));
    }

    #[test]
    fn workspace_registration_payload_preserves_app_and_server_ids() {
        let payload = orchestrator_workspace_registration_payload(
            "C:/repo",
            Some(" app-ws "),
            Some(" server-ws "),
            Some(" Project "),
        );

        assert_eq!(payload["path"], "C:/repo");
        assert_eq!(payload["id"], "app-ws");
        assert_eq!(payload["appWorkspaceId"], "app-ws");
        assert_eq!(payload["serverWorkspaceId"], "server-ws");
        assert_eq!(payload["vesloWorkspaceId"], "server-ws");
        assert_eq!(payload["name"], "Project");
    }

    #[test]
    fn workspace_registration_payload_keeps_legacy_id_when_server_id_is_absent() {
        let payload =
            orchestrator_workspace_registration_payload("/repo", Some(" app-ws "), None, None);

        assert_eq!(payload["id"], "app-ws");
        assert_eq!(payload["appWorkspaceId"], "app-ws");
        assert!(payload["serverWorkspaceId"].is_null());
        assert!(payload["vesloWorkspaceId"].is_null());
    }

    #[test]
    fn runtime_skill_binding_is_forwarded_only_as_a_complete_pair() {
        let complete = RuntimeSkillBindingInput {
            revision: " view-1 ".to_string(),
            authorization_revision: " auth-1 ".to_string(),
        };
        assert_eq!(complete.normalized(), Some(("view-1", "auth-1")));

        let missing_revision = RuntimeSkillBindingInput {
            revision: " ".to_string(),
            authorization_revision: "auth-1".to_string(),
        };
        assert_eq!(missing_revision.normalized(), None);

        let missing_authorization = RuntimeSkillBindingInput {
            revision: "view-1".to_string(),
            authorization_revision: " ".to_string(),
        };
        assert_eq!(missing_authorization.normalized(), None);
    }

    #[test]
    fn detached_veslo_ready_probes_verify_liveness_and_auth() {
        assert_eq!(
            detached_veslo_ready_probes(),
            &[
                DetachedVesloReadyProbe {
                    stage: "health",
                    path: "/health",
                    bearer_auth: false,
                },
                DetachedVesloReadyProbe {
                    stage: "capabilities",
                    path: "/capabilities",
                    bearer_auth: true,
                },
            ],
        );
    }

    #[test]
    fn detached_veslo_optional_ready_probes_cover_router_without_blocking_start() {
        assert_eq!(
            detached_veslo_optional_ready_probes(),
            &[DetachedVesloReadyProbe {
                stage: "opencode-router.health",
                path: "/opencode-router/health",
                bearer_auth: true,
            },],
        );
    }

    #[test]
    fn detached_veslo_probe_url_accepts_base_url_with_or_without_trailing_slash() {
        assert_eq!(
            detached_veslo_probe_url("http://127.0.0.1:8787", "/capabilities"),
            "http://127.0.0.1:8787/capabilities",
        );
        assert_eq!(
            detached_veslo_probe_url("http://127.0.0.1:8787/", "/capabilities"),
            "http://127.0.0.1:8787/capabilities",
        );
    }
}

#[cfg(all(debug_assertions, feature = "e2e"))]
fn post_orchestrator_e2e(base_url: &str, path: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let response = ureq::post(&url)
        .set("Content-Type", "application/json")
        .send_string("")
        .map_err(|error| format!("Failed to invoke orchestrator e2e endpoint {path}: {error}"))?;
    response
        .into_json()
        .map_err(|error| format!("Failed to parse orchestrator e2e response {path}: {error}"))
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

#[cfg(all(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn veslo_orchestrator_e2e_kill_daemon(
    manager: State<OrchestratorManager>,
) -> Result<OrchestratorStatus, String> {
    let data_dir = resolve_data_dir(&manager);
    let message = {
        let mut state = manager
            .inner
            .lock()
            .map_err(|_| "orchestrator mutex poisoned".to_string())?;
        let child = state
            .child
            .take()
            .ok_or_else(|| "orchestrator daemon child is not running".to_string())?;
        let pid = child.pid();
        child
            .kill()
            .map_err(|error| format!("Failed to kill orchestrator daemon child {pid}: {error}"))?;
        state.child_exited = true;
        let message = format!("orchestrator daemon child killed for E2E (pid {pid})");
        state.last_stderr = Some(message.clone());
        message
    };
    Ok(resolve_orchestrator_status(&data_dir, Some(message)))
}

#[cfg(all(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn shared_engine_e2e_kill_child(
    manager: State<OrchestratorManager>,
) -> Result<serde_json::Value, String> {
    let base_url = resolve_base_url(&manager)?;
    post_orchestrator_e2e(&base_url, "/e2e/shared-engine/kill-child")
}

#[cfg(all(debug_assertions, feature = "e2e"))]
#[tauri::command]
pub fn shared_engine_e2e_fail_next_proxy(
    manager: State<OrchestratorManager>,
) -> Result<serde_json::Value, String> {
    let base_url = resolve_base_url(&manager)?;
    post_orchestrator_e2e(&base_url, "/e2e/shared-engine/fail-next-proxy")
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
    app_workspace_id: Option<&str>,
    server_workspace_id: Option<&str>,
    name: Option<&str>,
) -> Result<OrchestratorWorkspace, String> {
    let add_url = format!("{}/workspaces", base_url.trim_end_matches('/'));
    let payload = orchestrator_workspace_registration_payload(
        workspace_path,
        app_workspace_id,
        server_workspace_id,
        name,
    );

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
        match register_workspace_with_orchestrator(
            &base_url,
            path,
            Some(workspace.id.as_str()),
            workspace.veslo_workspace_id.as_deref(),
            display_name,
        ) {
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
    workspace_id: Option<String>,
    name: Option<String>,
    skill_binding: Option<RuntimeSkillBindingInput>,
) -> Result<OrchestratorWorkspace, String> {
    let (base_url, workspace_path, workspace_id, server_workspace_id) =
        resolve_workspace_activation(&app, &manager, &workspace_path, workspace_id)?;

    // VSLO-86 — push the blocking ureq calls onto a dedicated thread so the
    // Tauri command runtime stays responsive. Otherwise consecutive sidebar
    // clicks queue behind the previous synchronous activate IPC and the
    // user sees "kolečko se točí" for 30s+ on every second click while
    // browser.execute / other Tauri invokes wait for their turn.
    tauri::async_runtime::spawn_blocking(move || {
        activate_workspace_blocking(
            &base_url,
            &workspace_path,
            workspace_id.as_deref(),
            server_workspace_id.as_deref(),
            name.as_deref(),
            skill_binding.as_ref(),
            None,
            None,
        )
    })
    .await
    .map_err(|e| format!("orchestrator_workspace_activate join error: {e}"))?
}

fn resolve_workspace_activation(
    app: &AppHandle,
    manager: &OrchestratorManager,
    workspace_path: &str,
    workspace_id: Option<String>,
) -> Result<(String, String, Option<String>, Option<String>), String> {
    let workspace_path =
        validate_workspace_path(app, workspace_path, ValidationMode::IsRegisteredWorkspace)?
            .to_string_lossy()
            .to_string();
    let registered_identity = workspace_identity_for_registered_path(app, &workspace_path);
    let workspace_id = workspace_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
        .or(registered_identity.app_workspace_id);
    let server_workspace_id = registered_identity.server_workspace_id;
    let base_url = resolve_base_url(manager)?;
    Ok((base_url, workspace_path, workspace_id, server_workspace_id))
}

fn activate_workspace_blocking(
    base_url: &str,
    workspace_path: &str,
    workspace_id: Option<&str>,
    server_workspace_id: Option<&str>,
    name: Option<&str>,
    skill_binding: Option<&RuntimeSkillBindingInput>,
    trace: Option<&WorkspaceActivationTrace<'_>>,
    app: Option<&AppHandle>,
) -> Result<OrchestratorWorkspace, String> {
    let registration_started = Instant::now();
    if let (Some(trace), Some(app)) = (trace, app) {
        trace.record(app, "desktop-runtime:orchestrator-registration:start", None);
    }
    let added = match register_workspace_with_orchestrator(
        base_url,
        workspace_path,
        workspace_id,
        server_workspace_id,
        name,
    ) {
        Ok(added) => added,
        Err(error) => {
            if let (Some(trace), Some(app)) = (trace, app) {
                trace.record(
                    app,
                    "desktop-runtime:orchestrator-registration:error",
                    Some(registration_started.elapsed().as_millis()),
                );
            }
            return Err(error);
        }
    };
    if let (Some(trace), Some(app)) = (trace, app) {
        trace.record(
            app,
            "desktop-runtime:orchestrator-registration:done",
            Some(registration_started.elapsed().as_millis()),
        );
        trace.record(app, "desktop-runtime:orchestrator-activate:start", None);
    }
    let activate_url = format!(
        "{}/workspaces/{}/activate",
        base_url.trim_end_matches('/'),
        added.id
    );
    crate::flow_log!(
        "[veslo:http] OUT POST {activate_url} (orchestrator.activate) wsId={:?}",
        added.id
    );
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(
            ORCHESTRATOR_WORKSPACE_ACTIVATE_TIMEOUT_MS,
        ))
        .build();
    let started = Instant::now();
    let request = agent
        .post(&activate_url)
        .set("Content-Type", "application/json");
    let request = match skill_binding.and_then(RuntimeSkillBindingInput::normalized) {
        Some((revision, authorization_revision)) => {
            request.set("x-veslo-skill-view-revision", revision).set(
                "x-veslo-skill-authorization-revision",
                authorization_revision,
            )
        }
        None => request,
    };
    match request.send_string("") {
        Ok(r) => {
            crate::flow_log!(
                "[veslo:http] IN  {} ({}ms) {activate_url} (orchestrator.activate)",
                r.status(),
                started.elapsed().as_millis()
            );
            if let (Some(trace), Some(app)) = (trace, app) {
                trace.record(
                    app,
                    "desktop-runtime:orchestrator-activate:done",
                    Some(started.elapsed().as_millis()),
                );
            }
        }
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            let excerpt: String = body.chars().take(500).collect();
            crate::flow_log!(
                "[veslo:http] IN  {code} ({}ms) {activate_url} (orchestrator.activate) body={excerpt:?}",
                started.elapsed().as_millis()
            );
            if let (Some(trace), Some(app)) = (trace, app) {
                trace.record(
                    app,
                    "desktop-runtime:orchestrator-activate:error",
                    Some(started.elapsed().as_millis()),
                );
            }
            return Err(format!(
                "Failed to activate workspace: status {code}: {excerpt}"
            ));
        }
        Err(ureq::Error::Transport(t)) => {
            crate::flow_log!(
                "[veslo:http] IN  ERR ({}ms) {activate_url} (orchestrator.activate) transport={:?}",
                started.elapsed().as_millis(),
                t.to_string()
            );
            if let (Some(trace), Some(app)) = (trace, app) {
                trace.record(
                    app,
                    "desktop-runtime:orchestrator-activate:error",
                    Some(started.elapsed().as_millis()),
                );
            }
            return Err(format!(
                "Failed to activate workspace: transport error: {t}"
            ));
        }
    }
    Ok(added)
}

pub fn orchestrator_workspace_activate_blocking(
    app: &AppHandle,
    manager: &OrchestratorManager,
    workspace_path: String,
    workspace_id: Option<String>,
    name: Option<String>,
    skill_binding: Option<RuntimeSkillBindingInput>,
    trace: Option<WorkspaceActivationTrace<'_>>,
) -> Result<OrchestratorWorkspace, String> {
    let (base_url, workspace_path, workspace_id, server_workspace_id) =
        resolve_workspace_activation(app, manager, &workspace_path, workspace_id)?;
    activate_workspace_blocking(
        &base_url,
        &workspace_path,
        workspace_id.as_deref(),
        server_workspace_id.as_deref(),
        name.as_deref(),
        skill_binding.as_ref(),
        trace.as_ref(),
        Some(app),
    )
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
    let workspace_identity = workspace_identity_for_registered_path(&app, &workspace_path);
    let base_url = resolve_base_url(&manager)?;
    let add_url = format!("{}/workspaces", base_url.trim_end_matches('/'));
    let payload = orchestrator_workspace_registration_payload(
        &workspace_path,
        workspace_identity.app_workspace_id.as_deref(),
        workspace_identity.server_workspace_id.as_deref(),
        None,
    );

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

    let mut command = match supervised_process::sidecar(&app, "veslo-orchestrator") {
        Ok(command) => command,
        Err(error) => supervised_process::command_fallback_for_missing_sidecar(
            &app,
            "veslo-orchestrator",
            "veslo",
            error,
        )?,
    };

    let shared_unsandboxed_engine =
        crate::runtime_preferences::read_shared_unsandboxed_engine_override(&app)?;
    for (key, value) in crate::runtime_preferences::host_runtime_env_overrides(
        shared_unsandboxed_engine,
    ) {
        command = command.env(key, value);
    }
    for (key, value) in crate::runtime_preferences::runtime_diagnostics_env_overrides(&app)? {
        command = command.env(key, value);
    }

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
            DEFAULT_DETACHED_VESLO_HOST.to_string(),
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

    let ready_elapsed_ms = match wait_for_detached_veslo_ready(
        &veslo_url,
        &token,
        DETACHED_VESLO_READY_TIMEOUT_MS,
        DETACHED_VESLO_READY_POLL_MS,
    ) {
        Ok(elapsed_ms) => elapsed_ms,
        Err(message) => {
            eprintln!(
                "[orchestrator-detached][at={}][runId={host_run_id}][stage=timeout] ready wait failed error={message}",
                now_ms()
            );
            return Err(message);
        }
    };

    for warning in probe_detached_veslo_optional_ready(&veslo_url, &token) {
        eprintln!(
            "[orchestrator-detached][at={}][runId={host_run_id}][stage=optional-readiness] {warning}",
            now_ms()
        );
    }

    eprintln!(
        "[orchestrator-detached][at={}][runId={host_run_id}][stage=complete] detached host ready in {}ms url={veslo_url}",
        now_ms(),
        ready_elapsed_ms
    );

    Ok(OrchestratorDetachedHost {
        veslo_url,
        token,
        host_token,
        port,
    })
}
