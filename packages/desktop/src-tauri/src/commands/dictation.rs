use std::env;
use std::fs;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

const MAX_AUDIO_BYTES: usize = 32 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationTranscribeResult {
    text: String,
    language: Option<String>,
    language_probability: Option<f64>,
}

fn audio_extension_for_mime(mime_type: Option<&str>) -> &'static str {
    match mime_type.unwrap_or("").split(';').next().unwrap_or("").trim() {
        "audio/wav" | "audio/wave" | "audio/x-wav" => "wav",
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" => "m4a",
        "audio/ogg" | "application/ogg" => "ogg",
        "audio/webm" => "webm",
        _ => "webm",
    }
}

fn python_candidates() -> Vec<(String, Vec<String>)> {
    if let Ok(value) = env::var("VESLO_DICTATION_PYTHON") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return vec![(trimmed.to_string(), Vec::new())];
        }
    }

    #[cfg(windows)]
    {
        vec![
            ("py".to_string(), vec!["-3".to_string()]),
            ("python".to_string(), Vec::new()),
            ("python3".to_string(), Vec::new()),
        ]
    }

    #[cfg(not(windows))]
    {
        vec![
            ("python3".to_string(), Vec::new()),
            ("python".to_string(), Vec::new()),
        ]
    }
}

fn dictation_python_script() -> &'static str {
    r#"
import json
import os
import sys

audio_path = sys.argv[1]
language = sys.argv[2].strip() if len(sys.argv) > 2 and sys.argv[2].strip() else None
model_name = os.environ.get("VESLO_DICTATION_MODEL", "Systran/faster-whisper-small")
device = os.environ.get("VESLO_DICTATION_DEVICE", "cpu")
compute_type = os.environ.get("VESLO_DICTATION_COMPUTE_TYPE", "int8")

try:
    from faster_whisper import WhisperModel
except Exception as exc:
    print(json.dumps({
        "ok": False,
        "error": "Python package faster-whisper is not installed. Install it locally, for example: python -m pip install faster-whisper"
    }))
    sys.exit(0)

try:
    model = WhisperModel(
        model_name,
        device=device,
        compute_type=compute_type,
        local_files_only=True,
    )
    segments, info = model.transcribe(
        audio_path,
        language=language,
        vad_filter=True,
    )
    text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
    print(json.dumps({
        "ok": True,
        "text": text,
        "language": getattr(info, "language", None),
        "languageProbability": getattr(info, "language_probability", None),
    }, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({
        "ok": False,
        "error": (
            str(exc)
            + "\n\nOffline dictation is locked to local models. Put a faster-whisper model in the local Hugging Face cache or set VESLO_DICTATION_MODEL to a local model directory."
        ),
    }))
    sys.exit(0)
"#
}

fn run_python_transcription(audio_path: &str, language: Option<&str>) -> Result<Value, String> {
    let mut last_error = String::new();
    for (program, prefix_args) in python_candidates() {
        let mut command = Command::new(&program);
        crate::platform::configure_hidden(&mut command);
        command
            .args(prefix_args)
            .arg("-c")
            .arg(dictation_python_script())
            .arg(audio_path)
            .arg(language.unwrap_or(""))
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1");

        match command.output() {
            Ok(output) => {
                if !output.status.success() {
                    last_error = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    if last_error.is_empty() {
                        last_error = format!("Python exited with status {}", output.status);
                    }
                    continue;
                }

                let stdout = String::from_utf8_lossy(&output.stdout);
                let payload = stdout
                    .lines()
                    .rev()
                    .find(|line| line.trim_start().starts_with('{'))
                    .ok_or_else(|| "Dictation helper did not return JSON.".to_string())?;
                return serde_json::from_str::<Value>(payload)
                    .map_err(|e| format!("Failed to parse dictation helper output: {e}"));
            }
            Err(error) => {
                last_error = format!("{program}: {error}");
            }
        }
    }

    Err(format!(
        "No usable Python interpreter found for local dictation. Tried VESLO_DICTATION_PYTHON, python/python3/py. Last error: {last_error}"
    ))
}

#[tauri::command]
pub fn dictation_transcribe(
    audio_bytes: Vec<u8>,
    mime_type: Option<String>,
    language: Option<String>,
) -> Result<DictationTranscribeResult, String> {
    if audio_bytes.is_empty() {
        return Err("No audio was recorded.".to_string());
    }
    if audio_bytes.len() > MAX_AUDIO_BYTES {
        return Err("Recorded audio is too large for the local dictation prototype.".to_string());
    }

    let extension = audio_extension_for_mime(mime_type.as_deref());
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let audio_path = env::temp_dir().join(format!(
        "veslo-dictation-{now_ms}-{}.{}",
        Uuid::new_v4(),
        extension
    ));

    fs::write(&audio_path, &audio_bytes)
        .map_err(|e| format!("Failed to write temporary dictation audio: {e}"))?;

    let audio_path_string = audio_path.to_string_lossy().to_string();
    let language = language
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "auto");
    let result = run_python_transcription(&audio_path_string, language);
    let _ = fs::remove_file(&audio_path);
    let payload = result?;

    if payload.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Local dictation failed.");
        return Err(message.to_string());
    }

    Ok(DictationTranscribeResult {
        text: payload
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string(),
        language: payload
            .get("language")
            .and_then(Value::as_str)
            .map(str::to_string),
        language_probability: payload
            .get("languageProbability")
            .and_then(Value::as_f64),
    })
}

#[cfg(test)]
mod tests {
    use super::audio_extension_for_mime;

    #[test]
    fn audio_extension_for_mime_accepts_common_browser_recording_types() {
        assert_eq!(audio_extension_for_mime(Some("audio/webm;codecs=opus")), "webm");
        assert_eq!(audio_extension_for_mime(Some("audio/mp4")), "m4a");
        assert_eq!(audio_extension_for_mime(Some("audio/wav")), "wav");
        assert_eq!(audio_extension_for_mime(None), "webm");
    }
}
