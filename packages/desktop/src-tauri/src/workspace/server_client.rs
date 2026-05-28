// Best-effort HTTP klient pro Veslo server workspace CRUD endpointy.
//
// Tauri komandy si Veslo state nadále drží lokálně (`veslo-workspaces.json`),
// ale po každé mutaci se výsledek "fire-and-forget" propíše na server přes
// tyto wrappery. Tím se postupně synchronizuje budoucí single-source-of-truth
// (server.json) bez přerušení existujícího flow.
//
// Server NEMUSÍ běžet — když nemáme base URL nebo host token, mutace se tiše
// přeskočí. Jakýkoli HTTP error se jen loguje, nikdy se nepropaguje do UI:
// lokální state už byl uložen, takže pro uživatele operace prošla.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::veslo_server::manager::VesloServerManager;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const BODY_EXCERPT_LIMIT: usize = 500;

fn collect_server_state(app: &AppHandle) -> Option<(String, String)> {
    let manager = app.try_state::<VesloServerManager>()?;
    let state = manager.inner.lock().ok()?;
    let base_url = state.base_url.clone()?;
    let host_token = state.host_token.clone()?;
    if base_url.trim().is_empty() || host_token.trim().is_empty() {
        return None;
    }
    Some((base_url, host_token))
}

fn build_agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(REQUEST_TIMEOUT).build()
}

/// `POST /workspaces/local` — register a new local workspace on the server.
/// Returns silently on duplicate (409) — that's expected when the same path
/// has already been registered (migration replays etc.).
pub fn post_local_workspace(app: &AppHandle, path: &str, name: &str) {
    let Some((base_url, host_token)) = collect_server_state(app) else {
        return;
    };
    let url = format!("{}/workspaces/local", base_url.trim_end_matches('/'));
    let payload = serde_json::json!({ "path": path, "name": name });

    crate::flow_log!("[veslo:http] OUT POST {url} (workspace.local) path={path:?}");
    let started = Instant::now();
    let result = build_agent()
        .post(&url)
        .set("Content-Type", "application/json")
        .set("x-veslo-host-token", &host_token)
        .send_string(&payload.to_string());

    match result {
        Ok(response) => {
            crate::flow_log!(
                "[veslo:http] IN  {} ({}ms) {url} (workspace.local)",
                response.status(),
                started.elapsed().as_millis()
            );
        }
        Err(ureq::Error::Status(409, _)) => {
            crate::flow_log!(
                "[veslo:http] IN  409 ({}ms) {url} (workspace.local) already-registered",
                started.elapsed().as_millis()
            );
        }
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            let excerpt: String = body.chars().take(BODY_EXCERPT_LIMIT).collect();
            crate::flow_log!(
                "[veslo:http] IN  {code} ({}ms) {url} (workspace.local) body={excerpt:?}",
                started.elapsed().as_millis()
            );
        }
        Err(ureq::Error::Transport(t)) => {
            crate::flow_log!(
                "[veslo:http] IN  ERR ({}ms) {url} (workspace.local) transport={:?}",
                started.elapsed().as_millis(),
                t.to_string()
            );
        }
    }
}

