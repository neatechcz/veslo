use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const JOURNAL_FILE: &str = "user-diagnostic-captures.json";
const CAPTURE_DURATION_MS: u64 = 120_000;
const CAPTURE_MAX_BYTES: u64 = 2 * 1024 * 1024;
const CAPTURE_RETENTION_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_BATCH_BYTES: usize = 224 * 1024;
const MAX_BATCH_EVENTS: usize = 500;
const MAX_RETRY_DELAY_MS: u64 = 5 * 60 * 1000;
const PRODUCTION_DEN_API_BASE: &str = "https://api.veslo.work";

// Debug Tauri runtimes support team-assisted captures. Release builds require
// build.rs to prove the explicit production compile-time inputs.
pub const USER_DIAGNOSTIC_CAPTURE_ENABLED: bool =
    cfg!(debug_assertions) || option_env!("VESLO_USER_DIAGNOSTIC_CAPTURE").is_some();

#[derive(Clone, Debug)]
pub struct CaptureCloudContext {
    pub den_api_base: String,
    pub token: String,
    pub user_id: String,
    pub org_id: String,
    pub workspace_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserDiagnosticCaptureStatus {
    pub available: bool,
    pub capture_id: Option<String>,
    pub state: String,
    pub started_at: Option<u64>,
    pub ends_at: Option<u64>,
    pub captured_events: u64,
    pub captured_bytes: u64,
    pub pending_events: u64,
    pub accepted_events: u64,
    pub dropped_retention: u64,
    pub dropped_budget: u64,
    pub dropped_delivery: u64,
    pub dropped_identity: u64,
    pub terminal_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureRecord {
    capture_id: String,
    user_id: String,
    org_id: String,
    workspace_id: Option<String>,
    started_at: u64,
    ends_at: u64,
    state: String,
    captured_events: u64,
    captured_bytes: u64,
    pending_events: u64,
    accepted_events: u64,
    dropped_retention: u64,
    dropped_budget: u64,
    #[serde(default)]
    dropped_delivery: u64,
    #[serde(default)]
    dropped_identity: u64,
    #[serde(default)]
    retry_attempts: u32,
    #[serde(default)]
    next_retry_at: Option<u64>,
    terminal_reason: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct CaptureJournal {
    latest: Option<CaptureRecord>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureEvent {
    id: String,
    user_id: String,
    org_id: String,
    workspace_id: String,
    source: String,
    stream: String,
    timestamp: u128,
    sequence_no: u64,
    capture_id: String,
    payload: serde_json::Value,
}

enum PostBatchError {
    Retryable,
    Rejected,
}

pub struct UserDiagnosticCapture {
    spool_dir: PathBuf,
    journal_path: PathBuf,
    journal: Mutex<CaptureJournal>,
    // Serializes every read/write/rewrite of a capture queue with capture appends.
    queue_lock: Mutex<()>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn now_ns() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0)
}

fn queue_path(spool_dir: &Path, capture_id: &str) -> PathBuf {
    spool_dir.join(format!("user-diagnostic-capture-{capture_id}.jsonl"))
}

fn load_journal(path: &Path) -> CaptureJournal {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn allowed_source(source: &str, stream: &str) -> bool {
    matches!(stream, "stdout" | "stderr")
        && matches!(
            source,
            "veslo-server-shell" | "engine" | "orchestrator" | "opencode-router" | "Veslo UI"
        )
}

fn is_production_den_api_base(value: &str) -> bool {
    value.trim().trim_end_matches('/') == PRODUCTION_DEN_API_BASE
}

fn event_batch_len(batch_id: &str, events: &[serde_json::Value]) -> usize {
    serde_json::to_vec(&serde_json::json!({ "batchId": batch_id, "events": events }))
        .map(|value| value.len())
        .unwrap_or(usize::MAX)
}

fn build_batches(events: &[serde_json::Value]) -> Vec<Vec<serde_json::Value>> {
    let mut batches = Vec::new();
    let mut current = Vec::new();
    for event in events {
        let id = event
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let mut candidate = current.clone();
        candidate.push(event.clone());
        let batch_id = format!(
            "capture:{}:{id}",
            event
                .get("captureId")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown")
        );
        if candidate.len() <= MAX_BATCH_EVENTS
            && event_batch_len(&batch_id, &candidate) <= MAX_BATCH_BYTES
        {
            current = candidate;
        } else if !current.is_empty() {
            batches.push(std::mem::take(&mut current));
            current.push(event.clone());
        }
    }
    if !current.is_empty() {
        batches.push(current);
    }
    batches
}

fn retry_delay_ms(attempts: u32) -> u64 {
    5_000u64
        .saturating_mul(1u64 << attempts.min(6))
        .min(MAX_RETRY_DELAY_MS)
}

impl UserDiagnosticCapture {
    pub fn new(spool_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&spool_dir);
        let journal_path = spool_dir.join(JOURNAL_FILE);
        let capture = Self {
            spool_dir,
            journal_path: journal_path.clone(),
            journal: Mutex::new(load_journal(&journal_path)),
            queue_lock: Mutex::new(()),
        };
        {
            let _queue = capture.queue_lock.lock().ok();
            let interrupted = capture.journal.lock().ok().and_then(|mut journal| {
                let record = journal
                    .latest
                    .as_mut()
                    .filter(|record| record.state == "active")?;
                record.state = "interrupted".to_string();
                record.terminal_reason = Some("desktop_restarted".to_string());
                Some(record.clone())
            });
            if let Some(record) = interrupted {
                if capture.append_summary_unlocked(&record).is_ok() {
                    capture.update_latest(&record.capture_id, |latest| latest.pending_events += 1);
                } else {
                    capture.mark_undeliverable(&record.capture_id, "summary_write_failed");
                }
            }
            let _ = capture.persist();
        }
        capture
    }

    fn persist(&self) -> Result<(), String> {
        let journal = self
            .journal
            .lock()
            .map_err(|_| "capture journal lock poisoned".to_string())?;
        let temporary = self.journal_path.with_extension("json.tmp");
        let data = serde_json::to_vec_pretty(&*journal).map_err(|error| error.to_string())?;
        fs::write(&temporary, data).map_err(|error| error.to_string())?;
        fs::rename(&temporary, &self.journal_path).map_err(|error| error.to_string())
    }

    fn update_latest(&self, capture_id: &str, update: impl FnOnce(&mut CaptureRecord)) {
        if let Ok(mut journal) = self.journal.lock() {
            if let Some(latest) = journal
                .latest
                .as_mut()
                .filter(|latest| latest.capture_id == capture_id)
            {
                update(latest);
            }
        }
    }

    fn mark_undeliverable(&self, capture_id: &str, reason: &str) {
        self.update_latest(capture_id, |latest| {
            latest.state = "undeliverable".to_string();
            latest.terminal_reason = Some(reason.to_string());
            latest.next_retry_at = None;
        });
    }

    fn serialize_event(
        &self,
        record: &CaptureRecord,
        source: &str,
        stream: &str,
        sequence_no: u64,
        payload: serde_json::Value,
    ) -> Result<String, String> {
        serde_json::to_string(&CaptureEvent {
            id: Uuid::new_v4().to_string(),
            user_id: record.user_id.clone(),
            org_id: record.org_id.clone(),
            workspace_id: record.workspace_id.clone().unwrap_or_default(),
            source: source.to_string(),
            stream: stream.to_string(),
            timestamp: now_ns(),
            sequence_no,
            capture_id: record.capture_id.clone(),
            payload,
        })
        .map_err(|error| error.to_string())
    }

    fn append_serialized_unlocked(
        &self,
        record: &CaptureRecord,
        serialized: &str,
    ) -> Result<usize, String> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(queue_path(&self.spool_dir, &record.capture_id))
            .map_err(|error| error.to_string())?;
        writeln!(file, "{serialized}").map_err(|error| error.to_string())?;
        Ok(serialized.len() + 1)
    }

    fn append_summary_unlocked(&self, record: &CaptureRecord) -> Result<usize, String> {
        let serialized = self.serialize_event(record, "Veslo user capture", "diagnostic", 0, serde_json::json!({
            "eventType": "user-capture:summary", "captureId": record.capture_id, "state": record.state,
            "capturedEvents": record.captured_events, "capturedBytes": record.captured_bytes,
            "droppedRetention": record.dropped_retention, "droppedBudget": record.dropped_budget,
            "droppedDelivery": record.dropped_delivery, "droppedIdentity": record.dropped_identity,
            "terminalReason": record.terminal_reason,
        }))?;
        self.append_serialized_unlocked(record, &serialized)
    }

    fn finalize_expired_locked(&self) {
        let record = {
            let Ok(mut journal) = self.journal.lock() else {
                return;
            };
            let Some(record) = journal.latest.as_mut() else {
                return;
            };
            if record.state != "active" || now_ms() < record.ends_at {
                return;
            }
            record.state = "finished".to_string();
            record.terminal_reason = Some("time_limit".to_string());
            record.clone()
        };
        if self.append_summary_unlocked(&record).is_ok() {
            self.update_latest(&record.capture_id, |latest| latest.pending_events += 1);
        } else {
            self.mark_undeliverable(&record.capture_id, "summary_write_failed");
        }
        let _ = self.persist();
    }

    fn finalize_expired(&self) {
        let Ok(_queue) = self.queue_lock.lock() else {
            return;
        };
        self.finalize_expired_locked();
    }

    pub fn start(
        &self,
        context: &CaptureCloudContext,
    ) -> Result<UserDiagnosticCaptureStatus, String> {
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return Err("User diagnostic capture is unavailable in this build".to_string());
        }
        if context.den_api_base.trim().is_empty()
            || context.token.trim().is_empty()
            || context.user_id.trim().is_empty()
            || context.org_id.trim().is_empty()
        {
            return Err("Sign in before starting a diagnostic capture".to_string());
        }
        if !is_production_den_api_base(&context.den_api_base) {
            return Err(
                "Diagnostic capture is available only for the production Veslo service".to_string(),
            );
        }
        let _queue = self
            .queue_lock
            .lock()
            .map_err(|_| "capture queue lock poisoned".to_string())?;
        self.finalize_expired_locked();
        if self
            .journal
            .lock()
            .ok()
            .and_then(|journal| journal.latest.clone())
            .is_some_and(|record| record.state == "active" || record.pending_events > 0)
        {
            return Err("The previous diagnostic capture is still active or queued".to_string());
        }
        let started_at = now_ms();
        let record = CaptureRecord {
            capture_id: Uuid::new_v4().to_string(),
            user_id: context.user_id.clone(),
            org_id: context.org_id.clone(),
            workspace_id: context.workspace_id.clone(),
            started_at,
            ends_at: started_at + CAPTURE_DURATION_MS,
            state: "active".to_string(),
            captured_events: 0,
            captured_bytes: 0,
            pending_events: 0,
            accepted_events: 0,
            dropped_retention: 0,
            dropped_budget: 0,
            dropped_delivery: 0,
            dropped_identity: 0,
            retry_attempts: 0,
            next_retry_at: None,
            terminal_reason: None,
        };
        if self.append_summary_unlocked(&record).is_err() {
            return Err("Could not create the diagnostic capture queue".to_string());
        }
        if let Ok(mut journal) = self.journal.lock() {
            journal.latest = Some(record.clone());
        }
        self.update_latest(&record.capture_id, |latest| latest.pending_events = 1);
        self.persist()?;
        drop(_queue);
        Ok(self.status())
    }

    pub fn observe(
        &self,
        source: &str,
        stream: &str,
        line: &str,
        sequence_no: u64,
        sanitize: impl Fn(&str) -> String,
    ) {
        if !allowed_source(source, stream) {
            return;
        }
        let Ok(_queue) = self.queue_lock.lock() else {
            return;
        };
        self.finalize_expired_locked();
        let record = self
            .journal
            .lock()
            .ok()
            .and_then(|journal| journal.latest.clone())
            .filter(|record| record.state == "active");
        let Some(record) = record else {
            return;
        };
        let serialized = match self.serialize_event(
            &record,
            source,
            stream,
            sequence_no,
            serde_json::json!({ "line": sanitize(line) }),
        ) {
            Ok(value) => value,
            Err(_) => return,
        };
        let event_bytes = (serialized.len() + 1) as u64;
        if record.captured_bytes.saturating_add(event_bytes) > CAPTURE_MAX_BYTES {
            self.update_latest(&record.capture_id, |latest| {
                latest.dropped_budget += 1;
                latest.state = "budget_exhausted".to_string();
                latest.terminal_reason = Some("byte_limit".to_string());
            });
            let summary = self
                .journal
                .lock()
                .ok()
                .and_then(|journal| journal.latest.clone());
            if let Some(summary) = summary {
                if self.append_summary_unlocked(&summary).is_ok() {
                    self.update_latest(&record.capture_id, |latest| latest.pending_events += 1);
                } else {
                    self.mark_undeliverable(&record.capture_id, "summary_write_failed");
                }
            }
            let _ = self.persist();
            return;
        }
        if self
            .append_serialized_unlocked(&record, &serialized)
            .is_ok()
        {
            self.update_latest(&record.capture_id, |latest| {
                if latest.state == "active" {
                    latest.captured_events += 1;
                    latest.captured_bytes += event_bytes;
                    latest.pending_events += 1;
                }
            });
            let _ = self.persist();
        }
    }

    pub fn status(&self) -> UserDiagnosticCaptureStatus {
        self.finalize_expired();
        match self
            .journal
            .lock()
            .ok()
            .and_then(|journal| journal.latest.clone())
        {
            Some(record) => UserDiagnosticCaptureStatus {
                available: USER_DIAGNOSTIC_CAPTURE_ENABLED,
                capture_id: Some(record.capture_id),
                state: record.state,
                started_at: Some(record.started_at),
                ends_at: Some(record.ends_at),
                captured_events: record.captured_events,
                captured_bytes: record.captured_bytes,
                pending_events: record.pending_events,
                accepted_events: record.accepted_events,
                dropped_retention: record.dropped_retention,
                dropped_budget: record.dropped_budget,
                dropped_delivery: record.dropped_delivery,
                dropped_identity: record.dropped_identity,
                terminal_reason: record.terminal_reason,
            },
            None => UserDiagnosticCaptureStatus {
                available: USER_DIAGNOSTIC_CAPTURE_ENABLED,
                capture_id: None,
                state: "idle".to_string(),
                started_at: None,
                ends_at: None,
                captured_events: 0,
                captured_bytes: 0,
                pending_events: 0,
                accepted_events: 0,
                dropped_retention: 0,
                dropped_budget: 0,
                dropped_delivery: 0,
                dropped_identity: 0,
                terminal_reason: None,
            },
        }
    }

    fn schedule_retry(&self, capture_id: &str) {
        self.update_latest(capture_id, |latest| {
            latest.retry_attempts = latest.retry_attempts.saturating_add(1);
            latest.next_retry_at =
                Some(now_ms().saturating_add(retry_delay_ms(latest.retry_attempts)));
        });
    }

    fn write_remaining_unlocked(
        &self,
        path: &Path,
        events: &[serde_json::Value],
    ) -> Result<(), String> {
        if events.is_empty() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
            return Ok(());
        }
        let temporary = path.with_extension("jsonl.tmp");
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        for event in events {
            writeln!(file, "{event}").map_err(|error| error.to_string())?;
        }
        fs::rename(temporary, path).map_err(|error| error.to_string())
    }

