use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionDraftCommand {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionDraftAttachmentMetadata {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionDraftAttachmentInput {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub kind: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionDraftAttachmentPayload {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub kind: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionDraftAttachmentFailure {
    pub attachment_id: String,
    pub name: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionDraftComposerInput {
    pub mode: String,
    pub parts: Vec<serde_json::Value>,
    pub attachments: Vec<PendingSessionDraftAttachmentInput>,
    pub text: String,
    pub resolved_text: Option<String>,
    pub command: Option<PendingSessionDraftCommand>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionDraftComposerMetadata {
    pub mode: String,
    pub parts: Vec<serde_json::Value>,
    pub attachments: Vec<PendingSessionDraftAttachmentMetadata>,
    pub text: String,
    pub resolved_text: Option<String>,
    pub command: Option<PendingSessionDraftCommand>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionDraftComposerPayload {
    pub mode: String,
    pub parts: Vec<serde_json::Value>,
    pub attachments: Vec<PendingSessionDraftAttachmentPayload>,
    pub text: String,
    pub resolved_text: Option<String>,
    pub command: Option<PendingSessionDraftCommand>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionDraftPutInput {
    pub id: String,
    pub kind: String,
    pub workspace_id: String,
    pub directory: Option<String>,
    pub private_workspace_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub composer: PendingSessionDraftComposerInput,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionDraftSummary {
    pub id: String,
    pub kind: String,
    pub workspace_id: String,
    pub directory: Option<String>,
    pub private_workspace_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub composer: PendingSessionDraftComposerMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionDraftRecord {
    pub id: String,
    pub kind: String,
    pub workspace_id: String,
    pub directory: Option<String>,
    pub private_workspace_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub composer: PendingSessionDraftComposerPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSessionDraftGetResult {
    pub draft: PendingSessionDraftRecord,
    pub attachment_failures: Vec<PendingSessionDraftAttachmentFailure>,
}

fn list_pending_session_drafts(root: &Path) -> Result<Vec<PendingSessionDraftSummary>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }

    let surfaced_backup_dirs = recover_or_surface_backup_only_drafts(root)?;
    let mut drafts = Vec::new();
    for entry in
        fs::read_dir(root).map_err(|e| format!("Failed to read {}: {e}", root.display()))?
    {
        let entry = entry.map_err(|e| format!("Failed to read draft entry: {e}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }

        match read_pending_session_draft_summary(&path) {
            Ok(summary) => drafts.push(summary),
            Err(error) => {
                eprintln!(
                    "[pending_session_drafts] skipping unreadable draft {}: {error}",
                    path.display()
                );
            }
        }
    }
    for path in surfaced_backup_dirs {
        match read_pending_session_draft_summary(&path) {
            Ok(summary) => drafts.push(summary),
            Err(error) => {
                eprintln!(
                    "[pending_session_drafts] skipping surfaced backup draft {}: {error}",
                    path.display()
                );
            }
        }
    }

    drafts.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(drafts)
}

fn put_pending_session_draft(
    root: &Path,
    input: PendingSessionDraftPutInput,
) -> Result<PendingSessionDraftSummary, String> {
    put_pending_session_draft_with_commit_hooks(root, input, |_| Ok(()), |_| Ok(()))
}

#[cfg(test)]
fn put_pending_session_draft_with_commit_hook<F>(
    root: &Path,
    input: PendingSessionDraftPutInput,
    before_activate: F,
) -> Result<PendingSessionDraftSummary, String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    put_pending_session_draft_with_commit_hooks(root, input, before_activate, |_| Ok(()))
}

fn put_pending_session_draft_with_commit_hooks<F, G>(
    root: &Path,
    input: PendingSessionDraftPutInput,
    before_activate: F,
    before_backup_cleanup: G,
) -> Result<PendingSessionDraftSummary, String>
where
    F: FnOnce(&Path) -> Result<(), String>,
    G: FnOnce(&Path) -> Result<(), String>,
{
    fs::create_dir_all(root).map_err(|e| format!("Failed to create {}: {e}", root.display()))?;

    let attachment_inputs = input.composer.attachments.clone();
    let summary = validate_and_build_summary(input)?;
    let staging_dir = root.join(format!(
        ".pending-session-draft-{}",
        Uuid::new_v4().simple()
    ));
    let attachments_dir = staging_dir.join("attachments");
    fs::create_dir_all(&attachments_dir)
        .map_err(|e| format!("Failed to create {}: {e}", attachments_dir.display()))?;

    for attachment in &summary.composer.attachments {
        let target = attachment_file_path(&staging_dir, &attachment.id);
        let bytes = find_attachment_bytes(&attachment_inputs, &attachment.id)?;
        fs::write(&target, bytes)
            .map_err(|e| format!("Failed to write {}: {e}", target.display()))?;
    }

    let draft_json_path = draft_json_path(&staging_dir);
    let draft_json = serde_json::to_vec_pretty(&summary)
        .map_err(|e| format!("Failed to serialize draft {}: {e}", summary.id))?;
    fs::write(&draft_json_path, draft_json)
        .map_err(|e| format!("Failed to write {}: {e}", draft_json_path.display()))?;

    let target_dir = draft_dir(root, &summary.id);
    if let Err(error) = commit_staged_pending_session_draft(
        &staging_dir,
        &target_dir,
        &summary.id,
        before_activate,
        before_backup_cleanup,
    ) {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(error);
    }

    Ok(summary)
}

fn commit_staged_pending_session_draft<F, G>(
    staging_dir: &Path,
    target_dir: &Path,
    draft_id: &str,
    before_activate: F,
    before_backup_cleanup: G,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
    G: FnOnce(&Path) -> Result<(), String>,
{
    let backup_dir = pending_session_draft_backup_dir(
        target_dir.parent().unwrap_or_else(|| Path::new(".")),
        draft_id,
    );

    let backup_dir = if target_dir.exists() {
        fs::rename(target_dir, &backup_dir).map_err(|e| {
            format!(
                "Failed to stage previous draft {}: {e}",
                target_dir.display()
            )
        })?;
        Some(backup_dir)
    } else {
        None
    };

    let activation_result = before_activate(target_dir).and_then(|_| {
        fs::rename(staging_dir, target_dir)
            .map_err(|e| format!("Failed to move draft {draft_id} into place: {e}"))
    });

    if let Err(error) = activation_result {
        if let Some(backup_dir) = &backup_dir {
            restore_pending_session_draft_backup(target_dir, backup_dir)?;
        }
        return Err(error);
    }

    if let Some(backup_dir) = backup_dir {
        if let Err(error) = before_backup_cleanup(&backup_dir).and_then(|_| {
            remove_path_if_exists(&backup_dir).map_err(|e| {
                format!(
                    "Failed to clean up previous draft backup {}: {e}",
                    backup_dir.display()
                )
            })
        }) {
            eprintln!(
                "[pending_session_drafts] leaving stale backup {} after successful commit: {error}",
                backup_dir.display()
            );
        }
    }

    Ok(())
}

fn restore_pending_session_draft_backup(
    target_dir: &Path,
    backup_dir: &Path,
) -> Result<(), String> {
    if target_dir.exists() {
        remove_path_if_exists(target_dir).map_err(|e| {
            format!(
                "Failed to remove failed replacement {} during restore: {e}",
                target_dir.display()
            )
        })?;
    }
    fs::rename(backup_dir, target_dir).map_err(|e| {
        format!(
            "Failed to restore previous draft from {}: {e}",
            backup_dir.display()
        )
    })
}

fn recover_or_surface_backup_only_drafts(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut surfaced_paths = Vec::new();
    for (draft_id, backup_dir, _) in latest_pending_session_draft_backup_dirs(root)? {
        let live_dir = draft_dir(root, &draft_id);
        if live_dir.exists() {
            continue;
        }
        match fs::rename(&backup_dir, &live_dir) {
            Ok(()) => {}
            Err(error) => {
                eprintln!(
                    "[pending_session_drafts] failed to restore backup {} to {}: {error}",
                    backup_dir.display(),
                    live_dir.display()
                );
                surfaced_paths.push(backup_dir);
            }
        }
    }
    Ok(surfaced_paths)
}

fn resolve_pending_session_draft_dir(
    root: &Path,
    draft_id: &str,
) -> Result<Option<PathBuf>, String> {
    let live_dir = draft_dir(root, draft_id);
    if live_dir.exists() {
        return Ok(Some(live_dir));
    }

    for (backup_draft_id, backup_dir, _) in latest_pending_session_draft_backup_dirs(root)? {
        if backup_draft_id != draft_id {
            continue;
        }
        match fs::rename(&backup_dir, &live_dir) {
            Ok(()) => return Ok(Some(live_dir)),
            Err(error) => {
                eprintln!(
                    "[pending_session_drafts] failed to restore backup {} to {}: {error}",
                    backup_dir.display(),
                    live_dir.display()
                );
                return Ok(Some(backup_dir));
            }
        }
    }

    Ok(None)
}

fn get_pending_session_draft(
    root: &Path,
    draft_id: &str,
) -> Result<Option<PendingSessionDraftGetResult>, String> {
    let draft_id = validate_storage_id(draft_id, "draft_id")?;
    let Some(draft_dir) = resolve_pending_session_draft_dir(root, &draft_id)? else {
        return Ok(None);
    };

    let summary = read_pending_session_draft_summary(&draft_dir)?;
    let mut attachments = Vec::new();
    let mut attachment_failures = Vec::new();

    for metadata in &summary.composer.attachments {
        let path = attachment_file_path(&draft_dir, &metadata.id);
        match fs::read(&path) {
            Ok(bytes) => attachments.push(PendingSessionDraftAttachmentPayload {
                id: metadata.id.clone(),
                name: metadata.name.clone(),
                mime_type: metadata.mime_type.clone(),
                size: bytes.len() as u64,
                kind: metadata.kind.clone(),
                bytes,
            }),
            Err(error) => attachment_failures.push(PendingSessionDraftAttachmentFailure {
                attachment_id: metadata.id.clone(),
                name: metadata.name.clone(),
                message: format!("Failed to read {}: {error}", path.display()),
            }),
        }
    }

    Ok(Some(PendingSessionDraftGetResult {
        draft: PendingSessionDraftRecord {
            id: summary.id,
            kind: summary.kind,
            workspace_id: summary.workspace_id,
            directory: summary.directory,
            private_workspace_id: summary.private_workspace_id,
            created_at: summary.created_at,
            updated_at: summary.updated_at,
            composer: PendingSessionDraftComposerPayload {
                mode: summary.composer.mode,
                parts: summary.composer.parts,
                attachments,
                text: summary.composer.text,
                resolved_text: summary.composer.resolved_text,
                command: summary.composer.command,
            },
        },
        attachment_failures,
    }))
}

fn delete_pending_session_draft(root: &Path, draft_id: &str) -> Result<bool, String> {
    let draft_id = validate_storage_id(draft_id, "draft_id")?;
    let mut target_paths = Vec::new();
    let live_dir = draft_dir(root, &draft_id);
    if live_dir.exists() {
        target_paths.push(live_dir);
    }
    target_paths.extend(pending_session_draft_backup_dirs_for_draft(
        root, &draft_id,
    )?);

    if target_paths.is_empty() {
        return Ok(false);
    }

    for target_path in target_paths {
        remove_path_if_exists(&target_path)?;
    }

    Ok(true)
}

fn pending_session_drafts_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join("pending-session-drafts"))
}

fn draft_dir(root: &Path, draft_id: &str) -> PathBuf {
    root.join(draft_id)
}

fn draft_json_path(draft_dir: &Path) -> PathBuf {
    draft_dir.join("draft.json")
}

fn pending_session_draft_backup_dir(root: &Path, draft_id: &str) -> PathBuf {
    root.join(format!(
        ".pending-session-draft-backup-{}-{}",
        draft_id,
        Uuid::new_v4().simple()
    ))
}

fn parse_pending_session_draft_backup_name(name: &str) -> Option<String> {
    let prefix = ".pending-session-draft-backup-";
    let remainder = name.strip_prefix(prefix)?;
    let (draft_id, suffix) = remainder.rsplit_once('-')?;
    if draft_id.is_empty() || suffix.is_empty() {
        return None;
    }
    Some(draft_id.to_string())
}

fn latest_pending_session_draft_backup_dirs(
    root: &Path,
) -> Result<Vec<(String, PathBuf, std::time::SystemTime)>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut latest_by_draft: std::collections::HashMap<String, (PathBuf, std::time::SystemTime)> =
        std::collections::HashMap::new();

    for entry in
        fs::read_dir(root).map_err(|e| format!("Failed to read {}: {e}", root.display()))?
    {
        let entry = entry.map_err(|e| format!("Failed to read draft entry: {e}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(draft_id) = parse_pending_session_draft_backup_name(name) else {
            continue;
        };
        let modified_at = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);

        match latest_by_draft.get(&draft_id) {
            Some((_, current_modified_at)) if *current_modified_at >= modified_at => {}
            _ => {
                latest_by_draft.insert(draft_id, (path, modified_at));
            }
        }
    }

    Ok(latest_by_draft
        .into_iter()
        .map(|(draft_id, (path, modified_at))| (draft_id, path, modified_at))
        .collect())
}

fn pending_session_draft_backup_dirs_for_draft(
    root: &Path,
    draft_id: &str,
) -> Result<Vec<PathBuf>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut backup_dirs = Vec::new();
    for entry in
        fs::read_dir(root).map_err(|e| format!("Failed to read {}: {e}", root.display()))?
    {
        let entry = entry.map_err(|e| format!("Failed to read draft entry: {e}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if parse_pending_session_draft_backup_name(name).as_deref() != Some(draft_id) {
            continue;
        }
        backup_dirs.push(path);
    }

    Ok(backup_dirs)
}

fn attachment_file_path(draft_dir: &Path, attachment_id: &str) -> PathBuf {
    draft_dir
        .join("attachments")
        .join(attachment_storage_name(attachment_id))
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| format!("Failed to remove {}: {e}", path.display()))
    } else {
        fs::remove_file(path).map_err(|e| format!("Failed to remove {}: {e}", path.display()))
    }
}

fn read_pending_session_draft_summary(
    draft_dir: &Path,
) -> Result<PendingSessionDraftSummary, String> {
    let draft_json_path = draft_json_path(draft_dir);
    let raw = fs::read_to_string(&draft_json_path)
        .map_err(|e| format!("Failed to read {}: {e}", draft_json_path.display()))?;
    serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", draft_json_path.display()))
}

fn validate_storage_id(value: &str, field_name: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field_name} is required"));
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(format!(
            "{field_name} must use only letters, numbers, '-' or '_'"
        ));
    }
    Ok(trimmed.to_string())
}

fn validate_attachment_id(value: &str) -> Result<String, String> {
    if value.trim().is_empty() {
        return Err("attachment.id is required".to_string());
    }
    if value.chars().any(|ch| ch == '\0' || ch.is_control()) {
        return Err("attachment.id must not contain control characters".to_string());
    }
    Ok(value.to_string())
}

fn attachment_storage_name(attachment_id: &str) -> String {
    let mut encoded = String::with_capacity(attachment_id.len() * 2 + 2);
    encoded.push_str("a-");
    for byte in attachment_id.as_bytes() {
        use std::fmt::Write as _;
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    encoded
}

fn validate_non_empty(value: &str, field_name: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field_name} is required"));
    }
    Ok(trimmed.to_string())
}

fn validate_draft_kind(kind: &str) -> Result<String, String> {
    let trimmed = kind.trim();
    match trimmed {
        "new-private" | "directory" => Ok(trimmed.to_string()),
        _ => Err("kind must be 'new-private' or 'directory'".to_string()),
    }
}

fn validate_attachment_kind(kind: &str) -> Result<String, String> {
    let trimmed = kind.trim();
    match trimmed {
        "image" | "file" => Ok(trimmed.to_string()),
        _ => Err("attachment kind must be 'image' or 'file'".to_string()),
    }
}

fn validate_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|item| {
        let trimmed = item.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn validate_and_build_summary(
    input: PendingSessionDraftPutInput,
) -> Result<PendingSessionDraftSummary, String> {
    let id = validate_storage_id(&input.id, "id")?;
    let kind = validate_draft_kind(&input.kind)?;
    let workspace_id = validate_non_empty(&input.workspace_id, "workspace_id")?;
    let mode = validate_non_empty(&input.composer.mode, "composer.mode")?;
    let directory = validate_optional_string(input.directory);
    let private_workspace_id = validate_optional_string(input.private_workspace_id);

    match kind.as_str() {
        "directory" => {
            if directory.is_none() {
                return Err("directory drafts require directory".to_string());
            }
            if private_workspace_id.is_some() {
                return Err("directory drafts must not include private_workspace_id".to_string());
            }
        }
        "new-private" => {
            if private_workspace_id.is_none() {
                return Err("new-private drafts require private_workspace_id".to_string());
            }
            if directory.is_some() {
                return Err("new-private drafts must not include directory".to_string());
            }
        }
        _ => {}
    }

    let mut attachment_ids = std::collections::HashSet::new();
    let mut attachments = Vec::with_capacity(input.composer.attachments.len());
    for attachment in &input.composer.attachments {
        let attachment_id = validate_attachment_id(&attachment.id)?;
        if !attachment_ids.insert(attachment_id.clone()) {
            return Err(format!("duplicate attachment.id: {}", attachment_id));
        }
        let name = validate_non_empty(&attachment.name, "attachment.name")?;
        let mime_type = validate_non_empty(&attachment.mime_type, "attachment.mime_type")?;
        let kind = validate_attachment_kind(&attachment.kind)?;
        attachments.push(PendingSessionDraftAttachmentMetadata {
            id: attachment_id,
            name,
            mime_type,
            size: attachment.bytes.len() as u64,
            kind,
        });
    }

    Ok(PendingSessionDraftSummary {
        id,
        kind,
        workspace_id,
        directory,
        private_workspace_id,
        created_at: input.created_at,
        updated_at: input.updated_at,
        composer: PendingSessionDraftComposerMetadata {
            mode,
            parts: input.composer.parts,
            attachments,
            text: input.composer.text,
            resolved_text: input.composer.resolved_text,
            command: input.composer.command,
        },
    })
}

fn find_attachment_bytes(
    attachments: &[PendingSessionDraftAttachmentInput],
    attachment_id: &str,
) -> Result<Vec<u8>, String> {
    attachments
        .iter()
        .find(|attachment| attachment.id == attachment_id)
        .map(|attachment| attachment.bytes.clone())
        .ok_or_else(|| format!("Attachment bytes missing for {attachment_id}"))
}

#[tauri::command]
pub fn pending_session_drafts_list(
    app: AppHandle,
) -> Result<Vec<PendingSessionDraftSummary>, String> {
    list_pending_session_drafts(&pending_session_drafts_root(&app)?)
}

#[tauri::command]
pub fn pending_session_drafts_get(
    app: AppHandle,
    draft_id: String,
) -> Result<Option<PendingSessionDraftGetResult>, String> {
    get_pending_session_draft(&pending_session_drafts_root(&app)?, &draft_id)
}

#[tauri::command]
pub fn pending_session_drafts_put(
    app: AppHandle,
    draft: PendingSessionDraftPutInput,
) -> Result<PendingSessionDraftSummary, String> {
    put_pending_session_draft(&pending_session_drafts_root(&app)?, draft)
}

#[tauri::command]
pub fn pending_session_drafts_delete(app: AppHandle, draft_id: String) -> Result<bool, String> {
    delete_pending_session_draft(&pending_session_drafts_root(&app)?, &draft_id)
}

#[cfg(test)]
mod tests {
    use super::{
        attachment_file_path, delete_pending_session_draft, get_pending_session_draft,
        latest_pending_session_draft_backup_dirs, list_pending_session_drafts,
        put_pending_session_draft, put_pending_session_draft_with_commit_hook,
        put_pending_session_draft_with_commit_hooks, PendingSessionDraftAttachmentInput,
        PendingSessionDraftAttachmentMetadata, PendingSessionDraftAttachmentPayload,
        PendingSessionDraftComposerInput, PendingSessionDraftComposerMetadata,
        PendingSessionDraftComposerPayload, PendingSessionDraftGetResult,
        PendingSessionDraftPutInput, PendingSessionDraftRecord, PendingSessionDraftSummary,
    };
    use serde_json::json;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Barrier, Mutex};
    use std::thread;
    use uuid::Uuid;

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let unique = format!("veslo-pending-session-drafts-test-{}", Uuid::new_v4());
            let path = std::env::temp_dir().join(unique);
            fs::create_dir_all(&path).expect("test dir should be created");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn sample_put_input() -> PendingSessionDraftPutInput {
        PendingSessionDraftPutInput {
            id: "draft-1".to_string(),
            kind: "directory".to_string(),
            workspace_id: "workspace-1".to_string(),
            directory: Some("/tmp/workspace".to_string()),
            private_workspace_id: None,
            created_at: 1_710_000_000_000,
            updated_at: 1_710_000_000_500,
            composer: PendingSessionDraftComposerInput {
                mode: "prompt".to_string(),
                parts: vec![
                    json!({ "type": "text", "text": "Review this file" }),
                    json!({ "type": "agent", "name": "planner" }),
                ],
                attachments: vec![
                    PendingSessionDraftAttachmentInput {
                        id: "attachment-image".to_string(),
                        name: "diagram.png".to_string(),
                        mime_type: "image/png".to_string(),
                        size: 4,
                        kind: "image".to_string(),
                        bytes: vec![0, 1, 2, 3],
                    },
                    PendingSessionDraftAttachmentInput {
                        id: "attachment-doc".to_string(),
                        name: "notes.txt".to_string(),
                        mime_type: "text/plain".to_string(),
                        size: 5,
                        kind: "file".to_string(),
                        bytes: b"hello".to_vec(),
                    },
                ],
                text: "Review this file".to_string(),
                resolved_text: Some("Review this file".to_string()),
                command: Some(super::PendingSessionDraftCommand {
                    name: "/review".to_string(),
                    arguments: "--quick".to_string(),
                }),
            },
        }
    }

    fn sample_put_input_with_attachment_id(attachment_id: &str) -> PendingSessionDraftPutInput {
        let mut input = sample_put_input();
        input.composer.attachments[0].id = attachment_id.to_string();
        input.composer.attachments[0].name = "diagram v2.png".to_string();
        input.composer.attachments[0].mime_type = "image/png".to_string();
        input
    }

    fn sample_new_private_put_input() -> PendingSessionDraftPutInput {
        let mut input = sample_put_input();
        input.kind = "new-private".to_string();
        input.directory = None;
        input.private_workspace_id = Some("private-workspace-1".to_string());
        input
    }

    fn expected_summary() -> PendingSessionDraftSummary {
        let input = sample_put_input();
        PendingSessionDraftSummary {
            id: input.id,
            kind: input.kind,
            workspace_id: input.workspace_id,
            directory: input.directory,
            private_workspace_id: input.private_workspace_id,
            created_at: input.created_at,
            updated_at: input.updated_at,
            composer: PendingSessionDraftComposerMetadata {
                mode: input.composer.mode,
                parts: input.composer.parts,
                attachments: vec![
                    PendingSessionDraftAttachmentMetadata {
                        id: "attachment-image".to_string(),
                        name: "diagram.png".to_string(),
                        mime_type: "image/png".to_string(),
                        size: 4,
                        kind: "image".to_string(),
                    },
                    PendingSessionDraftAttachmentMetadata {
                        id: "attachment-doc".to_string(),
                        name: "notes.txt".to_string(),
                        mime_type: "text/plain".to_string(),
                        size: 5,
                        kind: "file".to_string(),
                    },
                ],
                text: input.composer.text,
                resolved_text: input.composer.resolved_text,
                command: input.composer.command,
            },
        }
    }

    fn expected_get_result() -> PendingSessionDraftGetResult {
        let summary = expected_summary();
        PendingSessionDraftGetResult {
            draft: PendingSessionDraftRecord {
                id: summary.id,
                kind: summary.kind,
                workspace_id: summary.workspace_id,
                directory: summary.directory,
                private_workspace_id: summary.private_workspace_id,
                created_at: summary.created_at,
                updated_at: summary.updated_at,
                composer: PendingSessionDraftComposerPayload {
                    mode: summary.composer.mode,
                    parts: summary.composer.parts,
                    attachments: vec![
                        PendingSessionDraftAttachmentPayload {
                            id: "attachment-image".to_string(),
                            name: "diagram.png".to_string(),
                            mime_type: "image/png".to_string(),
                            size: 4,
                            kind: "image".to_string(),
                            bytes: vec![0, 1, 2, 3],
                        },
                        PendingSessionDraftAttachmentPayload {
                            id: "attachment-doc".to_string(),
                            name: "notes.txt".to_string(),
                            mime_type: "text/plain".to_string(),
                            size: 5,
                            kind: "file".to_string(),
                            bytes: b"hello".to_vec(),
                        },
                    ],
                    text: summary.composer.text,
                    resolved_text: summary.composer.resolved_text,
                    command: summary.composer.command,
                },
            },
            attachment_failures: Vec::new(),
        }
    }

    #[test]
    fn put_persists_metadata_and_copied_attachments_and_lists_summary() {
        let dir = TestDir::new();
        let input = sample_put_input();

        let written = put_pending_session_draft(dir.path(), input).expect("draft should be saved");

        assert_eq!(written, expected_summary());

        let draft_json_path = dir.path().join("draft-1").join("draft.json");
        assert!(draft_json_path.exists(), "draft.json should exist");
        let draft_json =
            fs::read_to_string(&draft_json_path).expect("draft.json should be readable");
        let persisted: PendingSessionDraftSummary =
            serde_json::from_str(&draft_json).expect("draft.json should parse");
        assert_eq!(persisted, expected_summary());

        let draft_dir = dir.path().join("draft-1");
        let image_path = attachment_file_path(&draft_dir, "attachment-image");
        let doc_path = attachment_file_path(&draft_dir, "attachment-doc");
        assert_eq!(
            fs::read(&image_path).expect("image copy should exist"),
            vec![0, 1, 2, 3]
        );
        assert_eq!(
            fs::read(&doc_path).expect("doc copy should exist"),
            b"hello".to_vec()
        );

        let listed = list_pending_session_drafts(dir.path()).expect("list should succeed");
        assert_eq!(listed, vec![expected_summary()]);
    }

    #[test]
    fn put_accepts_attachment_ids_built_from_normal_filenames() {
        let dir = TestDir::new();
        let attachment_id = "diagram v2.png-1713739918018-k4m2d9";

        let written = put_pending_session_draft(
            dir.path(),
            sample_put_input_with_attachment_id(attachment_id),
        )
        .expect("draft should be saved");

        assert_eq!(written.composer.attachments[0].id, attachment_id);

        let loaded = get_pending_session_draft(dir.path(), "draft-1")
            .expect("load should succeed")
            .expect("draft should exist");
        assert_eq!(loaded.draft.composer.attachments[0].id, attachment_id);
        assert_eq!(loaded.draft.composer.attachments[0].bytes, vec![0, 1, 2, 3]);
    }

    #[test]
    fn put_preserves_last_good_draft_when_commit_swap_fails() {
        let dir = TestDir::new();
        put_pending_session_draft(dir.path(), sample_put_input()).expect("draft should be saved");

        let mut updated = sample_put_input();
        updated.updated_at = 1_710_000_001_000;
        updated.composer.text = "Updated draft text".to_string();
        updated.composer.resolved_text = Some("Updated draft text".to_string());

        let error = put_pending_session_draft_with_commit_hook(dir.path(), updated, |target_dir| {
            fs::write(target_dir, b"conflict").map_err(|write_error| {
                format!(
                    "failed to create injected conflict at {}: {write_error}",
                    target_dir.display()
                )
            })
        })
        .expect_err("injected commit conflict should fail");
        assert!(error.contains("Failed to move draft"));

        let loaded = get_pending_session_draft(dir.path(), "draft-1")
            .expect("load should still succeed")
            .expect("previous draft should remain");
        assert_eq!(loaded, expected_get_result());
    }

    #[test]
    fn get_recovers_backup_only_draft_when_live_path_is_missing() {
        let dir = TestDir::new();
        put_pending_session_draft(dir.path(), sample_put_input()).expect("draft should be saved");

        let live_dir = dir.path().join("draft-1");
        let backup_dir = dir
            .path()
            .join(".pending-session-draft-backup-draft-1-manual");
        fs::rename(&live_dir, &backup_dir).expect("draft should be moved to backup-only state");

        let loaded = get_pending_session_draft(dir.path(), "draft-1")
            .expect("load should succeed")
            .expect("backup draft should be recovered");

        assert_eq!(loaded, expected_get_result());
        assert!(live_dir.exists(), "live draft path should be restored");
    }

    #[test]
    fn list_recovers_backup_only_draft_when_live_path_is_missing() {
        let dir = TestDir::new();
        put_pending_session_draft(dir.path(), sample_put_input()).expect("draft should be saved");

        let live_dir = dir.path().join("draft-1");
        let backup_dir = dir
            .path()
            .join(".pending-session-draft-backup-draft-1-manual");
        fs::rename(&live_dir, &backup_dir).expect("draft should be moved to backup-only state");

        let listed = list_pending_session_drafts(dir.path()).expect("list should succeed");

        assert_eq!(listed, vec![expected_summary()]);
        assert!(live_dir.exists(), "live draft path should be restored");
    }

    #[test]
    fn list_skips_corrupt_draft_directories_and_returns_valid_drafts() {
        let dir = TestDir::new();
        put_pending_session_draft(dir.path(), sample_put_input()).expect("draft should be saved");

        let corrupt_dir = dir.path().join("corrupt-draft");
        fs::create_dir_all(&corrupt_dir).expect("corrupt draft dir should exist");
        fs::write(corrupt_dir.join("draft.json"), "{not valid json")
            .expect("corrupt draft file should be written");

        let listed = list_pending_session_drafts(dir.path()).expect("list should succeed");
        assert_eq!(listed, vec![expected_summary()]);
    }

    #[test]
    fn get_round_trips_metadata_and_attachment_bytes() {
        let dir = TestDir::new();
        put_pending_session_draft(dir.path(), sample_put_input()).expect("draft should be saved");

        let loaded = get_pending_session_draft(dir.path(), "draft-1")
            .expect("load should succeed")
            .expect("draft should exist");

        assert_eq!(loaded, expected_get_result());
    }

    #[test]
    fn delete_removes_metadata_and_attachment_copies() {
        let dir = TestDir::new();
        put_pending_session_draft(dir.path(), sample_put_input()).expect("draft should be saved");
        let draft_dir = dir.path().join("draft-1");
        let image_path = attachment_file_path(&draft_dir, "attachment-image");

        let deleted =
            delete_pending_session_draft(dir.path(), "draft-1").expect("delete should succeed");

        assert!(deleted, "delete should report success");
        assert!(
            !dir.path().join("draft-1").join("draft.json").exists(),
            "draft.json should be removed"
        );
        assert!(
            !image_path.exists(),
            "encoded attachment copy should be removed"
        );
        assert_eq!(
            get_pending_session_draft(dir.path(), "draft-1").expect("get should succeed"),
            None
        );
        assert_eq!(
            list_pending_session_drafts(dir.path()).expect("list should succeed"),
            Vec::<PendingSessionDraftSummary>::new()
        );
    }

    #[test]
    fn delete_removes_stale_backups_so_draft_cannot_be_resurrected() {
        let dir = TestDir::new();
        put_pending_session_draft(dir.path(), sample_put_input()).expect("draft should be saved");

        let mut updated = sample_put_input();
        updated.updated_at = 1_710_000_001_000;
        updated.composer.text = "Updated draft text".to_string();
        updated.composer.resolved_text = Some("Updated draft text".to_string());
        put_pending_session_draft_with_commit_hooks(
            dir.path(),
            updated,
            |_target_dir: &Path| Ok(()),
            |backup_dir: &Path| {
                Err(format!(
                    "simulated cleanup failure for {}",
                    backup_dir.display()
                ))
            },
        )
        .expect("save should succeed despite backup cleanup failure");

        let stale_backups =
            latest_pending_session_draft_backup_dirs(dir.path()).expect("backup scan should work");
        assert_eq!(
            stale_backups.len(),
            1,
            "stale backup should exist before delete"
        );

        let deleted =
            delete_pending_session_draft(dir.path(), "draft-1").expect("delete should succeed");

        assert!(deleted, "delete should report success");
        assert_eq!(
            get_pending_session_draft(dir.path(), "draft-1").expect("get should succeed"),
            None,
            "deleted draft should not be recoverable from stale backup"
        );
        assert_eq!(
            list_pending_session_drafts(dir.path()).expect("list should succeed"),
            Vec::<PendingSessionDraftSummary>::new(),
            "deleted draft should not reappear in list"
        );
        assert!(
            latest_pending_session_draft_backup_dirs(dir.path())
                .expect("backup scan should work")
                .is_empty(),
            "delete should remove stale backup artifacts"
        );
    }

    #[test]
    fn put_rejects_duplicate_attachment_ids_within_one_draft() {
        let dir = TestDir::new();
        let mut input = sample_put_input();
        input.composer.attachments[1].id = input.composer.attachments[0].id.clone();

        let error =
            put_pending_session_draft(dir.path(), input).expect_err("duplicate ids should fail");

        assert!(error.contains("duplicate attachment.id"));
    }

    #[test]
    fn put_rejects_directory_draft_without_directory() {
        let dir = TestDir::new();
        let mut input = sample_put_input();
        input.directory = None;

        let error = put_pending_session_draft(dir.path(), input)
            .expect_err("directory draft without directory should fail");

        assert!(error.contains("directory drafts require directory"));
    }

    #[test]
    fn put_rejects_directory_draft_with_private_workspace_id() {
        let dir = TestDir::new();
        let mut input = sample_put_input();
        input.private_workspace_id = Some("private-workspace-1".to_string());

        let error = put_pending_session_draft(dir.path(), input)
            .expect_err("directory draft with private workspace id should fail");

        assert!(error.contains("directory drafts must not include private_workspace_id"));
    }

    #[test]
    fn put_rejects_new_private_draft_without_private_workspace_id() {
        let dir = TestDir::new();
        let mut input = sample_new_private_put_input();
        input.private_workspace_id = None;

        let error = put_pending_session_draft(dir.path(), input)
            .expect_err("new-private draft without private workspace id should fail");

        assert!(error.contains("new-private drafts require private_workspace_id"));
    }

    #[test]
    fn put_rejects_new_private_draft_with_directory() {
        let dir = TestDir::new();
        let mut input = sample_new_private_put_input();
        input.directory = Some("/tmp/workspace".to_string());

        let error = put_pending_session_draft(dir.path(), input)
            .expect_err("new-private draft with directory should fail");

        assert!(error.contains("new-private drafts must not include directory"));
    }

    #[test]
    fn put_succeeds_when_backup_cleanup_fails_after_new_draft_is_active() {
        let dir = TestDir::new();
        put_pending_session_draft(dir.path(), sample_put_input()).expect("draft should be saved");

        let mut updated = sample_put_input();
        updated.updated_at = 1_710_000_001_000;
        updated.composer.text = "Updated draft text".to_string();
        updated.composer.resolved_text = Some("Updated draft text".to_string());

        let written = put_pending_session_draft_with_commit_hooks(
            dir.path(),
            updated,
            |_target_dir: &Path| Ok(()),
            |backup_dir: &Path| {
                Err(format!(
                    "simulated cleanup failure for {}",
                    backup_dir.display()
                ))
            },
        )
        .expect("save should succeed despite backup cleanup failure");

        assert_eq!(written.updated_at, 1_710_000_001_000);
        let loaded = get_pending_session_draft(dir.path(), "draft-1")
            .expect("load should succeed")
            .expect("updated draft should exist");
        assert_eq!(loaded.draft.composer.text, "Updated draft text");
    }

    #[test]
    fn get_reports_broken_attachment_as_recoverable_failure() {
        let dir = TestDir::new();
        put_pending_session_draft(dir.path(), sample_put_input()).expect("draft should be saved");

        let broken_path = attachment_file_path(&dir.path().join("draft-1"), "attachment-doc");
        fs::remove_file(&broken_path).expect("attachment file should be removed");
        fs::create_dir(&broken_path).expect("broken attachment path should be a directory");

        let loaded = get_pending_session_draft(dir.path(), "draft-1")
            .expect("load should succeed")
            .expect("draft should exist");

        assert_eq!(loaded.draft.id, "draft-1");
        assert_eq!(loaded.draft.composer.text, "Review this file");
        assert_eq!(loaded.draft.composer.attachments.len(), 1);
        assert_eq!(loaded.draft.composer.attachments[0].id, "attachment-image");
        assert_eq!(loaded.attachment_failures.len(), 1);
        assert_eq!(
            loaded.attachment_failures[0].attachment_id,
            "attachment-doc".to_string()
        );
        assert_eq!(loaded.attachment_failures[0].name, "notes.txt".to_string());
        assert!(
            loaded.attachment_failures[0]
                .message
                .contains("Failed to read"),
            "failure message should stay readable for a broken attachment copy"
        );
    }

    #[test]
    fn test_dirs_are_unique_under_parallel_construction() {
        let worker_count = 128;
        let barrier = Arc::new(Barrier::new(worker_count));
        let paths = Arc::new(Mutex::new(Vec::with_capacity(worker_count)));
        let mut workers = Vec::with_capacity(worker_count);

        for _ in 0..worker_count {
            let barrier = Arc::clone(&barrier);
            let paths = Arc::clone(&paths);
            workers.push(thread::spawn(move || {
                barrier.wait();
                let dir = TestDir::new();
                paths
                    .lock()
                    .expect("paths mutex should be available")
                    .push(dir.path().to_path_buf());
            }));
        }

        for worker in workers {
            worker.join().expect("worker should complete");
        }

        let paths = paths.lock().expect("paths mutex should be available");
        let unique_paths: std::collections::HashSet<_> = paths.iter().cloned().collect();
        assert_eq!(
            unique_paths.len(),
            worker_count,
            "parallel test roots should not collide"
        );
    }
}
