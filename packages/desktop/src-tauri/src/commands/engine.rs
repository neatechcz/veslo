use tauri::{AppHandle, Manager, State};

use crate::commands::opencode_router::opencodeRouter_start;
use crate::commands::orchestrator::reconcile_orchestrator_workspaces;
use crate::config::{read_opencode_config, write_opencode_config};
use crate::engine::doctor::{
    opencode_serve_help, opencode_version, resolve_engine_path, resolve_sidecar_candidate,
};
use crate::engine::manager::EngineManager;
use crate::engine::spawn::{find_free_port, spawn_engine};
use crate::env_guard::EnvVarGuard;
use crate::opencode_router::manager::OpenCodeRouterManager;
use crate::opencode_router::spawn::resolve_opencode_router_health_port;
use crate::orchestrator::manager::OrchestratorManager;
use crate::orchestrator::{self, OrchestratorShutdownAttribution, OrchestratorSpawnOptions};
use crate::supervised_process::CommandEvent;
use crate::types::{
    EngineDoctorResult, EngineInfo, EngineRuntime, ExecResult, OrchestratorStatus,
    RuntimeEngineState,
};
use crate::utils::truncate_output;
use crate::veslo_server::{
    manager::VesloServerManager, persisted_veslo_server_plugin_state_path, start_veslo_server,
};
use crate::workspace::server_client::reconcile_server_workspaces;
use serde::Serialize;
use serde_json::json;
use std::sync::MutexGuard;
use std::time::Duration;
use uuid::Uuid;

const DEFAULT_OPENCODE_BIND_HOST: &str = "127.0.0.1";
const VESLO_OPENCODE_BIND_HOST_ENV: &str = "VESLO_OPENCODE_BIND_HOST";
#[cfg(debug_assertions)]
const VESLO_DISABLE_DEV_AUTOSTART_ENV: &str = "VESLO_DISABLE_DEV_AUTOSTART";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkspaceRuntimePrepareAction {
    FreshStart,
    OrchestratorActivate,
}

impl WorkspaceRuntimePrepareAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::FreshStart => "fresh_start",
            Self::OrchestratorActivate => "orchestrator_activate",
        }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRuntimePrepareResult {
    pub ok: bool,
    pub action: String,
    pub reason: String,
    pub engine: EngineInfo,
}

fn workspace_runtime_prepare_action(
    runtime: &EngineRuntime,
    reason: &str,
    force_fresh_runtime: bool,
) -> WorkspaceRuntimePrepareAction {
    if runtime != &EngineRuntime::Orchestrator {
        return WorkspaceRuntimePrepareAction::FreshStart;
    }

    let normalized_reason = reason.trim().to_ascii_lowercase();
    if force_fresh_runtime
        || normalized_reason.contains("runtime-recovery")
        || normalized_reason.contains("cold-start")
        || normalized_reason.contains("host-start")
        || normalized_reason.contains("engine-reload")
    {
        return WorkspaceRuntimePrepareAction::FreshStart;
    }

    WorkspaceRuntimePrepareAction::OrchestratorActivate
}

fn workspace_runtime_prepare_result(
    action: WorkspaceRuntimePrepareAction,
    reason: &str,
    engine: EngineInfo,
) -> WorkspaceRuntimePrepareResult {
    WorkspaceRuntimePrepareResult {
        ok: true,
        action: action.as_str().to_string(),
        reason: reason.to_string(),
        engine,
    }
}

fn current_or_new_veslo_client_token(manager: &VesloServerManager) -> String {
    let Ok(mut state) = manager.inner.lock() else {
        return Uuid::new_v4().to_string();
    };

    if let Some(token) = state
        .client_token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
    {
        return token;
    }

    let token = Uuid::new_v4().to_string();
    state.client_token = Some(token.clone());
    token
}

fn try_reserve_dev_autostart(manager: &EngineManager) -> Option<MutexGuard<'_, ()>> {
    let permit = manager.start_queue.try_lock().ok()?;
    let explicit_runtime_running = manager
        .inner
        .lock()
        .ok()
        .is_some_and(|state| state.base_url.is_some());
    if explicit_runtime_running {
        return None;
    }
    Some(permit)
}

#[derive(Default)]
struct OutputState {
    stdout: String,
    stderr: String,
    exited: bool,
    exit_code: Option<i32>,
}

fn resolve_opencode_bind_host_from_env(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_OPENCODE_BIND_HOST)
        .to_string()
}

fn resolve_opencode_bind_host() -> String {
    resolve_opencode_bind_host_from_env(std::env::var(VESLO_OPENCODE_BIND_HOST_ENV).ok().as_deref())
}

#[cfg(debug_assertions)]
fn dev_autostart_disabled_from_env(value: Option<&str>) -> bool {
    matches!(
        value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

#[cfg(debug_assertions)]
fn dev_autostart_disabled() -> bool {
    dev_autostart_disabled_from_env(
        std::env::var(VESLO_DISABLE_DEV_AUTOSTART_ENV)
            .ok()
            .as_deref(),
    )
}

fn runtime_engine_state_from_public(value: Option<&str>) -> RuntimeEngineState {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some("starting") => RuntimeEngineState::Starting,
        Some("process_ready") => RuntimeEngineState::ProcessReady,
        Some("workspace_api_waiting") => RuntimeEngineState::WorkspaceApiWaiting,
        Some("ready") => RuntimeEngineState::Ready,
        Some("stopped") => RuntimeEngineState::Stopped,
        Some("failed") => RuntimeEngineState::Failed,
        Some("absent") | None => RuntimeEngineState::Absent,
        Some(_) => RuntimeEngineState::Failed,
    }
}

fn runtime_engine_state_from_orchestrator_state(value: Option<&str>) -> RuntimeEngineState {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some("spawning") => RuntimeEngineState::Starting,
        Some("ready") | Some("idle") => RuntimeEngineState::Ready,
        Some("suspended") => RuntimeEngineState::Stopped,
        Some("crashed") => RuntimeEngineState::Failed,
        None => RuntimeEngineState::Absent,
        Some(_) => RuntimeEngineState::Failed,
    }
}

fn runtime_engine_state_from_shared_engine(status: &OrchestratorStatus) -> RuntimeEngineState {
    let Some(shared) = status.shared_engine.as_ref() else {
        return RuntimeEngineState::Absent;
    };
    if shared.pending || shared.state.as_deref() == Some("spawning") {
        return RuntimeEngineState::Starting;
    }
    let mapped = runtime_engine_state_from_public(shared.engine_state.as_deref());
    if mapped != RuntimeEngineState::Absent {
        return mapped;
    }
    if shared.running {
        RuntimeEngineState::Ready
    } else {
        RuntimeEngineState::Absent
    }
}

fn topology_uses_shared_engine(topology: Option<&str>) -> bool {
    matches!(
        topology.map(str::trim),
        Some("shared-unsandboxed" | "shared-directory-scoped")
    )
}

fn is_opencode_reachable(base_url: &str) -> bool {
    const HEALTH_TIMEOUT_MS: u64 = 1200;
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return false;
    }

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(HEALTH_TIMEOUT_MS))
        .build();

    for path in ["/global/health", "/health"] {
        let url = format!("{trimmed}{path}");
        let request = agent.get(&url).set("Accept", "application/json");

        match request.call() {
            Ok(response) => {
                if path == "/global/health" {
                    match response.into_json::<serde_json::Value>() {
                        Ok(payload) => {
                            if payload
                                .get("healthy")
                                .and_then(|value| value.as_bool())
                                .unwrap_or(true)
                            {
                                return true;
                            }
                        }
                        Err(_) => return true,
                    }
                } else {
                    return true;
                }
            }
            Err(ureq::Error::Status(401, _)) | Err(ureq::Error::Status(403, _)) => {
                // Auth failures still prove the server is up.
                return true;
            }
            Err(_) => continue,
        }
    }

    false
}

