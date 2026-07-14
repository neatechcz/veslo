use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::veslo_server::manager::VesloServerManager;

const PENDING_FILE: &str = "pending.jsonl";
const FLUSHING_PREFIX: &str = "flushing-";
const SPOOL_MAX_BYTES: u64 = 50 * 1024 * 1024; // 50 MB before retention drop
const RETENTION_LOW_BYTES: u64 = 35 * 1024 * 1024; // truncate down to ~35 MB
const MAX_EVENTS_PER_BATCH: usize = 500;
const MAX_LOG_LINE_BYTES: usize = 64 * 1024;
const MAX_DIAGNOSTIC_TEXT_BYTES: usize = 16 * 1024;
const MAX_RESPONSE_BODY_EXCERPT_BYTES: usize = 1024;
const MAX_BATCH_BODY_BYTES: usize = 224 * 1024;
const BATCH_SIZE_PROBE_ID: &str = "00000000-0000-0000-0000-000000000000";
const INSTALL_ID_FILE: &str = "install-id.txt";
const REDACTED: &str = "[redacted]";
const DIRECT_FALLBACK_FAILURE_BACKOFF: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug)]
pub enum LogStream {
    Stdout,
    Stderr,
    Diagnostic,
}

impl LogStream {
    fn as_str(self) -> &'static str {
        match self {
            LogStream::Stdout => "stdout",
            LogStream::Stderr => "stderr",
            LogStream::Diagnostic => "diagnostic",
        }
    }
}

#[derive(Clone, Debug)]
pub struct CloudDiagnosticsContext {
    den_api_base: String,
    token: String,
    user_id: String,
    org_id: String,
    workspace_id: Option<String>,
}

#[derive(Serialize)]
struct DebugLogEvent {
    id: String,
    #[serde(rename = "userId")]
    user_id: String,
    #[serde(rename = "orgId")]
    org_id: String,
    #[serde(rename = "workspaceId")]
    workspace_id: String,
    source: String,
    stream: String,
    timestamp: u128,
    #[serde(rename = "sequenceNo")]
    sequence_no: u64,
    payload: serde_json::Value,
}

pub struct DebugLogsForwarder {
    spool_dir: PathBuf,
    pending_path: PathBuf,
    install_id: String,
    boot_id: String,
    cloud_context: Mutex<Option<CloudDiagnosticsContext>>,
    direct_fallback_retry_after: Mutex<Option<SystemTime>>,
    direct_fallback_retry_files: Mutex<HashSet<PathBuf>>,
    local_cloud_upload_disabled_log_after: Mutex<Option<SystemTime>>,
    write_lock: Mutex<()>,
    sequence: AtomicU64,
}

#[derive(Debug)]
enum PostBatchError {
    Status {
        status: u16,
        body_excerpt: Option<String>,
    },
    Transport(String),
}

#[derive(Debug, PartialEq, Eq)]
enum LocalPostResult {
    CloudUploaded,
    CloudNotUploaded,
}

impl std::fmt::Display for PostBatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PostBatchError::Status {
                status,
                body_excerpt,
            } => {
                if let Some(excerpt) = body_excerpt {
                    write!(f, "HTTP {status}: {excerpt}")
                } else {
                    write!(f, "HTTP {status}")
                }
            }
            PostBatchError::Transport(message) => write!(f, "{message}"),
        }
    }
}

impl PostBatchError {
    fn status_code(&self) -> Option<u16> {
        match self {
            PostBatchError::Status { status, .. } => Some(*status),
            PostBatchError::Transport(_) => None,
        }
    }
}

fn truncate_utf8_to_bytes(input: &str, max_bytes: usize) -> String {
    if input.len() <= max_bytes {
        return input.to_string();
    }
    const SUFFIX: &str = "...[truncated]";
    let limit = max_bytes.saturating_sub(SUFFIX.len());
    if limit == 0 {
        return SUFFIX.chars().take(max_bytes).collect();
    }
    let mut end = limit.min(input.len());
    while end > 0 && !input.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &input[..end], SUFFIX)
}

fn load_or_create_install_id(spool_dir: &Path) -> String {
    let path = spool_dir.join(INSTALL_ID_FILE);
    if let Ok(raw) = fs::read_to_string(&path) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let install_id = Uuid::new_v4().to_string();
    let _ = fs::write(&path, format!("{install_id}\n"));
    install_id
}

fn is_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.contains("token")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("authorization")
        || lower.contains("credential")
        || lower.contains("apikey")
        || lower.contains("api_key")
        || lower.contains("accesskey")
        || lower.contains("access_key")
        || lower.contains("refreshkey")
        || lower.contains("refresh_key")
        || lower.contains("verifier")
        || lower == "code"
        || lower.ends_with("_code")
        || lower.ends_with("-code")
}

fn is_tail_key(key: Option<&str>) -> bool {
    let Some(key) = key else {
        return false;
    };
    let lower = key.to_ascii_lowercase();
    lower.contains("stdout") || lower.contains("stderr") || lower.contains("tail")
}

fn redact_home_paths(input: &str) -> String {
    let mut out = input.to_string();
    if let Ok(home) = std::env::var("HOME") {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            out = out.replace(trimmed, "[home]");
        }
    }

    out = redact_path_segment(&out, "/Users/", '/');
    out = redact_path_segment(&out, "/home/", '/');
    out = redact_path_segment(&out, "\\Users\\", '\\');
    out
}

