use std::fs;
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::paths::home_dir;
use crate::utils::now_ms;

#[cfg(target_os = "macos")]
use std::time::SystemTime;
#[cfg(target_os = "macos")]
use walkdir::WalkDir;

#[cfg(target_os = "macos")]
const DEN_AUTH_KEY: &str = "veslo.den.auth";
#[cfg(target_os = "macos")]
const DEN_KEEP_SIGNED_IN_KEY: &str = "veslo.den.keepSignedIn";
const DEN_AUTH_SNAPSHOT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DenAuthSnapshot {
    pub auth_json: Option<String>,
    pub keep_signed_in: Option<bool>,
    pub language: Option<String>,
    pub onboarding_complete: Option<bool>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DenAuthSnapshotFile {
    version: u32,
    auth_json: Option<String>,
    keep_signed_in: Option<bool>,
    language: Option<String>,
    onboarding_complete: Option<bool>,
    updated_at: u64,
    source: Option<String>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDenAuthState {
    den_api_base: Option<String>,
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

#[cfg(target_os = "macos")]
fn snapshot_den_api_base(snapshot: &DenAuthSnapshot) -> Option<String> {
    let raw = snapshot.auth_json.as_deref()?;
    let parsed = serde_json::from_str::<PersistedDenAuthState>(raw).ok()?;
    normalize_optional_text(parsed.den_api_base)
}

#[cfg(target_os = "macos")]
fn den_api_base_uses_loopback(base: &str) -> bool {
    let lower = base.trim().to_ascii_lowercase();
    lower.starts_with("http://127.0.0.1")
        || lower.starts_with("https://127.0.0.1")
        || lower.starts_with("http://localhost")
        || lower.starts_with("https://localhost")
        || lower.starts_with("http://[::1]")
        || lower.starts_with("https://[::1]")
        || lower.starts_with("http://0.0.0.0")
        || lower.starts_with("https://0.0.0.0")
}

#[cfg(target_os = "macos")]
fn snapshot_uses_loopback(snapshot: &DenAuthSnapshot) -> bool {
    snapshot_den_api_base(snapshot)
        .as_deref()
        .map(den_api_base_uses_loopback)
        .unwrap_or(false)
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
        language: normalize_optional_text(parsed.language),
        onboarding_complete: parsed.onboarding_complete,
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
        language: normalize_optional_text(snapshot.language.clone()),
        onboarding_complete: snapshot.onboarding_complete,
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

#[cfg(any(target_os = "macos", test))]
fn parse_keep_signed_in(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    }
}

#[cfg(any(target_os = "macos", test))]
fn decode_hex(input: &str) -> Option<Vec<u8>> {
    let trimmed = input.trim();
    if trimmed.is_empty() || !trimmed.len().is_multiple_of(2) {
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

#[cfg(any(target_os = "macos", test))]
fn decode_webkit_storage_hex_value(raw_hex: &str) -> Option<String> {
    let bytes = decode_hex(raw_hex)?;
    if bytes.is_empty() {
        return Some(String::new());
    }

    let looks_utf16le =
        bytes.len() % 2 == 0 && bytes.chunks_exact(2).filter(|chunk| chunk[1] == 0).count() > 0;

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
fn sqlite3_command() -> Command {
    #[cfg(target_os = "macos")]
    {
        let system_sqlite = std::path::Path::new("/usr/bin/sqlite3");
        if system_sqlite.is_file() {
            return Command::new(system_sqlite);
        }
    }

    Command::new("sqlite3")
}

#[cfg(target_os = "macos")]
fn read_webkit_localstorage_value(db_path: &std::path::Path, key: &str) -> Option<String> {
    let query = format!("SELECT hex(value) FROM ItemTable WHERE key='{key}' LIMIT 1;");
    let output = sqlite3_command().arg(db_path).arg(query).output().ok()?;
    if !output.status.success() {
        return None;
    }

    let hex = String::from_utf8(output.stdout).ok()?;
    decode_webkit_storage_hex_value(&hex)
}

#[cfg(target_os = "macos")]
struct LegacyWebkitDb {
    bucket: &'static str,
    path: PathBuf,
}

#[cfg(target_os = "macos")]
fn collect_legacy_webkit_dbs() -> Vec<LegacyWebkitDb> {
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
                paths.push(LegacyWebkitDb {
                    bucket,
                    path: entry.path().to_path_buf(),
                });
            }
        }
    }

    paths
}

#[cfg(target_os = "macos")]
fn legacy_webkit_bucket_priority(bucket: &str) -> u8 {
    match bucket {
        "com.neatech.veslo" | "com.neatech.veslo.dev" => 3,
        "com.differentai.openwork" => 2,
        "veslo" | "openwork" => 1,
        _ => 0,
    }
}

#[cfg(target_os = "macos")]
fn legacy_webkit_bucket_from_source(source: &str) -> Option<&str> {
    let path = source.strip_prefix("legacy-webkit:")?;
    let marker = "/Library/WebKit/";
    let start = path.find(marker)? + marker.len();
    let tail = &path[start..];
    let end = tail.find('/')?;
    Some(&tail[..end])
}

#[cfg(target_os = "macos")]
fn snapshot_source_priority(snapshot: &DenAuthSnapshot) -> u8 {
    snapshot
        .source
        .as_deref()
        .and_then(legacy_webkit_bucket_from_source)
        .map(legacy_webkit_bucket_priority)
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
fn should_prefer_legacy_over_snapshot_file(
    snapshot_file: &DenAuthSnapshot,
    legacy_snapshot: &DenAuthSnapshot,
) -> bool {
    let legacy_priority = snapshot_source_priority(legacy_snapshot);
    if legacy_priority <= snapshot_source_priority(snapshot_file) || legacy_priority <= 1 {
        return false;
    }

    snapshot_uses_loopback(snapshot_file) && !snapshot_uses_loopback(legacy_snapshot)
}

#[cfg(not(target_os = "macos"))]
fn should_prefer_legacy_over_snapshot_file(
    _snapshot_file: &DenAuthSnapshot,
    _legacy_snapshot: &DenAuthSnapshot,
) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn read_legacy_webkit_snapshot() -> Option<DenAuthSnapshot> {
    let mut selected: Option<(u8, SystemTime, DenAuthSnapshot)> = None;
    for db in collect_legacy_webkit_dbs() {
        let auth_json = read_webkit_localstorage_value(&db.path, DEN_AUTH_KEY);
        let Some(auth_json) = normalize_optional_text(auth_json) else {
            continue;
        };

        let keep_signed_in = read_webkit_localstorage_value(&db.path, DEN_KEEP_SIGNED_IN_KEY)
            .as_deref()
            .and_then(parse_keep_signed_in);
        let modified = db
            .path
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let priority = legacy_webkit_bucket_priority(db.bucket);

        let snapshot = DenAuthSnapshot {
            auth_json: Some(auth_json),
            keep_signed_in,
            language: None,
            onboarding_complete: None,
            source: Some(format!("legacy-webkit:{}", db.path.display())),
        };

        match &selected {
            Some((current_priority, current_modified, _))
                if priority < *current_priority
                    || (priority == *current_priority && modified <= *current_modified) => {}
            _ => {
                selected = Some((priority, modified, snapshot));
            }
        }
    }

    selected.map(|(_, _, snapshot)| snapshot)
}

#[cfg(not(target_os = "macos"))]
fn read_legacy_webkit_snapshot() -> Option<DenAuthSnapshot> {
    None
}

#[tauri::command]
pub fn den_auth_snapshot_read() -> Result<DenAuthSnapshot, String> {
    let snapshot_file = read_den_auth_snapshot_file();
    let legacy_snapshot = read_legacy_webkit_snapshot();

    if let (Some(file_snapshot), Some(legacy_snapshot)) =
        (snapshot_file.as_ref(), legacy_snapshot.as_ref())
    {
        if should_prefer_legacy_over_snapshot_file(file_snapshot, legacy_snapshot) {
            let repaired = legacy_snapshot.clone();
            let _ = write_den_auth_snapshot_file(&repaired);
            return Ok(repaired);
        }
    }

    if let Some(snapshot) = snapshot_file {
        return Ok(snapshot);
    }

    if let Some(snapshot) = legacy_snapshot {
        let _ = write_den_auth_snapshot_file(&snapshot);
        return Ok(snapshot);
    }

    Ok(DenAuthSnapshot {
        auth_json: None,
        keep_signed_in: None,
        language: None,
        onboarding_complete: None,
        source: Some("empty".to_string()),
    })
}

#[tauri::command]
pub fn den_auth_snapshot_write(
    auth_json: Option<String>,
    keep_signed_in: Option<bool>,
    language: Option<String>,
    onboarding_complete: Option<bool>,
) -> Result<(), String> {
    write_den_auth_snapshot_file(&DenAuthSnapshot {
        auth_json: normalize_optional_text(auth_json),
        keep_signed_in,
        language: normalize_optional_text(language),
        onboarding_complete,
        source: Some("desktop-runtime".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use crate::env_guard::EnvVarGuard;

    #[cfg(target_os = "macos")]
    use super::resolve_den_auth_snapshot_path;
    #[cfg(target_os = "macos")]
    use super::sqlite3_command;
    use super::{
        decode_webkit_storage_hex_value, den_auth_snapshot_read, den_auth_snapshot_write,
        parse_keep_signed_in,
    };
    use std::fs;
    use std::path::PathBuf;
    #[cfg(target_os = "macos")]
    use std::thread::sleep;
    #[cfg(target_os = "macos")]
    use std::time::Duration;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_home(prefix: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{nonce}"))
    }

    #[cfg(target_os = "macos")]
    fn hex_utf16le(input: &str) -> String {
        let mut out = String::new();
        for code_unit in input.encode_utf16() {
            let [lo, hi] = code_unit.to_le_bytes();
            out.push_str(&format!("{lo:02X}{hi:02X}"));
        }
        out
    }

    #[cfg(target_os = "macos")]
    fn create_legacy_webkit_db(
        temp_home: &std::path::Path,
        bucket: &str,
        auth_json: &str,
    ) -> PathBuf {
        let legacy_db = temp_home
            .join("Library")
            .join("WebKit")
            .join(bucket)
            .join("WebsiteData")
            .join("Default")
            .join("legacy-origin")
            .join("legacy-origin")
            .join("LocalStorage")
            .join("localstorage.sqlite3");
        fs::create_dir_all(legacy_db.parent().expect("legacy parent")).expect("legacy db dir");

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
        let sqlite_status = sqlite3_command()
            .arg(&legacy_db)
            .arg(sql)
            .status()
            .expect("sqlite3 command");
        assert!(
            sqlite_status.success(),
            "sqlite3 failed to create legacy db"
        );

        legacy_db
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
    #[cfg(target_os = "macos")]
    fn den_auth_snapshot_read_migrates_from_legacy_webkit_storage() {
        let temp_home = unique_temp_home("veslo-den-auth-migration");
        fs::create_dir_all(&temp_home).expect("temp home");

        let _env = EnvVarGuard::apply_many(&[
            ("HOME", Some(temp_home.to_string_lossy().as_ref())),
            ("VESLO_DEN_AUTH_SNAPSHOT_PATH", None),
        ]);

        let auth_json = r#"{"denApiBase":"https://den-control-plane-veslo.onrender.com","token":"token_123","orgId":"org_123"}"#;
        create_legacy_webkit_db(&temp_home, "com.neatech.veslo.dev", auth_json);

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

        let _ = fs::remove_dir_all(temp_home);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn den_auth_snapshot_read_migrates_when_path_excludes_sqlite3() {
        let temp_home = unique_temp_home("veslo-den-auth-path-isolation");
        let temp_path = unique_temp_home("veslo-den-auth-empty-path");
        fs::create_dir_all(&temp_home).expect("temp home");
        fs::create_dir_all(&temp_path).expect("temp path");

        let _env = EnvVarGuard::apply_many(&[
            ("HOME", Some(temp_home.to_string_lossy().as_ref())),
            ("VESLO_DEN_AUTH_SNAPSHOT_PATH", None),
            ("PATH", Some(temp_path.to_string_lossy().as_ref())),
        ]);

        let auth_json = r#"{"denApiBase":"https://den-control-plane-veslo.onrender.com","token":"token_123","orgId":"org_123"}"#;
        create_legacy_webkit_db(&temp_home, "com.neatech.veslo.dev", auth_json);

        let snapshot = den_auth_snapshot_read().expect("snapshot read");
        assert_eq!(snapshot.auth_json, Some(auth_json.to_string()));

        let _ = fs::remove_dir_all(temp_home);
        let _ = fs::remove_dir_all(temp_path);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn den_auth_snapshot_read_prefers_app_bundle_snapshot_over_generic_webkit_bucket() {
        let temp_home = unique_temp_home("veslo-den-auth-priority");
        fs::create_dir_all(&temp_home).expect("temp home");

        let _env = EnvVarGuard::apply_many(&[
            ("HOME", Some(temp_home.to_string_lossy().as_ref())),
            ("VESLO_DEN_AUTH_SNAPSHOT_PATH", None),
        ]);

        let preferred_auth = r#"{"email":"vaclav.soukup@neatech.cz","token":"real-token"}"#;
        let fallback_auth = r#"{"email":"feedback@example.com","token":"test-token"}"#;

        let preferred_db = create_legacy_webkit_db(&temp_home, "com.neatech.veslo", preferred_auth);
        sleep(Duration::from_millis(20));
        let fallback_db = create_legacy_webkit_db(&temp_home, "veslo", fallback_auth);

        let preferred_modified = preferred_db
            .metadata()
            .and_then(|meta| meta.modified())
            .expect("preferred modified");
        let fallback_modified = fallback_db
            .metadata()
            .and_then(|meta| meta.modified())
            .expect("fallback modified");
        assert!(
            fallback_modified >= preferred_modified,
            "expected generic bucket to be newer for regression coverage"
        );

        let snapshot = den_auth_snapshot_read().expect("snapshot read");
        assert_eq!(snapshot.auth_json, Some(preferred_auth.to_string()));
        assert!(
            snapshot
                .source
                .as_deref()
                .unwrap_or("")
                .contains("com.neatech.veslo"),
            "expected app bundle source, got {:?}",
            snapshot.source
        );

        let _ = fs::remove_dir_all(temp_home);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn den_auth_snapshot_read_repairs_loopback_snapshot_file_from_legacy_storage() {
        let temp_home = unique_temp_home("veslo-den-auth-repair");
        fs::create_dir_all(&temp_home).expect("temp home");

        let _env = EnvVarGuard::apply_many(&[
            ("HOME", Some(temp_home.to_string_lossy().as_ref())),
            ("VESLO_DEN_AUTH_SNAPSHOT_PATH", None),
        ]);

        let loopback_auth = r#"{"denApiBase":"http://127.0.0.1:65187","token":"den-token-e2e","orgId":"org-e2e","user":{"id":"user-e2e","email":"feedback@example.com","name":"Feedback Tester"},"org":{"id":"org-e2e","name":"E2E Org","slug":"e2e-org","role":"owner"}}"#;
        let preferred_auth = r#"{"denApiBase":"https://den-control-plane-veslo.onrender.com","token":"real-token","orgId":"org-real","user":{"id":"user-real","email":"vaclav.soukup@neatech.cz","name":"Václav Soukup"},"org":{"id":"org-real","name":"Personal","slug":"personal","role":"owner"}}"#;

        let snapshot_path = resolve_den_auth_snapshot_path();
        fs::create_dir_all(snapshot_path.parent().expect("snapshot parent")).expect("snapshot dir");
        fs::write(
            &snapshot_path,
            format!(
                r#"{{
  "version": 1,
  "authJson": {auth_json:?},
  "keepSignedIn": true,
  "updatedAt": 1,
  "source": "desktop-runtime"
}}"#,
                auth_json = loopback_auth
            ),
        )
        .expect("snapshot write");

        create_legacy_webkit_db(&temp_home, "com.neatech.veslo", preferred_auth);

        let snapshot = den_auth_snapshot_read().expect("snapshot read");
        assert_eq!(snapshot.auth_json, Some(preferred_auth.to_string()));
        assert!(
            snapshot
                .source
                .as_deref()
                .unwrap_or("")
                .contains("com.neatech.veslo"),
            "expected repaired snapshot to come from app bundle legacy storage, got {:?}",
            snapshot.source
        );

        let persisted = fs::read_to_string(&snapshot_path).expect("snapshot persisted");
        assert!(
            persisted.contains("real-token"),
            "expected repaired snapshot file to be rewritten"
        );

        let _ = fs::remove_dir_all(temp_home);
    }

    #[test]
    fn den_auth_snapshot_round_trips_language_and_onboarding_complete() {
        let temp_home = unique_temp_home("veslo-den-auth-roundtrip");
        fs::create_dir_all(&temp_home).expect("temp home");
        let snapshot_path = temp_home.join("den-auth.json");

        let _env = EnvVarGuard::apply(
            "VESLO_DEN_AUTH_SNAPSHOT_PATH",
            Some(snapshot_path.to_string_lossy().as_ref()),
        );

        den_auth_snapshot_write(
            Some(r#"{"token":"token_123"}"#.to_string()),
            Some(true),
            Some("en".to_string()),
            Some(true),
        )
        .expect("snapshot write");

        let snapshot = den_auth_snapshot_read().expect("snapshot read");
        assert_eq!(
            snapshot.auth_json,
            Some(r#"{"token":"token_123"}"#.to_string())
        );
        assert_eq!(snapshot.keep_signed_in, Some(true));
        assert_eq!(snapshot.language, Some("en".to_string()));
        assert_eq!(snapshot.onboarding_complete, Some(true));

        let _ = fs::remove_dir_all(temp_home);
    }
}