fn normalize_workspace_path_for_match(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

fn resolve_orchestrator_proxy_workspace_id(
    status: &OrchestratorStatus,
    project_dir: &str,
    health_active_id: Option<&str>,
) -> Option<String> {
    let target_path = normalize_workspace_path_for_match(project_dir);
    let by_path = if target_path.is_empty() {
        None
    } else {
        status
            .workspaces
            .iter()
            .find(|workspace| {
                workspace.workspace_type == "local"
                    && normalize_workspace_path_for_match(&workspace.path) == target_path
            })
            .map(|workspace| workspace.id.trim().to_string())
            .filter(|id| !id.is_empty())
    };

    by_path
        .or_else(|| {
            status
                .active_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            health_active_id
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(ToOwned::to_owned)
        })
}

fn orchestrator_opencode_base_url(daemon_port: u16, workspace_id: Option<&str>) -> String {
    let workspace_id = workspace_id.map(str::trim).filter(|id| !id.is_empty());
    if let Some(workspace_id) = workspace_id {
        format!("http://127.0.0.1:{daemon_port}/workspace/{workspace_id}/opencode")
    } else {
        format!("http://127.0.0.1:{daemon_port}")
    }
}

fn format_orchestrator_start_error(
    waited_ms: u64,
    health_error: &str,
    child_exited: bool,
    exit_code: Option<i32>,
    stderr: Option<&str>,
) -> String {
    let mut message = if child_exited {
        format!(
            "Failed to start orchestrator: process exited before health became ready.\n{}",
            health_error.trim()
        )
    } else {
        format!(
            "Failed to start orchestrator (waited {waited_ms}ms): {}",
            health_error.trim()
        )
    };

    if child_exited {
        if let Some(exit_code) = exit_code {
            message.push_str(&format!("\nexit code: {exit_code}"));
        }
    }

    let stderr = stderr.map(str::trim).filter(|value| !value.is_empty());
    if let Some(stderr) = stderr {
        message.push_str("\n\nstderr:\n");
        message.push_str(stderr);
    }

    message
}

fn should_retry_orchestrator_start(
    attempt: usize,
    max_attempts: usize,
    child_exited: bool,
) -> bool {
    child_exited && attempt < max_attempts && max_attempts > 1
}

/// VSLO-171 F2Ú7 (dev only): auto-spawn orchestrator daemon shortly after app
/// boot so the UI can use per-workspace `engine_info(workspaceId)` without
/// requiring an explicit user action. Runs on a dedicated OS thread because
/// `engine_start` does blocking I/O (spawns binaries, waits for health).
///
/// No-op when:
/// - the engine is already running (frontend onboarding got there first), or
/// - the home directory can't be resolved, or
/// - directory creation/spawning fails (logged to stderr, not surfaced).
#[cfg(debug_assertions)]
pub fn spawn_orchestrator_dev_autostart(app: AppHandle) {
    use std::thread;
    use std::time::Duration;
    use tauri::Manager;

    if dev_autostart_disabled() {
        eprintln!("[dev-autostart] disabled by VESLO_DISABLE_DEV_AUTOSTART");
        return;
    }

    thread::spawn(move || {
        // Give explicit runtime startup requests a short head start. If a real
        // workspace engine is already running after this delay, this debug
        // scratch autostart becomes a no-op (see check below).
        thread::sleep(Duration::from_millis(1500));

        let engine_manager = app.state::<EngineManager>();
        let Some(_start_permit) = try_reserve_dev_autostart(&engine_manager) else {
            eprintln!("[dev-autostart] explicit engine startup active or ready — skipping");
            return;
        };

        let scratch_root = crate::paths::app_local_data_dir_override()
            .or_else(|| app.path().app_local_data_dir().ok())
            .or_else(|| crate::paths::home_dir().map(|home| home.join(".veslo")));
        let Some(scratch_root) = scratch_root else {
            eprintln!("[dev-autostart] data dir not found — skipping");
            return;
        };
        let scratch = scratch_root.join("scratch");
        if let Err(e) = std::fs::create_dir_all(&scratch) {
            eprintln!("[dev-autostart] mkdir {:?} failed: {}", scratch, e);
            return;
        }

        let project_dir = scratch.to_string_lossy().to_string();
        eprintln!("[dev-autostart] starting orchestrator at {}", project_dir);
        // Force `prefer_sidecar = true`: the dev autostart runs before the
        // frontend has a chance to surface the user's engineSource preference,
        // so without this override the path resolver falls back to system
        // PATH and picks /opt/homebrew/bin/opencode (typically 1.3.2),
        // incompatible with the bundled orchestrator (expects 1.17.13).
        // Engine spawns then silently time out.
        let result = engine_start_reserved(
            app.clone(),
            app.state::<EngineManager>(),
            app.state::<OrchestratorManager>(),
            app.state::<VesloServerManager>(),
            app.state::<OpenCodeRouterManager>(),
            project_dir,
            Some(true),
            None,
            Some(EngineRuntime::Orchestrator),
            None,
            None,
            None,
        );
        match result {
            Ok(info) => eprintln!(
                "[dev-autostart] orchestrator ready, base_url={:?}",
                info.base_url
            ),
            Err(e) => eprintln!("[dev-autostart] failed: {}", e),
        }
    });
}

#[tauri::command]
pub fn engine_info(
    manager: State<EngineManager>,
    orchestrator_manager: State<OrchestratorManager>,
    workspace_id: Option<String>,
    workspace_path: Option<String>,
) -> EngineInfo {
    let (
        direct_snapshot,
        runtime,
        state_project_dir,
        state_opencode_username,
        state_opencode_password,
    ) = {
        let mut state = manager.inner.lock().expect("engine mutex poisoned");
        let direct_snapshot = EngineManager::snapshot_locked(&mut state);
        if workspace_id.is_none()
            && state.runtime != EngineRuntime::Orchestrator
            && direct_snapshot.running
        {
            return direct_snapshot;
        }
        (
            direct_snapshot,
            state.runtime.clone(),
            state.project_dir.clone(),
            state.opencode_username.clone(),
            state.opencode_password.clone(),
        )
    };

    let (data_dir, orchestrator_stdout, orchestrator_stderr) =
        if let Ok(orchestrator_state) = orchestrator_manager.inner.lock() {
            (
                orchestrator_state
                    .data_dir
                    .clone()
                    .unwrap_or_else(orchestrator::resolve_orchestrator_data_dir),
                orchestrator_state.last_stdout.clone(),
                orchestrator_state.last_stderr.clone(),
            )
        } else {
            (orchestrator::resolve_orchestrator_data_dir(), None, None)
        };

    let status = orchestrator::resolve_orchestrator_status(&data_dir, orchestrator_stderr.clone());
    let should_use_orchestrator = status.running || runtime == EngineRuntime::Orchestrator;
    if !should_use_orchestrator {
        return direct_snapshot;
    }

    // The orchestrator can keep running across app relaunches. In that case, the in-memory
    // EngineManager state (including opencode basic auth) is lost. Persist a small
    // auth snapshot next to veslo-orchestrator-state.json so the UI can reconnect.
    let auth_snapshot = orchestrator::read_orchestrator_auth(&data_dir);
    let opencode_username = state_opencode_username.or_else(|| {
        auth_snapshot
            .as_ref()
            .and_then(|auth| auth.opencode_username.clone())
    });
    let opencode_password = state_opencode_password.or_else(|| {
        auth_snapshot
            .as_ref()
            .and_then(|auth| auth.opencode_password.clone())
    });
    let auth_project_dir = auth_snapshot
        .as_ref()
        .and_then(|auth| auth.project_dir.clone());

    // Per-workspace branch: route to a pooled engine via the orchestrator's
    // /workspace/:id/opencode/* proxy (F2Ú2). The SDK still talks to the
    // returned base_url; the orchestrator injects x-opencode-directory and
    // basic auth on the way to the upstream engine.
    if let Some(ref ws_id) = workspace_id {
        let daemon_port = status.daemon.as_ref().map(|d| d.port);
        // VSLO-171 F3 fix — frontend and orchestrator maintain independent
        // workspace ID stores; the frontend ID may not match the orchestrator's
        // ID even though both refer to the same path. If the caller-provided
        // ws_id doesn't resolve in orchestrator state, fall back to a
        // path-based lookup using workspace_path. The proxy URL must use the
        // *orchestrator's* ID — otherwise the proxy returns 404 "workspace not
        // found" on the first request and the engine never starts.
        let by_id = status.workspaces.iter().find(|ws| &ws.id == ws_id);
        let by_path = workspace_path.as_ref().and_then(|path| {
            let normalized = path.trim_end_matches('/');
            status
                .workspaces
                .iter()
                .find(|ws| ws.path.trim_end_matches('/') == normalized)
        });
        let resolved_ws = by_id.or(by_path);
        let resolved_ws_id = resolved_ws
            .map(|ws| ws.id.clone())
            .unwrap_or_else(|| ws_id.clone());
        let engine = status
            .engines
            .iter()
            .find(|e| e.workspace_id == resolved_ws_id);
        let shared_engine = status.shared_engine.as_ref();
        let uses_shared_engine = topology_uses_shared_engine(status.engine_topology.as_deref());
        let engine_state = if uses_shared_engine {
            runtime_engine_state_from_shared_engine(&status)
        } else {
            runtime_engine_state_from_orchestrator_state(engine.map(|e| e.state.as_str()))
        };
        let workspace_path = resolved_ws
            .map(|ws| ws.path.clone())
            .or_else(|| engine.map(|e| e.workdir.clone()));
        // Workspace IDs are `ws-` + 12 hex chars (see workspaceIdForLocal in
        // packages/orchestrator/src/cli.ts); they are URL-safe, no encoding needed.
        let proxy_base_url = daemon_port
            .map(|port| format!("http://127.0.0.1:{port}/workspace/{resolved_ws_id}/opencode"));
        let running = engine_state == RuntimeEngineState::Ready;
        // VSLO-171 — always return the orchestrator proxy URL when daemon is
        // up. Engines are lazy-spawned by the proxy on the first request, so
        // gating base_url on the engine being "ready" prevented connectToServer
        // from running for a workspace the user just clicked into for the
        // first time (sendPrompt would block with no client).
        return EngineInfo {
            running,
            runtime: EngineRuntime::Orchestrator,
            engine_state: Some(engine_state),
            child_kind: if uses_shared_engine {
                shared_engine.and_then(|e| e.child_kind.clone())
            } else {
                engine.and_then(|e| e.child_kind.clone())
            },
            base_url: proxy_base_url,
            project_dir: workspace_path,
            hostname: Some("127.0.0.1".to_string()),
            port: if uses_shared_engine {
                shared_engine.and_then(|e| e.port)
            } else {
                engine.map(|e| e.port)
            },
            opencode_username,
            opencode_password,
            pid: if uses_shared_engine {
                shared_engine.and_then(|e| e.pid)
            } else {
                engine.map(|e| e.pid)
            },
            last_stdout: orchestrator_stdout,
            last_stderr: orchestrator_stderr,
        };
    }

    let opencode = status.opencode.clone();
    let base_url = opencode
        .as_ref()
        .map(|entry| format!("http://127.0.0.1:{}", entry.port));
    let opencode_reachable = base_url
        .as_deref()
        .map(is_opencode_reachable)
        .unwrap_or(false);
    let running = status.running && opencode_reachable;
    let project_dir = status
        .active_id
        .as_ref()
        .and_then(|active| status.workspaces.iter().find(|ws| &ws.id == active))
        .map(|ws| ws.path.clone())
        .or_else(|| state_project_dir.clone())
        .or(auth_project_dir);

    let effective_base_url = if running { base_url.clone() } else { None };
    let effective_port = if running {
        opencode.as_ref().map(|entry| entry.port)
    } else {
        None
    };
    let effective_pid = if running {
        opencode.as_ref().map(|entry| entry.pid)
    } else {
        None
    };

    if running {
        let mut state = manager.inner.lock().expect("engine mutex poisoned");
        state.runtime = EngineRuntime::Orchestrator;
        state.project_dir = project_dir.clone();
        state.base_url = effective_base_url.clone();
        state.hostname = Some("127.0.0.1".to_string());
        state.port = effective_port;
        state.opencode_username = opencode_username.clone();
        state.opencode_password = opencode_password.clone();
    }

    EngineInfo {
        running,
        runtime: EngineRuntime::Orchestrator,
        engine_state: Some(if running {
            RuntimeEngineState::Ready
        } else {
            RuntimeEngineState::Absent
        }),
        child_kind: None,
        base_url: effective_base_url,
        project_dir,
        hostname: Some("127.0.0.1".to_string()),
        port: effective_port,
        opencode_username,
        opencode_password,
        pid: effective_pid,
        last_stdout: orchestrator_stdout,
        last_stderr: orchestrator_stderr,
    }
}

#[tauri::command]
#[expect(
    clippy::too_many_arguments,
    reason = "The desktop IPC command keeps its established frontend argument contract."
)]
pub async fn runtime_prepare_workspace(
    app: AppHandle,
    project_dir: String,
    workspace_id: Option<String>,
    workspace_name: Option<String>,
    skill_view_revision: Option<String>,
    reason: Option<String>,
    force_fresh_runtime: Option<bool>,
    prefer_sidecar: Option<bool>,
    opencode_bin_path: Option<String>,
    runtime: Option<EngineRuntime>,
    workspace_paths: Option<Vec<String>>,
    max_engines: Option<u32>,
    idle_suspend_ms: Option<u64>,
) -> Result<WorkspaceRuntimePrepareResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        runtime_prepare_workspace_blocking(
            app,
            project_dir,
            workspace_id,
            workspace_name,
            skill_view_revision,
            reason,
            force_fresh_runtime,
            prefer_sidecar,
            opencode_bin_path,
            runtime,
            workspace_paths,
            max_engines,
            idle_suspend_ms,
        )
    })
    .await
    .map_err(|error| format!("runtime_prepare_workspace join error: {error}"))?
}