fn redact_path_segment(input: &str, marker: &str, separator: char) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(idx) = rest.find(marker) {
        out.push_str(&rest[..idx]);
        out.push_str(marker);
        out.push_str("[user]");
        let after_marker = &rest[idx + marker.len()..];
        match after_marker.find(separator) {
            Some(next_separator) => {
                rest = &after_marker[next_separator..];
            }
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn strip_url_query_values(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    loop {
        let http_idx = rest.find("http://");
        let https_idx = rest.find("https://");
        let idx = match (http_idx, https_idx) {
            (Some(http_idx), Some(https_idx)) => http_idx.min(https_idx),
            (Some(http_idx), None) => http_idx,
            (None, Some(https_idx)) => https_idx,
            (None, None) => {
                output.push_str(rest);
                break;
            }
        };
        output.push_str(&rest[..idx]);
        let urlish = &rest[idx..];
        let end = urlish
            .find(|ch: char| ch.is_whitespace() || matches!(ch, '"' | '\'' | '<' | '>'))
            .unwrap_or(urlish.len());
        output.push_str(&strip_single_url_query_values(&urlish[..end]));
        rest = &urlish[end..];
    }
    output
}

fn strip_single_url_query_values(input: &str) -> String {
    let Some(query_start) = input.find('?') else {
        return input.to_string();
    };

    let (base, query_and_fragment) = input.split_at(query_start);
    let query_and_fragment = &query_and_fragment[1..];
    let (query, fragment) = match query_and_fragment.find('#') {
        Some(idx) => (&query_and_fragment[..idx], &query_and_fragment[idx..]),
        None => (query_and_fragment, ""),
    };
    if query.is_empty() {
        return format!("{base}?{fragment}");
    }

    let stripped = query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let key = part.split_once('=').map(|(key, _)| key).unwrap_or(part);
            format!("{key}={REDACTED}")
        })
        .collect::<Vec<_>>()
        .join("&");
    format!("{base}?{stripped}{fragment}")
}

fn redact_inline_secret_assignments(input: &str) -> String {
    let mut out = input.to_string();
    for key in [
        "token",
        "secret",
        "password",
        "authorization",
        "api_key",
        "apikey",
    ] {
        out = redact_inline_secret_key(&out, key);
    }
    out
}

fn redact_inline_authorization(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let lower = input.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(relative_idx) = lower[cursor..].find("bearer ") {
        let idx = cursor + relative_idx;
        let value_start = idx + "bearer ".len();
        out.push_str(&input[cursor..value_start]);
        out.push_str(REDACTED);
        let mut end = value_start;
        while end < input.len() {
            let ch = input[end..].chars().next().unwrap();
            if ch.is_whitespace() || matches!(ch, ',' | ';' | '&') {
                break;
            }
            end += ch.len_utf8();
        }
        cursor = end;
    }
    out.push_str(&input[cursor..]);
    out
}

fn redact_inline_secret_key(input: &str, key: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let lower = input.to_ascii_lowercase();
    let needle = format!("{key}=");
    let mut cursor = 0;
    while let Some(relative_idx) = lower[cursor..].find(&needle) {
        let idx = cursor + relative_idx;
        out.push_str(&input[cursor..idx + needle.len()]);
        out.push_str(REDACTED);
        let mut end = idx + needle.len();
        while end < input.len() {
            let ch = input[end..].chars().next().unwrap();
            if ch.is_whitespace() || matches!(ch, ',' | ';' | '&') {
                break;
            }
            end += ch.len_utf8();
        }
        cursor = end;
    }
    out.push_str(&input[cursor..]);
    out
}

fn sanitize_diagnostic_string(input: &str, truncate: bool) -> String {
    let stripped_url = strip_url_query_values(input);
    let redacted_paths = redact_home_paths(&stripped_url);
    let redacted_secrets = redact_inline_secret_assignments(&redacted_paths);
    let redacted_secrets = redact_inline_authorization(&redacted_secrets);
    if truncate {
        truncate_utf8_to_bytes(&redacted_secrets, MAX_DIAGNOSTIC_TEXT_BYTES)
    } else {
        redacted_secrets
    }
}

fn sanitize_diagnostic_value(key: Option<&str>, value: serde_json::Value) -> serde_json::Value {
    if key.map(is_secret_key).unwrap_or(false) {
        return serde_json::Value::String(REDACTED.to_string());
    }

    match value {
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .into_iter()
                .map(|item| sanitize_diagnostic_value(None, item))
                .collect(),
        ),
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    let sanitized = sanitize_diagnostic_value(Some(&key), value);
                    (key, sanitized)
                })
                .collect(),
        ),
        serde_json::Value::String(value) => {
            serde_json::Value::String(sanitize_diagnostic_string(&value, is_tail_key(key)))
        }
        other => other,
    }
}

fn sanitize_diagnostic_payload(payload: serde_json::Value) -> serde_json::Value {
    sanitize_diagnostic_value(None, payload)
}

