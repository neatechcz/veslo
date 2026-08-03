use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Lines, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::recent_diagnostic_ring::RecentDiagnosticRing;

const JOURNAL_FILE: &str = "user-diagnostic-captures.json";
const CAPTURE_DURATION_MS: u64 = 120_000;
const CAPTURE_MAX_BYTES: u64 = 2 * 1024 * 1024;
const FEEDBACK_SNAPSHOT_MAX_BYTES: u64 = 50 * 1024 * 1024;
const CAPTURE_RETENTION_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_BATCH_BYTES: usize = 512 * 1024;
const MAX_BATCH_EVENTS: usize = 1_000;
// Feedback snapshots may be much larger than an interactive support capture.
// Den accepts up to 10 MiB, so 2 MiB keeps enough headroom while cutting the
// request count for a full 50 MiB snapshot by roughly four.
const FEEDBACK_BATCH_MAX_BYTES: usize = 2 * 1024 * 1024;
// The request envelope is small and fixed. Keeping this headroom lets the
// streaming packer avoid serializing every growing candidate just to discover
// whether the next event still fits.
const BATCH_REQUEST_OVERHEAD_BYTES: usize = 2 * 1024;
const MAX_RETRY_DELAY_MS: u64 = 5 * 60 * 1000;
const PRODUCTION_DEN_API_BASE: &str = "https://api.veslo.work";
const STAGING_DEN_API_BASE: &str = "https://api.staging.veslo.work";

// Debug Tauri runtimes support team-assisted captures. Release builds require
// build.rs to prove the explicit compile-time opt-in.
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
    pub can_start: bool,
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
    #[serde(default = "default_capture_kind")]
    kind: String,
    #[serde(default = "default_capture_max_bytes")]
    max_bytes: u64,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    level: Option<String>,
    timestamp: u128,
    sequence_no: u64,
    capture_id: String,
    payload: serde_json::Value,
}

enum PostBatchError {
    Retryable,
    Rejected,
}

struct PreparedBatch {
    batch_id: String,
    events: Vec<serde_json::Value>,
    body: Vec<u8>,
}

struct FeedbackAttachmentRecovery {
    capture_id: String,
    attempts: u32,
    next_attempt_at: u64,
}

enum FeedbackAttachmentLink {
    Linked,
    Unlinked,
    Unavailable,
}

pub struct UserDiagnosticCapture {
    spool_dir: PathBuf,
    journal_path: PathBuf,
    journal: Mutex<CaptureJournal>,
    // Delivery confirmation is useful in the running UI, but it must not be
    // restored after a desktop restart once every event was accepted.
    recently_completed: Mutex<Option<CaptureRecord>>,
    // A feedback record may have reached Den immediately before the desktop
    // stopped, leaving the local attachment in `ready`. On the next boot, do
    // one authenticated lookup for that exact capture before deciding whether
    // native delivery may begin. This is deliberately ephemeral so an
    // unlinked draft never creates a polling loop.
    feedback_attachment_recovery: Mutex<Option<FeedbackAttachmentRecovery>>,
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

fn default_capture_kind() -> String {
    "support-capture".to_string()
}

fn default_capture_max_bytes() -> u64 {
    CAPTURE_MAX_BYTES
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

fn is_fully_delivered(record: &CaptureRecord) -> bool {
    record.pending_events == 0
        && matches!(
            record.state.as_str(),
            "uploaded" | "uploaded_with_truncation"
        )
}

fn allowed_source(source: &str, stream: &str) -> bool {
    matches!(stream, "stdout" | "stderr")
        && matches!(
            source,
            "veslo-server-shell" | "engine" | "orchestrator" | "opencode-router" | "Veslo UI"
        )
}

fn is_allowed_den_api_base(value: &str) -> bool {
    matches!(
        value.trim().trim_end_matches('/'),
        PRODUCTION_DEN_API_BASE | STAGING_DEN_API_BASE
    )
}

fn event_id(event: &serde_json::Value) -> Option<&str> {
    event
        .get("id")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|id| !id.is_empty())
}

fn serialize_delivery_request(
    context: &CaptureCloudContext,
    batch_id: &str,
    events: &[serde_json::Value],
) -> Result<Vec<u8>, &'static str> {
    serde_json::to_vec(&serde_json::json!({
        "batchId": batch_id,
        "events": events,
        "installId": "user-capture",
        "bootId": "user-capture",
        "userId": context.user_id,
        "orgId": context.org_id,
        "workspaceId": context.workspace_id,
        "deliveryPath": "desktop-direct-fallback",
    }))
    .map_err(|_| "queue_event_unserializable")
}

fn prepare_batch(
    context: &CaptureCloudContext,
    capture_id: &str,
    events: Vec<serde_json::Value>,
) -> Result<PreparedBatch, &'static str> {
    let first_id = events
        .first()
        .and_then(event_id)
        .ok_or("queue_invalid_event_id")?;
    let batch_id = format!("capture:{capture_id}:{first_id}");
    let body = serialize_delivery_request(context, &batch_id, &events)?;
    Ok(PreparedBatch {
        batch_id,
        events,
        body,
    })
}

fn validate_delivery_events(events: &[serde_json::Value]) -> Result<(), &'static str> {
    let mut ids = std::collections::HashSet::new();
    for event in events {
        let id = event_id(event).ok_or("queue_invalid_event_id")?;
        if !ids.insert(id.to_string()) {
            return Err("queue_duplicate_event_id");
        }
        let bytes = serde_json::to_vec(event).map_err(|_| "queue_event_unserializable")?;
        if bytes.len() > CAPTURE_MAX_BYTES as usize {
            return Err("queue_event_exceeds_capture_budget");
        }
    }
    Ok(())
}

