use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use tauri::Manager;

const ACCESS_PROOFS_FILE_NAME: &str = "access-proofs.v1.json";
const ACCESS_PROOFS_VERSION: u32 = 1;
const MAX_MANAGED_AI_RECORDS: usize = 32;

fn default_access_proofs_version() -> u32 {
    ACCESS_PROOFS_VERSION
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct AccessProofFile {
    #[serde(default = "default_access_proofs_version")]
    version: u32,
    #[serde(default)]
    managed_ai: Vec<ManagedAiAccessProofRecord>,
    #[serde(default)]
    workspace_permissions: Vec<WorkspacePermissionProofRecord>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ManagedAiAccessProofRecord {
    cache_key_hash: String,
    fetched_at: u64,
    provider_id: String,
    default_model: ManagedAiModelRef,
    #[serde(default)]
    allowed_models: Vec<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    runtime_config_fingerprint: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct WorkspacePermissionProofRecord {
    workspace_id: String,
    path_hash: String,
    #[serde(default)]
    authorized_root_hashes: Vec<String>,
    validated_at: u64,
    #[serde(default)]
    source: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAiModelRef {
    pub provider_id: String,
    pub model_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAiAccessProofWrite {
    pub provider_id: String,
    pub default_model: ManagedAiModelRef,
    #[serde(default)]
    pub allowed_models: Vec<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub runtime_config_fingerprint: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAiAccessProofRead {
    pub fetched_at: u64,
    pub provider_id: String,
    pub default_model: ManagedAiModelRef,
    pub allowed_models: Vec<String>,
    pub updated_at: Option<String>,
    pub runtime_config_fingerprint: Option<String>,
}

fn access_proofs_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = if let Some(override_dir) = crate::paths::app_data_dir_override() {
        override_dir
    } else {
        app.path()
            .app_data_dir()
            .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
    };
    Ok(data_dir.join(ACCESS_PROOFS_FILE_NAME))
}

fn hash_cache_key(cache_key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(cache_key.trim().as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{:02x}", b)).collect();
    format!("sha1:{hex}")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    let trimmed = value?.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn normalize_model_ref(value: ManagedAiModelRef) -> ManagedAiModelRef {
    ManagedAiModelRef {
        provider_id: value.provider_id.trim().to_string(),
        model_id: value.model_id.trim().to_string(),
    }
}

fn normalize_allowed_models(values: Vec<String>) -> Vec<String> {
    let mut out = Vec::<String>::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() || out.iter().any(|existing| existing == trimmed) {
            continue;
        }
        out.push(trimmed.to_string());
    }
    out
}

fn valid_managed_ai_record(record: &ManagedAiAccessProofRecord) -> bool {
    !record.cache_key_hash.trim().is_empty()
        && !record.provider_id.trim().is_empty()
        && !record.default_model.provider_id.trim().is_empty()
        && !record.default_model.model_id.trim().is_empty()
}

fn read_access_proofs(path: &PathBuf) -> AccessProofFile {
    let Ok(raw) = fs::read_to_string(path) else {
        return AccessProofFile {
            version: ACCESS_PROOFS_VERSION,
            ..AccessProofFile::default()
        };
    };
    let mut parsed = serde_json::from_str::<AccessProofFile>(&raw).unwrap_or_default();
    if parsed.version == 0 {
        parsed.version = ACCESS_PROOFS_VERSION;
    }
    parsed.managed_ai.retain(valid_managed_ai_record);
    parsed
}

fn write_access_proofs(path: &PathBuf, proofs: &AccessProofFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let payload = serde_json::to_string_pretty(proofs).map_err(|e| e.to_string())?;
    fs::write(path, format!("{payload}\n"))
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

#[tauri::command]
pub fn access_proof_ai_read(
    app: tauri::AppHandle,
    cache_key: String,
    max_age_ms: u64,
) -> Result<Option<ManagedAiAccessProofRead>, String> {
    let trimmed_key = cache_key.trim();
    if trimmed_key.is_empty() {
        return Ok(None);
    }

    let path = access_proofs_path(&app)?;
    let proofs = read_access_proofs(&path);
    let cache_key_hash = hash_cache_key(trimmed_key);
    let now = now_ms();

    let Some(record) = proofs
        .managed_ai
        .into_iter()
        .find(|record| record.cache_key_hash == cache_key_hash)
    else {
        return Ok(None);
    };

    if max_age_ms > 0 && now.saturating_sub(record.fetched_at) > max_age_ms {
        return Ok(None);
    }

    Ok(Some(ManagedAiAccessProofRead {
        fetched_at: record.fetched_at,
        provider_id: record.provider_id,
        default_model: record.default_model,
        allowed_models: record.allowed_models,
        updated_at: record.updated_at,
        runtime_config_fingerprint: record.runtime_config_fingerprint,
    }))
}

#[tauri::command]
pub fn access_proof_ai_write(
    app: tauri::AppHandle,
    cache_key: String,
    proof: ManagedAiAccessProofWrite,
) -> Result<bool, String> {
    let trimmed_key = cache_key.trim();
    if trimmed_key.is_empty() {
        return Ok(false);
    }

    let model = normalize_model_ref(proof.default_model);
    let provider_id = proof.provider_id.trim().to_string();
    if provider_id.is_empty() || model.provider_id.is_empty() || model.model_id.is_empty() {
        return Ok(false);
    }

    let path = access_proofs_path(&app)?;
    let mut proofs = read_access_proofs(&path);
    proofs.version = ACCESS_PROOFS_VERSION;
    let cache_key_hash = hash_cache_key(trimmed_key);
    proofs
        .managed_ai
        .retain(|record| record.cache_key_hash != cache_key_hash);
    proofs.managed_ai.insert(
        0,
        ManagedAiAccessProofRecord {
            cache_key_hash,
            fetched_at: now_ms(),
            provider_id,
            default_model: model,
            allowed_models: normalize_allowed_models(proof.allowed_models),
            updated_at: normalize_optional_string(proof.updated_at),
            runtime_config_fingerprint: normalize_optional_string(proof.runtime_config_fingerprint),
        },
    );
    proofs.managed_ai.truncate(MAX_MANAGED_AI_RECORDS);
    write_access_proofs(&path, &proofs)?;
    Ok(true)
}

#[tauri::command]
pub fn access_proof_ai_clear(
    app: tauri::AppHandle,
    cache_key: Option<String>,
) -> Result<bool, String> {
    let path = access_proofs_path(&app)?;
    if !path.exists() {
        return Ok(false);
    }

    let mut proofs = read_access_proofs(&path);
    let before = proofs.managed_ai.len();
    if let Some(cache_key) = cache_key {
        let trimmed_key = cache_key.trim();
        if trimmed_key.is_empty() {
            return Ok(false);
        }
        let cache_key_hash = hash_cache_key(trimmed_key);
        proofs
            .managed_ai
            .retain(|record| record.cache_key_hash != cache_key_hash);
    } else {
        proofs.managed_ai.clear();
    }

    if proofs.managed_ai.len() == before {
        return Ok(false);
    }
    write_access_proofs(&path, &proofs)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{hash_cache_key, normalize_allowed_models};

    #[test]
    fn cache_key_hash_is_stable_and_not_plaintext() {
        let gateway = format!("https://ai.{}", "veslo.work");
        let cache_key = format!("user|org|{}", gateway);
        let hash = hash_cache_key(&cache_key);
        assert!(hash.starts_with("sha1:"));
        assert!(!hash.contains("user|org"));
        assert_eq!(hash, hash_cache_key(&cache_key));
    }

    #[test]
    fn allowed_models_are_trimmed_and_deduped() {
        assert_eq!(
            normalize_allowed_models(vec![
                " gpt-5 ".to_string(),
                "gpt-5".to_string(),
                "".to_string(),
                "gpt-5-mini".to_string(),
            ]),
            vec!["gpt-5".to_string(), "gpt-5-mini".to_string()],
        );
    }
}