#[expect(
    clippy::too_many_arguments,
    reason = "This blocking helper intentionally mirrors the stable IPC command inputs."
)]
fn runtime_prepare_workspace_blocking(
    app: AppHandle,
    project_dir: String,
    workspace_id: Option<String>,
    workspace_name: Option<String>,
    skill_view_revision: Option<String>,
    reason: Option<String>,
    force_fresh_runtime: Option<bool>,
    prefer_sidecar: Option<bool>,
    opencode_bin_path: Option<String>,
    runtime: Option<EngineRuntime>,
    workspace_paths: Option<Vec<String>>,
    max_engines: Option<u32>,
    idle_suspend_ms: Option<u64>,
) -> Result<WorkspaceRuntimePrepareResult, String> {
    let project_dir = project_dir.trim().to_string();
    if project_dir.is_empty() {
        return Err("projectDir is required".to_string());
    }

    let reason = reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("workspace-runtime-prepare")
        .to_string();
    let runtime = runtime.unwrap_or(EngineRuntime::Orchestrator);
    let requested_action =
        workspace_runtime_prepare_action(&runtime, &reason, force_fresh_runtime.unwrap_or(false));
    let mut action = requested_action;
    let start_queue = app.state::<EngineManager>().start_queue.clone();
    let _start_permit = start_queue
        .lock()
        .map_err(|_| "engine start queue mutex poisoned".to_string())?;

    if action == WorkspaceRuntimePrepareAction::OrchestratorActivate {
        match crate::commands::orchestrator::orchestrator_workspace_activate_blocking(
            &app,
            &app.state::<OrchestratorManager>(),
            project_dir.clone(),
            workspace_id.clone(),
            workspace_name.clone(),
            skill_view_revision.clone(),
        ) {
            Ok(_) => {
                let engine = engine_info(
                    app.state::<EngineManager>(),
                    app.state::<OrchestratorManager>(),
                    workspace_id.clone(),
                    Some(project_dir),
                );
                return Ok(workspace_runtime_prepare_result(action, &reason, engine));
            }
            Err(error) => {
                // A revision mismatch is a deliberate fail-closed response
                // from the orchestrator. Do not hide it behind a fresh daemon
                // start: the client must refresh its server-owned skill view
                // and retry activation with the newly published revision.
                if error.contains("skill_view_stale") || error.contains("skill_view_changed") {
                    return Err(error);
                }
                eprintln!(
                    "[runtime_prepare_workspace] orchestrator activate failed, falling back to fresh start: {error}"
                );
                action = WorkspaceRuntimePrepareAction::FreshStart;
            }
        }
    }

    let engine = engine_start_reserved(
        app.clone(),
        app.state::<EngineManager>(),
        app.state::<OrchestratorManager>(),
        app.state::<VesloServerManager>(),
        app.state::<OpenCodeRouterManager>(),
        project_dir.clone(),
        prefer_sidecar,
        opencode_bin_path,
        Some(runtime.clone()),
        workspace_paths,
        max_engines,
        idle_suspend_ms,
    )?;

    let engine = if runtime == EngineRuntime::Orchestrator {
        // Fresh orchestrator start only boots the daemon; activate spawns the workspace engine.
        crate::commands::orchestrator::orchestrator_workspace_activate_blocking(
            &app,
            &app.state::<OrchestratorManager>(),
            project_dir.clone(),
            workspace_id.clone(),
            workspace_name.clone(),
            skill_view_revision,
        )?;
        engine_info(
            app.state::<EngineManager>(),
            app.state::<OrchestratorManager>(),
            workspace_id.clone(),
            Some(project_dir),
        )
    } else {
        engine
    };

    Ok(workspace_runtime_prepare_result(action, &reason, engine))
}