fn build_batches(
    context: &CaptureCloudContext,
    capture_id: &str,
    events: &[serde_json::Value],
) -> Result<Vec<PreparedBatch>, &'static str> {
    let mut batches = Vec::new();
    let mut current = Vec::new();
    for event in events {
        let mut candidate = current.clone();
        candidate.push(event.clone());
        let candidate_batch = prepare_batch(context, capture_id, candidate.clone())?;
        if candidate.len() <= MAX_BATCH_EVENTS && candidate_batch.body.len() <= MAX_BATCH_BYTES {
            current = candidate;
            continue;
        }

        if !current.is_empty() {
            batches.push(prepare_batch(
                context,
                capture_id,
                std::mem::take(&mut current),
            )?);
        }

        let single = prepare_batch(context, capture_id, vec![event.clone()])?;
        if single.body.len() > MAX_BATCH_BYTES {
            batches.push(single);
        } else {
            current.push(event.clone());
        }
    }
    if !current.is_empty() {
        batches.push(prepare_batch(context, capture_id, current)?);
    }
    Ok(batches)
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
            recently_completed: Mutex::new(None),
            feedback_attachment_recovery: Mutex::new(None),
            queue_lock: Mutex::new(()),
        };
        {
            let _queue = capture.queue_lock.lock().ok();
            let completed_capture_id = capture.journal.lock().ok().and_then(|mut journal| {
                let capture_id = journal
                    .latest
                    .as_ref()
                    .filter(|record| is_fully_delivered(record))?
                    .capture_id
                    .clone();
                journal.latest = None;
                Some(capture_id)
            });
            if let Some(capture_id) = completed_capture_id {
                let _ = fs::remove_file(&capture.journal_path);
                let _ = fs::remove_file(queue_path(&capture.spool_dir, &capture_id));
            }
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
                let _ = capture.persist();
            }
            let recovery_capture_id = capture.journal.lock().ok().and_then(|journal| {
                journal
                    .latest
                    .as_ref()
                    .filter(|record| {
                        record.kind == "feedback-attachment"
                            && matches!(record.state.as_str(), "ready" | "ready_with_truncation")
                    })
                    .map(|record| record.capture_id.clone())
            });
            if let Ok(mut recovery) = capture.feedback_attachment_recovery.lock() {
                *recovery = recovery_capture_id.map(|capture_id| FeedbackAttachmentRecovery {
                    capture_id,
                    attempts: 0,
                    next_attempt_at: 0,
                });
            }
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

    // Event metadata is intentionally explicit at the capture boundary. It
    // keeps the serialized line independent from the mutable capture record.
    #[allow(clippy::too_many_arguments)]
    fn serialize_event_at(
        &self,
        record: &CaptureRecord,
        source: &str,
        stream: &str,
        level: Option<&str>,
        sequence_no: u64,
        timestamp: u128,
        payload: serde_json::Value,
    ) -> Result<String, String> {
        serde_json::to_string(&CaptureEvent {
            id: Uuid::new_v4().to_string(),
            user_id: record.user_id.clone(),
            org_id: record.org_id.clone(),
            workspace_id: record.workspace_id.clone().unwrap_or_default(),
            source: source.to_string(),
            stream: stream.to_string(),
            level: level.map(str::to_string),
            timestamp,
            sequence_no,
            capture_id: record.capture_id.clone(),
            payload,
        })
        .map_err(|error| error.to_string())
    }

    fn serialize_event(
        &self,
        record: &CaptureRecord,
        source: &str,
        stream: &str,
        level: Option<&str>,
        sequence_no: u64,
        payload: serde_json::Value,
    ) -> Result<String, String> {
        self.serialize_event_at(
            record,
            source,
            stream,
            level,
            sequence_no,
            now_ns(),
            payload,
        )
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
        let serialized = self.serialize_event(record, "Veslo user capture", "diagnostic", None, 0, serde_json::json!({
            "eventType": "user-capture:summary", "captureId": record.capture_id, "state": record.state,
            "captureKind": record.kind,
            // A capture is attachment causation, not a feedback operation. The
            // authoritative feedback id is created later by Den, so native
            // diagnostics must not invent one before the durable write.
            "correlation": {
                "version": 1,
                "authoritativeOperation": serde_json::Value::Null,
                "causation": { "captureId": record.capture_id },
                "scope": { "workspaceId": record.workspace_id },
                "phase": "diagnostic-capture",
                "outcome": record.state,
                "reason": record.terminal_reason,
            },
            "capturedEvents": record.captured_events, "capturedBytes": record.captured_bytes,
            "droppedRetention": record.dropped_retention, "droppedBudget": record.dropped_budget,
            "droppedDelivery": record.dropped_delivery, "droppedIdentity": record.dropped_identity,
            "terminalReason": record.terminal_reason,
        }))?;
        self.append_serialized_unlocked(record, &serialized)
    }

    fn finish_active_locked(&self, terminal_reason: &str) {
        let record = {
            let Ok(mut journal) = self.journal.lock() else {
                return;
            };
            let Some(record) = journal.latest.as_mut() else {
                return;
            };
            if record.state != "active" {
                return;
            }
            record.state = "finished".to_string();
            record.terminal_reason = Some(terminal_reason.to_string());
            record.clone()
        };
        if self.append_summary_unlocked(&record).is_ok() {
            self.update_latest(&record.capture_id, |latest| latest.pending_events += 1);
        } else {
            self.mark_undeliverable(&record.capture_id, "summary_write_failed");
        }
        let _ = self.persist();
    }

    fn finalize_expired_locked(&self) {
        let expired = self
            .journal
            .lock()
            .ok()
            .and_then(|journal| journal.latest.clone())
            .is_some_and(|record| record.state == "active" && now_ms() >= record.ends_at);
        if expired {
            self.finish_active_locked("time_limit");
        }
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
        if !is_allowed_den_api_base(&context.den_api_base) {
            return Err(
                "Diagnostic capture is available only for the production or staging Veslo service"
                    .to_string(),
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
            kind: default_capture_kind(),
            max_bytes: CAPTURE_MAX_BYTES,
        };
        if self.append_summary_unlocked(&record).is_err() {
            return Err("Could not create the diagnostic capture queue".to_string());
        }
        if let Ok(mut completed) = self.recently_completed.lock() {
            *completed = None;
        }
        if let Ok(mut journal) = self.journal.lock() {
            journal.latest = Some(record.clone());
        }
        self.update_latest(&record.capture_id, |latest| latest.pending_events = 1);
        self.persist()?;
        drop(_queue);
        Ok(self.status())
    }

    pub fn create_feedback_snapshot(
        &self,
        context: &CaptureCloudContext,
        ring: &RecentDiagnosticRing,
    ) -> Result<UserDiagnosticCaptureStatus, String> {
        if !Self::can_start_with_context(Some(context)) {
            return Err("Sign in before attaching diagnostics to feedback".to_string());
        }
        let _queue = self
            .queue_lock
            .lock()
            .map_err(|_| "capture queue lock poisoned".to_string())?;
        self.finalize_expired_locked();
        let previous = self
            .journal
            .lock()
            .ok()
            .and_then(|journal| journal.latest.clone());
        if let Some(previous) = previous {
            if previous.kind == "feedback-attachment"
                && matches!(previous.state.as_str(), "ready" | "ready_with_truncation")
            {
                if previous.user_id != context.user_id || previous.org_id != context.org_id {
                    return Err(
                        "The previous diagnostic feedback attachment belongs to another account"
                            .to_string(),
                    );
                }
                match feedback_attachment_link_status(context, &previous.capture_id) {
                    FeedbackAttachmentLink::Linked => {
                        self.update_latest(&previous.capture_id, |latest| {
                            latest.state = "queued".to_string()
                        });
                        self.persist()?;
                        return Err("The previous feedback attachment is already linked and is being uploaded".to_string());
                    }
                    FeedbackAttachmentLink::Unlinked => {
                        self.discard_feedback_snapshot_locked(&previous.capture_id)?;
                    }
                    FeedbackAttachmentLink::Unavailable => {
                        return Err(
                            "Could not verify the previous feedback attachment; it was kept safely"
                                .to_string(),
                        );
                    }
                }
            } else if previous.state == "active" || previous.pending_events > 0 {
                return Err("The previous diagnostic capture is still active or queued".to_string());
            }
        }

        let captured_at = now_ms();
        let record = CaptureRecord {
            capture_id: Uuid::new_v4().to_string(),
            user_id: context.user_id.clone(),
            org_id: context.org_id.clone(),
            workspace_id: context.workspace_id.clone(),
            started_at: captured_at,
            ends_at: captured_at,
            state: "snapshotting".to_string(),
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
            kind: "feedback-attachment".to_string(),
            max_bytes: FEEDBACK_SNAPSHOT_MAX_BYTES,
        };
        if let Ok(mut completed) = self.recently_completed.lock() {
            *completed = None;
        }
        if let Ok(mut journal) = self.journal.lock() {
            journal.latest = Some(record.clone());
        }
        self.persist()?;

        let capture_id = record.capture_id.clone();
        let snapshot_path = queue_path(&self.spool_dir, &capture_id);
        let snapshot_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&snapshot_path)
            .map_err(|error| error.to_string());
        let mut snapshot_file = match snapshot_file {
            Ok(file) => BufWriter::new(file),
            Err(error) => {
                self.mark_undeliverable(&capture_id, "snapshot_write_failed");
                let _ = self.persist();
                return Err(error);
            }
        };
        let mut captured_events = 0_u64;
        let mut captured_bytes = 0_u64;
        let mut dropped_budget = 0_u64;
        let streamed = ring.for_each_recent(|event| {
            let serialized = match self.serialize_event_at(
                &record,
                &event.source,
                &event.stream,
                event.level.as_deref(),
                event.sequence_no,
                (event.timestamp_ms as u128).saturating_mul(1_000_000),
                serde_json::json!({ "line": event.line }),
            ) {
                Ok(value) => value,
                Err(_) => return Ok(()),
            };
            let event_bytes = (serialized.len() + 1) as u64;
            if captured_bytes.saturating_add(event_bytes) > record.max_bytes {
                dropped_budget += 1;
                return Ok(());
            }
            writeln!(snapshot_file, "{serialized}").map_err(|error| error.to_string())?;
            captured_events += 1;
            captured_bytes += event_bytes;
            Ok(())
        });
        if let Err(error) = streamed {
            self.mark_undeliverable(&capture_id, "snapshot_read_failed");
            let _ = self.persist();
            return Err(error);
        }
        if let Err(error) = snapshot_file.flush() {
            self.mark_undeliverable(&capture_id, "snapshot_write_failed");
            let _ = self.persist();
            return Err(error.to_string());
        }

        if self
            .journal
            .lock()
            .ok()
            .and_then(|journal| journal.latest.clone())
            .is_some()
        {
            self.update_latest(&capture_id, |latest| {
                latest.captured_events = captured_events;
                latest.captured_bytes = captured_bytes;
                latest.pending_events = captured_events;
                latest.dropped_budget = dropped_budget;
                latest.state = if dropped_budget > 0 {
                    "ready_with_truncation".to_string()
                } else {
                    "ready".to_string()
                };
                latest.terminal_reason = (dropped_budget > 0).then(|| "byte_limit".to_string());
            });
            let summary = self
                .journal
                .lock()
                .ok()
                .and_then(|journal| journal.latest.clone());
            if let Some(summary) = summary {
                if self.append_summary_unlocked(&summary).is_ok() {
                    self.update_latest(&capture_id, |latest| latest.pending_events += 1);
                } else {
                    self.mark_undeliverable(&capture_id, "summary_write_failed");
                }
            }
        }
        self.persist()?;
        drop(_queue);
        Ok(self.status())
    }

    pub fn queue_feedback_snapshot_for_delivery(&self, capture_id: &str) -> Result<(), String> {
        let _queue = self
            .queue_lock
            .lock()
            .map_err(|_| "capture queue lock poisoned".to_string())?;
        let record = self
            .journal
            .lock()
            .ok()
            .and_then(|journal| journal.latest.clone())
            .filter(|record| {
                record.capture_id == capture_id && record.kind == "feedback-attachment"
            })
            .ok_or_else(|| "Diagnostic feedback attachment was not found".to_string())?;
        if !matches!(record.state.as_str(), "ready" | "ready_with_truncation") {
            return Err("Diagnostic feedback attachment is not ready to send".to_string());
        }
        self.update_latest(capture_id, |latest| latest.state = "queued".to_string());
        self.persist()
    }

    fn feedback_attachment_recovery_due(&self, capture_id: &str) -> bool {
        self.feedback_attachment_recovery
            .lock()
            .ok()
            .and_then(|recovery| {
                recovery.as_ref().map(|recovery| {
                    recovery.capture_id == capture_id && now_ms() >= recovery.next_attempt_at
                })
            })
            .unwrap_or(false)
    }

    fn clear_feedback_attachment_recovery(&self, capture_id: &str) {
        let Ok(mut recovery) = self.feedback_attachment_recovery.lock() else {
            return;
        };
        if recovery
            .as_ref()
            .is_some_and(|recovery| recovery.capture_id == capture_id)
        {
            *recovery = None;
        }
    }

    fn retry_feedback_attachment_recovery(&self, capture_id: &str) {
        let Ok(mut recovery) = self.feedback_attachment_recovery.lock() else {
            return;
        };
        let Some(recovery) = recovery
            .as_mut()
            .filter(|recovery| recovery.capture_id == capture_id)
        else {
            return;
        };
        recovery.attempts = recovery.attempts.saturating_add(1);
        recovery.next_attempt_at = now_ms().saturating_add(retry_delay_ms(recovery.attempts));
    }

    pub fn discard_feedback_snapshot(&self, capture_id: &str) -> Result<(), String> {
        let _queue = self
            .queue_lock
            .lock()
            .map_err(|_| "capture queue lock poisoned".to_string())?;
        self.discard_feedback_snapshot_locked(capture_id)
    }

    fn discard_feedback_snapshot_locked(&self, capture_id: &str) -> Result<(), String> {
        let record = self
            .journal
            .lock()
            .ok()
            .and_then(|journal| journal.latest.clone())
            .filter(|record| {
                record.capture_id == capture_id && record.kind == "feedback-attachment"
            })
            .ok_or_else(|| "Diagnostic feedback attachment was not found".to_string())?;
        if !matches!(record.state.as_str(), "ready" | "ready_with_truncation") {
            return Err(
                "Diagnostic feedback attachment cannot be discarded after delivery starts"
                    .to_string(),
            );
        }

        let path = queue_path(&self.spool_dir, capture_id);
        if path.exists() {
            fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
        if let Ok(mut journal) = self.journal.lock() {
            if journal
                .latest
                .as_ref()
                .is_some_and(|latest| latest.capture_id == capture_id)
            {
                journal.latest = None;
            }
        }
        if let Ok(mut completed) = self.recently_completed.lock() {
            *completed = None;
        }
        if self.journal_path.exists() {
            fs::remove_file(&self.journal_path).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn can_start_with_context(context: Option<&CaptureCloudContext>) -> bool {
        USER_DIAGNOSTIC_CAPTURE_ENABLED
            && context.is_some_and(|context| {
                !context.den_api_base.trim().is_empty()
                    && !context.token.trim().is_empty()
                    && !context.user_id.trim().is_empty()
                    && !context.org_id.trim().is_empty()
                    && is_allowed_den_api_base(&context.den_api_base)
            })
    }

    pub fn stop(&self) -> UserDiagnosticCaptureStatus {
        if let Ok(_queue) = self.queue_lock.lock() {
            self.finalize_expired_locked();
            self.finish_active_locked("user_stopped");
        }
        self.status()
    }

    pub fn observe(
        &self,
        source: &str,
        stream: &str,
        level: Option<&str>,
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
            level,
            sequence_no,
            serde_json::json!({ "line": sanitize(line) }),
        ) {
            Ok(value) => value,
            Err(_) => return,
        };
        let event_bytes = (serialized.len() + 1) as u64;
        if record.captured_bytes.saturating_add(event_bytes) > record.max_bytes {
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
        let record = self
            .journal
            .lock()
            .ok()
            .and_then(|journal| journal.latest.clone())
            .or_else(|| {
                self.recently_completed
                    .lock()
                    .ok()
                    .and_then(|completed| completed.clone())
            });
        match record {
            Some(record) => UserDiagnosticCaptureStatus {
                available: USER_DIAGNOSTIC_CAPTURE_ENABLED,
                can_start: false,
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
                can_start: false,
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

    fn write_feedback_remaining_unlocked(
        &self,
        path: &Path,
        buffered: &[serde_json::Value],
        lines: &mut Lines<BufReader<fs::File>>,
    ) -> Result<u64, String> {
        let temporary = path.with_extension("jsonl.tmp");
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        let mut count = 0_u64;
        for event in buffered {
            writeln!(file, "{event}").map_err(|error| error.to_string())?;
            count += 1;
        }
        for line in lines {
            let line = line.map_err(|error| error.to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            writeln!(file, "{line}").map_err(|error| error.to_string())?;
            count += 1;
        }
        fs::rename(temporary, path).map_err(|error| error.to_string())?;
        Ok(count)
    }

    fn flush_feedback_snapshot_streaming<P>(
        &self,
        record: &CaptureRecord,
        path: &Path,
        context: &CaptureCloudContext,
        poster: &mut P,
    ) where
        P: FnMut(&CaptureCloudContext, &PreparedBatch) -> Result<(), PostBatchError>,
    {
        let file = match fs::File::open(path) {
            Ok(file) => file,
            Err(_) => {
                self.mark_undeliverable(&record.capture_id, "queue_read_failed");
                let _ = self.persist();
                return;
            }
        };
        let mut lines = BufReader::new(file).lines();
        let mut buffered = Vec::<serde_json::Value>::new();
        let mut buffered_ids = std::collections::HashSet::<String>::new();
        let mut buffered_bytes = 0_usize;
        let mut delivered = 0_u64;

        loop {
            let next = match lines.next() {
                Some(Ok(line)) if !line.trim().is_empty() => Some(line),
                Some(Ok(_)) => continue,
                Some(Err(_)) => {
                    self.mark_undeliverable(&record.capture_id, "queue_read_failed");
                    let _ = self.persist();
                    return;
                }
                None => None,
            };
            let is_final = next.is_none();
            let event = match next {
                Some(line) => match serde_json::from_str(&line) {
                    Ok(event) => Some(event),
                    Err(_) => {
                        self.mark_undeliverable(&record.capture_id, "queue_corrupt");
                        let _ = self.persist();
                        return;
                    }
                },
                None => None,
            };

            if let Some(event) = event {
                if let Err(reason) = validate_delivery_events(std::slice::from_ref(&event)) {
                    self.reject_delivery(
                        &record.capture_id,
                        path,
                        buffered.len() as u64 + 1,
                        reason,
                    );
                    return;
                }
                let event_id = event_id(&event).expect("validated event ID").to_string();
                if !buffered_ids.insert(event_id) {
                    self.reject_delivery(
                        &record.capture_id,
                        path,
                        buffered.len() as u64 + 1,
                        "queue_duplicate_event_id",
                    );
                    return;
                }
                let event_bytes = match serde_json::to_vec(&event) {
                    Ok(value) => value.len().saturating_add(1),
                    Err(_) => {
                        self.reject_delivery(
                            &record.capture_id,
                            path,
                            buffered.len() as u64 + 1,
                            "queue_event_unserializable",
                        );
                        return;
                    }
                };
                buffered_bytes = buffered_bytes.saturating_add(event_bytes);
                buffered.push(event);
            }
            if buffered.is_empty() {
                break;
            }

            let should_send = is_final
                || buffered.len() > MAX_BATCH_EVENTS
                || buffered_bytes.saturating_add(BATCH_REQUEST_OVERHEAD_BYTES)
                    > FEEDBACK_BATCH_MAX_BYTES;
            if !should_send {
                continue;
            }

            let mut remainder = Vec::new();
            if !is_final
                && (buffered.len() > MAX_BATCH_EVENTS
                    || buffered_bytes.saturating_add(BATCH_REQUEST_OVERHEAD_BYTES)
                        > FEEDBACK_BATCH_MAX_BYTES)
                && buffered.len() > 1
            {
                let last = buffered.pop().expect("checked buffered event");
                remainder.push(last);
            }
            let mut batch =
                match prepare_batch(context, &record.capture_id, std::mem::take(&mut buffered)) {
                    Ok(prepared) => prepared,
                    Err(reason) => {
                        self.reject_delivery(&record.capture_id, path, 1, reason);
                        return;
                    }
                };
            // The conservative size estimate above avoids this loop for normal
            // input. It remains as an exact guard for future envelope changes.
            while batch.body.len() > FEEDBACK_BATCH_MAX_BYTES && batch.events.len() > 1 {
                let mut events = batch.events;
                let last = events.pop().expect("checked multi-event batch");
                remainder.insert(0, last);
                batch = match prepare_batch(context, &record.capture_id, events) {
                    Ok(prepared) => prepared,
                    Err(reason) => {
                        self.reject_delivery(&record.capture_id, path, 1, reason);
                        return;
                    }
                };
            }
            match poster(context, &batch) {
                Ok(()) => {
                    delivered += batch.events.len() as u64;
                    buffered = remainder;
                    buffered_ids.clear();
                    buffered_bytes = 0;
                    for event in &buffered {
                        let id = event_id(event).expect("validated event ID").to_string();
                        buffered_ids.insert(id);
                        buffered_bytes = buffered_bytes.saturating_add(
                            serde_json::to_vec(event)
                                .expect("validated serializable event")
                                .len()
                                .saturating_add(1),
                        );
                    }
                }
                Err(PostBatchError::Rejected) => {
                    let mut failure_remaining = batch.events;
                    failure_remaining.extend(remainder);
                    let dropped = self
                        .write_feedback_remaining_unlocked(path, &failure_remaining, &mut lines)
                        .unwrap_or(failure_remaining.len() as u64);
                    self.update_latest(&record.capture_id, |latest| {
                        latest.accepted_events += delivered;
                        latest.dropped_delivery += dropped;
                        latest.pending_events = 0;
                        latest.state = "delivery_rejected".to_string();
                        latest.terminal_reason = Some("server_rejected_capture".to_string());
                        latest.next_retry_at = None;
                    });
                    let _ = fs::remove_file(path);
                    let _ = self.persist();
                    return;
                }
                Err(PostBatchError::Retryable) => {
                    let mut failure_remaining = batch.events;
                    failure_remaining.extend(remainder);
                    let remaining = match self.write_feedback_remaining_unlocked(
                        path,
                        &failure_remaining,
                        &mut lines,
                    ) {
                        Ok(remaining) => remaining,
                        Err(_) => {
                            self.mark_undeliverable(&record.capture_id, "queue_rewrite_failed");
                            let _ = self.persist();
                            return;
                        }
                    };
                    self.update_latest(&record.capture_id, |latest| {
                        latest.accepted_events += delivered;
                        latest.pending_events = remaining;
                    });
                    self.schedule_retry(&record.capture_id);
                    let _ = self.persist();
                    return;
                }
            }
        }

        let _ = fs::remove_file(path);
        self.update_latest(&record.capture_id, |latest| {
            latest.accepted_events += delivered;
            latest.pending_events = 0;
            latest.retry_attempts = 0;
            latest.next_retry_at = None;
            latest.state = if latest.dropped_budget > 0 || latest.dropped_retention > 0 {
                "uploaded_with_truncation".to_string()
            } else {
                "uploaded".to_string()
            };
        });
        let _ = self.persist();
    }

    pub fn flush(&self, context: Option<CaptureCloudContext>) {
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(5))
            .build();
        self.flush_with_poster(context, |context, batch| post_batch(&agent, context, batch));
    }

    fn reject_delivery(&self, capture_id: &str, path: &Path, dropped: u64, reason: &str) {
        self.update_latest(capture_id, |latest| {
            latest.dropped_delivery += dropped;
            latest.pending_events = 0;
            latest.state = "delivery_rejected".to_string();
            latest.terminal_reason = Some(reason.to_string());
            latest.next_retry_at = None;
        });
        let _ = fs::remove_file(path);
        let _ = self.persist();
    }

    fn flush_with_poster<P>(&self, context: Option<CaptureCloudContext>, mut poster: P)
    where
        P: FnMut(&CaptureCloudContext, &PreparedBatch) -> Result<(), PostBatchError>,
    {
        let Ok(_queue) = self.queue_lock.lock() else {
            return;
        };
        self.finalize_expired_locked();
        let record = self
            .journal
            .lock()
            .ok()
            .and_then(|journal| journal.latest.clone());
        let Some(mut record) = record else {
            return;
        };
        if record.kind == "feedback-attachment" && record.state != "queued" {
            if matches!(record.state.as_str(), "ready" | "ready_with_truncation")
                && context.as_ref().is_some_and(|context| {
                    context.user_id == record.user_id
                        && context.org_id == record.org_id
                        && is_allowed_den_api_base(&context.den_api_base)
                })
                && self.feedback_attachment_recovery_due(&record.capture_id)
            {
                match feedback_attachment_link_status(
                    context.as_ref().expect("checked capture cloud context"),
                    &record.capture_id,
                ) {
                    FeedbackAttachmentLink::Linked => {
                        self.update_latest(&record.capture_id, |latest| {
                            latest.state = "queued".to_string()
                        });
                        let _ = self.persist();
                        self.clear_feedback_attachment_recovery(&record.capture_id);
                        record.state = "queued".to_string();
                    }
                    FeedbackAttachmentLink::Unlinked => {
                        self.clear_feedback_attachment_recovery(&record.capture_id);
                    }
                    FeedbackAttachmentLink::Unavailable => {
                        self.retry_feedback_attachment_recovery(&record.capture_id);
                    }
                }
            }
            if record.state != "queued" {
                return;
            }
        }
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
        if !is_allowed_den_api_base(&context.den_api_base) {
            return;
        }
        if record
            .next_retry_at
            .is_some_and(|retry_at| now_ms() < retry_at)
        {
            return;
        }
        if record.kind == "feedback-attachment" {
            self.flush_feedback_snapshot_streaming(&record, &path, &context, &mut poster);
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
        if let Err(reason) = validate_delivery_events(&events) {
            self.reject_delivery(&record.capture_id, &path, events.len() as u64, reason);
            return;
        }
        let batches = match build_batches(&context, &record.capture_id, &events) {
            Ok(batches) => batches,
            Err(reason) => {
                self.reject_delivery(&record.capture_id, &path, events.len() as u64, reason);
                return;
            }
        };
        let mut delivered = std::collections::HashSet::new();
        let mut rejected = false;
        let mut retryable = false;
        for batch in batches {
            match poster(&context, &batch) {
                Ok(()) => {
                    for event in &batch.events {
                        delivered.insert(event_id(event).expect("validated event ID").to_string());
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
        let completed = self
            .journal
            .lock()
            .ok()
            .and_then(|journal| journal.latest.clone())
            .filter(is_fully_delivered);
        if let Some(completed) = completed {
            if let Ok(mut journal) = self.journal.lock() {
                if journal.latest.as_ref().is_some_and(|latest| {
                    latest.capture_id == completed.capture_id && is_fully_delivered(latest)
                }) {
                    journal.latest = None;
                }
            }
            if let Ok(mut recent) = self.recently_completed.lock() {
                *recent = Some(completed);
            }
            let _ = fs::remove_file(&self.journal_path);
            return;
        }
        let _ = self.persist();
    }
}

fn post_batch(
    agent: &ureq::Agent,
    context: &CaptureCloudContext,
    batch: &PreparedBatch,
) -> Result<(), PostBatchError> {
    let url = format!(
        "{}/v1/desktop-diagnostics",
        context.den_api_base.trim_end_matches('/')
    );
    let response = agent
        .post(&url)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {}", context.token))
        .set("Idempotency-Key", &batch.batch_id)
        .send_bytes(&batch.body);
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

#[derive(Deserialize)]
struct FeedbackAttachmentLookupResponse {
    linked: bool,
}

fn feedback_attachment_link_status(
    context: &CaptureCloudContext,
    capture_id: &str,
) -> FeedbackAttachmentLink {
    let url = format!(
        "{}/v1/feedback/diagnostic-captures/{capture_id}",
        context.den_api_base.trim_end_matches('/')
    );
    let response = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .get(&url)
        .set("Authorization", &format!("Bearer {}", context.token))
        .set("x-veslo-org-id", &context.org_id)
        .call();
    match response {
        Ok(response) if (200..300).contains(&response.status()) => {
            match response.into_json::<FeedbackAttachmentLookupResponse>() {
                Ok(body) if body.linked => FeedbackAttachmentLink::Linked,
                Ok(_) => FeedbackAttachmentLink::Unlinked,
                Err(_) => FeedbackAttachmentLink::Unavailable,
            }
        }
        Err(ureq::Error::Status(404, _)) => FeedbackAttachmentLink::Unavailable,
        _ => FeedbackAttachmentLink::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recent_diagnostic_ring::RecentDiagnosticEvent;
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

    fn queued_event(id: &str, capture_id: &str, line: String) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "captureId": capture_id,
            "userId": "user-1",
            "orgId": "org-1",
            "workspaceId": "workspace-1",
            "source": "engine",
            "stream": "stderr",
            "timestamp": 1,
            "sequenceNo": 1,
            "payload": { "line": line },
        })
    }

    fn replace_queue(
        capture: &UserDiagnosticCapture,
        capture_id: &str,
        events: &[serde_json::Value],
        state: &str,
    ) {
        let queue = queue_path(&capture.spool_dir, capture_id);
        let raw = events
            .iter()
            .map(|event| event.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&queue, format!("{raw}\n")).unwrap();
        capture.update_latest(capture_id, |latest| {
            latest.state = state.to_string();
            latest.pending_events = events.len() as u64;
        });
        capture.persist().unwrap();
    }

    #[test]
    fn prepared_batches_preserve_oversized_event_order_and_exact_body() {
        let capture_id = "capture-1";
        let events = vec![
            queued_event("small-before", capture_id, "a".to_string()),
            queued_event("oversized", capture_id, "x".repeat(MAX_BATCH_BYTES + 1)),
            queued_event("small-after", capture_id, "b".to_string()),
        ];

        let batches = build_batches(&context(), capture_id, &events).unwrap();
        let ids = batches
            .iter()
            .flat_map(|batch| batch.events.iter())
            .map(|event| event_id(event).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ids, ["small-before", "oversized", "small-after"]);
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[1].events.len(), 1);
        assert!(batches[1].body.len() > MAX_BATCH_BYTES);
        assert_eq!(batches[1].batch_id, "capture:capture-1:oversized");
        let posted: serde_json::Value = serde_json::from_slice(&batches[1].body).unwrap();
        assert_eq!(posted["batchId"], batches[1].batch_id);
        assert_eq!(posted["events"], serde_json::json!([events[1].clone()]));
    }

    #[test]
    fn prepared_batches_keep_the_1000_event_boundary_normal() {
        let capture_id = "capture-1";
        let events = (0..=MAX_BATCH_EVENTS)
            .map(|index| queued_event(&format!("event-{index}"), capture_id, "x".to_string()))
            .collect::<Vec<_>>();

        let batches = build_batches(&context(), capture_id, &events).unwrap();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].events.len(), MAX_BATCH_EVENTS);
        assert_eq!(batches[1].events.len(), 1);
        assert!(batches
            .iter()
            .all(|batch| batch.body.len() <= MAX_BATCH_BYTES));
    }

    #[test]
    fn successful_local_poster_removes_oversized_event_from_finished_capture() {
        let dir = tempdir().unwrap();
        let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return;
        }
        let capture_id = capture.start(&context()).unwrap().capture_id.unwrap();
        let event = queued_event("oversized", &capture_id, "x".repeat(MAX_BATCH_BYTES + 1));
        replace_queue(
            &capture,
            &capture_id,
            std::slice::from_ref(&event),
            "finished",
        );

        let mut posted = None;
        capture.flush_with_poster(Some(context()), |_, batch| {
            posted = Some((batch.batch_id.clone(), batch.body.clone()));
            Ok(())
        });

        let (batch_id, body) = posted.expect("oversized batch posted");
        assert_eq!(batch_id, format!("capture:{capture_id}:oversized"));
        assert!(body.len() > MAX_BATCH_BYTES);
        let status = capture.status();
        assert_eq!(status.pending_events, 0);
        assert_eq!(status.accepted_events, 1);
        assert_eq!(status.state, "uploaded");
        assert!(!queue_path(dir.path(), &capture_id).exists());
        assert!(!dir.path().join(JOURNAL_FILE).exists());

        let restarted = UserDiagnosticCapture::new(dir.path().to_path_buf());
        let restarted_status = restarted.status();
        assert_eq!(restarted_status.state, "idle");
        assert_eq!(restarted_status.capture_id, None);
        assert!(!dir.path().join(JOURNAL_FILE).exists());
    }

    #[test]
    fn next_start_prunes_a_legacy_completed_capture_and_its_queue() {
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return;
        }

        let dir = tempdir().unwrap();
        let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
        let capture_id = capture.start(&context()).unwrap().capture_id.unwrap();
        fs::write(queue_path(dir.path(), &capture_id), "legacy event\n").unwrap();
        capture.update_latest(&capture_id, |latest| {
            latest.state = "uploaded".to_string();
            latest.pending_events = 0;
        });
        capture.persist().unwrap();
        drop(capture);

        let restarted = UserDiagnosticCapture::new(dir.path().to_path_buf());
        let status = restarted.status();
        assert_eq!(status.state, "idle");
        assert_eq!(status.capture_id, None);
        assert!(!dir.path().join(JOURNAL_FILE).exists());
        assert!(!queue_path(dir.path(), &capture_id).exists());
    }

    #[test]
    fn invalid_or_over_budget_queue_event_is_terminally_dropped_without_posting() {
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return;
        }

        for (reason, events) in [
            (
                "queue_invalid_event_id",
                vec![serde_json::json!({ "captureId": "capture-1" })],
            ),
            (
                "queue_invalid_event_id",
                vec![queued_event("", "capture-1", "x".to_string())],
            ),
            (
                "queue_duplicate_event_id",
                vec![
                    queued_event("duplicate", "capture-1", "x".to_string()),
                    queued_event(" duplicate ", "capture-1", "y".to_string()),
                ],
            ),
            (
                "queue_event_exceeds_capture_budget",
                vec![queued_event(
                    "over-budget",
                    "capture-1",
                    "x".repeat(CAPTURE_MAX_BYTES as usize),
                )],
            ),
        ] {
            let dir = tempdir().unwrap();
            let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
            let capture_id = capture.start(&context()).unwrap().capture_id.unwrap();
            replace_queue(&capture, &capture_id, &events, "finished");
            let mut post_calls = 0;
            capture.flush_with_poster(Some(context()), |_, _| {
                post_calls += 1;
                Ok(())
            });

            let status = capture.status();
            assert_eq!(post_calls, 0, "{reason}");
            assert_eq!(status.pending_events, 0, "{reason}");
            assert_eq!(status.dropped_delivery, events.len() as u64, "{reason}");
            assert_eq!(status.state, "delivery_rejected", "{reason}");
            assert_eq!(status.terminal_reason.as_deref(), Some(reason), "{reason}");
            assert!(!queue_path(dir.path(), &capture_id).exists(), "{reason}");
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
            Some("error"),
            "Bearer secret-token /Users/alice/project",
            1,
            |_| "Bearer [redacted] /Users/[user]/project".to_string(),
        );
        capture.observe("unlisted", "stderr", None, "must not queue", 2, |value| {
            value.to_string()
        });
        let raw = fs::read_to_string(queue_path(dir.path(), &capture_id)).unwrap();
        assert!(raw.contains("\"captureId\":\""));
        assert!(raw.contains("Bearer [redacted]"));
        assert!(!raw.contains("must not queue"));
        assert!(raw.contains("\"level\":\"error\""));
        assert_eq!(capture.status().captured_events, 1);
        assert_eq!(capture.status().pending_events, 2);
    }

    #[test]
    fn feedback_snapshot_stays_local_until_feedback_delivery_is_requested() {
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return;
        }
        let dir = tempdir().unwrap();
        let ring = RecentDiagnosticRing::new(dir.path().to_path_buf());
        ring.append(RecentDiagnosticEvent {
            timestamp_ms: now_ms(),
            sequence_no: 7,
            source: "engine".to_string(),
            stream: "stderr".to_string(),
            level: Some("error".to_string()),
            line: "sanitized failure".to_string(),
        });
        let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
        let snapshot = capture.create_feedback_snapshot(&context(), &ring).unwrap();
        let capture_id = snapshot.capture_id.unwrap();
        assert_eq!(snapshot.state, "ready");
        assert_eq!(snapshot.captured_events, 1);
        assert_eq!(snapshot.pending_events, 2);

        let mut post_calls = 0;
        capture.flush_with_poster(Some(context()), |_, _| {
            post_calls += 1;
            Ok(())
        });
        assert_eq!(post_calls, 0);

        capture
            .queue_feedback_snapshot_for_delivery(&capture_id)
            .unwrap();
        capture.flush_with_poster(Some(context()), |_, batch| {
            post_calls += 1;
            assert!(batch.body.len() <= FEEDBACK_BATCH_MAX_BYTES);
            Ok(())
        });
        let status = capture.status();
        assert_eq!(post_calls, 1);
        assert_eq!(status.state, "uploaded");
        assert_eq!(status.pending_events, 0);
    }

    #[test]
    fn feedback_snapshot_streams_bounded_batches_without_rebuilding_candidates() {
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return;
        }
        let dir = tempdir().unwrap();
        let ring = RecentDiagnosticRing::new(dir.path().to_path_buf());
        let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
        let capture_id = capture
            .create_feedback_snapshot(&context(), &ring)
            .unwrap()
            .capture_id
            .unwrap();
        let events = (0..=MAX_BATCH_EVENTS)
            .map(|index| queued_event(&format!("event-{index}"), &capture_id, "x".to_string()))
            .collect::<Vec<_>>();
        replace_queue(&capture, &capture_id, &events, "queued");

        let mut batches = Vec::new();
        capture.flush_with_poster(Some(context()), |_, batch| {
            batches.push((batch.events.len(), batch.body.len()));
            Ok(())
        });

        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].0, MAX_BATCH_EVENTS);
        assert_eq!(batches[1].0, 1);
        assert!(batches
            .iter()
            .all(|(_, bytes)| *bytes <= FEEDBACK_BATCH_MAX_BYTES));
        let status = capture.status();
        assert_eq!(status.state, "uploaded");
        assert_eq!(status.accepted_events, events.len() as u64);
    }

    #[test]
    fn feedback_snapshot_uses_the_larger_bounded_delivery_request() {
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return;
        }
        let dir = tempdir().unwrap();
        let ring = RecentDiagnosticRing::new(dir.path().to_path_buf());
        let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
        let capture_id = capture
            .create_feedback_snapshot(&context(), &ring)
            .unwrap()
            .capture_id
            .unwrap();
        let events = (0..3)
            .map(|index| {
                queued_event(
                    &format!("large-event-{index}"),
                    &capture_id,
                    "x".repeat(800 * 1024),
                )
            })
            .collect::<Vec<_>>();
        replace_queue(&capture, &capture_id, &events, "queued");

        let mut batches = Vec::new();
        capture.flush_with_poster(Some(context()), |_, batch| {
            batches.push((batch.events.len(), batch.body.len()));
            Ok(())
        });

        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].0, 2);
        assert_eq!(batches[1].0, 1);
        assert!(batches
            .iter()
            .all(|(_, bytes)| *bytes <= FEEDBACK_BATCH_MAX_BYTES));
    }

    #[test]
    fn restarted_desktop_marks_one_ready_feedback_snapshot_for_link_recovery() {
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return;
        }
        let dir = tempdir().unwrap();
        let ring = RecentDiagnosticRing::new(dir.path().to_path_buf());
        let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
        let capture_id = capture
            .create_feedback_snapshot(&context(), &ring)
            .unwrap()
            .capture_id
            .unwrap();

        let restarted = UserDiagnosticCapture::new(dir.path().to_path_buf());

        assert!(restarted.feedback_attachment_recovery_due(&capture_id));
        restarted.clear_feedback_attachment_recovery(&capture_id);
        assert!(!restarted.feedback_attachment_recovery_due(&capture_id));
        assert_eq!(restarted.status().state, "ready");
    }

    #[test]
    fn failed_feedback_can_discard_its_unqueued_snapshot() {
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return;
        }
        let dir = tempdir().unwrap();
        let ring = RecentDiagnosticRing::new(dir.path().to_path_buf());
        ring.append(RecentDiagnosticEvent {
            timestamp_ms: now_ms(),
            sequence_no: 7,
            source: "engine".to_string(),
            stream: "stderr".to_string(),
            level: Some("error".to_string()),
            line: "sanitized failure".to_string(),
        });
        let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
        let snapshot = capture.create_feedback_snapshot(&context(), &ring).unwrap();
        let capture_id = snapshot.capture_id.unwrap();

        capture.discard_feedback_snapshot(&capture_id).unwrap();

        assert_eq!(capture.status().state, "idle");
        assert!(!queue_path(dir.path(), &capture_id).exists());
        assert!(!dir.path().join(JOURNAL_FILE).exists());
    }

    #[test]
    fn a_new_feedback_snapshot_keeps_an_unverified_ready_snapshot() {
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return;
        }
        let dir = tempdir().unwrap();
        let ring = RecentDiagnosticRing::new(dir.path().to_path_buf());
        let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
        let first = capture.create_feedback_snapshot(&context(), &ring).unwrap();
        let first_id = first.capture_id.unwrap();

        let replacement = capture.create_feedback_snapshot(&context(), &ring);

        assert!(replacement.is_err());
        assert!(queue_path(dir.path(), &first_id).exists());
        assert_eq!(
            capture.status().capture_id.as_deref(),
            Some(first_id.as_str())
        );
    }

    #[test]
    fn stop_finishes_capture_with_user_stopped_summary() {
        let dir = tempdir().unwrap();
        let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return;
        }
        let started = capture.start(&context()).unwrap();
        let capture_id = started.capture_id.unwrap();
        capture.observe("engine", "stderr", None, "before stop", 1, |value| {
            value.to_string()
        });

        let stopped = capture.stop();
        assert_eq!(stopped.state, "finished");
        assert_eq!(stopped.terminal_reason.as_deref(), Some("user_stopped"));
        assert_eq!(stopped.captured_events, 1);

        let raw = fs::read_to_string(queue_path(dir.path(), &capture_id)).unwrap();
        assert!(raw.contains("\"state\":\"finished\""));
        assert!(raw.contains("\"terminalReason\":\"user_stopped\""));
        assert!(raw.contains("\"authoritativeOperation\":null"));
        assert!(raw.contains("\"captureId\":\""));
        assert!(raw.contains("\"phase\":\"diagnostic-capture\""));
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
                None,
                1,
                serde_json::json!({"line":"x"}),
            )
            .unwrap()
            .len() as u64
            + 1;
        capture.update_latest(&capture_id, |latest| {
            latest.captured_bytes = CAPTURE_MAX_BYTES - size + 1
        });
        capture.observe("engine", "stderr", None, "x", 1, |value| value.to_string());
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
    fn capture_rejects_an_unapproved_den_endpoint() {
        let dir = tempdir().unwrap();
        let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return;
        }
        let mut non_production = context();
        non_production.den_api_base = "https://example.test".to_string();
        assert!(capture.start(&non_production).is_err());
    }

    #[test]
    fn capture_accepts_the_staging_den_endpoint() {
        let dir = tempdir().unwrap();
        let capture = UserDiagnosticCapture::new(dir.path().to_path_buf());
        if !USER_DIAGNOSTIC_CAPTURE_ENABLED {
            return;
        }
        let mut staging = context();
        staging.den_api_base = STAGING_DEN_API_BASE.to_string();
        assert!(capture.start(&staging).is_ok());
    }
}
