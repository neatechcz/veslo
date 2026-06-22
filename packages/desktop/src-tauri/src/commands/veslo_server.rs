use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

use crate::engine::manager::EngineManager;
use crate::opencode_router::manager::OpenCodeRouterManager;
use crate::orchestrator::{self, read_orchestrator_auth};
use crate::types::{VesloServerInfo, WorkspaceState, WorkspaceType};
use crate::utils::truncate_output;
use crate::veslo_server::manager::{VesloServerManager, VesloServerState};
use crate::veslo_server::{
    clear_persisted_veslo_server_info, recover_persisted_veslo_server_info, server_health_identity,
    start_veslo_server, HealthIdentity,
};
use crate::workspace::state::load_workspace_state;

const ENGINE_URL_REFRESH_TTL: Duration = Duration::from_secs(120);
const ENGINE_URL_REFRESH_LOCK_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct EngineUrlRefreshLease {
    generation: u64,
    port: u16,
    host: Option<String>,
}

fn active_local_workspace_path(state: &WorkspaceState) -> Option<String> {
    state
        .workspaces
        .iter()
        .find(|workspace| {
            workspace.id == state.active_id && workspace.workspace_type == WorkspaceType::Local
        })
        .and_then(|workspace| {
            let path = workspace.path.trim();
            if path.is_empty() {
                None
            } else {
                Some(path.to_string())
            }
        })
}

fn push_unique_workspace_path(paths: &mut Vec<String>, path: &str) {
    let trimmed = path.trim();
    if trimmed.is_empty() || paths.iter().any(|entry| entry == trimmed) {
        return;
    }
    paths.push(trimmed.to_string());
}

fn local_workspace_paths_for_server_restart(
    state: &WorkspaceState,
    engine_workspace_path: Option<&str>,
) -> Vec<String> {
    let mut paths = Vec::new();

    if let Some(path) = engine_workspace_path {
        push_unique_workspace_path(&mut paths, path);
    }

    if paths.is_empty() {
        if let Some(path) = active_local_workspace_path(state) {
            push_unique_workspace_path(&mut paths, &path);
        }
    }

    for workspace in &state.workspaces {
        if workspace.workspace_type == WorkspaceType::Local {
            push_unique_workspace_path(&mut paths, &workspace.path);
        }
    }

    paths
}

fn sanitize_live_info_with_health(
    mut info: VesloServerInfo,
    health_check: impl Fn(&str) -> Option<HealthIdentity>,
) -> (VesloServerInfo, bool) {
    if !info.running {
        return (info, false);
    }

    let base_url = info.base_url.clone().unwrap_or_default();
    if base_url.trim().is_empty() {
        return (info, false);
    }

    let Some(identity) = health_check(&base_url) else {
        // For the managed child, this command reports process ownership. HTTP
        // health is polled separately by the frontend; using it here turns one
        // transient probe failure into a lost token/PID snapshot and can trigger
        // a restart loop for an otherwise live sidecar.
        return (info, false);
    };

    let token_verified = matches!(
        (info.client_token.as_deref(), identity.token.as_deref()),
        (Some(a), Some(b)) if a == b
    );
    let token_mismatch = matches!(
        (info.client_token.as_deref(), identity.token.as_deref()),
        (Some(a), Some(b)) if a != b
    );
    // A matching bearer token is stronger than the PID. In dev-watch mode the
    // managed child can be the Bun watcher while /health is served by its
    // worker process, so the PID can differ for a valid server.
    let pid_mismatch =
        !token_verified && matches!((info.pid, identity.pid), (Some(a), Some(b)) if a != b);
    if !(token_mismatch || pid_mismatch) {
        return (info, false);
    }

    info.running = false;
    info.base_url = None;
    info.connect_url = None;
    info.mdns_url = None;
    info.lan_url = None;
    info.client_token = None;
    info.host_token = None;
    info.engine_url = None;
    info.pid = None;
    info.last_stderr = Some(truncate_output(
        "Veslo server identity does not match persisted state.",
        8000,
    ));

    (info, true)
}

fn elapsed_since(now: Instant, then: Instant) -> Duration {
    now.checked_duration_since(then)
        .unwrap_or_else(|| Duration::from_secs(0))
}

fn normalize_engine_url(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
}