#[tauri::command]
pub fn engine_stop(
    app: AppHandle,
    manager: State<EngineManager>,
    orchestrator_manager: State<OrchestratorManager>,
    veslo_manager: State<VesloServerManager>,
    opencode_router_manager: State<OpenCodeRouterManager>,
) -> EngineInfo {
    let mut state = manager.inner.lock().expect("engine mutex poisoned");
    if let Ok(mut orchestrator_state) = orchestrator_manager.inner.lock() {
        OrchestratorManager::stop_locked(
            &mut orchestrator_state,
            OrchestratorShutdownAttribution::new("engine_stop", "engine_stop"),
        );
    }
    EngineManager::stop_locked(&mut state);
    if let Ok(mut veslo_state) = veslo_manager.inner.lock() {
        VesloServerManager::stop_locked(&mut veslo_state);
    }
    // VSLO-86 — keep disk state.json in sync with the actually-stopped server.
    let _ = crate::veslo_server::clear_persisted_veslo_server_info(&app);
    if let Ok(mut opencode_router_state) = opencode_router_manager.inner.lock() {
        OpenCodeRouterManager::stop_locked(&mut opencode_router_state);
    }
    EngineManager::snapshot_locked(&mut state)
}

#[tauri::command]
pub fn engine_restart(
    app: AppHandle,
    manager: State<EngineManager>,
    orchestrator_manager: State<OrchestratorManager>,
    veslo_manager: State<VesloServerManager>,
    opencode_router_manager: State<OpenCodeRouterManager>,
) -> Result<EngineInfo, String> {
    let (project_dir, runtime) = {
        let state = manager.inner.lock().expect("engine mutex poisoned");
        (
            state
                .project_dir
                .clone()
                .ok_or_else(|| "OpenCode is not configured for a local workspace".to_string())?,
            state.runtime.clone(),
        )
    };

    let workspace_paths = vec![project_dir.clone()];
    engine_start(
        app,
        manager,
        orchestrator_manager,
        veslo_manager,
        opencode_router_manager,
        project_dir,
        None,
        None,
        Some(runtime),
        Some(workspace_paths),
        None,
        None,
    )
}

#[tauri::command]
pub fn engine_doctor(
    app: AppHandle,
    prefer_sidecar: Option<bool>,
    opencode_bin_path: Option<String>,
) -> EngineDoctorResult {
    let prefer_sidecar = prefer_sidecar.unwrap_or(false)
        || !crate::supervised_process::external_runtime_binaries_allowed();
    let resource_dir = app.path().resource_dir().ok();

    let current_bin_dir = tauri::process::current_binary(&app.env())
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));

    let _guard = EnvVarGuard::apply("OPENCODE_BIN_PATH", opencode_bin_path.as_deref());

    let (resolved, in_path, notes) = resolve_engine_path(
        prefer_sidecar,
        resource_dir.as_deref(),
        current_bin_dir.as_deref(),
    );

    let external_path_blocked =
        in_path && !crate::supervised_process::external_runtime_binaries_allowed();
    let mut notes = notes;
    if external_path_blocked {
        notes.push(format!(
            "PATH OpenCode resolution is disabled in release; set {}=1 only for a developer override.",
            crate::supervised_process::ALLOW_EXTERNAL_RUNTIME_BINARIES_ENV
        ));
    }

    let (version, supports_serve, serve_help_status, serve_help_stdout, serve_help_stderr) =
        match (resolved.as_ref(), external_path_blocked) {
            (_, true) => (None, false, None, None, None),
            (Some(path), false) => {
                let (ok, status, stdout, stderr) = opencode_serve_help(path.as_os_str());
                (
                    opencode_version(path.as_os_str()),
                    ok,
                    status,
                    stdout,
                    stderr,
                )
            }
            (None, false) => (None, false, None, None, None),
        };

    EngineDoctorResult {
        found: resolved.is_some() && !external_path_blocked,
        in_path,
        resolved_path: if external_path_blocked {
            None
        } else {
            resolved.map(|path| path.to_string_lossy().to_string())
        },
        version,
        supports_serve,
        notes,
        serve_help_status,
        serve_help_stdout,
        serve_help_stderr,
    }
}

#[tauri::command]
pub fn engine_install() -> Result<ExecResult, String> {
    #[cfg(windows)]
    {
        Ok(ExecResult {
            ok: false,
            status: -1,
            stdout: String::new(),
            stderr: "Guided install is not supported on Windows yet. Install OpenCode via Scoop/Chocolatey or https://opencode.ai/install, then restart Veslo.".to_string(),
        })
    }

    #[cfg(not(windows))]
    {
        let install_dir = crate::paths::home_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join(".opencode")
            .join("bin");

        let output = std::process::Command::new("bash")
            .arg("-lc")
            .arg("curl -fsSL https://opencode.ai/install | bash")
            .env("OPENCODE_INSTALL_DIR", install_dir)
            .output()
            .map_err(|e| format!("Failed to run installer: {e}"))?;

        let status = output.status.code().unwrap_or(-1);
        Ok(ExecResult {
            ok: output.status.success(),
            status,
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    }
}

#[tauri::command]
#[expect(
    clippy::too_many_arguments,
    reason = "The desktop IPC command keeps its established frontend argument contract."
)]
pub fn engine_start(
    app: AppHandle,
    manager: State<EngineManager>,
    orchestrator_manager: State<OrchestratorManager>,
    veslo_manager: State<VesloServerManager>,
    opencode_router_manager: State<OpenCodeRouterManager>,
    project_dir: String,
    prefer_sidecar: Option<bool>,
    opencode_bin_path: Option<String>,
    runtime: Option<EngineRuntime>,
    workspace_paths: Option<Vec<String>>,
    // VSLO-171 F3Ú9: Settings Performance panel passes pool tuning.
    max_engines: Option<u32>,
    idle_suspend_ms: Option<u64>,
) -> Result<EngineInfo, String> {
    let start_queue = manager.start_queue.clone();
    let _start_permit = start_queue
        .lock()
        .map_err(|_| "engine start queue mutex poisoned".to_string())?;
    engine_start_reserved(
        app,
        manager,
        orchestrator_manager,
        veslo_manager,
        opencode_router_manager,
        project_dir,
        prefer_sidecar,
        opencode_bin_path,
        runtime,
        workspace_paths,
        max_engines,
        idle_suspend_ms,
    )
}

