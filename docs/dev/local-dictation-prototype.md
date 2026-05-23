# Local Dictation Prototype

This is an experimental side-branch prototype for local-only dictation in the Veslo desktop composer.

Related YouTrack task: `VSLO-192`

Status:

- Verified on Windows in local development.
- macOS is expected to work with the same Tauri/Python/faster-whisper path, but it has not been verified yet.
- This is not production-ready architecture. Treat it as a fast usability and technical feasibility prototype.

## Branch

Use the side branch:

```bash
git fetch origin prototype/local-dictation
git checkout prototype/local-dictation
```

Do not merge this branch into `main` until the dictation architecture is reviewed.

## What The Prototype Does

- Adds a microphone button to the desktop composer.
- Records microphone audio inside the Tauri WebView with `MediaRecorder`.
- Shows immediate local microphone activity with the Web Audio API so recording does not look frozen.
- Sends recorded audio bytes to the Tauri command `dictation_transcribe`.
- Runs a local Python helper with `faster-whisper`.
- Forces offline inference with `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and `local_files_only=True`.
- Writes interim transcription directly into the composer, then replaces it with final normal text when recording stops.
- Supports Czech and English through Whisper auto-detection for now.

No audio is intentionally sent to a cloud API by this prototype. The only network step is the one-time model download unless the model is already present locally.

## macOS Setup For A Colleague

Run these commands in Terminal. They assume Apple Silicon or modern Intel macOS with Homebrew.

### 1. Install system tools

```bash
xcode-select --install

brew install git node pnpm rust python@3.11
```

If `cargo` is missing after installing Rust, restart Terminal or run:

```bash
source "$HOME/.cargo/env"
```

### 2. Clone Veslo and check out the branch

```bash
git clone https://github.com/neatechcz/veslo.git
cd veslo
git fetch origin prototype/local-dictation
git checkout prototype/local-dictation
```

### 3. Install repo dependencies

```bash
corepack enable
corepack prepare pnpm@10.27.0 --activate
pnpm install
```

### 4. Create the local dictation Python environment

```bash
mkdir -p "$HOME/.veslo/dictation/models"
python3 -m venv "$HOME/.veslo/dictation/.venv"
source "$HOME/.veslo/dictation/.venv/bin/activate"
python -m pip install --upgrade pip
python -m pip install faster-whisper huggingface_hub
```

### 5. Download the model once

HF token is not required for the public `Systran/faster-whisper-small` model.

```bash
source "$HOME/.veslo/dictation/.venv/bin/activate"
python - <<'PY'
from pathlib import Path
from huggingface_hub import snapshot_download

snapshot_download(
    repo_id="Systran/faster-whisper-small",
    local_dir=Path.home() / ".veslo" / "dictation" / "models" / "faster-whisper-small",
    local_dir_use_symlinks=False,
)
PY
```

After this step the app can run dictation offline from the local model directory.

### 6. Start Veslo desktop with local dictation enabled

Run from the repository root:

```bash
export VESLO_DICTATION_PYTHON="$HOME/.veslo/dictation/.venv/bin/python"
export VESLO_DICTATION_MODEL="$HOME/.veslo/dictation/models/faster-whisper-small"
export VESLO_DICTATION_DEVICE="cpu"
export VESLO_DICTATION_COMPUTE_TYPE="int8"

pnpm --filter @neatech/veslo exec cargo clean --manifest-path src-tauri/Cargo.toml
pnpm --filter @neatech/veslo exec cargo build --manifest-path src-tauri/Cargo.toml --no-default-features
pnpm dev
```

Startup is successful when logs show both:

- `VITE ... ready`
- `Running target/debug/veslo`

Use the desktop window, not a raw browser tab, for testing.

## How To Test Manually

1. Open any Veslo session.
2. Click the microphone button in the composer.
3. Accept the macOS microphone permission prompt if shown.
4. Speak Czech or English.
5. Confirm the small activity meter next to the microphone reacts while speaking.
6. Confirm interim text appears directly in the composer.
7. Click the microphone button again to stop.
8. Confirm the final text replaces the interim text and can be edited or sent normally.

If macOS denies microphone access, check System Settings -> Privacy & Security -> Microphone and allow Veslo Dev, Terminal, or the development app shown there. Restart the app after changing the permission.

## Technical Details

Frontend:

- Composer uses `navigator.mediaDevices.getUserMedia({ audio: true })`.
- Recording uses browser `MediaRecorder` chunks.
- Audio activity uses `AudioContext`/`AnalyserNode`.
- Preview transcription is attempted every 2.5 seconds from accumulated local chunks.
- The inline preview is a temporary editable DOM span marked as dictation preview and is finalized into normal text after stop.

Desktop/Tauri:

- The frontend invokes `dictation_transcribe`.
- The Tauri command writes audio bytes to a temporary local file.
- The command starts Python from `VESLO_DICTATION_PYTHON`, otherwise `python3`/`python`.
- Python runs `faster_whisper.WhisperModel`.
- Model is selected by `VESLO_DICTATION_MODEL`; default is `Systran/faster-whisper-small`.
- Device and compute type come from `VESLO_DICTATION_DEVICE` and `VESLO_DICTATION_COMPUTE_TYPE`.
- Runtime is locked to offline model loading with `local_files_only=True`.
- Temporary audio is deleted after transcription.

Current limits:

- Interim text is not true token streaming. It is periodic local transcription, so it can lag by a few seconds.
- The current prototype retranscribes accumulated chunks for preview, which is simple but not efficient.
- No product settings UI exists yet for model path, language, device, or compute type.
- No packaged app bootstrap exists yet for installing Python deps or model files.
- macOS performance and microphone behavior need confirmation.

## Troubleshooting

`Python package faster-whisper is not installed`

Run:

```bash
source "$HOME/.veslo/dictation/.venv/bin/activate"
python -m pip install faster-whisper
```

`Offline dictation is locked to local models`

The model is missing or `VESLO_DICTATION_MODEL` points to the wrong directory. Re-run the model download and export the model path again.

`No usable Python interpreter found`

Set:

```bash
export VESLO_DICTATION_PYTHON="$HOME/.veslo/dictation/.venv/bin/python"
```

Microphone button does nothing or permission fails

Grant microphone permission in macOS System Settings, then restart the Tauri dev app.

Only Vite starts, no desktop window

Stop the process and run `pnpm dev` from the repository root. Do not test this prototype from a raw web runtime.

## Notes For The Next Architecture Pass

Evaluate these before productionizing:

- Whether Python/faster-whisper stays as a helper, becomes a sidecar, or is replaced by a packaged native transcription runtime.
- How models are selected, downloaded, cached, upgraded, and deleted.
- Whether preview transcription should use a streaming/VAD-aware pipeline instead of retranscribing accumulated chunks.
- How to expose local-only guarantees in UI and docs.
- How to support Windows/macOS/Linux packaging without requiring developers to hand-install Python.
