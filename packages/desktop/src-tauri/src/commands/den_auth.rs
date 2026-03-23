use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::paths::home_dir;
use crate::utils::now_ms;

#[cfg(target_os = "macos")]
use std::process::Command;
#[cfg(target_os = "macos")]
use std::time::SystemTime;
#[cfg(target_os = "macos")]
use walkdir::WalkDir;

const DEN_AUTH_KEY: &str = "veslo.den.auth";
const DEN_KEEP_SIGNED_IN_KEY: &str = "veslo.den.keepSignedIn";
const DEN_AUTH_SNAPSHOT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DenAuthSnapshot {
    pub auth_json: Option<String>,
    pub keep_signed_in: Option<bool>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DenAuthSnapshotFile {
    version: u32,
    auth_json: Option<String>,
    keep_signed_in: Option<bool>,
    updated_at: u64,
    source: Option<String>,
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn resolve_den_auth_snapshot_path() -> PathBuf {
    if let Ok(raw) = std::env::var("VESLO_DEN_AUTH_SNAPSHOT_PATH") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    if let Some(home) = home_dir() {
        return home.join(".veslo").join("den-auth.json");
    }

    PathBuf::from(".veslo/den-auth.json")
}

fn read_den_auth_snapshot_file() -> Option<DenAuthSnapshot> {
    let path = resolve_den_auth_snapshot_path();
    let payload = fs::read_to_string(path).ok()?;
    let parsed = serde_json::from_str::<DenAuthSnapshotFile>(&payload).ok()?;
    Some(DenAuthSnapshot {
        auth_json: normalize_optional_text(parsed.auth_json),
        keep_signed_in: parsed.keep_signed_in,
        source: parsed.source,
    })
}

fn write_den_auth_snapshot_file(snapshot: &DenAuthSnapshot) -> Result<(), String> {
    let path = resolve_den_auth_snapshot_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    let payload = DenAuthSnapshotFile {
        version: DEN_AUTH_SNAPSHOT_VERSION,
        auth_json: normalize_optional_text(snapshot.auth_json.clone()),
        keep_signed_in: snapshot.keep_signed_in,
        updated_at: now_ms(),
        source: snapshot.source.clone(),
    };

    fs::write(
        &path,
        serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(())
}

fn parse_keep_signed_in(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    }
}

fn decode_hex(input: &str) -> Option<Vec<u8>> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.len() % 2 != 0 {
        return None;
    }

    let mut output = Vec::with_capacity(trimmed.len() / 2);
    let bytes = trimmed.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let pair = std::str::from_utf8(&bytes[index..index + 2]).ok()?;
        let value = u8::from_str_radix(pair, 16).ok()?;
        output.push(value);
        index += 2;
    }

    Some(output)
}

fn decode_webkit_storage_hex_value(raw_hex: &str) -> Option<String> {
    let bytes = decode_hex(raw_hex)?;
    if bytes.is_empty() {
        return Some(String::new());
    }

    let looks_utf16le = bytes.len() % 2 == 0
        && bytes
            .chunks_exact(2)
            .filter(|chunk| chunk[1] == 0)
            .count()
            > 0;

    if looks_utf16le {
        let utf16 = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        if let Ok(decoded) = String::from_utf16(&utf16) {
            return Some(decoded.trim_end_matches('\u{0}').to_string());
        }
    }

    String::from_utf8(bytes)
        .ok()
        .map(|value| value.trim_end_matches('\u{0}').to_string())
}

#[cfg(target_os = "macos")]
fn read_webkit_localstorage_value(db_path: &Path, key: &str) -> Option<String> {
    let query = format!("SELECT hex(value) FROM ItemTable WHERE key='{key}' LIMIT 1;");
    let output = Command::new("sqlite3")
        .arg(db_path)
        .arg(query)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let hex = String::from_utf8(output.stdout).ok()?;
    decode_webkit_storage_hex_value(&hex)
}

#[cfg(target_os = "macos")]
fn collect_legacy_webkit_dbs() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Some(home) = home_dir() else {
        return paths;
    };

    let buckets = [
        "veslo",
        "openwork",
        "com.neatech.veslo",
        "com.neatech.veslo.dev",
        "com.differentai.openwork",
    ];

    for bucket in buckets {
        let root = home
            .join("Library")
            .join("WebKit")
            .join(bucket)
            .join("WebsiteData")
            .join("Default");
        if !root.exists() {
            continue;
        }

        for entry in WalkDir::new(&root)
            .min_depth(1)
            .max_depth(8)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            if entry.file_name() == "localstorage.sqlite3" {
                paths.push(entry.path().to_path_buf());
            }
        }
    }

    paths
}

#[cfg(target_os = "macos")]
fn read_legacy_webkit_snapshot() -> Option<DenAuthSnapshot> {
    let mut selected: Option<(SystemTime, DenAuthSnapshot)> = None;
    for db_path in collect_legacy_webkit_dbs() {
        let auth_json = read_webkit_localstorage_value(&db_path, DEN_AUTH_KEY);
        let Some(auth_json) = normalize_optional_text(auth_json) else {
            continue;
        };

        let keep_signed_in = read_webkit_localstorage_value(&db_path, DEN_KEEP_SIGNED_IN_KEY)
            .as_deref()
            .and_then(parse_keep_signed_in);
        let modified = db_path
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);

        let snapshot = DenAuthSnapshot {
            auth_json: Some(auth_json),
            keep_signed_in,
            source: Some(format!("legacy-webkit:{}", db_path.display())),
        };

        match &selected {
            Some((current_modified, _)) if modified <= *current_modified => {}
            _ => {
                selected = Some((modified, snapshot));
            }
        }
    }

    selected.map(|(_, snapshot)| snapshot)
}