#[expect(
    clippy::too_many_arguments,
    reason = "This reservation helper intentionally mirrors the stable IPC command inputs."
)]
fn engine_start_reserved(
    app: AppHandle,
    manager: State<EngineManager>,
    orchestrator_manager: State<OrchestratorManager>,
    veslo_manager: State<VesloServerManager>,
    opencode_router_manager: State<OpenCodeRouterManager>,
    project_dir: String,
    prefer_sidecar: Option<bool>,
    opencode_bin_path: Option<String>,
    runtime: Option<EngineRuntime>,
    workspace_paths: Option<Vec<String>>,
    max_engines: Option<u32>,
    idle_suspend_ms: Option<u64>,
) -> Result<EngineInfo, String> {
    let project_dir = project_dir.trim().to_string();
    if project_dir.is_empty() {
        return Err("projectDir is required".to_string());
    }

    crate::flow_log!(
        "[veslo:flow] BOOT rust-up {{ pid: {}, project_dir: {:?} }}",
        std::process::id(),
        project_dir
    );

    // OpenCode is spawned with `current_dir(project_dir)`. If the user selected a
    // workspace path that doesn't exist yet (common during onboarding), spawning
    // fails with `os error 2`.
    std::fs::create_dir_all(&project_dir)
        .map_err(|e| format!("Failed to create projectDir directory: {e}"))?;

    let config = read_opencode_config("project", &project_dir)?;
    if !config.exists {
        let content = serde_json::to_string_pretty(&json!({
            "$schema": "https://opencode.ai/config.json",
        }))
        .map_err(|e| format!("Failed to serialize opencode config: {e}"))?;
        let write_result = write_opencode_config("project", &project_dir, &format!("{content}\n"))?;
        if !write_result.ok {
            return Err(write_result.stderr);
        }
    }

    // Preserve historical behavior: if runtime isn't provided by the UI, prefer orchestrator.
    let runtime = runtime.unwrap_or(EngineRuntime::Orchestrator);
    let mut workspace_paths = workspace_paths.unwrap_or_default();
    workspace_paths.retain(|path| !path.trim().is_empty());
    workspace_paths.retain(|path| path.trim() != project_dir);
    workspace_paths.insert(0, project_dir.clone());

    let bind_host = resolve_opencode_bind_host();
    let client_host = "127.0.0.1".to_string();
    let port = find_free_port()?;
    let enable_auth = std::env::var("VESLO_OPENCODE_AUTH")
        .ok()
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(true);
    let opencode_username = if enable_auth {
        Some("opencode".to_string())
    } else {
        None
    };
    let opencode_password = if enable_auth {
        Some(Uuid::new_v4().to_string())
    } else {
        None
    };

    let mut state = manager.inner.lock().expect("engine mutex poisoned");
    EngineManager::stop_locked(&mut state);
    if let Ok(mut orchestrator_state) = orchestrator_manager.inner.lock() {
        OrchestratorManager::stop_locked(
            &mut orchestrator_state,
            OrchestratorShutdownAttribution::new("engine_start_replace", "engine_start"),
        );
    }
    state.runtime = runtime.clone();

    let resource_dir = app.path().resource_dir().ok();
    let current_bin_dir = tauri::process::current_binary(&app.env())
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));
    let prefer_sidecar = prefer_sidecar.unwrap_or(false)
        || !crate::supervised_process::external_runtime_binaries_allowed();
    let _guard = EnvVarGuard::apply("OPENCODE_BIN_PATH", opencode_bin_path.as_deref());
    let (program, in_path, notes) = resolve_engine_path(
        prefer_sidecar,
        resource_dir.as_deref(),
        current_bin_dir.as_deref(),
    );
    if in_path && !crate::supervised_process::external_runtime_binaries_allowed() {
        let notes_text = notes.join("\n");
        return Err(format!(
            "Bundled OpenCode sidecar is unavailable; refusing to run OpenCode from PATH in release. Set {}=1 only for a developer override.\n\nNotes:\n{notes_text}",
            crate::supervised_process::ALLOW_EXTERNAL_RUNTIME_BINARIES_ENV
        ));
    }
    let Some(program) = program else {
        let notes_text = notes.join("\n");
        return Err(format!(
      "OpenCode CLI not found.\n\nInstall with:\n- brew install anomalyco/tap/opencode\n- curl -fsSL https://opencode.ai/install | bash\n\nNotes:\n{notes_text}"
    ));
    };

    let (sidecar_candidate, _sidecar_notes) = resolve_sidecar_candidate(
        prefer_sidecar,
        resource_dir.as_deref(),
        current_bin_dir.as_deref(),
    );
    let use_sidecar = prefer_sidecar
        && sidecar_candidate
            .as_ref()
            .is_some_and(|candidate| candidate == &program);

    if runtime == EngineRuntime::Orchestrator {
        drop(state);
        let data_dir = orchestrator::resolve_orchestrator_data_dir();
        // veslo-orchestrator doesn't start its daemon HTTP server until it has ensured that
        // OpenCode is available. On fresh installs (or after schema changes), OpenCode can run a
        // one-time SQLite migration that takes longer than a few seconds.
        //
        // If we give up too early, the desktop app reports the engine as offline even though the
        // orchestrator is still booting in the background.
        let health_timeout_ms = std::env::var("VESLO_ORCHESTRATOR_START_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|value| *value >= 1_000)
            .unwrap_or(180_000);
        let max_start_attempts = std::env::var("VESLO_ORCHESTRATOR_START_ATTEMPTS")
            .ok()
            .and_then(|value| value.trim().parse::<usize>().ok())
            .filter(|value| *value >= 1)
            .unwrap_or(2);
        let daemon_host = "127.0.0.1".to_string();
        let opencode_bin = program.to_string_lossy().to_string();
        let lifecycle_token = Uuid::new_v4().to_string();
        let veslo_client_token = current_or_new_veslo_client_token(&veslo_manager);
        let veslo_server_state_path = persisted_veslo_server_plugin_state_path(&app)
            .ok()
            .map(|path| path.to_string_lossy().to_string());
        let shared_unsandboxed_engine =
            crate::runtime_preferences::read_shared_unsandboxed_engine_override(&app)?;

        let mut health = None;
        for attempt in 1..=max_start_attempts {
            let daemon_port = find_free_port()?;
            let orchestrator_opencode_port = find_free_port()?;
            let spawn_options = OrchestratorSpawnOptions {
                data_dir: data_dir.clone(),
                daemon_host: daemon_host.clone(),
                daemon_port,
                opencode_bin: opencode_bin.clone(),
                opencode_host: bind_host.clone(),
                opencode_workdir: project_dir.clone(),
                opencode_port: Some(orchestrator_opencode_port),
                opencode_username: opencode_username.clone(),
                opencode_password: opencode_password.clone(),
                veslo_token: Some(veslo_client_token.clone()),
                lifecycle_token: Some(lifecycle_token.clone()),
                cors: Some("*".to_string()),
                veslo_server_state_path: veslo_server_state_path.clone(),
                max_engines,
                idle_suspend_ms,
                shared_unsandboxed_engine,
            };

            let (mut rx, child) = orchestrator::spawn_orchestrator_daemon(&app, &spawn_options)?;

            // Persist basic auth (and project dir) so relaunches can attach.
            let _ = orchestrator::write_orchestrator_auth(
                &data_dir,
                opencode_username.as_deref(),
                opencode_password.as_deref(),
                Some(lifecycle_token.as_str()),
                Some(project_dir.as_str()),
            );

            {
                let mut orchestrator_state = orchestrator_manager
                    .inner
                    .lock()
                    .map_err(|_| "orchestrator mutex poisoned".to_string())?;
                orchestrator_state.child = Some(child);
                orchestrator_state.child_exited = false;
                orchestrator_state.last_exit_code = None;
                orchestrator_state.data_dir = Some(data_dir.clone());
                orchestrator_state.last_stdout = None;
                orchestrator_state.last_stderr = None;
            }

            let orchestrator_state_handle = orchestrator_manager.inner.clone();
            let orchestrator_state_wait_handle = orchestrator_state_handle.clone();
            let orchestrator_forwarder = app
                .try_state::<std::sync::Arc<crate::debug_logs_forwarder::DebugLogsForwarder>>()
                .map(|s| s.inner().clone());
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line_bytes) => {
                            let line = String::from_utf8_lossy(&line_bytes).to_string();
                            if let Some(fwd) = orchestrator_forwarder.as_ref() {
                                fwd.append(
                                    "orchestrator",
                                    crate::debug_logs_forwarder::LogStream::Stdout,
                                    &line,
                                );
                            }
                            if let Ok(mut state) = orchestrator_state_handle.lock() {
                                let next =
                                    state.last_stdout.as_deref().unwrap_or_default().to_string()
                                        + &line;
                                state.last_stdout = Some(truncate_output(&next, 8000));
                            }
                        }
                        CommandEvent::Stderr(line_bytes) => {
                            let line = String::from_utf8_lossy(&line_bytes).to_string();
                            if let Some(fwd) = orchestrator_forwarder.as_ref() {
                                fwd.append(
                                    "orchestrator",
                                    crate::debug_logs_forwarder::LogStream::Stderr,
                                    &line,
                                );
                            }
                            if let Ok(mut state) = orchestrator_state_handle.lock() {
                                let next =
                                    state.last_stderr.as_deref().unwrap_or_default().to_string()
                                        + &line;
                                state.last_stderr = Some(truncate_output(&next, 8000));
                            }
                        }
                        CommandEvent::Terminated(payload) => {
                            if let Ok(mut state) = orchestrator_state_handle.lock() {
                                state.child_exited = true;
                                state.last_exit_code = payload.code;
                            }
                        }
                        CommandEvent::Error(message) => {
                            if let Some(fwd) = orchestrator_forwarder.as_ref() {
                                fwd.append(
                                    "orchestrator",
                                    crate::debug_logs_forwarder::LogStream::Stderr,
                                    &message,
                                );
                            }
                            if let Ok(mut state) = orchestrator_state_handle.lock() {
                                state.child_exited = true;
                                state.last_exit_code = Some(-1);
                                let next =
                                    state.last_stderr.as_deref().unwrap_or_default().to_string()
                                        + &message;
                                state.last_stderr = Some(truncate_output(&next, 8000));
                            }
                        }
                        _ => {}
                    }
                }
            });

            let daemon_base_url = format!("http://{}:{}", daemon_host, daemon_port);
            let wait_started_at = std::time::Instant::now();

            let health_result = loop {
                let health_error = match orchestrator::fetch_orchestrator_health(&daemon_base_url) {
                    Ok(health) if health.ok => break Ok(health),
                    Ok(_) => "Orchestrator reported unhealthy".to_string(),
                    Err(error) => error,
                };
                let elapsed_ms = wait_started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
                let (child_exited, exit_code, stderr) = orchestrator_state_wait_handle
                    .lock()
                    .map(|state| {
                        (
                            state.child_exited,
                            state.last_exit_code,
                            state.last_stderr.clone(),
                        )
                    })
                    .unwrap_or((false, None, None));

                if child_exited {
                    break Err(format_orchestrator_start_error(
                        elapsed_ms,
                        &health_error,
                        true,
                        exit_code,
                        stderr.as_deref(),
                    ));
                }

                if elapsed_ms >= health_timeout_ms {
                    break Err(format_orchestrator_start_error(
                        health_timeout_ms,
                        &health_error,
                        false,
                        None,
                        stderr.as_deref(),
                    ));
                }

                std::thread::sleep(std::time::Duration::from_millis(200));
            };

            match health_result {
                Ok(next_health) => {
                    crate::flow_log!(
                        "[veslo:flow] BOOT daemon-ready {{ port: {}, ms: {}, attempt: {} }}",
                        daemon_port,
                        wait_started_at.elapsed().as_millis(),
                        attempt
                    );
                    health = Some(next_health);
                    break;
                }
                Err(error) => {
                    let child_exited = orchestrator_manager
                        .inner
                        .lock()
                        .map(|state| state.child_exited)
                        .unwrap_or(false);

                    if should_retry_orchestrator_start(attempt, max_start_attempts, child_exited) {
                        if let Ok(mut orchestrator_state) = orchestrator_manager.inner.lock() {
                            OrchestratorManager::stop_locked(
                                &mut orchestrator_state,
                                OrchestratorShutdownAttribution::new(
                                    "engine_start_retry",
                                    "engine_start",
                                ),
                            );
                        }
                        continue;
                    }

                    return Err(error);
                }
            }
        }

        let health = health.ok_or_else(|| {
            "Failed to start orchestrator: retry loop exhausted without a successful health check."
                .to_string()
        })?;

        // VSLO-171 F2Ú3 removed the legacy singleton `opencode` field from
        // /health — in multi-mode the orchestrator spawns per-workspace engines
        // lazily through its proxy. Route via the daemon proxy URL when no
        // singleton is reported; fall back to the singleton path for backward
        // compatibility if `opencode` is still present.
        let daemon_reconciled = match reconcile_orchestrator_workspaces(&app, &orchestrator_manager)
        {
            Ok(count) => {
                if count > 0 {
                    eprintln!("[orchestrator] reconciled {count} workspace(s)");
                }
                Ok(count)
            }
            Err(error) => {
                eprintln!("[orchestrator] reconcile failed: {error}");
                Err(error)
            }
        };
        let reconciled_status = orchestrator::resolve_orchestrator_status(&data_dir, None);
        let daemon_port = health
            .daemon
            .as_ref()
            .map(|d| d.port)
            .unwrap_or_else(|| health.opencode.as_ref().map(|o| o.port).unwrap_or(0));
        let active_ws_id = resolve_orchestrator_proxy_workspace_id(
            &reconciled_status,
            &project_dir,
            health.active_id.as_deref(),
        );
        let opencode_port = health
            .opencode
            .as_ref()
            .map(|o| o.port)
            .unwrap_or(daemon_port);
        let opencode_pid = health.opencode.as_ref().map(|o| o.pid);
        let opencode_base_url =
            orchestrator_opencode_base_url(daemon_port, active_ws_id.as_deref());
        let active_engine = active_ws_id.as_ref().and_then(|workspace_id| {
            reconciled_status
                .engines
                .iter()
                .find(|engine| &engine.workspace_id == workspace_id)
        });
        let return_engine_state = if health.opencode.is_some() {
            RuntimeEngineState::Ready
        } else if topology_uses_shared_engine(reconciled_status.engine_topology.as_deref()) {
            runtime_engine_state_from_shared_engine(&reconciled_status)
        } else {
            runtime_engine_state_from_orchestrator_state(
                active_engine.map(|engine| engine.state.as_str()),
            )
        };
        let return_running = return_engine_state == RuntimeEngineState::Ready;
        if let Ok(mut state) = manager.inner.lock() {
            state.runtime = EngineRuntime::Orchestrator;
            state.child = None;
            state.child_exited = false;
            state.project_dir = Some(project_dir.clone());
            state.hostname = Some("127.0.0.1".to_string());
            state.port = Some(opencode_port);
            state.base_url = Some(opencode_base_url.clone());
            state.opencode_username = opencode_username.clone();
            state.opencode_password = opencode_password.clone();
            state.last_stdout = None;
            state.last_stderr = None;
        }

        let opencode_router_health_port = match resolve_opencode_router_health_port() {
            Ok(port) => Some(port),
            Err(error) => {
                if let Ok(mut state) = manager.inner.lock() {
                    state.last_stderr = Some(truncate_output(
                        &format!("OpenCodeRouter health port: {error}"),
                        8000,
                    ));
                }
                None
            }
        };

        let veslo_started_at = std::time::Instant::now();
        let orchestrator_daemon_url = format!("http://127.0.0.1:{daemon_port}");
        let veslo_started = start_veslo_server(
            &app,
            &veslo_manager,
            &workspace_paths,
            Some(&opencode_base_url),
            opencode_username.as_deref(),
            opencode_password.as_deref(),
            opencode_router_health_port,
            Some(orchestrator_daemon_url.as_str()),
            Some(lifecycle_token.as_str()),
            Some(veslo_client_token.as_str()),
        );
        match &veslo_started {
            Ok(_) => {
                let server_port = veslo_manager.inner.lock().ok().and_then(|s| s.port);
                let has_token = veslo_manager
                    .inner
                    .lock()
                    .ok()
                    .map(|s| s.host_token.as_ref().is_some_and(|t| !t.is_empty()))
                    .unwrap_or(false);
                crate::flow_log!(
                    "[veslo:flow] BOOT server-ready {{ port: {:?}, host_token_set: {}, ms: {} }}",
                    server_port,
                    has_token,
                    veslo_started_at.elapsed().as_millis()
                );
            }
            Err(error) => {
                crate::flow_log!(
                    "[veslo:flow] BOOT server-ready:FAIL {{ ms: {}, error: {error:?} }}",
                    veslo_started_at.elapsed().as_millis()
                );
                if let Ok(mut state) = manager.inner.lock() {
                    state.last_stderr =
                        Some(truncate_output(&format!("Veslo server: {error}"), 8000));
                }
            }
        }
        // Reconcile every engine_start call (not only on fresh spawn), because
        // start_veslo_server has an idempotent-reuse fast path that skips the
        // reconcile branch — sidebar clicks on workspaces added after the
        // initial boot would otherwise stay unknown to veslo-server.
        let server_reconciled = reconcile_server_workspaces(&app);
        if server_reconciled.accepted > 0 {
            eprintln!(
                "[veslo-server] reconciled {} workspace(s)",
                server_reconciled.accepted
            );
        }
        if server_reconciled.total_unsynced() > 0 {
            eprintln!(
                "[veslo-server] workspace_registry_unsynced: attempted={} accepted={} skipped={} failed={}",
                server_reconciled.attempted,
                server_reconciled.accepted,
                server_reconciled.skipped,
                server_reconciled.failed
            );
        }

        if let Err(error) = opencodeRouter_start(
            app.clone(),
            opencode_router_manager,
            project_dir.clone(),
            Some(opencode_base_url.clone()),
            opencode_username.clone(),
            opencode_password.clone(),
            opencode_router_health_port,
        ) {
            if let Ok(mut state) = manager.inner.lock() {
                state.last_stderr =
                    Some(truncate_output(&format!("OpenCodeRouter: {error}"), 8000));
            }
        }

        crate::flow_log!(
            "[veslo:flow] RECONCILE done {{ server: {}, daemon: {} }}",
            server_reconciled.accepted,
            match &daemon_reconciled {
                Ok(c) => format!("{c}"),
                Err(e) => format!("ERR({e:?})"),
            }
        );

        return Ok(EngineInfo {
            running: return_running,
            runtime: EngineRuntime::Orchestrator,
            engine_state: Some(return_engine_state),
            child_kind: active_engine.and_then(|engine| engine.child_kind.clone()),
            base_url: Some(opencode_base_url),
            project_dir: Some(project_dir),
            hostname: Some("127.0.0.1".to_string()),
            port: active_engine
                .map(|engine| engine.port)
                .or(Some(opencode_port)),
            opencode_username,
            opencode_password,
            pid: active_engine.map(|engine| engine.pid).or(opencode_pid),
            last_stdout: None,
            last_stderr: None,
        });
    }

    let veslo_client_token = current_or_new_veslo_client_token(&veslo_manager);
    let (mut rx, child) = spawn_engine(
        &app,
        &program,
        &bind_host,
        port,
        &project_dir,
        use_sidecar,
        opencode_username.as_deref(),
        opencode_password.as_deref(),
        Some(veslo_client_token.as_str()),
    )?;

    state.last_stdout = None;
    state.last_stderr = None;
    state.child_exited = false;

    let output_state = std::sync::Arc::new(std::sync::Mutex::new(OutputState::default()));
    let output_state_handle = output_state.clone();
    let state_handle = manager.inner.clone();
    let engine_forwarder = app
        .try_state::<std::sync::Arc<crate::debug_logs_forwarder::DebugLogsForwarder>>()
        .map(|s| s.inner().clone());

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    if let Some(fwd) = engine_forwarder.as_ref() {
                        fwd.append(
                            "engine",
                            crate::debug_logs_forwarder::LogStream::Stdout,
                            &line,
                        );
                    }
                    if let Ok(mut output) = output_state_handle.lock() {
                        output.stdout.push_str(&line);
                    }
                    if let Ok(mut state) = state_handle.try_lock() {
                        let next =
                            state.last_stdout.as_deref().unwrap_or_default().to_string() + &line;
                        state.last_stdout = Some(truncate_output(&next, 8000));
                    }
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    if let Some(fwd) = engine_forwarder.as_ref() {
                        fwd.append(
                            "engine",
                            crate::debug_logs_forwarder::LogStream::Stderr,
                            &line,
                        );
                    }
                    if let Ok(mut output) = output_state_handle.lock() {
                        output.stderr.push_str(&line);
                    }
                    if let Ok(mut state) = state_handle.try_lock() {
                        let next =
                            state.last_stderr.as_deref().unwrap_or_default().to_string() + &line;
                        state.last_stderr = Some(truncate_output(&next, 8000));
                    }
                }
                CommandEvent::Terminated(payload) => {
                    if let Ok(mut output) = output_state_handle.lock() {
                        output.exited = true;
                        output.exit_code = payload.code;
                    }
                    if let Ok(mut state) = state_handle.try_lock() {
                        state.child_exited = true;
                    }
                }
                CommandEvent::Error(message) => {
                    if let Some(fwd) = engine_forwarder.as_ref() {
                        fwd.append(
                            "engine",
                            crate::debug_logs_forwarder::LogStream::Stderr,
                            &message,
                        );
                    }
                    if let Ok(mut output) = output_state_handle.lock() {
                        output.exited = true;
                        output.exit_code = Some(-1);
                        output.stderr.push_str(&message);
                    }
                    if let Ok(mut state) = state_handle.try_lock() {
                        state.child_exited = true;
                    }
                }
                _ => {}
            }
        }
    });

    let warmup_deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if let Ok(output) = output_state.lock() {
            if output.exited {
                let stdout = output.stdout.trim().to_string();
                let stderr = output.stderr.trim().to_string();

                let stdout = if stdout.is_empty() {
                    None
                } else {
                    Some(truncate_output(&stdout, 8000))
                };
                let stderr = if stderr.is_empty() {
                    None
                } else {
                    Some(truncate_output(&stderr, 8000))
                };

                let mut parts = Vec::new();
                if let Some(stdout) = stdout {
                    parts.push(format!("stdout:\n{stdout}"));
                }
                if let Some(stderr) = stderr {
                    parts.push(format!("stderr:\n{stderr}"));
                }

                let suffix = if parts.is_empty() {
                    String::new()
                } else {
                    format!("\n\n{}", parts.join("\n\n"))
                };

                return Err(format!(
                    "OpenCode exited immediately with status {}.{}",
                    output.exit_code.unwrap_or(-1),
                    suffix
                ));
            }
        }

        if std::time::Instant::now() >= warmup_deadline {
            break;
        }

        std::thread::sleep(std::time::Duration::from_millis(150));
    }

    let opencode_base_url = format!("http://{client_host}:{port}");

    state.child = Some(child);
    state.project_dir = Some(project_dir.clone());
    state.hostname = Some(client_host.clone());
    state.port = Some(port);
    state.base_url = Some(opencode_base_url.clone());
    state.opencode_username = opencode_username.clone();
    state.opencode_password = opencode_password.clone();

    let opencode_router_health_port = match resolve_opencode_router_health_port() {
        Ok(port) => Some(port),
        Err(error) => {
            state.last_stderr = Some(truncate_output(
                &format!("OpenCodeRouter health port: {error}"),
                8000,
            ));
            None
        }
    };

    if let Err(error) = start_veslo_server(
        &app,
        &veslo_manager,
        &workspace_paths,
        Some(&opencode_base_url),
        opencode_username.as_deref(),
        opencode_password.as_deref(),
        opencode_router_health_port,
        None,
        None,
        Some(veslo_client_token.as_str()),
    ) {
        state.last_stderr = Some(truncate_output(&format!("Veslo server: {error}"), 8000));
    }

    if let Err(error) = opencodeRouter_start(
        app.clone(),
        opencode_router_manager,
        project_dir.clone(),
        Some(opencode_base_url.clone()),
        opencode_username,
        opencode_password,
        opencode_router_health_port,
    ) {
        state.last_stderr = Some(truncate_output(&format!("OpenCodeRouter: {error}"), 8000));
    }

    Ok(EngineManager::snapshot_locked(&mut state))
}

