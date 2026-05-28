use std::env;
use std::fs;
use std::path::PathBuf;

use crate::types::{ExecResult, OpencodeConfigFile};

pub(crate) fn strip_trailing_nul_padding(mut content: String) -> String {
    if !content.as_bytes().contains(&0) {
        return content;
    }

    let bytes = content.as_bytes();
    let mut suffix_start = bytes.len();
    while suffix_start > 0 && matches!(bytes[suffix_start - 1], b' ' | b'\t' | b'\r' | b'\n') {
        suffix_start -= 1;
    }

    let mut nul_start = suffix_start;
    while nul_start > 0 && bytes[nul_start - 1] == 0 {
        nul_start -= 1;
    }

    if nul_start < suffix_start {
        content.replace_range(nul_start..suffix_start, "");
    }
    content
}

fn opencode_config_candidates(
    scope: &str,
    project_dir: &str,
) -> Result<(PathBuf, PathBuf), String> {
    match scope {
        "project" => {
            if project_dir.trim().is_empty() {
                return Err("projectDir is required".to_string());
            }
            let root = PathBuf::from(project_dir);
            Ok((root.join("opencode.jsonc"), root.join("opencode.json")))
        }
        "global" => {
            let base = if let Ok(dir) = env::var("XDG_CONFIG_HOME") {
                PathBuf::from(dir)
            } else if let Ok(home) = env::var("HOME") {
                PathBuf::from(home).join(".config")
            } else {
                return Err("Unable to resolve config directory".to_string());
            };

            let root = base.join("opencode");
            Ok((root.join("opencode.jsonc"), root.join("opencode.json")))
        }
        _ => Err("scope must be 'project' or 'global'".to_string()),
    }
}

pub fn resolve_opencode_config_path(scope: &str, project_dir: &str) -> Result<PathBuf, String> {
    let (jsonc_path, json_path) = opencode_config_candidates(scope, project_dir)?;

    if jsonc_path.exists() {
        return Ok(jsonc_path);
    }

    if json_path.exists() {
        return Ok(json_path);
    }

    Ok(jsonc_path)
}

pub fn read_opencode_config(scope: &str, project_dir: &str) -> Result<OpencodeConfigFile, String> {
    let path = resolve_opencode_config_path(scope.trim(), project_dir)?;
    let exists = path.exists();

    let content = if exists {
        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
        Some(strip_trailing_nul_padding(raw))
    } else {
        None
    };

    Ok(OpencodeConfigFile {
        path: path.to_string_lossy().to_string(),
        exists,
        content,
    })
}

pub fn write_opencode_config(
    scope: &str,
    project_dir: &str,
    content: &str,
) -> Result<ExecResult, String> {
    let path = resolve_opencode_config_path(scope.trim(), project_dir)?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir {}: {e}", parent.display()))?;
    }

    fs::write(&path, strip_trailing_nul_padding(content.to_string()))
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;

    Ok(ExecResult {
        ok: true,
        status: 0,
        stdout: format!("Wrote {}", path.display()),
        stderr: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::strip_trailing_nul_padding;

    #[test]
    fn strips_trailing_nul_padding_before_final_whitespace() {
        assert_eq!(
            strip_trailing_nul_padding("{\"ok\":true}\0\0\n".to_string()),
            "{\"ok\":true}\n"
        );
    }

    #[test]
    fn keeps_embedded_nul_invalid() {
        assert_eq!(
            strip_trailing_nul_padding("{\"bad\":\"\0\"}\n".to_string()),
            "{\"bad\":\"\0\"}\n"
        );
    }
}