fn begin_engine_url_refresh_if_due(
    state: &mut VesloServerState,
    info: &VesloServerInfo,
    now: Instant,
    ttl: Duration,
    lock_timeout: Duration,
) -> Option<EngineUrlRefreshLease> {
    if !info.running {
        return None;
    }
    if !crate::veslo_server::publishes_external_urls(info.host.as_deref()) {
        return None;
    }

    let port = info.port?;

    if let Some(started_at) = state.engine_url_refresh_started_at {
        if elapsed_since(now, started_at) < lock_timeout {
            return None;
        }
    }

    if let Some(checked_at) = state.engine_url_checked_at {
        if elapsed_since(now, checked_at) < ttl {
            return None;
        }
    }

    state.engine_url_refresh_generation = state.engine_url_refresh_generation.wrapping_add(1);
    state.engine_url_refresh_started_at = Some(now);
    Some(EngineUrlRefreshLease {
        generation: state.engine_url_refresh_generation,
        port,
        host: info.host.clone(),
    })
}

fn finish_engine_url_refresh(
    state: &mut VesloServerState,
    lease: EngineUrlRefreshLease,
    checked_at: Instant,
    refreshed: Option<String>,
) {
    if state.engine_url_refresh_generation != lease.generation {
        return;
    }

    state.engine_url_refresh_started_at = None;
    state.engine_url_checked_at = Some(checked_at);

    if let Some(url) = normalize_engine_url(refreshed) {
        state.engine_url = Some(url);
    }
}

#[tauri::command]
pub fn veslo_server_info(app: AppHandle, manager: State<VesloServerManager>) -> VesloServerInfo {
    let (running_snapshot, engine_url_refresh) = {
        let mut state = manager.inner.lock().expect("veslo server mutex poisoned");
        let info = VesloServerManager::snapshot_locked(&mut state);
        let (sanitized, stale) = sanitize_live_info_with_health(info, server_health_identity);
        if sanitized.running {
            let refresh = begin_engine_url_refresh_if_due(
                &mut state,
                &sanitized,
                Instant::now(),
                ENGINE_URL_REFRESH_TTL,
                ENGINE_URL_REFRESH_LOCK_TIMEOUT,
            );
            (Some(sanitized), refresh)
        } else {
            if stale {
                let _ = clear_persisted_veslo_server_info(&app);
                return sanitized;
            }
            (None, None)
        }
    };

    if let Some(mut sanitized) = running_snapshot {
        if let Some(lease) = engine_url_refresh {
            let refreshed = crate::veslo_server::resolve_engine_url_for_bind_host(
                lease.host.as_deref(),
                Some(lease.port),
            );
            let mut state = manager.inner.lock().expect("veslo server mutex poisoned");
            let live = VesloServerManager::snapshot_locked(&mut state);
            if state.engine_url_refresh_generation == lease.generation {
                if live.running && live.port == Some(lease.port) && live.host == lease.host {
                    finish_engine_url_refresh(&mut state, lease, Instant::now(), refreshed);
                    sanitized = VesloServerManager::snapshot_locked(&mut state);
                } else {
                    state.engine_url_refresh_started_at = None;
                    state.engine_url_checked_at = Some(Instant::now());
                }
            }
        }
        return sanitized;
    }

    match recover_persisted_veslo_server_info(&app) {
        Ok(Some(info)) => info,
        Ok(None) | Err(_) => {
            let mut state = manager.inner.lock().expect("veslo server mutex poisoned");
            VesloServerManager::snapshot_locked(&mut state)
        }
    }
}