#[cfg(test)]
mod tests {
    use super::{
        current_or_new_veslo_client_token, dev_autostart_disabled_from_env,
        format_orchestrator_start_error, orchestrator_opencode_base_url,
        resolve_opencode_bind_host_from_env, resolve_orchestrator_proxy_workspace_id,
        should_retry_orchestrator_start, try_reserve_dev_autostart,
        workspace_runtime_prepare_action, WorkspaceRuntimePrepareAction,
    };
    use crate::engine::manager::EngineManager;
    use crate::types::{
        EngineRuntime, OrchestratorSharedEngineSnapshot, OrchestratorStatus, OrchestratorWorkspace,
        RuntimeEngineState,
    };
    use crate::veslo_server::manager::VesloServerManager;

    fn orchestrator_workspace(id: &str, path: &str) -> OrchestratorWorkspace {
        OrchestratorWorkspace {
            id: id.to_string(),
            name: id.to_string(),
            path: path.to_string(),
            workspace_type: "local".to_string(),
            server_workspace_id: None,
            app_workspace_id: None,
            derived_local_workspace_id: None,
            legacy_workspace_ids: Vec::new(),
            base_url: None,
            directory: None,
            created_at: None,
            last_used_at: None,
        }
    }

    fn orchestrator_status(
        active_id: Option<&str>,
        workspaces: Vec<OrchestratorWorkspace>,
    ) -> OrchestratorStatus {
        OrchestratorStatus {
            running: true,
            data_dir: "/tmp/veslo-orchestrator".to_string(),
            daemon: None,
            opencode: None,
            engine_topology: None,
            cli_version: None,
            sidecar: None,
            binaries: None,
            active_id: active_id.map(ToOwned::to_owned),
            workspace_count: workspaces.len(),
            workspaces,
            engines: Vec::new(),
            shared_engine: None,
            last_error: None,
        }
    }

