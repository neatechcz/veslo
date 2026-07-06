// HTTP client for mirroring desktop workspace mutations into the local Veslo
// server registry. Local workspace state remains owned by veslo-workspaces.json
// for now, but every sync call now returns a structured result and logs
// skipped/failed sync as workspace_registry_unsynced.

use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::utils::truncate_output;
use crate::veslo_server::manager::VesloServerManager;
use crate::workspace::state::{
    apply_veslo_workspace_id_mapping, load_workspace_state, save_workspace_state,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const BODY_EXCERPT_LIMIT: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceServerSyncOutcome {
    Accepted,
    AlreadyRegistered,
    SkippedNoServer,
    SkippedMissingHostToken,
    HttpError,
    TransportError,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceServerSyncResult {
    pub operation: &'static str,
    pub outcome: WorkspaceServerSyncOutcome,
    pub status_code: Option<u16>,
    pub workspace_id: Option<String>,
    pub path: Option<String>,
    pub message: Option<String>,
}

impl WorkspaceServerSyncResult {
    fn accepted(
        operation: &'static str,
        status_code: u16,
        workspace_id: Option<String>,
        path: Option<String>,
    ) -> Self {
        Self {
            operation,
            outcome: WorkspaceServerSyncOutcome::Accepted,
            status_code: Some(status_code),
            workspace_id,
            path,
            message: None,
        }
    }

    fn already_registered(
        operation: &'static str,
        status_code: u16,
        workspace_id: Option<String>,
        path: Option<String>,
        message: Option<String>,
    ) -> Self {
        Self {
            operation,
            outcome: WorkspaceServerSyncOutcome::AlreadyRegistered,
            status_code: Some(status_code),
            workspace_id,
            path,
            message,
        }
    }

    fn skipped(
        operation: &'static str,
        outcome: WorkspaceServerSyncOutcome,
        message: &str,
    ) -> Self {
        Self {
            operation,
            outcome,
            status_code: None,
            workspace_id: None,
            path: None,
            message: Some(message.to_string()),
        }
    }

    fn http_error(operation: &'static str, status_code: u16, body: &str) -> Self {
        let error = parse_error_body(body);
        Self {
            operation,
            outcome: WorkspaceServerSyncOutcome::HttpError,
            status_code: Some(status_code),
            workspace_id: error
                .details
                .as_ref()
                .and_then(|details| details.id.clone()),
            path: error
                .details
                .as_ref()
                .and_then(|details| details.path.clone()),
            message: error.message.or_else(|| Some(excerpt_body(body))),
        }
    }

    fn transport_error(operation: &'static str, message: String) -> Self {
        Self {
            operation,
            outcome: WorkspaceServerSyncOutcome::TransportError,
            status_code: None,
            workspace_id: None,
            path: None,
            message: Some(message),
        }
    }

    pub fn is_accepted(&self) -> bool {
        matches!(
            self.outcome,
            WorkspaceServerSyncOutcome::Accepted | WorkspaceServerSyncOutcome::AlreadyRegistered
        )
    }

    pub fn is_skipped(&self) -> bool {
        matches!(
            self.outcome,
            WorkspaceServerSyncOutcome::SkippedNoServer
                | WorkspaceServerSyncOutcome::SkippedMissingHostToken
        )
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct WorkspaceServerReconcileResult {
    pub attempted: usize,
    pub accepted: usize,
    pub skipped: usize,
    pub failed: usize,
}

impl WorkspaceServerReconcileResult {
    pub fn total_unsynced(&self) -> usize {
        self.skipped + self.failed
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalWorkspaceRegistrationResponse {
    active_id: Option<String>,
    workspace: Option<WorkspaceRegistrationItem>,
}

#[derive(Debug, Deserialize)]
struct WorkspaceRegistrationItem {
    id: Option<String>,
    path: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct ErrorBody {
    code: Option<String>,
    message: Option<String>,
    details: Option<ErrorDetails>,
}

#[derive(Debug, Deserialize)]
struct ErrorDetails {
    id: Option<String>,
    path: Option<String>,
}

fn collect_server_state(
    app: &AppHandle,
    operation: &'static str,
) -> Result<(String, String), WorkspaceServerSyncResult> {
    let Some(manager) = app.try_state::<VesloServerManager>() else {
        return Err(WorkspaceServerSyncResult::skipped(
            operation,
            WorkspaceServerSyncOutcome::SkippedNoServer,
            "veslo server manager is not available",
        ));
    };
    let Ok(state) = manager.inner.lock() else {
        return Err(WorkspaceServerSyncResult::skipped(
            operation,
            WorkspaceServerSyncOutcome::SkippedNoServer,
            "veslo server state lock is unavailable",
        ));
    };
    let Some(base_url) = state
        .base_url
        .clone()
        .filter(|value| !value.trim().is_empty())
    else {
        return Err(WorkspaceServerSyncResult::skipped(
            operation,
            WorkspaceServerSyncOutcome::SkippedNoServer,
            "veslo server base URL is not available",
        ));
    };
    let Some(host_token) = state
        .host_token
        .clone()
        .filter(|value| !value.trim().is_empty())
    else {
        return Err(WorkspaceServerSyncResult::skipped(
            operation,
            WorkspaceServerSyncOutcome::SkippedMissingHostToken,
            "veslo server host token is not available",
        ));
    };
    Ok((base_url, host_token))
}

fn excerpt_body(body: &str) -> String {
    body.chars().take(BODY_EXCERPT_LIMIT).collect()
}

fn parse_error_body(body: &str) -> ErrorBody {
    serde_json::from_str::<ErrorBody>(body).unwrap_or_default()
}

fn parse_local_workspace_registration_body(body: &str) -> (Option<String>, Option<String>) {
    let Ok(payload) = serde_json::from_str::<LocalWorkspaceRegistrationResponse>(body) else {
        return (None, None);
    };
    let workspace_id = payload
        .workspace
        .as_ref()
        .and_then(|workspace| workspace.id.clone())
        .or(payload.active_id);
    let path = payload.workspace.and_then(|workspace| workspace.path);
    (workspace_id, path)
}

fn normalized_path_evidence(path: &str) -> Option<String> {
    let mut normalized = path.trim().replace('\\', "/");
    while normalized.ends_with('/') {
        normalized.pop();
    }
    if normalized.is_empty() {
        None
    } else {
        Some(normalized.to_ascii_lowercase())
    }
}

fn response_path_matches_expected(
    expected_path: Option<&str>,
    response_path: Option<&str>,
) -> bool {
    let Some(response_path) = response_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    let Some(response_key) = normalized_path_evidence(response_path) else {
        return false;
    };
    expected_path
        .and_then(normalized_path_evidence)
        .map(|expected_key| expected_key == response_key)
        .unwrap_or(true)
}

fn local_workspace_result_from_status(
    operation: &'static str,
    status_code: u16,
    body: &str,
    expected_path: Option<&str>,
) -> WorkspaceServerSyncResult {
    let (workspace_id, path) = parse_local_workspace_registration_body(body);
    if status_code == 409 {
        let error = parse_error_body(body);
        let duplicate_id = error
            .details
            .as_ref()
            .and_then(|details| details.id.clone())
            .or_else(|| workspace_id.clone());
        let duplicate_path = error
            .details
            .as_ref()
            .and_then(|details| details.path.clone())
            .or_else(|| path.clone());
        let is_workspace_exists = error.code.as_deref() == Some("workspace_exists");
        if is_workspace_exists
            && duplicate_id.is_some()
            && response_path_matches_expected(expected_path, duplicate_path.as_deref())
        {
            return WorkspaceServerSyncResult::already_registered(
                operation,
                status_code,
                duplicate_id,
                duplicate_path,
                error.message,
            );
        }
    }
    if (200..300).contains(&status_code) {
        return WorkspaceServerSyncResult::accepted(operation, status_code, workspace_id, path);
    }
    WorkspaceServerSyncResult::http_error(operation, status_code, body)
}

fn generic_workspace_result_from_status(
    operation: &'static str,
    status_code: u16,
    body: &str,
    accepted_missing: bool,
) -> WorkspaceServerSyncResult {
    if (200..300).contains(&status_code) || (accepted_missing && status_code == 404) {
        return WorkspaceServerSyncResult::accepted(operation, status_code, None, None);
    }
    WorkspaceServerSyncResult::http_error(operation, status_code, body)
}

fn build_agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(REQUEST_TIMEOUT).build()
}

fn workspace_sync_result_message(result: &WorkspaceServerSyncResult) -> String {
    let level = if result.is_skipped() {
        "skipped"
    } else {
        "failed"
    };
    format!(
        "workspace_registry_unsynced {level}: operation={} outcome={:?} status={:?} workspace_id={:?} path={:?} message={:?}",
        result.operation,
        result.outcome,
        result.status_code,
        result.workspace_id,
        result.path,
        result.message
    )
}

fn report_workspace_sync_result(app: &AppHandle, result: &WorkspaceServerSyncResult) {
    if result.is_accepted() {
        return;
    }
    let message = workspace_sync_result_message(result);
    report_workspace_registry_diagnostic(app, &message);
}

fn report_workspace_registry_diagnostic(app: &AppHandle, message: &str) {
    eprintln!("[workspace] {message}");
    if let Some(manager) = app.try_state::<VesloServerManager>() {
        if let Ok(mut state) = manager.inner.lock() {
            state.last_stderr = Some(truncate_output(&message, 8000));
        }
    }
}

fn mapping_path_for_result<'a>(
    expected_path: &'a str,
    result: &'a WorkspaceServerSyncResult,
) -> Option<&'a str> {
    let response_path = result
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    if response_path_matches_expected(Some(expected_path), Some(response_path)) {
        Some(response_path)
    } else {
        None
    }
}

fn persist_accepted_local_workspace_mapping(
    app: &AppHandle,
    expected_path: &str,
    result: &WorkspaceServerSyncResult,
) {
    if !result.is_accepted() {
        return;
    }
    let Some(server_workspace_id) = result
        .workspace_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        report_workspace_registry_diagnostic(
            app,
            &format!(
                "workspace_id_mapping_unsynced: operation={} missing server workspace id path={expected_path:?}",
                result.operation
            ),
        );
        return;
    };
    let Some(mapping_path) = mapping_path_for_result(expected_path, result) else {
        report_workspace_registry_diagnostic(
            app,
            &format!(
                "workspace_id_mapping_unsynced: operation={} response path did not match expected path={expected_path:?} response_path={:?}",
                result.operation, result.path
            ),
        );
        return;
    };

    let mut state = match load_workspace_state(app) {
        Ok(state) => state,
        Err(error) => {
            report_workspace_registry_diagnostic(
                app,
                &format!(
                    "workspace_id_mapping_unsynced: operation={} load workspace state failed: {error}",
                    result.operation
                ),
            );
            return;
        }
    };
    if !apply_veslo_workspace_id_mapping(&mut state, mapping_path, Some(server_workspace_id)) {
        return;
    }
    if let Err(error) = save_workspace_state(app, &state) {
        report_workspace_registry_diagnostic(
            app,
            &format!(
                "workspace_id_mapping_unsynced: operation={} save workspace state failed: {error}",
                result.operation
            ),
        );
    }
}

fn read_response_body(response: ureq::Response) -> String {
    response.into_string().unwrap_or_default()
}

/// `POST /workspaces/local` registers a local workspace on the server.
/// Duplicate 409 responses are treated as accepted because they prove the
/// server already knows the workspace.
pub fn post_local_workspace(app: &AppHandle, path: &str, name: &str) -> WorkspaceServerSyncResult {
    const OPERATION: &str = "workspace.local";
    let (base_url, host_token) = match collect_server_state(app, OPERATION) {
        Ok(state) => state,
        Err(result) => {
            report_workspace_sync_result(app, &result);
            return result;
        }
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

    let sync_result = match result {
        Ok(response) => {
            let status = response.status();
            let body = read_response_body(response);
            crate::flow_log!(
                "[veslo:http] IN  {} ({}ms) {url} (workspace.local)",
                status,
                started.elapsed().as_millis()
            );
            local_workspace_result_from_status(OPERATION, status, &body, Some(path))
        }
        Err(ureq::Error::Status(code, response)) => {
            let body = read_response_body(response);
            let sync_result =
                local_workspace_result_from_status(OPERATION, code, &body, Some(path));
            let excerpt = excerpt_body(&body);
            crate::flow_log!(
                "[veslo:http] IN  {code} ({}ms) {url} (workspace.local) body={excerpt:?}",
                started.elapsed().as_millis()
            );
            sync_result
        }
        Err(ureq::Error::Transport(error)) => {
            let message = error.to_string();
            crate::flow_log!(
                "[veslo:http] IN  ERR ({}ms) {url} (workspace.local) transport={message:?}",
                started.elapsed().as_millis()
            );
            WorkspaceServerSyncResult::transport_error(OPERATION, message)
        }
    };
    report_workspace_sync_result(app, &sync_result);
    persist_accepted_local_workspace_mapping(app, path, &sync_result);
    sync_result
}

/// Push every local workspace from veslo-workspaces.json into the server
/// registry. The returned summary lets lifecycle callers report unsynced
/// workspaces without blocking the user's local mutation.
pub fn reconcile_server_workspaces(app: &AppHandle) -> WorkspaceServerReconcileResult {
    use crate::types::WorkspaceType;

    let state = match load_workspace_state(app) {
        Ok(state) => state,
        Err(error) => {
            eprintln!(
                "[workspace] reconcile_server_workspaces: load_workspace_state failed: {error}"
            );
            return WorkspaceServerReconcileResult {
                failed: 1,
                ..Default::default()
            };
        }
    };

    let mut summary = WorkspaceServerReconcileResult::default();
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
        summary.attempted += 1;
        let result = post_local_workspace(app, path, display_name);
        if result.is_accepted() {
            summary.accepted += 1;
        } else if result.is_skipped() {
            summary.skipped += 1;
        } else {
            summary.failed += 1;
        }
    }
    summary
}

/// `PATCH /workspaces/:id` renames or updates workspace metadata.
pub fn patch_workspace(
    app: &AppHandle,
    workspace_id: &str,
    name: &str,
) -> WorkspaceServerSyncResult {
    const OPERATION: &str = "workspace.rename";
    let (base_url, host_token) = match collect_server_state(app, OPERATION) {
        Ok(state) => state,
        Err(result) => {
            report_workspace_sync_result(app, &result);
            return result;
        }
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

    let sync_result = match result {
        Ok(response) => {
            let status = response.status();
            let body = read_response_body(response);
            crate::flow_log!(
                "[veslo:http] IN  {} ({}ms) {url} (workspace.rename)",
                status,
                started.elapsed().as_millis()
            );
            generic_workspace_result_from_status(OPERATION, status, &body, false)
        }
        Err(ureq::Error::Status(code, response)) => {
            let body = read_response_body(response);
            let sync_result = generic_workspace_result_from_status(OPERATION, code, &body, false);
            let excerpt = excerpt_body(&body);
            crate::flow_log!(
                "[veslo:http] IN  {code} ({}ms) {url} (workspace.rename) body={excerpt:?}",
                started.elapsed().as_millis()
            );
            sync_result
        }
        Err(ureq::Error::Transport(error)) => {
            let message = error.to_string();
            crate::flow_log!(
                "[veslo:http] IN  ERR ({}ms) {url} (workspace.rename) transport={message:?}",
                started.elapsed().as_millis()
            );
            WorkspaceServerSyncResult::transport_error(OPERATION, message)
        }
    };
    report_workspace_sync_result(app, &sync_result);
    sync_result
}

/// `DELETE /workspaces/:id` removes a workspace from the server registry.
pub fn delete_workspace(app: &AppHandle, workspace_id: &str) -> WorkspaceServerSyncResult {
    const OPERATION: &str = "workspace.delete";
    let (base_url, host_token) = match collect_server_state(app, OPERATION) {
        Ok(state) => state,
        Err(result) => {
            report_workspace_sync_result(app, &result);
            return result;
        }
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

    let sync_result = match result {
        Ok(response) => {
            let status = response.status();
            let body = read_response_body(response);
            crate::flow_log!(
                "[veslo:http] IN  {} ({}ms) {url} (workspace.delete)",
                status,
                started.elapsed().as_millis()
            );
            generic_workspace_result_from_status(OPERATION, status, &body, true)
        }
        Err(ureq::Error::Status(code, response)) => {
            let body = read_response_body(response);
            let sync_result = generic_workspace_result_from_status(OPERATION, code, &body, true);
            let excerpt = excerpt_body(&body);
            crate::flow_log!(
                "[veslo:http] IN  {code} ({}ms) {url} (workspace.delete) body={excerpt:?}",
                started.elapsed().as_millis()
            );
            sync_result
        }
        Err(ureq::Error::Transport(error)) => {
            let message = error.to_string();
            crate::flow_log!(
                "[veslo:http] IN  ERR ({}ms) {url} (workspace.delete) transport={message:?}",
                started.elapsed().as_millis()
            );
            WorkspaceServerSyncResult::transport_error(OPERATION, message)
        }
    };
    report_workspace_sync_result(app, &sync_result);
    sync_result
}

#[cfg(test)]
mod tests {
    use super::{
        local_workspace_result_from_status, mapping_path_for_result, workspace_sync_result_message,
        WorkspaceServerReconcileResult, WorkspaceServerSyncOutcome,
    };

    #[test]
    fn local_workspace_result_extracts_registered_workspace_identity() {
        let result = local_workspace_result_from_status(
            "workspace.local",
            201,
            r#"{"activeId":"ws-active","workspace":{"id":"ws-local","path":"/tmp/project"},"items":[],"persisted":true}"#,
            Some("/tmp/project"),
        );

        assert_eq!(result.outcome, WorkspaceServerSyncOutcome::Accepted);
        assert_eq!(result.status_code, Some(201));
        assert_eq!(result.workspace_id.as_deref(), Some("ws-local"));
        assert_eq!(result.path.as_deref(), Some("/tmp/project"));
        assert!(result.is_accepted());
    }

    #[test]
    fn local_workspace_result_treats_duplicate_as_registered() {
        let result = local_workspace_result_from_status(
            "workspace.local",
            409,
            r#"{"code":"workspace_exists","message":"Workspace already exists","details":{"id":"ws-existing","path":"/tmp/project"}}"#,
            Some("/tmp/project"),
        );

        assert_eq!(
            result.outcome,
            WorkspaceServerSyncOutcome::AlreadyRegistered
        );
        assert_eq!(result.status_code, Some(409));
        assert_eq!(result.workspace_id.as_deref(), Some("ws-existing"));
        assert_eq!(result.path.as_deref(), Some("/tmp/project"));
        assert!(result.is_accepted());
    }

    #[test]
    fn local_workspace_result_rejects_unacknowledged_409_conflicts() {
        for body in [
            r#"{"code":"conflict","message":"Different conflict","details":{"id":"ws-existing","path":"/tmp/project"}}"#,
            r#"{"code":"workspace_exists","message":"Workspace already exists","details":{"path":"/tmp/project"}}"#,
            r#"{"code":"workspace_exists","message":"Workspace already exists","details":{"id":"ws-existing","path":"/tmp/other"}}"#,
        ] {
            let result = local_workspace_result_from_status(
                "workspace.local",
                409,
                body,
                Some("/tmp/project"),
            );

            assert_eq!(result.outcome, WorkspaceServerSyncOutcome::HttpError);
            assert_eq!(result.status_code, Some(409));
            assert!(!result.is_accepted());
        }
    }

    #[test]
    fn mapping_path_for_result_requires_acknowledged_response_path() {
        let accepted = local_workspace_result_from_status(
            "workspace.local",
            201,
            r#"{"activeId":"ws-active","workspace":{"id":"ws-local","path":"/tmp/project"}}"#,
            Some("/tmp/project"),
        );
        let wrong_path = local_workspace_result_from_status(
            "workspace.local",
            201,
            r#"{"activeId":"ws-active","workspace":{"id":"ws-local","path":"/tmp/other"}}"#,
            Some("/tmp/project"),
        );
        let missing_path = local_workspace_result_from_status(
            "workspace.local",
            201,
            r#"{"activeId":"ws-active","workspace":{"id":"ws-local"}}"#,
            Some("/tmp/project"),
        );
        let trailing_expected_path = local_workspace_result_from_status(
            "workspace.local",
            201,
            r#"{"activeId":"ws-active","workspace":{"id":"ws-local","path":"/tmp/project"}}"#,
            Some("/tmp/project/"),
        );

        assert_eq!(
            mapping_path_for_result("/tmp/project", &accepted),
            Some("/tmp/project")
        );
        assert_eq!(
            mapping_path_for_result("/tmp/project/", &trailing_expected_path),
            Some("/tmp/project")
        );
        assert_eq!(mapping_path_for_result("/tmp/project", &wrong_path), None);
        assert_eq!(mapping_path_for_result("/tmp/project", &missing_path), None);
    }

    #[test]
    fn local_workspace_result_keeps_http_errors_visible() {
        let result = local_workspace_result_from_status(
            "workspace.local",
            401,
            r#"{"code":"unauthorized","message":"Invalid host token"}"#,
            Some("/tmp/project"),
        );

        assert_eq!(result.outcome, WorkspaceServerSyncOutcome::HttpError);
        assert_eq!(result.status_code, Some(401));
        assert_eq!(result.message.as_deref(), Some("Invalid host token"));
        assert!(!result.is_accepted());
        assert!(!result.is_skipped());
    }

    #[test]
    fn reconcile_summary_counts_unsynced_workspaces() {
        let summary = WorkspaceServerReconcileResult {
            attempted: 4,
            accepted: 2,
            skipped: 1,
            failed: 1,
        };

        assert_eq!(summary.total_unsynced(), 2);
    }

    #[test]
    fn unsynced_message_uses_stable_reason_code() {
        let result = local_workspace_result_from_status(
            "workspace.local",
            401,
            r#"{"code":"unauthorized","message":"Invalid host token"}"#,
            Some("/tmp/project"),
        );
        let message = workspace_sync_result_message(&result);

        assert!(message.contains("workspace_registry_unsynced"));
        assert!(message.contains("workspace.local"));
        assert!(message.contains("HttpError"));
    }
}
