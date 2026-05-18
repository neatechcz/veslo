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

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::veslo_server::manager::VesloServerManager;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);

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

    let result = build_agent()
        .post(&url)
        .set("Content-Type", "application/json")
        .set("x-veslo-host-token", &host_token)
        .send_string(&payload.to_string());

    match result {
        Ok(_) => {}
        Err(ureq::Error::Status(409, _)) => {
            // Workspace already exists server-side — fine.
        }
        Err(e) => eprintln!("[workspace] server POST /workspaces/local failed: {e}"),
    }
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

    let result = build_agent()
        .request("PATCH", &url)
        .set("Content-Type", "application/json")
        .set("x-veslo-host-token", &host_token)
        .send_string(&payload.to_string());

    match result {
        Ok(_) => {}
        Err(ureq::Error::Status(404, _)) => {
            // Server doesn't know this workspace yet — happens before first POST sync.
        }
        Err(e) => eprintln!("[workspace] server PATCH /workspaces/{workspace_id} failed: {e}"),
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

    let result = build_agent()
        .delete(&url)
        .set("x-veslo-host-token", &host_token)
        .call();

    match result {
        Ok(_) => {}
        Err(ureq::Error::Status(404, _)) => {
            // Already gone server-side — fine.
        }
        Err(e) => eprintln!("[workspace] server DELETE /workspaces/{workspace_id} failed: {e}"),
    }
}
