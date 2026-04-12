use std::collections::BTreeMap;
use std::sync::{mpsc, OnceLock};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DebugLogTarget {
    pub base_url: String,
    pub host_token: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct DebugLogRequest {
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

#[derive(Debug)]
struct PendingDebugLogLine {
    target: DebugLogTarget,
    source: String,
    stream: String,
    line: String,
}

pub fn resolve_debug_log_target(
    base_url: Option<&str>,
    host_token: Option<&str>,
) -> Option<DebugLogTarget> {
    let base_url = base_url?.trim().trim_end_matches('/').to_string();
    let host_token = host_token?.trim().to_string();
    if base_url.is_empty() || host_token.is_empty() {
        return None;
    }
    Some(DebugLogTarget {
        base_url,
        host_token,
    })
}

pub fn build_debug_log_request(
    base_url: &str,
    host_token: &str,
    source: &str,
    stream: &str,
    line: &str,
) -> DebugLogRequest {
    DebugLogRequest {
        url: format!("{}/internal/debug-logs", base_url.trim_end_matches('/')),
        headers: BTreeMap::from([
            ("content-type".to_string(), "application/json".to_string()),
            ("x-veslo-host-token".to_string(), host_token.to_string()),
        ]),
        body: serde_json::json!({
            "events": [
                {
                    "source": source,
                    "stream": stream,
                    "payload": {
                        "text": line,
                    },
                }
            ],
        })
        .to_string(),
    }
}

fn send_debug_log_request(request: &DebugLogRequest) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_millis(1_000))
        .build();
    let mut http_request = agent.post(&request.url);
    for (key, value) in &request.headers {
        http_request = http_request.set(key, value);
    }

    match http_request.send_string(&request.body) {
        Ok(response) if (200..300).contains(&response.status()) => Ok(()),
        Ok(response) => Err(format!(
            "debug log request failed with status {}",
            response.status()
        )),
        Err(ureq::Error::Status(code, _)) => {
            Err(format!("debug log request failed with status {code}"))
        }
        Err(error) => Err(format!("debug log request failed: {error}")),
    }
}

fn debug_log_sender() -> &'static mpsc::Sender<PendingDebugLogLine> {
    static SENDER: OnceLock<mpsc::Sender<PendingDebugLogLine>> = OnceLock::new();

    SENDER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<PendingDebugLogLine>();
        let _ = std::thread::Builder::new()
            .name("veslo-debug-log-sink".to_string())
            .spawn(move || {
                while let Ok(item) = rx.recv() {
                    let request = build_debug_log_request(
                        &item.target.base_url,
                        &item.target.host_token,
                        &item.source,
                        &item.stream,
                        &item.line,
                    );
                    let _ = send_debug_log_request(&request);
                }
            });
        tx
    })
}

pub fn dispatch_debug_log_line(target: DebugLogTarget, source: &str, stream: &str, line: String) {
    if line.is_empty() {
        return;
    }

    let _ = debug_log_sender().send(PendingDebugLogLine {
        target,
        source: source.to_string(),
        stream: stream.to_string(),
        line,
    });
}

#[cfg(test)]
mod tests {
    use super::{build_debug_log_request, resolve_debug_log_target};

    #[test]
    fn builds_host_authenticated_debug_log_requests() {
        let request = build_debug_log_request(
            "http://127.0.0.1:8787",
            "host-token",
            "engine",
            "stdout",
            "hello\n",
        );

        assert_eq!(request.url, "http://127.0.0.1:8787/internal/debug-logs");
        assert_eq!(
            request
                .headers
                .get("x-veslo-host-token")
                .map(String::as_str),
            Some("host-token")
        );
        assert!(request.body.contains("\"source\":\"engine\""));
        assert!(request.body.contains("\"stream\":\"stdout\""));
    }

    #[test]
    fn resolves_only_complete_debug_log_targets() {
        assert!(
            resolve_debug_log_target(Some("http://127.0.0.1:8787"), Some("host-token")).is_some()
        );
        assert!(resolve_debug_log_target(Some(""), Some("host-token")).is_none());
        assert!(resolve_debug_log_target(Some("http://127.0.0.1:8787"), Some("")).is_none());
    }
}