    #[test]
    fn current_or_new_veslo_client_token_persists_the_first_generated_token() {
        let manager = VesloServerManager::default();

        let first = current_or_new_veslo_client_token(&manager);
        let second = current_or_new_veslo_client_token(&manager);

        assert_eq!(first, second);
        assert_eq!(
            manager
                .inner
                .lock()
                .expect("manager state")
                .client_token
                .as_deref(),
            Some(first.as_str())
        );
    }

    #[test]
    fn local_sidecars_use_loopback_opencode_url() {
        let source = include_str!("engine.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("production source");

        assert!(source.contains("Some(&opencode_base_url)"));
        assert!(source.contains("Some(opencode_base_url.clone())"));
        assert!(!source.contains("Some(&opencode_connect_url)"));
        assert!(!source.contains("Some(opencode_connect_url)"));
    }

    #[test]
    fn opencode_bind_host_defaults_to_loopback() {
        assert_eq!(resolve_opencode_bind_host_from_env(None), "127.0.0.1");
        assert_eq!(resolve_opencode_bind_host_from_env(Some(" ")), "127.0.0.1");
        assert_eq!(
            resolve_opencode_bind_host_from_env(Some("0.0.0.0")),
            "0.0.0.0"
        );
    }

    #[test]
    fn dev_autostart_disable_env_accepts_truthy_values() {
        assert!(!dev_autostart_disabled_from_env(None));
        assert!(!dev_autostart_disabled_from_env(Some("")));
        assert!(!dev_autostart_disabled_from_env(Some("0")));
        assert!(!dev_autostart_disabled_from_env(Some("false")));
        assert!(dev_autostart_disabled_from_env(Some("1")));
        assert!(dev_autostart_disabled_from_env(Some(" TRUE ")));
        assert!(dev_autostart_disabled_from_env(Some("yes")));
        assert!(dev_autostart_disabled_from_env(Some("on")));
    }

    #[test]
    fn dev_autostart_does_not_race_an_explicit_engine_start() {
        let manager = EngineManager::default();
        let explicit_start = manager
            .start_queue
            .lock()
            .expect("engine start queue mutex poisoned");

        assert!(try_reserve_dev_autostart(&manager).is_none());
        drop(explicit_start);

        assert!(try_reserve_dev_autostart(&manager).is_some());
        manager
            .inner
            .lock()
            .expect("engine mutex poisoned")
            .base_url = Some("http://127.0.0.1:12345".to_string());
        assert!(try_reserve_dev_autostart(&manager).is_none());
    }

    #[test]
    fn engine_info_maps_pooled_orchestrator_states_to_runtime_engine_state() {
        assert_eq!(
            super::runtime_engine_state_from_orchestrator_state(Some("spawning")),
            RuntimeEngineState::Starting,
        );
        assert_eq!(
            super::runtime_engine_state_from_orchestrator_state(Some("ready")),
            RuntimeEngineState::Ready,
        );
        assert_eq!(
            super::runtime_engine_state_from_orchestrator_state(Some("idle")),
            RuntimeEngineState::Ready,
        );
        assert_eq!(
            super::runtime_engine_state_from_orchestrator_state(Some("suspended")),
            RuntimeEngineState::Stopped,
        );
        assert_eq!(
            super::runtime_engine_state_from_orchestrator_state(Some("crashed")),
            RuntimeEngineState::Failed,
        );
        assert_eq!(
            super::runtime_engine_state_from_orchestrator_state(None),
            RuntimeEngineState::Absent,
        );
    }

    #[test]
    fn engine_info_maps_shared_pending_snapshot_to_starting() {
        let mut status = orchestrator_status(None, Vec::new());
        status.engine_topology = Some("shared-unsandboxed".to_string());
        status.shared_engine = Some(OrchestratorSharedEngineSnapshot {
            mode: "shared-unsandboxed".to_string(),
            running: false,
            pending: true,
            engine_state: Some("starting".to_string()),
            state: Some("spawning".to_string()),
            base_url: Some("http://127.0.0.1:61234".to_string()),
            pid: Some(1234),
            port: Some(61234),
            child_kind: Some("direct".to_string()),
            started_at: Some("2026-07-04T00:00:00.000Z".to_string()),
            runtime_directory: "/tmp/shared-runtime".to_string(),
            config_directory: "/tmp/shared-config".to_string(),
        });

        assert_eq!(
            super::runtime_engine_state_from_shared_engine(&status),
            RuntimeEngineState::Starting,
        );
    }

    #[test]
    fn shared_directory_scoped_topology_uses_the_shared_engine_snapshot() {
        assert!(super::topology_uses_shared_engine(Some(
            "shared-unsandboxed"
        )));
        assert!(super::topology_uses_shared_engine(Some(
            "shared-directory-scoped"
        )));
        assert!(!super::topology_uses_shared_engine(Some(
            "pooled-per-workspace"
        )));
    }

    #[test]
    fn formats_orchestrator_timeout_with_captured_stderr() {
        let message = format_orchestrator_start_error(
            180_000,
            "Failed to fetch http://127.0.0.1:59024/health: Connection refused",
            false,
            None,
            Some("[opencode] wrong platform binary"),
        );

        assert!(message.contains("Failed to start orchestrator (waited 180000ms)"));
        assert!(message.contains("Connection refused"));
        assert!(message.contains("stderr:\n[opencode] wrong platform binary"));
    }

    #[test]
    fn formats_orchestrator_early_exit_without_timeout_label() {
        let message = format_orchestrator_start_error(
            2_300,
            "Failed to fetch http://127.0.0.1:59024/health: Connection refused",
            true,
            Some(1),
            Some("[opencode] wrong platform binary"),
        );

        assert!(message
            .contains("Failed to start orchestrator: process exited before health became ready."));
        assert!(message.contains("Connection refused"));
        assert!(message.contains("exit code: 1"));
        assert!(!message.contains("waited 2300ms"));
    }

    #[test]
    fn retries_orchestrator_start_only_for_nonfinal_early_exit_attempts() {
        assert!(should_retry_orchestrator_start(1, 2, true));
        assert!(!should_retry_orchestrator_start(2, 2, true));
        assert!(!should_retry_orchestrator_start(1, 2, false));
        assert!(!should_retry_orchestrator_start(1, 1, true));
    }

    #[test]
    fn workspace_runtime_prepare_keeps_process_lifecycle_decisions_backend_owned() {
        assert_eq!(
            workspace_runtime_prepare_action(&EngineRuntime::Direct, "browse-attach-direct", false),
            WorkspaceRuntimePrepareAction::FreshStart,
        );
        assert_eq!(
            workspace_runtime_prepare_action(
                &EngineRuntime::Orchestrator,
                "browse-attach-orchestrator",
                false,
            ),
            WorkspaceRuntimePrepareAction::OrchestratorActivate,
        );
        assert_eq!(
            workspace_runtime_prepare_action(
                &EngineRuntime::Orchestrator,
                "sendPrompt-runtime-recovery",
                false,
            ),
            WorkspaceRuntimePrepareAction::FreshStart,
        );
        assert_eq!(
            workspace_runtime_prepare_action(
                &EngineRuntime::Orchestrator,
                "workspace-orchestrator-switch",
                true,
            ),
            WorkspaceRuntimePrepareAction::FreshStart,
        );
    }

    #[test]
    fn orchestrator_proxy_url_uses_project_workspace_when_health_active_id_is_empty() {
        let status = orchestrator_status(
            Some(""),
            vec![orchestrator_workspace(
                "ws-project",
                "C:\\work\\project-beta-legal",
            )],
        );

        let workspace_id = resolve_orchestrator_proxy_workspace_id(
            &status,
            "C:/work/project-beta-legal/",
            Some(""),
        );
        let base_url = orchestrator_opencode_base_url(59104, workspace_id.as_deref());

        assert_eq!(
            workspace_id.as_deref(),
            Some("ws-project"),
            "project path should win over an empty /health activeId"
        );
        assert_eq!(
            base_url,
            "http://127.0.0.1:59104/workspace/ws-project/opencode"
        );
        assert!(!base_url.contains("/workspace//opencode"));
    }

    #[test]
    fn orchestrator_proxy_url_falls_back_to_daemon_root_without_workspace_id() {
        let base_url = orchestrator_opencode_base_url(59104, Some(" "));

        assert_eq!(base_url, "http://127.0.0.1:59104");
        assert!(!base_url.contains("/workspace//opencode"));
    }
}