#[tauri::command]
pub fn veslo_server_restart(
    app: AppHandle,
    manager: State<VesloServerManager>,
    engine_manager: State<EngineManager>,
    opencode_router_manager: State<OpenCodeRouterManager>,
) -> Result<VesloServerInfo, String> {
    let (
        engine_workspace_path,
        engine_opencode_url,
        engine_opencode_username,
        engine_opencode_password,
    ) = {
        let engine = engine_manager
            .inner
            .lock()
            .map_err(|_| "engine mutex poisoned".to_string())?;
        (
            engine.project_dir.clone(),
            engine.base_url.clone(),
            engine.opencode_username.clone(),
            engine.opencode_password.clone(),
        )
    };

    let engine_workspace_path = engine_workspace_path
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());
    let workspace_state = load_workspace_state(&app)?;
    let workspace_paths = local_workspace_paths_for_server_restart(
        &workspace_state,
        engine_workspace_path.as_deref(),
    );

    let engine_attached = engine_opencode_url
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    let opencode_url = if engine_attached {
        engine_opencode_url
    } else {
        None
    };
    let opencode_username = if engine_attached {
        engine_opencode_username
    } else {
        None
    };
    let opencode_password = if engine_attached {
        engine_opencode_password
    } else {
        None
    };

    let opencode_router_health_port = opencode_router_manager
        .inner
        .lock()
        .ok()
        .and_then(|state| state.health_port);
    let lifecycle_config = opencode_url.as_deref().and_then(|url| {
        let trimmed = url.trim();
        let prefix = trimmed.find("/workspace/")?;
        let daemon_url = trimmed[..prefix].trim_end_matches('/').to_string();
        let auth = read_orchestrator_auth(&orchestrator::resolve_orchestrator_data_dir())?;
        let token = auth
            .lifecycle_token
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())?;
        Some((daemon_url, token))
    });

    start_veslo_server(
        &app,
        &manager,
        &workspace_paths,
        opencode_url.as_deref(),
        opencode_username.as_deref(),
        opencode_password.as_deref(),
        opencode_router_health_port,
        lifecycle_config.as_ref().map(|(url, _)| url.as_str()),
        lifecycle_config.as_ref().map(|(_, token)| token.as_str()),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        active_local_workspace_path, begin_engine_url_refresh_if_due, finish_engine_url_refresh,
        local_workspace_paths_for_server_restart, sanitize_live_info_with_health,
        EngineUrlRefreshLease, HealthIdentity,
    };
    use crate::types::{
        RemoteType, VesloServerInfo, WorkspaceInfo, WorkspaceState, WorkspaceType,
        WORKSPACE_STATE_VERSION,
    };
    use crate::veslo_server::manager::VesloServerState;
    use std::time::{Duration, Instant};

    fn workspace(id: &str, path: &str, workspace_type: WorkspaceType) -> WorkspaceInfo {
        WorkspaceInfo {
            id: id.to_string(),
            name: id.to_string(),
            path: path.to_string(),
            preset: "starter".to_string(),
            workspace_type,
            remote_type: Some(RemoteType::Opencode),
            base_url: None,
            directory: None,
            display_name: None,
            veslo_host_url: None,
            veslo_token: None,
            veslo_workspace_id: None,
            veslo_workspace_name: None,
        }
    }

    #[test]
    fn active_local_workspace_path_selects_active_local_workspace() {
        let state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: "ws-local".to_string(),
            workspaces: vec![
                workspace("ws-remote", "https://example.test", WorkspaceType::Remote),
                workspace("ws-local", "C:\\workspaces\\private", WorkspaceType::Local),
            ],
        };

        assert_eq!(
            active_local_workspace_path(&state).as_deref(),
            Some("C:\\workspaces\\private")
        );
    }

    #[test]
    fn local_workspace_paths_for_server_restart_keeps_active_workspace_first() {
        let state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: "ws-b".to_string(),
            workspaces: vec![
                workspace("ws-a", "/workspace-a", WorkspaceType::Local),
                workspace("ws-b", "/workspace-b", WorkspaceType::Local),
                workspace(
                    "ws-remote",
                    "https://example.invalid",
                    WorkspaceType::Remote,
                ),
            ],
        };

        assert_eq!(
            local_workspace_paths_for_server_restart(&state, None),
            vec!["/workspace-b".to_string(), "/workspace-a".to_string()],
        );
    }

    #[test]
    fn local_workspace_paths_for_server_restart_keeps_attached_engine_path_first() {
        let state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: "ws-a".to_string(),
            workspaces: vec![
                workspace("ws-a", "/workspace-a", WorkspaceType::Local),
                workspace("ws-b", "/workspace-b", WorkspaceType::Local),
            ],
        };

        assert_eq!(
            local_workspace_paths_for_server_restart(&state, Some("/workspace-b")),
            vec!["/workspace-b".to_string(), "/workspace-a".to_string()],
        );
    }

    #[test]
    fn local_workspace_paths_for_server_restart_allows_fresh_profile() {
        let state = WorkspaceState {
            version: WORKSPACE_STATE_VERSION,
            active_id: String::new(),
            workspaces: Vec::new(),
        };

        assert_eq!(
            local_workspace_paths_for_server_restart(&state, None),
            Vec::<String>::new()
        );
    }

    fn sample_live_info() -> VesloServerInfo {
        VesloServerInfo {
            running: true,
            host: Some("0.0.0.0".to_string()),
            port: Some(8787),
            base_url: Some("http://127.0.0.1:8787".to_string()),
            connect_url: Some("http://192.168.0.10:8787".to_string()),
            mdns_url: Some("http://veslo.local:8787".to_string()),
            lan_url: Some("http://192.168.0.10:8787".to_string()),
            engine_url: Some("http://172.21.0.1:8787".to_string()),
            client_token: Some("client-token".to_string()),
            host_token: Some("host-token".to_string()),
            pid: Some(12345),
            last_stdout: None,
            last_stderr: None,
        }
    }

    fn sample_engine_url_state(
        info: &VesloServerInfo,
        checked_at: Option<Instant>,
    ) -> VesloServerState {
        VesloServerState {
            host: info.host.clone(),
            port: info.port,
            engine_url: info.engine_url.clone(),
            engine_url_checked_at: checked_at,
            ..Default::default()
        }
    }

    #[test]
    fn engine_url_refresh_waits_until_ttl_expires() {
        let info = sample_live_info();
        let now = Instant::now();
        let ttl = Duration::from_secs(120);
        let lock_timeout = Duration::from_secs(30);
        let mut state = sample_engine_url_state(&info, Some(now - Duration::from_secs(119)));

        assert_eq!(
            begin_engine_url_refresh_if_due(&mut state, &info, now, ttl, lock_timeout),
            None
        );

        state.engine_url_checked_at = Some(now - Duration::from_secs(120));
        let lease = begin_engine_url_refresh_if_due(&mut state, &info, now, ttl, lock_timeout)
            .expect("expired ttl should start a refresh");
        assert_eq!(lease.port, 8787);
        assert_eq!(lease.host.as_deref(), Some("0.0.0.0"));
        assert_eq!(state.engine_url_refresh_started_at, Some(now));
    }

    #[test]
    fn engine_url_refresh_skips_loopback_server() {
        let mut info = sample_live_info();
        info.host = Some("127.0.0.1".to_string());
        let now = Instant::now();
        let mut state = sample_engine_url_state(&info, Some(now - Duration::from_secs(120)));

        assert_eq!(
            begin_engine_url_refresh_if_due(
                &mut state,
                &info,
                now,
                Duration::from_secs(120),
                Duration::from_secs(30),
            ),
            None
        );
    }

    #[test]
    fn engine_url_refresh_throttles_recent_failed_probe() {
        let mut info = sample_live_info();
        info.engine_url = None;
        let now = Instant::now();
        let mut state = sample_engine_url_state(&info, Some(now - Duration::from_secs(30)));

        assert_eq!(
            begin_engine_url_refresh_if_due(
                &mut state,
                &info,
                now,
                Duration::from_secs(120),
                Duration::from_secs(30),
            ),
            None,
            "a missing engineUrl should still respect the last checked timestamp"
        );
    }

    #[test]
    fn engine_url_refresh_lock_is_single_flight_but_expires() {
        let info = sample_live_info();
        let now = Instant::now();
        let mut state = sample_engine_url_state(&info, Some(now - Duration::from_secs(121)));
        state.engine_url_refresh_generation = 41;
        state.engine_url_refresh_started_at = Some(now - Duration::from_secs(29));

        assert_eq!(
            begin_engine_url_refresh_if_due(
                &mut state,
                &info,
                now,
                Duration::from_secs(120),
                Duration::from_secs(30),
            ),
            None,
            "an active refresh inside the lock timeout should suppress duplicate probes"
        );

        state.engine_url_refresh_started_at = Some(now - Duration::from_secs(30));
        let lease = begin_engine_url_refresh_if_due(
            &mut state,
            &info,
            now,
            Duration::from_secs(120),
            Duration::from_secs(30),
        )
        .expect("an expired refresh lease should allow a new probe");
        assert_eq!(
            lease,
            EngineUrlRefreshLease {
                generation: 42,
                port: 8787,
                host: Some("0.0.0.0".to_string()),
            }
        );
    }

    #[test]
    fn finish_engine_url_refresh_preserves_old_url_on_failure() {
        let info = sample_live_info();
        let now = Instant::now();
        let mut state = sample_engine_url_state(&info, Some(now - Duration::from_secs(121)));
        state.engine_url_refresh_generation = 7;
        state.engine_url_refresh_started_at = Some(now - Duration::from_secs(1));

        finish_engine_url_refresh(
            &mut state,
            EngineUrlRefreshLease {
                generation: 7,
                port: 8787,
                host: Some("0.0.0.0".to_string()),
            },
            now,
            None,
        );

        assert_eq!(state.engine_url.as_deref(), Some("http://172.21.0.1:8787"));
        assert_eq!(state.engine_url_checked_at, Some(now));
        assert_eq!(state.engine_url_refresh_started_at, None);
    }

    #[test]
    fn finish_engine_url_refresh_ignores_stale_generation() {
        let info = sample_live_info();
        let now = Instant::now();
        let mut state = sample_engine_url_state(&info, Some(now - Duration::from_secs(121)));
        state.engine_url_refresh_generation = 8;
        state.engine_url_refresh_started_at = Some(now - Duration::from_secs(1));

        finish_engine_url_refresh(
            &mut state,
            EngineUrlRefreshLease {
                generation: 7,
                port: 8787,
                host: Some("0.0.0.0".to_string()),
            },
            now,
            Some("http://172.30.64.1:8787/".to_string()),
        );

        assert_eq!(state.engine_url.as_deref(), Some("http://172.21.0.1:8787"));
        assert_ne!(state.engine_url_checked_at, Some(now));
        assert!(state.engine_url_refresh_started_at.is_some());
    }

    #[test]
    fn sanitize_live_info_with_health_keeps_a_live_server_snapshot() {
        let info = sample_live_info();
        let (sanitized, stale) = sanitize_live_info_with_health(info.clone(), |_| {
            Some(HealthIdentity {
                token: info.client_token.clone(),
                pid: info.pid,
            })
        });
        assert!(!stale);
        assert!(sanitized.running);
        assert_eq!(sanitized.base_url, info.base_url);
        assert_eq!(sanitized.client_token, info.client_token);
    }

    #[test]
    fn sanitize_live_info_with_health_preserves_live_child_when_health_fails() {
        let info = sample_live_info();
        let (sanitized, stale) = sanitize_live_info_with_health(info.clone(), |_| None);
        assert!(!stale);
        assert!(sanitized.running);
        assert_eq!(sanitized.base_url, info.base_url);
        assert_eq!(sanitized.connect_url, info.connect_url);
        assert_eq!(sanitized.mdns_url, info.mdns_url);
        assert_eq!(sanitized.lan_url, info.lan_url);
        assert_eq!(sanitized.client_token, info.client_token);
        assert_eq!(sanitized.host_token, info.host_token);
        assert_eq!(sanitized.pid, info.pid);
    }

    #[test]
    fn sanitize_live_info_marks_stale_when_token_does_not_match() {
        let info = sample_live_info();
        let (sanitized, stale) = sanitize_live_info_with_health(info, |_| {
            Some(HealthIdentity {
                token: Some("foreign-token".to_string()),
                pid: Some(12345),
            })
        });
        assert!(stale);
        assert!(!sanitized.running);
        assert_eq!(sanitized.client_token, None);
    }

    #[test]
    fn sanitize_live_info_tolerates_pid_mismatch_when_token_matches() {
        let info = sample_live_info();
        let (sanitized, stale) = sanitize_live_info_with_health(info.clone(), |_| {
            Some(HealthIdentity {
                token: info.client_token.clone(),
                pid: Some(99999),
            })
        });
        assert!(!stale);
        assert!(sanitized.running);
        assert_eq!(sanitized.client_token, info.client_token);
    }

    #[test]
    fn sanitize_live_info_marks_stale_when_pid_mismatch_without_token_match() {
        let info = sample_live_info();
        let (sanitized, stale) = sanitize_live_info_with_health(info, |_| {
            Some(HealthIdentity {
                token: None,
                pid: Some(99999),
            })
        });
        assert!(stale);
        assert!(!sanitized.running);
    }

    #[test]
    fn sanitize_live_info_tolerates_legacy_server_without_identity_fields() {
        let info = sample_live_info();
        let (sanitized, stale) =
            sanitize_live_info_with_health(info.clone(), |_| Some(HealthIdentity::default()));
        assert!(!stale);
        assert!(sanitized.running);
        assert_eq!(sanitized.client_token, info.client_token);
    }
}
