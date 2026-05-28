use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

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

/// Print a `[veslo:flow]` / `[veslo:http]` diagnostic line if the toggle is on.
/// Same args as `eprintln!`. Guarded so format/allocation cost is skipped
/// entirely when disabled.
#[macro_export]
macro_rules! flow_log {
    ($($arg:tt)*) => {
        if $crate::utils::flow_log_enabled() {
            eprintln!($($arg)*);
        }
    };
}
