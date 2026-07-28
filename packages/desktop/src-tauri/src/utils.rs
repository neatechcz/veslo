use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

const FLOW_LOG_SENSITIVE_TAIL_MARKERS: &[&str] = &[
    "body=",
    "transport=",
    "error=",
    "error:",
    "path=",
    "project_dir:",
    "workspacepath=",
    "workspace_path=",
    "workdir=",
    "configdir=",
    "config_dir=",
    "directory=",
];

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn truncate_output(input: &str, max_chars: usize) -> String {
    if input.len() <= max_chars {
        return input.to_string();
    }

    input
        .chars()
        .skip(input.chars().count() - max_chars)
        .collect()
}

// Workflow / HTTP diagnostic logging toggle.
//
// Spec: dev-specific-docs/logging-workflow-milestones--claude.md
//
// Off by default. Opt-in via env var:
//   $env:VESLO_FLOW_LOG=1; pnpm dev    (PowerShell)
//   VESLO_FLOW_LOG=1 pnpm dev          (bash)
//
// Accepts "1", "true", "TRUE" as enabled; anything else (incl. unset) = off.
// The value is read once on first call and cached for the process lifetime.
pub fn flow_log_enabled() -> bool {
    static CACHED: OnceLock<bool> = OnceLock::new();
    *CACHED.get_or_init(|| {
        std::env::var("VESLO_FLOW_LOG")
            .map(|v| {
                let t = v.trim();
                t == "1" || t.eq_ignore_ascii_case("true")
            })
            .unwrap_or(false)
    })
}

/// Removes values which are useful to local debugging but unsafe to place in a
/// persisted diagnostic capture. Flow logging is opt-in, but it is forwarded by
/// the same capture path as ordinary runtime diagnostics.
pub fn sanitize_flow_log_message(message: &str) -> String {
    let mut sanitized = redact_http_urls(message);

    for marker in FLOW_LOG_SENSITIVE_TAIL_MARKERS {
        let lowercase = sanitized.to_ascii_lowercase();
        if let Some(index) = lowercase.find(marker) {
            sanitized.truncate(index + marker.len());
            sanitized.push_str("[redacted]");
            break;
        }
    }

    sanitized
}

fn redact_http_urls(message: &str) -> String {
    let mut sanitized = String::with_capacity(message.len());
    let mut remainder = message;

    loop {
        let lowercase = remainder.to_ascii_lowercase();
        let http_index = lowercase.find("http://");
        let https_index = lowercase.find("https://");
        let Some(start) = (match (http_index, https_index) {
            (Some(http), Some(https)) => Some(http.min(https)),
            (Some(index), None) | (None, Some(index)) => Some(index),
            (None, None) => None,
        }) else {
            sanitized.push_str(remainder);
            break;
        };

        sanitized.push_str(&remainder[..start]);
        sanitized.push_str("[redacted-url]");
        let url_tail = &remainder[start..];
        let end = url_tail
            .find(|character: char| {
                character.is_whitespace() || matches!(character, '\"' | '\'' | ')')
            })
            .unwrap_or(url_tail.len());
        remainder = &url_tail[end..];
    }

    sanitized
}

pub fn emit_flow_log(args: std::fmt::Arguments<'_>) {
    eprintln!("{}", sanitize_flow_log_message(&args.to_string()));
}

/// Print a `[veslo:flow]` / `[veslo:http]` diagnostic line if the toggle is on.
/// Same args as `eprintln!`. Guarded so format/allocation cost is skipped
/// entirely when disabled.
#[macro_export]
macro_rules! flow_log {
    ($($arg:tt)*) => {
        if $crate::utils::flow_log_enabled() {
            $crate::utils::emit_flow_log(format_args!($($arg)*));
        }
    };
}

#[cfg(test)]
mod tests {
    use super::sanitize_flow_log_message;

    #[test]
    fn flow_log_sanitizer_preserves_operation_status_and_duration() {
        let sanitized = sanitize_flow_log_message(
            "[veslo:http] IN 503 (17ms) http://127.0.0.1:43123/v1 (workspace.local)",
        );

        assert_eq!(
            sanitized,
            "[veslo:http] IN 503 (17ms) [redacted-url] (workspace.local)"
        );
    }

    #[test]
    fn flow_log_sanitizer_redacts_paths_bodies_and_transport_errors() {
        assert_eq!(
            sanitize_flow_log_message(
                "[veslo:http] OUT POST http://127.0.0.1:43123/workspaces path=\"C:\\\\Users\\\\jajse\\\\Desktop\\\\secret\"",
            ),
            "[veslo:http] OUT POST [redacted-url] path=[redacted]"
        );
        assert_eq!(
            sanitize_flow_log_message(
                "[veslo:http] IN 500 (7ms) http://127.0.0.1:43123/workspaces body=\"token=secret\"",
            ),
            "[veslo:http] IN 500 (7ms) [redacted-url] body=[redacted]"
        );
        assert_eq!(
            sanitize_flow_log_message(
                "[veslo:http] IN ERR (7ms) http://127.0.0.1:43123 transport=Connection refused",
            ),
            "[veslo:http] IN ERR (7ms) [redacted-url] transport=[redacted]"
        );
    }
}