/// Push every local workspace from the Tauri-side veslo-workspaces.json into
/// veslo-server's registry. Symmetric to reconcile_orchestrator_workspaces in
/// commands/orchestrator.rs: without this, veslo-server only learns about
/// workspaces present in its --workspace CLI args at spawn (just `scratch` in
/// dev mode) plus whatever the frontend's reconcileVesloServerWorkspaces
/// races in afterwards. Workspaces created later in the same session miss
/// the bootstrap reconcile and stay invisible to veslo-server, so clicking
/// them in the sidebar 404s on /workspaces/:id/activate or /workspace/:id/*
/// reads, and the frontend hangs on "Opening conversation…".
pub fn reconcile_server_workspaces(app: &AppHandle) -> usize {
    use crate::types::WorkspaceType;
    use crate::workspace::state::load_workspace_state;

    let state = match load_workspace_state(app) {
        Ok(state) => state,
        Err(error) => {
            eprintln!(
                "[workspace] reconcile_server_workspaces: load_workspace_state failed: {error}"
            );
            return 0;
        }
    };

    // Wait for veslo-server to actually start accepting connections before
    // POSTing. start_veslo_server returns when the child process is spawned,
    // not when bun has finished loading + listening. Posting too early just
    // logs "Connection refused" for every workspace and leaves the registry
    // empty until the next engine_start call. Poll /health for up to ~5s.
    if let Some((base_url, _)) = collect_server_state(app) {
        let probe_url = format!("{}/health", base_url.trim_end_matches('/'));
        let probe_agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_millis(800))
            .build();
        for _ in 0..10 {
            if probe_agent.get(&probe_url).call().is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    let mut registered = 0usize;
    for workspace in state.workspaces.iter() {
        if !matches!(workspace.workspace_type, WorkspaceType::Local) {
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
            .unwrap_or_else(|| workspace.name.trim());
        post_local_workspace(app, path, display_name);
        registered += 1;
    }
    registered
}

/// `PATCH /workspaces/:id` — rename / update workspace metadata.
pub fn patch_workspace(app: &AppHandle, workspace_id: &str, name: &str) {
    let Some((base_url, host_token)) = collect_server_state(app) else {
        return;
    };
    let url = format!(
        "{}/workspaces/{}",
        base_url.trim_end_matches('/'),
        workspace_id
    );
    let payload = serde_json::json!({ "name": name });

    crate::flow_log!("[veslo:http] OUT PATCH {url} (workspace.rename)");
    let started = Instant::now();
    let result = build_agent()
        .request("PATCH", &url)
        .set("Content-Type", "application/json")
        .set("x-veslo-host-token", &host_token)
        .send_string(&payload.to_string());

    match result {
        Ok(response) => {
            crate::flow_log!(
                "[veslo:http] IN  {} ({}ms) {url} (workspace.rename)",
                response.status(),
                started.elapsed().as_millis()
            );
        }
        Err(ureq::Error::Status(404, _)) => {
            crate::flow_log!(
                "[veslo:http] IN  404 ({}ms) {url} (workspace.rename) not-yet-synced",
                started.elapsed().as_millis()
            );
        }
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            let excerpt: String = body.chars().take(BODY_EXCERPT_LIMIT).collect();
            crate::flow_log!(
                "[veslo:http] IN  {code} ({}ms) {url} (workspace.rename) body={excerpt:?}",
                started.elapsed().as_millis()
            );
        }
        Err(ureq::Error::Transport(t)) => {
            crate::flow_log!(
                "[veslo:http] IN  ERR ({}ms) {url} (workspace.rename) transport={:?}",
                started.elapsed().as_millis(),
                t.to_string()
            );
        }
    }
}

/// `DELETE /workspaces/:id` — remove workspace from server registry.
pub fn delete_workspace(app: &AppHandle, workspace_id: &str) {
    let Some((base_url, host_token)) = collect_server_state(app) else {
        return;
    };
    let url = format!(
        "{}/workspaces/{}",
        base_url.trim_end_matches('/'),
        workspace_id
    );

    crate::flow_log!("[veslo:http] OUT DELETE {url} (workspace.delete)");
    let started = Instant::now();
    let result = build_agent()
        .delete(&url)
        .set("x-veslo-host-token", &host_token)
        .call();

    match result {
        Ok(response) => {
            crate::flow_log!(
                "[veslo:http] IN  {} ({}ms) {url} (workspace.delete)",
                response.status(),
                started.elapsed().as_millis()
            );
        }
        Err(ureq::Error::Status(404, _)) => {
            crate::flow_log!(
                "[veslo:http] IN  404 ({}ms) {url} (workspace.delete) already-gone",
                started.elapsed().as_millis()
            );
        }
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            let excerpt: String = body.chars().take(BODY_EXCERPT_LIMIT).collect();
            crate::flow_log!(
                "[veslo:http] IN  {code} ({}ms) {url} (workspace.delete) body={excerpt:?}",
                started.elapsed().as_millis()
            );
        }
        Err(ureq::Error::Transport(t)) => {
            crate::flow_log!(
                "[veslo:http] IN  ERR ({}ms) {url} (workspace.delete) transport={:?}",
                started.elapsed().as_millis(),
                t.to_string()
            );
        }
    }
}