    pub fn flush(&self, context: Option<CaptureCloudContext>) {
        let Ok(_queue) = self.queue_lock.lock() else {
            return;
        };
        self.finalize_expired_locked();
        let record = self
            .journal
            .lock()
            .ok()
            .and_then(|journal| journal.latest.clone());
        let Some(record) = record else {
            return;
        };
        let path = queue_path(&self.spool_dir, &record.capture_id);
        if !path.exists() {
            if record.pending_events > 0 {
                self.mark_undeliverable(&record.capture_id, "queue_missing");
                let _ = self.persist();
            }
            return;
        }
        if now_ms() > record.ends_at.saturating_add(CAPTURE_RETENTION_MS) {
            let dropped = fs::read_to_string(&path)
                .map(|raw| raw.lines().filter(|line| !line.trim().is_empty()).count() as u64)
                .unwrap_or(0);
            self.update_latest(&record.capture_id, |latest| {
                latest.state = "expired".to_string();
                latest.terminal_reason = Some("queue_retention_expired".to_string());
                latest.dropped_retention += dropped;
                latest.pending_events = 0;
                latest.next_retry_at = None;
            });
            let _ = fs::remove_file(path);
            let _ = self.persist();
            return;
        }
        let Some(context) = context else {
            return;
        };
        if context.user_id != record.user_id || context.org_id != record.org_id {
            let dropped = fs::read_to_string(&path)
                .map(|raw| raw.lines().filter(|line| !line.trim().is_empty()).count() as u64)
                .unwrap_or(0);
            self.update_latest(&record.capture_id, |latest| {
                latest.state = "identity_changed".to_string();
                latest.terminal_reason = Some("signed_in_identity_changed".to_string());
                latest.dropped_identity += dropped;
                latest.pending_events = 0;
                latest.next_retry_at = None;
            });
            let _ = fs::remove_file(path);
            let _ = self.persist();
            return;
        }
        if !is_production_den_api_base(&context.den_api_base) {
            return;
        }
        if record
            .next_retry_at
            .is_some_and(|retry_at| now_ms() < retry_at)
        {
            return;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(value) => value,
            Err(_) => {
                self.mark_undeliverable(&record.capture_id, "queue_read_failed");
                let _ = self.persist();
                return;
            }
        };
        let mut events = Vec::new();
        for line in raw.lines().filter(|line| !line.trim().is_empty()) {
            match serde_json::from_str(line) {
                Ok(event) => events.push(event),
                Err(_) => {
                    self.mark_undeliverable(&record.capture_id, "queue_corrupt");
                    let _ = self.persist();
                    return;
                }
            }
        }
        if events.is_empty() {
            self.mark_undeliverable(&record.capture_id, "queue_corrupt");
            let _ = self.persist();
            return;
        }
        let mut delivered = std::collections::HashSet::new();
        let mut rejected = false;
        let mut retryable = false;
        for batch in build_batches(&events) {
            let first_id = batch
                .first()
                .and_then(|event| event.get("id"))
                .and_then(|value| value.as_str())
                .unwrap_or("unknown");
            let batch_id = format!("capture:{}:{first_id}", record.capture_id);
            match post_batch(&context, &batch_id, &batch) {
                Ok(()) => {
                    for event in batch {
                        if let Some(id) = event.get("id").and_then(|value| value.as_str()) {
                            delivered.insert(id.to_string());
                        }
                    }
                }
                Err(PostBatchError::Rejected) => {
                    rejected = true;
                    break;
                }
                Err(PostBatchError::Retryable) => {
                    retryable = true;
                    break;
                }
            }
        }
        let remaining = events
            .into_iter()
            .filter(|event| {
                event
                    .get("id")
                    .and_then(|value| value.as_str())
                    .map(|id| !delivered.contains(id))
                    .unwrap_or(true)
            })
            .collect::<Vec<_>>();
        if rejected {
            self.update_latest(&record.capture_id, |latest| {
                latest.accepted_events += delivered.len() as u64;
                latest.dropped_delivery += remaining.len() as u64;
                latest.pending_events = 0;
                latest.state = "delivery_rejected".to_string();
                latest.terminal_reason = Some("server_rejected_capture".to_string());
                latest.next_retry_at = None;
            });
            let _ = fs::remove_file(path);
            let _ = self.persist();
            return;
        }
        if retryable {
            if !delivered.is_empty() && self.write_remaining_unlocked(&path, &remaining).is_err() {
                self.mark_undeliverable(&record.capture_id, "queue_rewrite_failed");
                let _ = self.persist();
                return;
            }
            self.update_latest(&record.capture_id, |latest| {
                latest.accepted_events += delivered.len() as u64;
                latest.pending_events = remaining.len() as u64;
            });
            self.schedule_retry(&record.capture_id);
            let _ = self.persist();
            return;
        }
        if self.write_remaining_unlocked(&path, &remaining).is_err() {
            self.mark_undeliverable(&record.capture_id, "queue_rewrite_failed");
            let _ = self.persist();
            return;
        }
        self.update_latest(&record.capture_id, |latest| {
            latest.accepted_events += delivered.len() as u64;
            latest.pending_events = remaining.len() as u64;
            latest.retry_attempts = 0;
            latest.next_retry_at = None;
            if remaining.is_empty()
                && matches!(latest.state.as_str(), "finished" | "budget_exhausted")
            {
                latest.state = if latest.dropped_budget > 0 || latest.dropped_retention > 0 {
                    "uploaded_with_truncation".to_string()
                } else {
                    "uploaded".to_string()
                };
            }
        });
        let _ = self.persist();
    }
}