impl DebugLogsForwarder {
    pub fn new(spool_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&spool_dir);
        let pending_path = spool_dir.join(PENDING_FILE);
        let install_id = load_or_create_install_id(&spool_dir);
        Self {
            spool_dir,
            pending_path,
            install_id,
            boot_id: Uuid::new_v4().to_string(),
            cloud_context: Mutex::new(None),
            direct_fallback_retry_after: Mutex::new(None),
            direct_fallback_retry_files: Mutex::new(HashSet::new()),
            local_cloud_upload_disabled_log_after: Mutex::new(None),
            write_lock: Mutex::new(()),
            sequence: AtomicU64::new(0),
        }
    }

    pub fn install_id(&self) -> &str {
        &self.install_id
    }

    pub fn boot_id(&self) -> &str {
        &self.boot_id
    }

    pub fn set_cloud_diagnostics_context(
        &self,
        den_api_base: String,
        token: String,
        user_id: String,
        org_id: String,
        workspace_id: Option<String>,
    ) {
        let context = CloudDiagnosticsContext {
            den_api_base: den_api_base.trim().to_string(),
            token: token.trim().to_string(),
            user_id: user_id.trim().to_string(),
            org_id: org_id.trim().to_string(),
            workspace_id: workspace_id.and_then(|value| {
                let trimmed = value.trim().to_string();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            }),
        };

        if let Ok(mut guard) = self.cloud_context.lock() {
            *guard = Some(context);
        }
    }

    pub fn clear_cloud_diagnostics_context(&self) {
        if let Ok(mut guard) = self.cloud_context.lock() {
            *guard = None;
        }
    }

    fn cloud_context_snapshot(&self) -> Option<CloudDiagnosticsContext> {
        self.cloud_context
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    fn should_attempt_direct_fallback(&self, now: SystemTime) -> bool {
        let Ok(guard) = self.direct_fallback_retry_after.lock() else {
            return true;
        };

        guard
            .as_ref()
            .map(|retry_after| now >= *retry_after)
            .unwrap_or(true)
    }

    fn record_direct_fallback_failure(&self, now: SystemTime) {
        if let Ok(mut guard) = self.direct_fallback_retry_after.lock() {
            *guard = Some(now + DIRECT_FALLBACK_FAILURE_BACKOFF);
        }
    }

    fn record_missing_direct_fallback_context(&self, now: SystemTime) -> bool {
        if !self.should_attempt_direct_fallback(now) {
            return false;
        }
        self.record_direct_fallback_failure(now);
        true
    }

    fn record_local_cloud_upload_disabled(&self, now: SystemTime) -> bool {
        let Ok(mut guard) = self.local_cloud_upload_disabled_log_after.lock() else {
            return true;
        };
        if guard
            .as_ref()
            .map(|retry_after| now < *retry_after)
            .unwrap_or(false)
        {
            return false;
        }
        *guard = Some(now + DIRECT_FALLBACK_FAILURE_BACKOFF);
        true
    }

    fn mark_direct_fallback_retry_file(&self, path: &Path) {
        if let Ok(mut guard) = self.direct_fallback_retry_files.lock() {
            guard.insert(path.to_path_buf());
        }
    }

    fn clear_direct_fallback_retry_file(&self, path: &Path) {
        if let Ok(mut guard) = self.direct_fallback_retry_files.lock() {
            guard.remove(path);
        }
    }

    fn is_direct_fallback_retry_file(&self, path: &Path) -> bool {
        self.direct_fallback_retry_files
            .lock()
            .map(|guard| guard.contains(path))
            .unwrap_or(false)
    }

    fn record_direct_fallback_success(&self, path: &Path) {
        self.clear_direct_fallback_retry_file(path);
        if let Ok(mut guard) = self.direct_fallback_retry_after.lock() {
            *guard = None;
        }
    }

    pub fn append(&self, source: &str, stream: LogStream, line: &str) {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed.is_empty() {
            return;
        }
        let trimmed = truncate_utf8_to_bytes(trimmed, MAX_LOG_LINE_BYTES);
        self.append_event(
            source,
            stream,
            serde_json::json!({ "line": trimmed }),
            self.cloud_context_snapshot(),
        );
    }

    pub fn append_bootstrap_diagnostic(&self, event_type: &str, payload: serde_json::Value) {
        let event_type = event_type.trim();
        if event_type.is_empty() {
            return;
        }
        let sanitized = sanitize_diagnostic_payload(payload);
        let mut payload = match sanitized {
            serde_json::Value::Object(map) => map,
            other => {
                let mut map = serde_json::Map::new();
                map.insert("value".to_string(), other);
                map
            }
        };
        payload.insert(
            "eventType".to_string(),
            serde_json::Value::String(event_type.to_string()),
        );
        self.append_event(
            "Veslo bootstrap",
            LogStream::Diagnostic,
            serde_json::Value::Object(payload),
            self.cloud_context_snapshot(),
        );
    }

    fn append_event(
        &self,
        source: &str,
        stream: LogStream,
        mut payload: serde_json::Value,
        context: Option<CloudDiagnosticsContext>,
    ) {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let sequence_no = self.sequence.fetch_add(1, Ordering::Relaxed);

        let diagnostics = self.diagnostics_payload(context.as_ref());
        match &mut payload {
            serde_json::Value::Object(map) => {
                map.insert("diagnostics".to_string(), diagnostics);
            }
            _ => {
                payload = serde_json::json!({
                    "value": payload,
                    "diagnostics": diagnostics,
                });
            }
        }

        let event = DebugLogEvent {
            id: Uuid::new_v4().to_string(),
            user_id: context
                .as_ref()
                .map(|value| value.user_id.clone())
                .unwrap_or_default(),
            org_id: context
                .as_ref()
                .map(|value| value.org_id.clone())
                .unwrap_or_default(),
            workspace_id: context
                .as_ref()
                .and_then(|value| value.workspace_id.clone())
                .unwrap_or_default(),
            source: source.to_string(),
            stream: stream.as_str().to_string(),
            timestamp,
            sequence_no,
            payload,
        };

        let serialized = match serde_json::to_string(&event) {
            Ok(s) => s,
            Err(_) => return,
        };

        let _guard = match self.write_lock.lock() {
            Ok(g) => g,
            Err(_) => return,
        };

        if let Err(error) = self.enforce_retention() {
            eprintln!("[debug-logs-forwarder] retention error: {error}");
        }

        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.pending_path)
        {
            let _ = writeln!(file, "{}", serialized);
        }
    }

    fn diagnostics_payload(&self, context: Option<&CloudDiagnosticsContext>) -> serde_json::Value {
        let mut diagnostics = serde_json::Map::new();
        diagnostics.insert(
            "installId".to_string(),
            serde_json::Value::String(self.install_id.clone()),
        );
        diagnostics.insert(
            "bootId".to_string(),
            serde_json::Value::String(self.boot_id.clone()),
        );
        if let Some(context) = context {
            diagnostics.insert(
                "userId".to_string(),
                serde_json::Value::String(context.user_id.clone()),
            );
            diagnostics.insert(
                "orgId".to_string(),
                serde_json::Value::String(context.org_id.clone()),
            );
            if let Some(workspace_id) = context.workspace_id.as_ref() {
                diagnostics.insert(
                    "workspaceId".to_string(),
                    serde_json::Value::String(workspace_id.clone()),
                );
            }
        }
        serde_json::Value::Object(diagnostics)
    }

    fn enforce_retention(&self) -> std::io::Result<()> {
        let metadata = match fs::metadata(&self.pending_path) {
            Ok(m) => m,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };

        let size = metadata.len();
        if size <= SPOOL_MAX_BYTES {
            return Ok(());
        }

        let raw = fs::read_to_string(&self.pending_path)?;
        let bytes_to_keep = RETENTION_LOW_BYTES as usize;
        if raw.len() <= bytes_to_keep {
            return Ok(());
        }
        let start = raw.len().saturating_sub(bytes_to_keep);
        // Skip ahead to the next newline so we don't keep a half line.
        let kept = match raw[start..].find('\n') {
            Some(idx) => &raw[start + idx + 1..],
            None => "",
        };
        fs::write(&self.pending_path, kept)?;
        Ok(())
    }

    fn rotate_pending(&self) -> std::io::Result<Option<PathBuf>> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "lock poisoned"))?;

        if !self.pending_path.exists() {
            return Ok(None);
        }
        let metadata = fs::metadata(&self.pending_path)?;
        if metadata.len() == 0 {
            return Ok(None);
        }

        let target = self
            .spool_dir
            .join(format!("{FLUSHING_PREFIX}{}.jsonl", Uuid::new_v4()));
        fs::rename(&self.pending_path, &target)?;
        Ok(Some(target))
    }

    fn list_flushing_files(&self) -> std::io::Result<Vec<PathBuf>> {
        let mut out = Vec::new();
        let entries = match fs::read_dir(&self.spool_dir) {
            Ok(e) => e,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(error) => return Err(error),
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name_str) = name.to_str() else {
                continue;
            };
            if name_str.starts_with(FLUSHING_PREFIX) && name_str.ends_with(".jsonl") {
                out.push(entry.path());
            }
        }
        out.sort();
        Ok(out)
    }
}

