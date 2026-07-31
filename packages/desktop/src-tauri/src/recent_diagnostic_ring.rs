use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const RECENT_DIAGNOSTIC_WINDOW_MS: u64 = 10 * 60 * 1000;
pub const RECENT_DIAGNOSTIC_MAX_BYTES: u64 = 50 * 1024 * 1024;
const SEGMENT_MAX_BYTES: u64 = 1024 * 1024;
const SEGMENT_PREFIX: &str = "recent-diagnostics-";
const SEGMENT_SUFFIX: &str = ".jsonl";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecentDiagnosticEvent {
    pub timestamp_ms: u64,
    pub sequence_no: u64,
    pub source: String,
    pub stream: String,
    pub level: Option<String>,
    pub line: String,
}

#[derive(Clone, Debug)]
struct Segment {
    path: PathBuf,
    created_at_ms: u64,
    last_event_at_ms: u64,
    bytes: u64,
}

#[derive(Default)]
struct RingState {
    segments: VecDeque<Segment>,
    total_bytes: u64,
}

pub struct RecentDiagnosticRing {
    dir: PathBuf,
    state: Mutex<RingState>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn segment_name(created_at_ms: u64) -> String {
    format!("{SEGMENT_PREFIX}{created_at_ms}-{}.jsonl", Uuid::new_v4())
}

fn segment_timestamp(name: &str) -> Option<u64> {
    let raw = name
        .strip_prefix(SEGMENT_PREFIX)?
        .strip_suffix(SEGMENT_SUFFIX)?;
    raw.split('-').next()?.parse().ok()
}

impl RecentDiagnosticRing {
    pub fn new(parent_dir: PathBuf) -> Self {
        let dir = parent_dir.join("recent-diagnostics");
        let _ = fs::create_dir_all(&dir);
        let ring = Self {
            dir,
            state: Mutex::new(RingState::default()),
        };
        ring.restore();
        ring
    }

    pub fn append(&self, event: RecentDiagnosticEvent) {
        let serialized = match serde_json::to_string(&event) {
            Ok(value) => value,
            Err(_) => return,
        };
        let bytes = serialized.len().saturating_add(1) as u64;
        if bytes > SEGMENT_MAX_BYTES {
            return;
        }

        let Ok(mut state) = self.state.lock() else {
            return;
        };
        self.prune_locked(&mut state, event.timestamp_ms);

        let needs_new_segment = state
            .segments
            .back()
            .map(|segment| segment.bytes.saturating_add(bytes) > SEGMENT_MAX_BYTES)
            .unwrap_or(true);
        if needs_new_segment {
            let path = self.dir.join(segment_name(event.timestamp_ms));
            state.segments.push_back(Segment {
                path,
                created_at_ms: event.timestamp_ms,
                last_event_at_ms: event.timestamp_ms,
                bytes: 0,
            });
        }

        let Some(segment) = state.segments.back_mut() else {
            return;
        };
        let write_result = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&segment.path)
            .and_then(|mut file| writeln!(file, "{serialized}"));
        if write_result.is_err() {
            return;
        }
        segment.bytes = segment.bytes.saturating_add(bytes);
        segment.last_event_at_ms = event.timestamp_ms;
        state.total_bytes = state.total_bytes.saturating_add(bytes);
        self.prune_locked(&mut state, event.timestamp_ms);
    }

    pub fn for_each_recent(
        &self,
        mut visitor: impl FnMut(RecentDiagnosticEvent) -> Result<(), String>,
    ) -> Result<(), String> {
        let cutoff = now_ms().saturating_sub(RECENT_DIAGNOSTIC_WINDOW_MS);
        let paths = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "recent diagnostic ring lock poisoned".to_string())?;
            self.prune_locked(&mut state, now_ms());
            state
                .segments
                .iter()
                .map(|segment| segment.path.clone())
                .collect::<Vec<_>>()
        };

        for path in paths {
            let file = match File::open(path) {
                Ok(file) => file,
                Err(_) => continue,
            };
            for line in BufReader::new(file).lines() {
                let line = line.map_err(|error| error.to_string())?;
                let event: RecentDiagnosticEvent = match serde_json::from_str(&line) {
                    Ok(event) => event,
                    Err(_) => continue,
                };
                if event.timestamp_ms >= cutoff {
                    visitor(event)?;
                }
            }
        }
        Ok(())
    }

    fn restore(&self) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        let mut segments = entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let created_at_ms = segment_timestamp(&name)?;
                let bytes = entry.metadata().ok()?.len();
                let last_event_at_ms = File::open(entry.path())
                    .ok()
                    .and_then(|file| {
                        BufReader::new(file)
                            .lines()
                            .filter_map(Result::ok)
                            .filter_map(|line| {
                                serde_json::from_str::<RecentDiagnosticEvent>(&line).ok()
                            })
                            .map(|event| event.timestamp_ms)
                            .max()
                    })
                    .unwrap_or(created_at_ms);
                Some(Segment {
                    path: entry.path(),
                    created_at_ms,
                    last_event_at_ms,
                    bytes,
                })
            })
            .collect::<Vec<_>>();
        segments.sort_by_key(|segment| segment.created_at_ms);
        let total_bytes = segments.iter().map(|segment| segment.bytes).sum();
        if let Ok(mut state) = self.state.lock() {
            state.segments = segments.into();
            state.total_bytes = total_bytes;
            self.prune_locked(&mut state, now_ms());
        }
    }

    fn prune_locked(&self, state: &mut RingState, reference_ms: u64) {
        let cutoff = reference_ms.saturating_sub(RECENT_DIAGNOSTIC_WINDOW_MS);
        while state.segments.front().is_some_and(|segment| {
            segment.last_event_at_ms < cutoff || state.total_bytes > RECENT_DIAGNOSTIC_MAX_BYTES
        }) {
            let Some(segment) = state.segments.pop_front() else {
                break;
            };
            state.total_bytes = state.total_bytes.saturating_sub(segment.bytes);
            let _ = fs::remove_file(segment.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{RecentDiagnosticEvent, RecentDiagnosticRing, RECENT_DIAGNOSTIC_MAX_BYTES};
    use tempfile::tempdir;

    fn event(sequence_no: u64) -> RecentDiagnosticEvent {
        RecentDiagnosticEvent {
            timestamp_ms: super::now_ms(),
            sequence_no,
            source: "Veslo UI".to_string(),
            stream: "stderr".to_string(),
            level: Some("error".to_string()),
            line: format!("event-{sequence_no}"),
        }
    }

    #[test]
    fn persists_and_streams_recent_events_without_a_memory_snapshot() {
        let dir = tempdir().unwrap();
        let ring = RecentDiagnosticRing::new(dir.path().to_path_buf());
        ring.append(event(1));
        ring.append(event(2));

        let mut observed = Vec::new();
        ring.for_each_recent(|entry| {
            observed.push(entry.sequence_no);
            Ok(())
        })
        .unwrap();

        assert_eq!(observed, vec![1, 2]);
    }

    #[test]
    fn declared_budget_is_finite() {
        assert_eq!(RECENT_DIAGNOSTIC_MAX_BYTES, 50 * 1024 * 1024);
    }
}
