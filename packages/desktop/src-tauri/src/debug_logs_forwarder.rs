use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
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

#[derive(Clone, Copy, Debug)]
pub enum LogStream {
    Stdout,
    Stderr,
}

impl LogStream {
    fn as_str(self) -> &'static str {
        match self {
            LogStream::Stdout => "stdout",
            LogStream::Stderr => "stderr",
        }
    }
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
    write_lock: Mutex<()>,
    sequence: AtomicU64,
}

impl DebugLogsForwarder {
    pub fn new(spool_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&spool_dir);
        let pending_path = spool_dir.join(PENDING_FILE);
        Self {
            spool_dir,
            pending_path,
            write_lock: Mutex::new(()),
            sequence: AtomicU64::new(0),
        }
    }

    pub fn append(&self, source: &str, stream: LogStream, line: &str) {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed.is_empty() {
            return;
        }

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let sequence_no = self.sequence.fetch_add(1, Ordering::Relaxed);

        let event = DebugLogEvent {
            id: Uuid::new_v4().to_string(),
            user_id: String::new(),
            org_id: String::new(),
            workspace_id: String::new(),
            source: source.to_string(),
            stream: stream.as_str().to_string(),
            timestamp,
            sequence_no,
            payload: serde_json::json!({ "line": trimmed }),
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

fn post_batch(
    base_url: &str,
    host_token: &str,
    batch_id: &str,
    events: Vec<serde_json::Value>,
) -> Result<(), String> {
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
        .map_err(|e| e.to_string())?;

    if !(200..300).contains(&response.status()) {
        return Err(format!("HTTP {}", response.status()));
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

        let Some((base_url, host_token)) = collect_server_state(&app) else {
            continue;
        };

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

        let mut server_unhealthy = false;
        for file in files {
            if server_unhealthy {
                break;
            }
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

            let mut all_ok = true;
            for chunk in events.chunks(MAX_EVENTS_PER_BATCH) {
                let batch_id = Uuid::new_v4().to_string();
                let chunk_vec: Vec<serde_json::Value> = chunk.to_vec();
                match post_batch(&base_url, &host_token, &batch_id, chunk_vec) {
                    Ok(()) => {}
                    Err(error) => {
                        eprintln!("[debug-logs-forwarder] post failed: {error}");
                        all_ok = false;
                        server_unhealthy = true;
                        break;
                    }
                }
            }
            if all_ok {
                let _ = fs::remove_file(&file);
            }
        }
    });
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