fn parse_events(path: &PathBuf) -> std::io::Result<Vec<serde_json::Value>> {
    let raw = fs::read_to_string(path)?;
    let mut out = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(value) => out.push(value),
            Err(error) => {
                eprintln!("[debug-logs-forwarder] skipping malformed line: {error}");
            }
        }
    }
    Ok(out)
}

fn batch_body_len(batch_id: &str, events: &[serde_json::Value]) -> Option<usize> {
    serde_json::to_vec(&serde_json::json!({
        "batchId": batch_id,
        "events": events,
    }))
    .ok()
    .map(|bytes| bytes.len())
}

fn build_event_batches(events: Vec<serde_json::Value>) -> (Vec<Vec<serde_json::Value>>, usize) {
    let mut batches = Vec::new();
    let mut current: Vec<serde_json::Value> = Vec::new();
    let mut dropped = 0;

    for event in events {
        if current.len() >= MAX_EVENTS_PER_BATCH {
            batches.push(std::mem::take(&mut current));
        }

        let mut tentative = current.clone();
        tentative.push(event.clone());
        if batch_body_len(BATCH_SIZE_PROBE_ID, &tentative)
            .map(|len| len <= MAX_BATCH_BODY_BYTES)
            .unwrap_or(false)
        {
            current.push(event);
            continue;
        }

        if !current.is_empty() {
            batches.push(std::mem::take(&mut current));
        }

        if batch_body_len(BATCH_SIZE_PROBE_ID, std::slice::from_ref(&event))
            .map(|len| len <= MAX_BATCH_BODY_BYTES)
            .unwrap_or(false)
        {
            current.push(event);
        } else {
            dropped += 1;
        }
    }

    if !current.is_empty() {
        batches.push(current);
    }

    (batches, dropped)
}

fn parse_local_cloud_upload_enabled(body: &str) -> Option<bool> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .map(|value| value.get("cloudUploadEnabled").and_then(|v| v.as_bool()) == Some(true))
}

fn is_direct_fallback_event(event: &serde_json::Value) -> bool {
    let source = event
        .get("source")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let stream = event
        .get("stream")
        .and_then(|value| value.as_str())
        .unwrap_or_default();

    if source == "veslo-server-shell" && matches!(stream, "stdout" | "stderr") {
        return true;
    }
    if source != "Veslo bootstrap" || stream != "diagnostic" {
        return false;
    }

    let event_type = event
        .get("payload")
        .and_then(|payload| payload.get("eventType"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();

    event_type.starts_with("desktop-auth:")
        || event_type.starts_with("new-session:")
        || event_type.starts_with("updater:")
        || event_type.starts_with("veslo-server-launch:")
        || event_type.starts_with("session-archives:")
        || event_type.starts_with("debug-log-delivery:")
}

fn write_events_file(path: &PathBuf, events: &[serde_json::Value]) -> std::io::Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)?;
    for event in events {
        let line = serde_json::to_string(event)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        writeln!(file, "{line}")?;
    }
    Ok(())
}