#[cfg(not(target_os = "macos"))]
fn read_legacy_webkit_snapshot() -> Option<DenAuthSnapshot> {
    None
}

#[tauri::command]
pub fn den_auth_snapshot_read() -> Result<DenAuthSnapshot, String> {
    if let Some(snapshot) = read_den_auth_snapshot_file() {
        return Ok(snapshot);
    }

    if let Some(snapshot) = read_legacy_webkit_snapshot() {
        let _ = write_den_auth_snapshot_file(&snapshot);
        return Ok(snapshot);
    }

    Ok(DenAuthSnapshot {
        auth_json: None,
        keep_signed_in: None,
        source: Some("empty".to_string()),
    })
}

#[tauri::command]
pub fn den_auth_snapshot_write(
    auth_json: Option<String>,
    keep_signed_in: Option<bool>,
) -> Result<(), String> {
    write_den_auth_snapshot_file(&DenAuthSnapshot {
        auth_json: normalize_optional_text(auth_json),
        keep_signed_in,
        source: Some("desktop-runtime".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        decode_webkit_storage_hex_value, den_auth_snapshot_read, parse_keep_signed_in,
        resolve_den_auth_snapshot_path,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn unique_temp_home(prefix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{nonce}"))
    }

    fn hex_utf16le(input: &str) -> String {
        let mut out = String::new();
        for code_unit in input.encode_utf16() {
            let [lo, hi] = code_unit.to_le_bytes();
            out.push_str(&format!("{lo:02X}{hi:02X}"));
        }
        out
    }

    #[test]
    fn decode_webkit_storage_hex_value_supports_utf16le() {
        let decoded = decode_webkit_storage_hex_value("3100").expect("decode");
        assert_eq!(decoded, "1");
    }

    #[test]
    fn decode_webkit_storage_hex_value_supports_utf8() {
        let decoded = decode_webkit_storage_hex_value("7b7d").expect("decode");
        assert_eq!(decoded, "{}");
    }

    #[test]
    fn parse_keep_signed_in_accepts_boolean_variants() {
        assert_eq!(parse_keep_signed_in("1"), Some(true));
        assert_eq!(parse_keep_signed_in("true"), Some(true));
        assert_eq!(parse_keep_signed_in("0"), Some(false));
        assert_eq!(parse_keep_signed_in("false"), Some(false));
        assert_eq!(parse_keep_signed_in("unexpected"), None);
    }

    #[test]
    fn den_auth_snapshot_read_migrates_from_legacy_webkit_storage() {
        let _lock = ENV_LOCK.lock().expect("env lock");

        let temp_home = unique_temp_home("veslo-den-auth-migration");
        fs::create_dir_all(&temp_home).expect("temp home");

        let previous_home = std::env::var("HOME").ok();
        std::env::set_var("HOME", temp_home.to_string_lossy().to_string());

        let legacy_db = temp_home
            .join("Library")
            .join("WebKit")
            .join("com.neatech.veslo.dev")
            .join("WebsiteData")
            .join("Default")
            .join("legacy-origin")
            .join("legacy-origin")
            .join("LocalStorage")
            .join("localstorage.sqlite3");
        fs::create_dir_all(legacy_db.parent().expect("legacy parent")).expect("legacy db dir");

        let auth_json = r#"{"denApiBase":"https://den-control-plane-veslo.onrender.com","token":"token_123","orgId":"org_123"}"#;
        let auth_hex = hex_utf16le(auth_json);
        let keep_hex = "3100";

        let sql = format!(
            "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL);\
             INSERT INTO ItemTable(key, value) VALUES('{auth_key}', X'{auth_hex}');\
             INSERT INTO ItemTable(key, value) VALUES('{keep_key}', X'{keep_hex}');",
            auth_key = "veslo.den.auth",
            keep_key = "veslo.den.keepSignedIn",
            auth_hex = auth_hex,
            keep_hex = keep_hex,
        );
        let sqlite_status = Command::new("sqlite3")
            .arg(&legacy_db)
            .arg(sql)
            .status()
            .expect("sqlite3 command");
        assert!(sqlite_status.success(), "sqlite3 failed to create legacy db");

        let snapshot = den_auth_snapshot_read().expect("snapshot read");
        assert_eq!(snapshot.auth_json, Some(auth_json.to_string()));
        assert_eq!(snapshot.keep_signed_in, Some(true));
        assert!(
            snapshot
                .source
                .as_deref()
                .unwrap_or("")
                .starts_with("legacy-webkit:"),
            "expected legacy-webkit source, got {:?}",
            snapshot.source
        );

        let snapshot_path = resolve_den_auth_snapshot_path();
        assert!(snapshot_path.is_file(), "snapshot file not created");

        if let Some(previous) = previous_home {
            std::env::set_var("HOME", previous);
        } else {
            std::env::remove_var("HOME");
        }

        let _ = fs::remove_dir_all(temp_home);
    }
}
