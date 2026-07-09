// VSLO-86 — Rust-side SSE proxy for engine `/event` streams.
//
// The Tauri http plugin (v2) routes every fetch through an IPC channel from
// the webview into a Rust handler. A long-lived SSE subscription started from
// JS via `tauriFetch` keeps an `fetch_read_body` invoke pending forever, which
// holds the IPC channel and blocks paralel short requests (e.g. sidebar
// session listing for several workspaces) until the 60s frontend timeout
// fires. Symptom: every workspace shows `Request timed out` Error badge after
// clicking the active one, even though direct curl to the same URL returns in
// ~70ms.
//
// We bypass this by holding the SSE stream entirely in Rust: a tokio task
// per subscription connects via reqwest, parses SSE chunks line-by-line, and
// emits each event to the webview through Tauri's event channel. The JS side
// `listen()`s instead of holding a fetch promise, so the http plugin's IPC
// stays free for short requests.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

const ENGINE_SSE_EVENT_NAME: &str = "veslo://engine-sse-event";
const SSE_LINE_BUFFER_CAP: usize = 1 << 20; // 1 MiB hard cap per single event

#[derive(Debug, PartialEq, Eq)]
enum SseParseStep {
    None,
    Emit(String),
    Overflow,
    InvalidUtf8,
}

#[derive(Default, Clone)]
pub struct EngineSseRegistry {
    inner: Arc<Mutex<EngineSseRegistryInner>>,
}

#[derive(Default)]
struct EngineSseRegistryInner {
    by_subscription: HashMap<String, EngineSseRegistration>,
    by_connection: HashMap<String, String>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct EngineSseRegistrySnapshot {
    active_subscription_count: usize,
    active_connection_count: usize,
}

struct EngineSseRegistration {
    cancel: tokio::sync::oneshot::Sender<()>,
    connection_key: Option<String>,
}

impl EngineSseRegistryInner {
    fn snapshot(&self) -> EngineSseRegistrySnapshot {
        EngineSseRegistrySnapshot {
            active_subscription_count: self.by_subscription.len(),
            active_connection_count: self.by_connection.len(),
        }
    }
}

impl EngineSseRegistry {
    fn insert(
        &self,
        id: String,
        connection_key: Option<String>,
        sender: tokio::sync::oneshot::Sender<()>,
    ) -> (
        Vec<tokio::sync::oneshot::Sender<()>>,
        EngineSseRegistrySnapshot,
    ) {
        let mut replaced = Vec::new();
        let mut snapshot = EngineSseRegistrySnapshot::default();
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(existing) = inner.by_subscription.remove(&id) {
                remove_connection_if_current(&mut inner, existing.connection_key.as_deref(), &id);
                replaced.push(existing.cancel);
            }

            if let Some(key) = connection_key.as_deref() {
                if let Some(previous_id) = inner.by_connection.insert(key.to_owned(), id.clone()) {
                    if previous_id != id {
                        if let Some(existing) = inner.by_subscription.remove(&previous_id) {
                            replaced.push(existing.cancel);
                        }
                    }
                }
            }

            inner.by_subscription.insert(
                id,
                EngineSseRegistration {
                    cancel: sender,
                    connection_key,
                },
            );
            snapshot = inner.snapshot();
        }
        (replaced, snapshot)
    }

    fn remove(&self, id: &str) -> Option<tokio::sync::oneshot::Sender<()>> {
        self.inner.lock().ok().and_then(|mut inner| {
            let existing = inner.by_subscription.remove(id)?;
            remove_connection_if_current(&mut inner, existing.connection_key.as_deref(), id);
            Some(existing.cancel)
        })
    }

    fn finish(&self, id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(existing) = inner.by_subscription.remove(id) {
                remove_connection_if_current(&mut inner, existing.connection_key.as_deref(), id);
            }
        }
    }
}