fn response_body_excerpt(body: &str) -> Option<String> {
    let excerpt = truncate_utf8_to_bytes(
        &sanitize_diagnostic_string(body, false),
        MAX_RESPONSE_BODY_EXCERPT_BYTES,
    );
    let trimmed = excerpt.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn response_status_error(status: u16, response: Option<ureq::Response>) -> PostBatchError {
    let body_excerpt = response
        .and_then(|response| response.into_string().ok())
        .and_then(|body| response_body_excerpt(&body));
    PostBatchError::Status {
        status,
        body_excerpt,
    }
}

fn is_invalid_direct_fallback_error(error: &PostBatchError) -> bool {
    error.status_code() == Some(400)
}

fn post_batch(
    base_url: &str,
    host_token: &str,
    batch_id: &str,
    events: Vec<serde_json::Value>,
) -> Result<LocalPostResult, PostBatchError> {
    let url = format!("{}/debug-logs", base_url.trim_end_matches('/'));
    let payload = serde_json::json!({
        "batchId": batch_id,
        "events": events,
    });

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(5))
        .build();

    let response = agent
        .post(&url)
        .set("Content-Type", "application/json")
        .set("x-veslo-host-token", host_token)
        .send_string(&payload.to_string())
        .map_err(|e| match e {
            ureq::Error::Status(status, response) => response_status_error(status, Some(response)),
            other => PostBatchError::Transport(other.to_string()),
        })?;

    if !(200..300).contains(&response.status()) {
        let status = response.status();
        return Err(response_status_error(status, Some(response)));
    }
    let cloud_upload_enabled = response
        .into_string()
        .ok()
        .and_then(|body| parse_local_cloud_upload_enabled(&body))
        .unwrap_or(false);
    if cloud_upload_enabled {
        Ok(LocalPostResult::CloudUploaded)
    } else {
        Ok(LocalPostResult::CloudNotUploaded)
    }
}

fn post_direct_den_batch(
    context: &CloudDiagnosticsContext,
    batch_id: &str,
    events: Vec<serde_json::Value>,
    install_id: &str,
    boot_id: &str,
) -> Result<(), PostBatchError> {
    if context.den_api_base.trim().is_empty() || context.token.trim().is_empty() {
        return Err(PostBatchError::Transport(
            "missing cloud diagnostics context".to_string(),
        ));
    }

    let url = format!(
        "{}/v1/desktop-diagnostics",
        context.den_api_base.trim_end_matches('/')
    );
    let payload = serde_json::json!({
        "batchId": batch_id,
        "events": events,
        "installId": install_id,
        "bootId": boot_id,
        "userId": context.user_id,
        "orgId": context.org_id,
        "workspaceId": context.workspace_id,
        "deliveryPath": "desktop-direct-fallback",
    });

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(5))
        .build();

    let response = agent
        .post(&url)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {}", context.token))
        .send_string(&payload.to_string())
        .map_err(|e| match e {
            ureq::Error::Status(status, response) => response_status_error(status, Some(response)),
            other => PostBatchError::Transport(other.to_string()),
        })?;

    if !(200..300).contains(&response.status()) {
        let status = response.status();
        return Err(response_status_error(status, Some(response)));
    }
    Ok(())
}

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

pub fn spawn_flush_task(
    forwarder: Arc<DebugLogsForwarder>,
    app: AppHandle,
    flush_interval: Duration,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(flush_interval);

        if let Err(error) = forwarder.rotate_pending() {
            eprintln!("[debug-logs-forwarder] rotate error: {error}");
        }

        let files = match forwarder.list_flushing_files() {
            Ok(f) => f,
            Err(error) => {
                eprintln!("[debug-logs-forwarder] list error: {error}");
                continue;
            }
        };

        let local_state = collect_server_state(&app);
        let cloud_context = forwarder.cloud_context_snapshot();
        for file in files {
            let events = match parse_events(&file) {
                Ok(e) => e,
                Err(error) => {
                    eprintln!("[debug-logs-forwarder] read error: {error}");
                    continue;
                }
            };
            if events.is_empty() {
                let _ = fs::remove_file(&file);
                continue;
            }

            let direct_retry_only = forwarder.is_direct_fallback_retry_file(&file);
            if !direct_retry_only {
                if let Some((base_url, host_token)) = local_state.as_ref() {
                    let (batches, dropped) = build_event_batches(events.clone());
                    if dropped > 0 {
                        eprintln!(
                            "[debug-logs-forwarder] dropped {dropped} oversized debug log event(s)"
                        );
                    }

                    let mut local_delivered = true;
                    for chunk_vec in batches {
                        let batch_id = Uuid::new_v4().to_string();
                        match post_batch(base_url, host_token, &batch_id, chunk_vec) {
                            Ok(LocalPostResult::CloudUploaded) => {}
                            Ok(LocalPostResult::CloudNotUploaded) => {
                                // Local 2xx means the server accepted the batch. In dev the
                                // server often has no cloud uploader, and retrying the same
                                // already-accepted events through Den causes invalid-payload spam.
                                if forwarder.record_local_cloud_upload_disabled(SystemTime::now()) {
                                    eprintln!(
                                        "[debug-logs-forwarder] local debug-log post accepted without cloud upload"
                                    );
                                }
                            }
                            Err(error) => {
                                eprintln!(
                                    "[debug-logs-forwarder] local debug-log post failed: {error}, trying direct fallback"
                                );
                                local_delivered = false;
                                break;
                            }
                        }
                    }

                    if local_delivered {
                        let _ = fs::remove_file(&file);
                        continue;
                    }
                }
            }

            let direct_events = events
                .iter()
                .filter(|event| is_direct_fallback_event(event))
                .cloned()
                .collect::<Vec<_>>();
            if direct_events.is_empty() {
                forwarder.clear_direct_fallback_retry_file(&file);
                continue;
            }

            let Some(context) = cloud_context.as_ref() else {
                forwarder.mark_direct_fallback_retry_file(&file);
                if forwarder.record_missing_direct_fallback_context(SystemTime::now()) {
                    eprintln!("[debug-logs-forwarder] direct fallback skipped: missing cloud diagnostics context");
                }
                continue;
            };
            if !forwarder.should_attempt_direct_fallback(SystemTime::now()) {
                forwarder.mark_direct_fallback_retry_file(&file);
                continue;
            }

            let retained_events = events
                .iter()
                .filter(|event| !is_direct_fallback_event(event))
                .cloned()
                .collect::<Vec<_>>();
            let (batches, dropped) = build_event_batches(direct_events);
            if dropped > 0 {
                eprintln!(
                    "[debug-logs-forwarder] dropped {dropped} oversized direct diagnostics event(s)"
                );
            }

            let mut direct_delivered = true;
            let mut direct_invalid = false;
            for chunk_vec in batches {
                let batch_id = Uuid::new_v4().to_string();
                if let Err(error) = post_direct_den_batch(
                    context,
                    &batch_id,
                    chunk_vec,
                    forwarder.install_id(),
                    forwarder.boot_id(),
                ) {
                    if is_invalid_direct_fallback_error(&error) {
                        eprintln!(
                            "[debug-logs-forwarder] direct fallback delivery rejected as invalid payload: {error}"
                        );
                        forwarder.clear_direct_fallback_retry_file(&file);
                        direct_invalid = true;
                        break;
                    }
                    eprintln!("[debug-logs-forwarder] direct fallback delivery failed: {error}");
                    forwarder.record_direct_fallback_failure(SystemTime::now());
                    forwarder.mark_direct_fallback_retry_file(&file);
                    direct_delivered = false;
                    break;
                }
            }

            if direct_invalid {
                if retained_events.is_empty() {
                    let _ = fs::remove_file(&file);
                } else if let Err(error) = write_events_file(&file, &retained_events) {
                    eprintln!(
                        "[debug-logs-forwarder] failed to retain non-direct debug log events after invalid direct fallback: {error}"
                    );
                }
                continue;
            }

            if !direct_delivered {
                continue;
            }

            forwarder.record_direct_fallback_success(&file);
            if retained_events.is_empty() {
                let _ = fs::remove_file(&file);
            } else if let Err(error) = write_events_file(&file, &retained_events) {
                eprintln!(
                    "[debug-logs-forwarder] failed to retain non-direct debug log events: {error}"
                );
            }
        }
    });
}