fn post_batch(
    context: &CaptureCloudContext,
    batch_id: &str,
    events: &[serde_json::Value],
) -> Result<(), PostBatchError> {
    let url = format!(
        "{}/v1/desktop-diagnostics",
        context.den_api_base.trim_end_matches('/')
    );
    let response = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(5)).build().post(&url).set("Content-Type", "application/json").set("Authorization", &format!("Bearer {}", context.token)).set("Idempotency-Key", batch_id).send_string(&serde_json::json!({ "batchId": batch_id, "events": events, "installId": "user-capture", "bootId": "user-capture", "userId": context.user_id, "orgId": context.org_id, "workspaceId": context.workspace_id, "deliveryPath": "desktop-direct-fallback" }).to_string());
    match response {
        Ok(response) if (200..300).contains(&response.status()) => Ok(()),
        Err(ureq::Error::Status(status, _))
            if (400..500).contains(&status) && status != 408 && status != 429 =>
        {
            Err(PostBatchError::Rejected)
        }
        _ => Err(PostBatchError::Retryable),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn context() -> CaptureCloudContext {
        CaptureCloudContext {
            den_api_base: PRODUCTION_DEN_API_BASE.to_string(),
            token: "token".to_string(),
            user_id: "user-1".to_string(),
            org_id: "org-1".to_string(),
            workspace_id: Some("workspace-1".to_string()),
        }
    }

    #[test]
    fn capture_queue_is_separate_sanitized_and_identity_bound() {
        let dir = tempdir().unwrap();
        let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return;
        }
        let capture_id = capture.start(&context()).unwrap().capture_id.unwrap();
        capture.observe(
            "engine",
            "stderr",
            "Bearer secret-token /Users/alice/project",
            1,
            |_| "Bearer [redacted] /Users/[user]/project".to_string(),
        );
        capture.observe("unlisted", "stderr", "must not queue", 2, |value| {
            value.to_string()
        });
        let raw = fs::read_to_string(queue_path(dir.path(), &capture_id)).unwrap();
        assert!(raw.contains("\"captureId\":\""));
        assert!(raw.contains("Bearer [redacted]"));
        assert!(!raw.contains("must not queue"));
        assert_eq!(capture.status().captured_events, 1);
        assert_eq!(capture.status().pending_events, 2);
    }

    #[test]
    fn byte_budget_counts_the_full_serialized_event() {
        let dir = tempdir().unwrap();
        let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return;
        }
        let status = capture.start(&context()).unwrap();
        let capture_id = status.capture_id.unwrap();
        let record = capture.journal.lock().unwrap().latest.clone().unwrap();
        let size = capture
            .serialize_event(
                &record,
                "engine",
                "stderr",
                1,
                serde_json::json!({"line":"x"}),
            )
            .unwrap()
            .len() as u64
            + 1;
        capture.update_latest(&capture_id, |latest| {
            latest.captured_bytes = CAPTURE_MAX_BYTES - size + 1
        });
        capture.observe("engine", "stderr", "x", 1, |value| value.to_string());
        let status = capture.status();
        assert_eq!(status.state, "budget_exhausted");
        assert_eq!(status.captured_events, 0);
        assert_eq!(status.dropped_budget, 1);
    }

    #[test]
    fn corrupt_queue_is_never_silently_marked_uploaded() {
        let dir = tempdir().unwrap();
        let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return;
        }
        let capture_id = capture.start(&context()).unwrap().capture_id.unwrap();
        let mut queue = OpenOptions::new()
            .append(true)
            .open(queue_path(dir.path(), &capture_id))
            .unwrap();
        writeln!(queue, "not-json").unwrap();
        capture.flush(Some(context()));
        let status = capture.status();
        assert_eq!(status.state, "undeliverable");
        assert_eq!(status.terminal_reason.as_deref(), Some("queue_corrupt"));
    }

    #[test]
    fn capture_is_fail_closed_without_the_release_build_flag() {
        let dir = tempdir().unwrap();
        let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
        if USER_DIAGNOSTIC_CAPTURE_ENABLED {
            assert!(capture.start(&context()).is_ok());
        } else {
            assert!(capture.start(&context()).is_err());
        }
    }

    #[test]
    fn capture_rejects_a_non_production_den_endpoint() {
        let dir = tempdir().unwrap();
        let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return;
        }
        let mut non_production = context();
        non_production.den_api_base = "https://example.test".to_string();
        assert!(capture.start(&non_production).is_err());
    }
}