fn remove_connection_if_current(
    inner: &mut EngineSseRegistryInner,
    connection_key: Option<&str>,
    subscription_id: &str,
) {
    let Some(key) = connection_key else {
        return;
    };
    if inner
        .by_connection
        .get(key)
        .map(|current| current == subscription_id)
        .unwrap_or(false)
    {
        inner.by_connection.remove(key);
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EngineSseEvent {
    #[serde(rename_all = "camelCase")]
    Open {
        subscription_id: String,
        workspace_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Message {
        subscription_id: String,
        workspace_id: String,
        // Raw JSON parsed from the SSE `data:` payload. Engine emits one JSON
        // value per event so we keep it as a string and let JS parse — avoids
        // double-parsing and preserves engine wire format exactly.
        data: String,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        subscription_id: String,
        workspace_id: String,
        message: String,
    },
    #[serde(rename_all = "camelCase")]
    Closed {
        subscription_id: String,
        workspace_id: String,
        reason: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSseSubscribeOptions {
    /// Client-generated subscription id. JS registers its event listener
    /// before invoking this command so fast Rust-side open/error/closed events
    /// cannot be lost between command start and command return.
    pub subscription_id: Option<String>,
    pub workspace_id: String,
    /// Full base URL of the orchestrator proxy or engine, e.g.
    /// `http://127.0.0.1:51494/workspace/ws-XXX/opencode` or the bare engine
    /// `http://127.0.0.1:60931`. We append `/event` and pass the directory
    /// query through.
    pub base_url: String,
    pub directory: Option<String>,
    /// Stable owner key. A new subscription with the same key replaces the
    /// previous live stream before it can accumulate another upstream listener.
    pub connection_key: Option<String>,
    /// Optional Basic auth (engine + orchestrator daemon both expect
    /// `Authorization: Basic <b64>`).
    pub username: Option<String>,
    pub password: Option<String>,
    /// Optional Bearer auth (veslo-server expects `Authorization: Bearer
    /// <token>`). Mutually exclusive with username/password — Bearer wins
    /// when both are supplied.
    pub bearer_token: Option<String>,
    /// Timeout in seconds for the initial connect (HTTP headers). Once the
    /// stream is open we stay connected indefinitely. Default 30s.
    pub connect_timeout_secs: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSseSubscribeResult {
    pub subscription_id: String,
    pub replaced_existing: bool,
    pub active_subscription_count: usize,
    pub active_connection_count: usize,
}

#[tauri::command]
pub async fn engine_sse_subscribe(
    app: AppHandle,
    registry: State<'_, EngineSseRegistry>,
    options: EngineSseSubscribeOptions,
) -> Result<EngineSseSubscribeResult, String> {
    let subscription_id = resolve_subscription_id(options.subscription_id.as_deref());
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    let connection_key = normalize_connection_key(options.connection_key.as_deref());
    let (replaced, registry_snapshot) =
        registry.insert(subscription_id.clone(), connection_key, cancel_tx);
    let replaced_existing = !replaced.is_empty();
    for cancel_tx in replaced {
        let _ = cancel_tx.send(());
    }

    let app_handle = app.clone();
    let registry_handle = EngineSseRegistry {
        inner: registry.inner.clone(),
    };
    let sub_id = subscription_id.clone();
    let workspace_id = options.workspace_id.clone();
    let base_url = options.base_url.clone();
    let directory = options.directory.clone();
    let auth_header = match options
        .bearer_token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(token) => Some(format!("Bearer {}", token)),
        None => build_basic_auth_header(options.username.as_deref(), options.password.as_deref()),
    };
    let connect_timeout =
        std::time::Duration::from_secs(options.connect_timeout_secs.unwrap_or(30));

    tauri::async_runtime::spawn(async move {
        run_subscription(
            app_handle,
            registry_handle,
            sub_id,
            workspace_id,
            base_url,
            directory,
            auth_header,
            connect_timeout,
            cancel_rx,
        )
        .await;
    });

    Ok(EngineSseSubscribeResult {
        subscription_id,
        replaced_existing,
        active_subscription_count: registry_snapshot.active_subscription_count,
        active_connection_count: registry_snapshot.active_connection_count,
    })
}

#[tauri::command]
pub fn engine_sse_unsubscribe(
    registry: State<'_, EngineSseRegistry>,
    subscription_id: String,
) -> Result<bool, String> {
    match registry.remove(&subscription_id) {
        Some(cancel_tx) => {
            // Best-effort cancel — receiver may have already exited.
            let _ = cancel_tx.send(());
            Ok(true)
        }
        None => Ok(false),
    }
}

fn build_basic_auth_header(username: Option<&str>, password: Option<&str>) -> Option<String> {
    let user = username.unwrap_or("").trim();
    let pass = password.unwrap_or("").trim();
    if user.is_empty() && pass.is_empty() {
        return None;
    }
    let token = format!("{}:{}", user, pass);
    let encoded = base64::engine::general_purpose::STANDARD.encode(token.as_bytes());
    Some(format!("Basic {}", encoded))
}

fn resolve_subscription_id(subscription_id: Option<&str>) -> String {
    subscription_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}

fn normalize_connection_key(connection_key: Option<&str>) -> Option<String> {
    connection_key
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(ToOwned::to_owned)
}

fn build_event_url(base_url: &str, directory: &Option<String>) -> String {
    let trimmed = base_url.trim_end_matches('/');
    let base = format!("{}/event", trimmed);
    match directory.as_deref().map(str::trim) {
        Some(dir) if !dir.is_empty() => {
            let encoded = urlencoding_encode(dir);
            format!("{}?directory={}", base, encoded)
        }
        _ => base,
    }
}

/// Minimal RFC 3986 percent-encoding for the `directory` query string. We
/// avoid pulling in `urlencoding` crate for one callsite.
fn urlencoding_encode(input: &str) -> String {
    const SAFE: &[u8] = b"-_.~";
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        if byte.is_ascii_alphanumeric() || SAFE.contains(byte) {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

fn ingest_sse_byte(
    byte: u8,
    line_buffer: &mut Vec<u8>,
    data_accumulator: &mut String,
) -> SseParseStep {
    line_buffer.push(byte);
    if line_buffer.len() > SSE_LINE_BUFFER_CAP {
        line_buffer.clear();
        data_accumulator.clear();
        return SseParseStep::Overflow;
    }

    if byte != b'\n' {
        return SseParseStep::None;
    }

    let mut line = line_buffer.as_slice();
    if line.ends_with(b"\n") {
        line = &line[..line.len().saturating_sub(1)];
    }
    if line.ends_with(b"\r") {
        line = &line[..line.len().saturating_sub(1)];
    }

    let step = if line.is_empty() {
        if data_accumulator.is_empty() {
            SseParseStep::None
        } else {
            SseParseStep::Emit(std::mem::take(data_accumulator))
        }
    } else {
        let trimmed = match std::str::from_utf8(line) {
            Ok(value) => value,
            Err(_) => {
                data_accumulator.clear();
                line_buffer.clear();
                return SseParseStep::InvalidUtf8;
            }
        };
        if let Some(payload) = trimmed.strip_prefix("data:") {
            if !data_accumulator.is_empty() {
                data_accumulator.push('\n');
            }
            data_accumulator.push_str(payload.trim_start_matches(' '));
        }
        SseParseStep::None
    };

    line_buffer.clear();
    step
}

#[allow(clippy::too_many_arguments)]
async fn run_subscription(
    app: AppHandle,
    registry: EngineSseRegistry,
    subscription_id: String,
    workspace_id: String,
    base_url: String,
    directory: Option<String>,
    auth_header: Option<String>,
    connect_timeout: std::time::Duration,
    cancel_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let emit = |event: EngineSseEvent| {
        let _ = app.emit(ENGINE_SSE_EVENT_NAME, event);
    };

    let url = build_event_url(&base_url, &directory);

    let client = match reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .pool_idle_timeout(None)
        .build()
    {
        Ok(c) => c,
        Err(err) => {
            emit(EngineSseEvent::Error {
                subscription_id: subscription_id.clone(),
                workspace_id: workspace_id.clone(),
                message: format!("client build failed: {}", err),
            });
            registry.finish(&subscription_id);
            emit(EngineSseEvent::Closed {
                subscription_id,
                workspace_id,
                reason: "client-build-failed".into(),
            });
            return;
        }
    };

    let mut req = client.get(&url).header("Accept", "text/event-stream");
    if let Some(header) = auth_header.as_deref() {
        req = req.header("Authorization", header);
    }

    let response = match req.send().await {
        Ok(r) => r,
        Err(err) => {
            emit(EngineSseEvent::Error {
                subscription_id: subscription_id.clone(),
                workspace_id: workspace_id.clone(),
                message: format!("connect failed: {}", err),
            });
            registry.finish(&subscription_id);
            emit(EngineSseEvent::Closed {
                subscription_id,
                workspace_id,
                reason: "connect-failed".into(),
            });
            return;
        }
    };

    if !response.status().is_success() {
        emit(EngineSseEvent::Error {
            subscription_id: subscription_id.clone(),
            workspace_id: workspace_id.clone(),
            message: format!("upstream status {}", response.status()),
        });
        registry.finish(&subscription_id);
        emit(EngineSseEvent::Closed {
            subscription_id,
            workspace_id,
            reason: "non-success-status".into(),
        });
        return;
    }

    emit(EngineSseEvent::Open {
        subscription_id: subscription_id.clone(),
        workspace_id: workspace_id.clone(),
    });

    let mut byte_stream = response.bytes_stream();
    let mut line_buffer: Vec<u8> = Vec::new();
    let mut data_accumulator = String::new();
    let mut cancel_rx = cancel_rx;

    let close_reason: &'static str = loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                break "cancelled";
            }
            chunk = byte_stream.next() => {
                match chunk {
                    None => break "upstream-eof",
                    Some(Err(err)) => {
                        emit(EngineSseEvent::Error {
                            subscription_id: subscription_id.clone(),
                            workspace_id: workspace_id.clone(),
                            message: format!("stream error: {}", err),
                        });
                        break "stream-error";
                    }
                    Some(Ok(bytes)) => {
                        // SSE frames are CRLF or LF separated. Accumulate raw
                        // bytes and decode a full line as UTF-8. Decoding each
                        // byte as `char` corrupts multibyte text (`ř` -> `Å`).
                        for byte in bytes.iter() {
                            match ingest_sse_byte(*byte, &mut line_buffer, &mut data_accumulator) {
                                SseParseStep::None => {}
                                SseParseStep::Emit(data) => {
                                    emit(EngineSseEvent::Message {
                                        subscription_id: subscription_id.clone(),
                                        workspace_id: workspace_id.clone(),
                                        data,
                                    });
                                }
                                SseParseStep::Overflow => {
                                    emit(EngineSseEvent::Error {
                                        subscription_id: subscription_id.clone(),
                                        workspace_id: workspace_id.clone(),
                                        message: "line buffer overflow".into(),
                                    });
                                }
                                SseParseStep::InvalidUtf8 => {
                                    emit(EngineSseEvent::Error {
                                        subscription_id: subscription_id.clone(),
                                        workspace_id: workspace_id.clone(),
                                        message: "invalid utf-8 in SSE line".into(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    };

    registry.finish(&subscription_id);
    emit(EngineSseEvent::Closed {
        subscription_id,
        workspace_id,
        reason: close_reason.into(),
    });
}

// Parked for now: lib.rs manages EngineSseRegistry directly in the Tauri builder.
// pub fn register(app: &AppHandle) {
//     if app.try_state::<EngineSseRegistry>().is_none() {
//         app.manage(EngineSseRegistry::default());
//     }
// }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_basic_auth_when_credentials_present() {
        let h = build_basic_auth_header(Some("opencode"), Some("secret"));
        assert!(h.unwrap().starts_with("Basic "));
    }

    #[test]
    fn returns_none_when_no_credentials() {
        assert!(build_basic_auth_header(None, None).is_none());
        assert!(build_basic_auth_header(Some("  "), Some("")).is_none());
    }

    #[test]
    fn event_url_appends_directory_when_present() {
        let u = build_event_url(
            "http://127.0.0.1:1234/workspace/ws-x/opencode",
            &Some("/Users/test/path".into()),
        );
        assert_eq!(
            u,
            "http://127.0.0.1:1234/workspace/ws-x/opencode/event?directory=%2FUsers%2Ftest%2Fpath"
        );
    }

    #[test]
    fn event_url_omits_directory_when_empty() {
        let u = build_event_url("http://127.0.0.1:1234/", &None);
        assert_eq!(u, "http://127.0.0.1:1234/event");
        let u = build_event_url("http://127.0.0.1:1234", &Some("".into()));
        assert_eq!(u, "http://127.0.0.1:1234/event");
    }

    #[test]
    fn subscribe_options_accept_client_subscription_id() {
        assert_eq!(resolve_subscription_id(Some(" client-sub ")), "client-sub");
        assert!(!resolve_subscription_id(Some("   ")).is_empty());
        assert!(!resolve_subscription_id(None).is_empty());
    }

    #[test]
    fn normalizes_connection_key() {
        assert_eq!(
            normalize_connection_key(Some(" session-workspace:ws-a ")).as_deref(),
            Some("session-workspace:ws-a")
        );
        assert_eq!(normalize_connection_key(Some("   ")), None);
        assert_eq!(normalize_connection_key(None), None);
    }

    #[test]
    fn registry_replaces_existing_connection_key() {
        let registry = EngineSseRegistry::default();
        let (first_tx, mut first_rx) = tokio::sync::oneshot::channel::<()>();
        let (replaced, snapshot) = registry.insert("sub-a".into(), Some("key-a".into()), first_tx);
        assert!(replaced.is_empty());
        assert_eq!(
            snapshot,
            EngineSseRegistrySnapshot {
                active_subscription_count: 1,
                active_connection_count: 1,
            }
        );

        let (second_tx, _second_rx) = tokio::sync::oneshot::channel::<()>();
        let (replaced, snapshot) = registry.insert("sub-b".into(), Some("key-a".into()), second_tx);
        assert_eq!(replaced.len(), 1);
        assert_eq!(
            snapshot,
            EngineSseRegistrySnapshot {
                active_subscription_count: 1,
                active_connection_count: 1,
            }
        );
        for cancel_tx in replaced {
            let _ = cancel_tx.send(());
        }

        assert!(first_rx.try_recv().is_ok());
        assert!(registry.remove("sub-a").is_none());
        assert!(registry.remove("sub-b").is_some());
    }

    #[test]
    fn registry_finish_old_subscription_does_not_remove_replacement() {
        let registry = EngineSseRegistry::default();
        let (first_tx, _first_rx) = tokio::sync::oneshot::channel::<()>();
        let _ = registry.insert("sub-a".into(), Some("key-a".into()), first_tx);

        let (second_tx, _second_rx) = tokio::sync::oneshot::channel::<()>();
        let (replaced, _snapshot) =
            registry.insert("sub-b".into(), Some("key-a".into()), second_tx);
        assert_eq!(replaced.len(), 1);

        registry.finish("sub-a");

        assert!(registry.remove("sub-b").is_some());
    }

    #[test]
    fn sse_parser_preserves_utf8_payload() {
        let input = "data: {\"text\":\"Příliš žluťoučký kůň\"}\n\n";
        let mut line_buffer = Vec::new();
        let mut data_accumulator = String::new();
        let mut emitted = None;

        for byte in input.as_bytes() {
            if let SseParseStep::Emit(data) =
                ingest_sse_byte(*byte, &mut line_buffer, &mut data_accumulator)
            {
                emitted = Some(data);
            }
        }

        assert_eq!(
            emitted.as_deref(),
            Some("{\"text\":\"Příliš žluťoučký kůň\"}")
        );
    }

    #[test]
    fn sse_parser_joins_multiple_data_lines() {
        let input = "data: {\"a\":1,\ndata: \"b\":2}\n\n";
        let mut line_buffer = Vec::new();
        let mut data_accumulator = String::new();
        let mut emitted = None;

        for byte in input.as_bytes() {
            if let SseParseStep::Emit(data) =
                ingest_sse_byte(*byte, &mut line_buffer, &mut data_accumulator)
            {
                emitted = Some(data);
            }
        }

        assert_eq!(emitted.as_deref(), Some("{\"a\":1,\n\"b\":2}"));
    }
}