#[cfg(test)]
mod batch_tests {
    use super::*;

    #[test]
    fn truncate_utf8_to_bytes_preserves_utf8_boundaries() {
        let input = "\u{017E}".repeat(40_000);
        let truncated = truncate_utf8_to_bytes(&input, 1024);

        assert!(truncated.len() <= 1024);
        assert!(truncated.ends_with("...[truncated]"));
        assert!(std::str::from_utf8(truncated.as_bytes()).is_ok());
    }

    #[test]
    fn build_event_batches_respects_body_byte_limit() {
        let events = (0..20)
            .map(|idx| {
                serde_json::json!({
                    "id": idx,
                    "payload": { "line": "x".repeat(16 * 1024) },
                })
            })
            .collect::<Vec<_>>();

        let (batches, dropped) = build_event_batches(events);

        assert_eq!(dropped, 0);
        assert!(batches.len() > 1);
        for batch in batches {
            let len = batch_body_len(BATCH_SIZE_PROBE_ID, &batch).unwrap();
            assert!(len <= MAX_BATCH_BODY_BYTES, "batch len {len}");
        }
    }

    #[test]
    fn build_event_batches_drops_single_oversized_event() {
        let events = vec![serde_json::json!({
            "id": "too-large",
            "payload": { "line": "x".repeat(MAX_BATCH_BODY_BYTES + 1024) },
        })];

        let (batches, dropped) = build_event_batches(events);

        assert!(batches.is_empty());
        assert_eq!(dropped, 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn append_writes_jsonl_line() {
        let dir = tempdir().unwrap();
        let forwarder = DebugLogsForwarder::new(dir.path().to_path_buf());
        forwarder.append("test", LogStream::Stdout, "hello world");
        let raw = fs::read_to_string(dir.path().join(PENDING_FILE)).unwrap();
        assert!(raw.contains("\"source\":\"test\""));
        assert!(raw.contains("\"stream\":\"stdout\""));
        assert!(raw.contains("hello world"));
    }

    #[test]
    fn install_id_persists_for_spool_dir_and_boot_id_changes_between_instances() {
        let dir = tempdir().unwrap();
        let first = DebugLogsForwarder::new(dir.path().to_path_buf());
        let install_id = first.install_id().to_string();
        let first_boot_id = first.boot_id().to_string();

        let second = DebugLogsForwarder::new(dir.path().to_path_buf());

        assert_eq!(second.install_id(), install_id);
        assert_ne!(second.boot_id(), first_boot_id);
    }

    #[test]
    fn sanitize_diagnostic_payload_redacts_paths_queries_secrets_and_long_tails() {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/tester".to_string());
        let sanitized = sanitize_diagnostic_payload(serde_json::json!({
            "apiToken": "secret-token",
            "codeVerifier": "oauth-secret",
            "nested": { "authorization": "Bearer secret-token" },
            "message": "Request failed with Authorization: Bearer secret-token",
            "path": format!("{home}/Library/Application Support/Veslo/state.json"),
            "url": "https://den.example.test/bootstrap?token=secret-token&workspace=abc",
            "stderrTail": "x".repeat(MAX_DIAGNOSTIC_TEXT_BYTES + 512),
        }));

        assert_eq!(sanitized["apiToken"], "[redacted]");
        assert_eq!(sanitized["codeVerifier"], "[redacted]");
        assert_eq!(sanitized["nested"]["authorization"], "[redacted]");
        assert_eq!(
            sanitized["message"],
            "Request failed with Authorization: Bearer [redacted]"
        );
        assert!(!sanitized["path"].as_str().unwrap().contains(&home));
        assert_eq!(
            sanitized["url"],
            "https://den.example.test/bootstrap?token=[redacted]&workspace=[redacted]"
        );
        let stderr_tail = sanitized["stderrTail"].as_str().unwrap();
        assert!(stderr_tail.ends_with("...[truncated]"));
        assert!(stderr_tail.len() <= MAX_DIAGNOSTIC_TEXT_BYTES);
    }

    #[test]
    fn structured_append_writes_diagnostics_and_cloud_context_ids() {
        let dir = tempdir().unwrap();
        let forwarder = DebugLogsForwarder::new(dir.path().to_path_buf());
        forwarder.set_cloud_diagnostics_context(
            "https://den.example.test".to_string(),
            "secret-token".to_string(),
            "user-1".to_string(),
            "org-1".to_string(),
            Some("workspace-1".to_string()),
        );

        forwarder.append_bootstrap_diagnostic(
            "bootstrap.server_unavailable",
            serde_json::json!({
                "message": "server unavailable",
                "stderrTail": "failed with token=secret-token",
            }),
        );

        let raw = fs::read_to_string(dir.path().join(PENDING_FILE)).unwrap();
        let event: serde_json::Value = serde_json::from_str(raw.lines().next().unwrap()).unwrap();
        assert_eq!(event["userId"], "user-1");
        assert_eq!(event["orgId"], "org-1");
        assert_eq!(event["workspaceId"], "workspace-1");
        assert_eq!(
            event["payload"]["eventType"],
            "bootstrap.server_unavailable"
        );
        assert_eq!(
            event["payload"]["diagnostics"]["installId"],
            forwarder.install_id()
        );
        assert_eq!(
            event["payload"]["diagnostics"]["bootId"],
            forwarder.boot_id()
        );
        assert_eq!(event["payload"]["diagnostics"]["userId"], "user-1");
        assert_eq!(event["payload"]["diagnostics"]["orgId"], "org-1");
        assert_eq!(
            event["payload"]["diagnostics"]["workspaceId"],
            "workspace-1"
        );
        assert!(!event["payload"]["stderrTail"]
            .as_str()
            .unwrap()
            .contains("secret-token"));
    }

    #[test]
    fn local_response_cloud_upload_enabled_is_true_only_when_explicitly_true() {
        assert_eq!(parse_local_cloud_upload_enabled("{}"), Some(false));
        assert_eq!(
            parse_local_cloud_upload_enabled(r#"{"cloudUploadEnabled":false}"#),
            Some(false)
        );
        assert_eq!(
            parse_local_cloud_upload_enabled(r#"{"cloudUploadEnabled":true}"#),
            Some(true)
        );
        assert_eq!(parse_local_cloud_upload_enabled("not json"), None);
    }

    #[test]
    fn direct_fallback_allows_only_bootstrap_and_veslo_server_output_events() {
        assert!(is_direct_fallback_event(&serde_json::json!({
            "source": "Veslo bootstrap",
            "stream": "diagnostic",
            "payload": { "eventType": "new-session:disabled" },
        })));
        assert!(is_direct_fallback_event(&serde_json::json!({
            "source": "Veslo bootstrap",
            "stream": "diagnostic",
            "payload": { "eventType": "session-archives:load-failed" },
        })));
        assert!(is_direct_fallback_event(&serde_json::json!({
            "source": "veslo-server-shell",
            "stream": "stderr",
            "payload": { "line": "server failed" },
        })));
        assert!(!is_direct_fallback_event(&serde_json::json!({
            "source": "Veslo UI",
            "stream": "stderr",
            "payload": { "line": "ordinary ui log" },
        })));
        assert!(!is_direct_fallback_event(&serde_json::json!({
            "source": "Veslo bootstrap",
            "stream": "diagnostic",
            "payload": { "eventType": "unbounded:custom" },
        })));
    }

    #[test]
    fn direct_fallback_allows_updater_diagnostics_only_through_bootstrap_lane() {
        assert!(is_direct_fallback_event(&serde_json::json!({
            "source": "Veslo bootstrap",
            "stream": "diagnostic",
            "payload": { "eventType": "updater:download-end" },
        })));
        assert!(!is_direct_fallback_event(&serde_json::json!({
            "source": "Veslo UI",
            "stream": "stderr",
            "payload": { "eventType": "updater:download-end" },
        })));
    }

    #[test]
    fn direct_fallback_error_excerpt_is_sanitized_and_truncated() {
        let body = format!(
            "invalid token=secret-token url=https://den.example.test/path?token=secret&workspace=abc {}",
            "x".repeat(MAX_RESPONSE_BODY_EXCERPT_BYTES + 512)
        );
        let excerpt = response_body_excerpt(&body).unwrap();

        assert!(excerpt.len() <= MAX_RESPONSE_BODY_EXCERPT_BYTES);
        assert!(excerpt.contains("token=[redacted]"));
        assert!(excerpt.contains("workspace=[redacted]"));
        assert!(!excerpt.contains("secret-token"));
        assert!(!excerpt.contains("token=secret&workspace=abc"));
    }

    #[test]
    fn direct_fallback_status_400_is_invalid_payload() {
        let invalid = PostBatchError::Status {
            status: 400,
            body_excerpt: Some("invalid schema".to_string()),
        };
        let retryable = PostBatchError::Status {
            status: 502,
            body_excerpt: Some("bad gateway".to_string()),
        };

        assert!(is_invalid_direct_fallback_error(&invalid));
        assert!(!is_invalid_direct_fallback_error(&retryable));
        assert_eq!(invalid.to_string(), "HTTP 400: invalid schema");
    }

    #[test]
    fn direct_fallback_failure_backs_off_and_success_clears_backoff() {
        let dir = tempdir().unwrap();
        let forwarder = DebugLogsForwarder::new(dir.path().to_path_buf());
        let flushing_file = dir.path().join("flushing-a.jsonl");
        let now = UNIX_EPOCH + Duration::from_secs(1_000);

        assert!(forwarder.should_attempt_direct_fallback(now));
        assert!(!forwarder.is_direct_fallback_retry_file(&flushing_file));

        forwarder.record_direct_fallback_failure(now);
        forwarder.mark_direct_fallback_retry_file(&flushing_file);
        assert!(!forwarder.should_attempt_direct_fallback(
            now + DIRECT_FALLBACK_FAILURE_BACKOFF - Duration::from_secs(1)
        ));
        assert!(forwarder.should_attempt_direct_fallback(now + DIRECT_FALLBACK_FAILURE_BACKOFF));
        assert!(forwarder.is_direct_fallback_retry_file(&flushing_file));

        forwarder.record_direct_fallback_failure(now);
        forwarder.record_direct_fallback_success(&flushing_file);
        assert!(forwarder.should_attempt_direct_fallback(now));
        assert!(!forwarder.is_direct_fallback_retry_file(&flushing_file));
    }

    #[test]
    fn missing_direct_fallback_context_uses_backoff() {
        let dir = tempdir().unwrap();
        let forwarder = DebugLogsForwarder::new(dir.path().to_path_buf());
        let now = UNIX_EPOCH + Duration::from_secs(1_000);

        assert!(forwarder.record_missing_direct_fallback_context(now));
        assert!(!forwarder.record_missing_direct_fallback_context(
            now + DIRECT_FALLBACK_FAILURE_BACKOFF - Duration::from_secs(1)
        ));
        assert!(
            forwarder.record_missing_direct_fallback_context(now + DIRECT_FALLBACK_FAILURE_BACKOFF)
        );
    }

    #[test]
    fn local_cloud_upload_disabled_log_uses_backoff() {
        let dir = tempdir().unwrap();
        let forwarder = DebugLogsForwarder::new(dir.path().to_path_buf());
        let now = UNIX_EPOCH + Duration::from_secs(1_000);

        assert!(forwarder.record_local_cloud_upload_disabled(now));
        assert!(!forwarder.record_local_cloud_upload_disabled(
            now + DIRECT_FALLBACK_FAILURE_BACKOFF - Duration::from_secs(1)
        ));
        assert!(forwarder.record_local_cloud_upload_disabled(now + DIRECT_FALLBACK_FAILURE_BACKOFF));
    }

    #[test]
    fn append_skips_empty_lines() {
        let dir = tempdir().unwrap();
        let forwarder = DebugLogsForwarder::new(dir.path().to_path_buf());
        forwarder.append("test", LogStream::Stdout, "");
        forwarder.append("test", LogStream::Stdout, "\n");
        let pending = dir.path().join(PENDING_FILE);
        let exists_with_data = pending.exists() && fs::metadata(&pending).unwrap().len() > 0;
        assert!(!exists_with_data, "empty lines must not be persisted");
    }

    #[test]
    fn rotate_moves_pending_to_flushing() {
        let dir = tempdir().unwrap();
        let forwarder = DebugLogsForwarder::new(dir.path().to_path_buf());
        forwarder.append("test", LogStream::Stdout, "line one");
        forwarder.append("test", LogStream::Stderr, "line two");

        let target = forwarder.rotate_pending().unwrap();
        assert!(target.is_some());
        let target_path = target.unwrap();
        assert!(target_path.exists());
        assert!(!dir.path().join(PENDING_FILE).exists());

        let raw = fs::read_to_string(&target_path).unwrap();
        assert_eq!(raw.lines().count(), 2);
    }

    #[test]
    fn rotate_returns_none_when_pending_empty() {
        let dir = tempdir().unwrap();
        let forwarder = DebugLogsForwarder::new(dir.path().to_path_buf());
        let target = forwarder.rotate_pending().unwrap();
        assert!(target.is_none());
    }

    #[test]
    fn list_flushing_files_finds_only_flushing() {
        let dir = tempdir().unwrap();
        let forwarder = DebugLogsForwarder::new(dir.path().to_path_buf());
        // Stale flushing files (e.g. from a prior failed flush)
        fs::write(dir.path().join("flushing-aaa.jsonl"), b"").unwrap();
        fs::write(dir.path().join("flushing-bbb.jsonl"), b"").unwrap();
        fs::write(dir.path().join(PENDING_FILE), b"x").unwrap();
        fs::write(dir.path().join("unrelated.txt"), b"y").unwrap();

        let files = forwarder.list_flushing_files().unwrap();
        assert_eq!(files.len(), 2);
    }

    #[test]
    fn retention_truncates_oversized_pending() {
        let dir = tempdir().unwrap();
        let forwarder = DebugLogsForwarder::new(dir.path().to_path_buf());
        // Fill pending past SPOOL_MAX_BYTES.
        let big = "x".repeat(SPOOL_MAX_BYTES as usize + 1024);
        fs::write(dir.path().join(PENDING_FILE), big).unwrap();
        // Trigger retention via append.
        forwarder.append("test", LogStream::Stdout, "after retention");
        let size = fs::metadata(dir.path().join(PENDING_FILE)).unwrap().len();
        assert!(size <= SPOOL_MAX_BYTES, "size after retention was {size}");
    }
}
