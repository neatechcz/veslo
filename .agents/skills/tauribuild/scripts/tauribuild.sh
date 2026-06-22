#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: .agents/skills/tauribuild/scripts/tauribuild.sh [--dry-run] [--skip-launch-check]

Build the full Veslo macOS release-profile app with Tauri Pilot enabled.

Options:
  --dry-run            Print the planned build without modifying files or building.
  --skip-launch-check  Skip isolated app launch and tauri-pilot ping/state checks.
  -h, --help           Show this help.
EOF
}

DRY_RUN=0
SKIP_LAUNCH_CHECK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --skip-launch-check)
      SKIP_LAUNCH_CHECK=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" || ! -f "$ROOT/AGENTS.md" || ! -d "$ROOT/packages/desktop/src-tauri" ]]; then
  echo "Run this from the Veslo repository." >&2
  exit 1
fi

cd "$ROOT"

APP_RS="$ROOT/packages/desktop/src-tauri/src/lib.rs"
CARGO_TOML="$ROOT/packages/desktop/src-tauri/Cargo.toml"
CARGO_LOCK="$ROOT/packages/desktop/src-tauri/Cargo.lock"
DESKTOP_DIR="$ROOT/packages/desktop"
PILOT_TAG="${TAURIBUILD_PILOT_TAG:-v0.7.2}"
PILOT_TMP="${TAURIBUILD_TMPDIR:-/tmp/veslo-tauribuild-pilot-$$}"
BACKUP_DIR="$(mktemp -d /tmp/veslo-tauribuild-backup.XXXXXX)"
APP_VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$CARGO_TOML" | head -1)"
if [[ -z "$APP_VERSION" ]]; then
  echo "Could not read desktop app version from $CARGO_TOML." >&2
  exit 1
fi
CHECK_HOME=""
CHECK_RUNTIME=""
CHECK_PID=""
RESTORED=0

restore_repo_files() {
  if [[ "$RESTORED" -eq 1 ]]; then
    return
  fi
  if [[ -f "$BACKUP_DIR/lib.rs" ]]; then cp "$BACKUP_DIR/lib.rs" "$APP_RS"; fi
  if [[ -f "$BACKUP_DIR/Cargo.toml" ]]; then cp "$BACKUP_DIR/Cargo.toml" "$CARGO_TOML"; fi
  if [[ -f "$BACKUP_DIR/Cargo.lock" ]]; then cp "$BACKUP_DIR/Cargo.lock" "$CARGO_LOCK"; fi
  RESTORED=1
}

cleanup() {
  if [[ -n "$CHECK_PID" ]] && kill -0 "$CHECK_PID" >/dev/null 2>&1; then
    kill "$CHECK_PID" >/dev/null 2>&1 || true
    wait "$CHECK_PID" >/dev/null 2>&1 || true
  fi
  restore_repo_files
  rm -rf "$BACKUP_DIR"
  if [[ -n "$CHECK_HOME" ]]; then rm -rf "$CHECK_HOME"; fi
  if [[ -n "$CHECK_RUNTIME" ]]; then rm -rf "$CHECK_RUNTIME"; fi
  rm -rf "$PILOT_TMP"
}

trap cleanup EXIT INT TERM

BUILD_CMD=(pnpm exec tauri -vvv build --target aarch64-apple-darwin --bundles dmg,app --no-sign -- --features e2e)

if [[ "$DRY_RUN" -eq 1 ]]; then
  cat <<EOF
Veslo Tauri Pilot release-profile build dry run
Repo: $ROOT
Pilot source: $PILOT_TAG patched in a temporary copy
Temporary repo files: packages/desktop/src-tauri/src/lib.rs, Cargo.toml, Cargo.lock
Build directory: $DESKTOP_DIR
Build command:
  SOURCE_DATE_EPOCH=\$(git log -1 --format=%ct HEAD) CI=true ${BUILD_CMD[*]}
Launch verification: $([[ "$SKIP_LAUNCH_CHECK" -eq 1 ]] && echo "skipped" || echo "enabled when no Veslo app is already running")
EOF
  exit 0
fi

cp "$APP_RS" "$BACKUP_DIR/lib.rs"
cp "$CARGO_TOML" "$BACKUP_DIR/Cargo.toml"
cp "$CARGO_LOCK" "$BACKUP_DIR/Cargo.lock"

if command -v git >/dev/null 2>&1; then
  if ! git clone --depth 1 --branch "$PILOT_TAG" https://github.com/mpiton/tauri-pilot.git "$PILOT_TMP" >/dev/null 2>&1; then
    CACHED_PLUGIN="$(find "$HOME/.cargo/git/checkouts" -path '*/crates/tauri-plugin-pilot/Cargo.toml' -print 2>/dev/null | while read -r f; do
      if grep -q 'version = "0.7.2"' "$f"; then
        dirname "$(dirname "$(dirname "$f")")"
        break
      fi
    done)"
    if [[ -z "$CACHED_PLUGIN" ]]; then
      echo "Could not fetch or find tauri-plugin-pilot $PILOT_TAG." >&2
      exit 1
    fi
    cp -R "$CACHED_PLUGIN" "$PILOT_TMP"
  fi
else
  echo "git is required to prepare the temporary tauri-pilot source." >&2
  exit 1
fi

PILOT_CRATE="$PILOT_TMP/crates/tauri-plugin-pilot"
PILOT_LIB="$PILOT_CRATE/src/lib.rs"
if [[ ! -f "$PILOT_LIB" ]]; then
  echo "Temporary tauri-plugin-pilot source is incomplete: $PILOT_LIB missing." >&2
  exit 1
fi

python3 - "$PILOT_LIB" "$CARGO_TOML" "$APP_RS" "$PILOT_CRATE" <<'PY'
from pathlib import Path
import sys

pilot_lib = Path(sys.argv[1])
cargo_toml = Path(sys.argv[2])
app_rs = Path(sys.argv[3])
pilot_crate = Path(sys.argv[4])

text = pilot_lib.read_text()
text = text.replace(
    "#[cfg(all(any(unix, windows), debug_assertions))]",
    "#[cfg(all(any(unix, windows), any(debug_assertions, feature = \"press\")))]",
)
text = text.replace(
    "#[cfg(not(all(any(unix, windows), debug_assertions)))]",
    "#[cfg(not(all(any(unix, windows), any(debug_assertions, feature = \"press\"))))]",
)
pilot_lib.write_text(text)

toml = cargo_toml.read_text()
old = 'tauri-plugin-pilot = { git = "https://github.com/mpiton/tauri-pilot", rev = "85d9091e616f90167399ac45f89edf028cdb3895" }'
new = f'tauri-plugin-pilot = {{ path = "{pilot_crate}" }}'
if old not in toml and new not in toml:
    raise SystemExit("Could not find expected tauri-plugin-pilot dependency in Cargo.toml")
cargo_toml.write_text(toml.replace(old, new))

src = app_rs.read_text()
needle = "    #[cfg(debug_assertions)]\n    let builder = builder.plugin(tauri_plugin_pilot::init());\n"
insert = needle + "\n    #[cfg(all(not(debug_assertions), feature = \"e2e\"))]\n    let builder = builder.plugin(tauri_plugin_pilot::init());\n"
if insert not in src:
    if needle not in src:
        raise SystemExit("Could not find debug tauri_plugin_pilot registration in lib.rs")
    src = src.replace(needle, insert)
app_rs.write_text(src)
PY

SOURCE_DATE_EPOCH="$(git log -1 --format=%ct HEAD)"
export SOURCE_DATE_EPOCH CI=true
(cd "$DESKTOP_DIR" && "${BUILD_CMD[@]}")

restore_repo_files

APP_BUNDLE="$ROOT/packages/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Veslo by Neatech.app"
APP_BIN="$APP_BUNDLE/Contents/MacOS/veslo"
TARBALL="$ROOT/packages/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Veslo by Neatech.app.tar.gz"
DMG="$ROOT/packages/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Veslo by Neatech_${APP_VERSION}_aarch64.dmg"

if [[ ! -x "$APP_BIN" ]]; then
  echo "Build did not produce expected app binary: $APP_BIN" >&2
  exit 1
fi
grep -a -q 'window.__PILOT__' "$APP_BIN"
grep -a -q '0.7.2' "$APP_BIN"

if ! cmp -s "$APP_RS" "$BACKUP_DIR/lib.rs" || ! cmp -s "$CARGO_TOML" "$BACKUP_DIR/Cargo.toml" || ! cmp -s "$CARGO_LOCK" "$BACKUP_DIR/Cargo.lock"; then
  echo "Repo files were not restored to their pre-build contents." >&2
  exit 1
fi

if [[ "$SKIP_LAUNCH_CHECK" -eq 0 ]]; then
  if pgrep -fl '[V]eslo by Neatech\.app/Contents/MacOS/veslo|/[A]pplications/Veslo by Neatech\.app|[c]om\.neatech\.veslo' >/dev/null 2>&1; then
    echo "Live Pilot check skipped because a Veslo app process is already running."
  elif command -v tauri-pilot >/dev/null 2>&1; then
    CHECK_HOME="$(mktemp -d /tmp/veslo-tauribuild-home.XXXXXX)"
    CHECK_RUNTIME="$(mktemp -d /tmp/veslo-tauribuild-runtime.XXXXXX)"
    chmod 700 "$CHECK_RUNTIME"
    CHECK_SOCKET="$CHECK_RUNTIME/tauri-pilot-com.neatech.veslo.sock"
    HOME="$CHECK_HOME" USERPROFILE="$CHECK_HOME" XDG_RUNTIME_DIR="$CHECK_RUNTIME" "$APP_BIN" >/tmp/veslo-tauribuild-app.log 2>&1 &
    CHECK_PID="$!"
    for _ in $(seq 1 40); do
      [[ -S "$CHECK_SOCKET" ]] && break
      sleep 0.25
    done
    if [[ ! -S "$CHECK_SOCKET" ]]; then
      echo "Pilot socket did not appear during isolated launch check." >&2
      tail -100 /tmp/veslo-tauribuild-app.log >&2 || true
      exit 1
    fi
    tauri-pilot --socket "$CHECK_SOCKET" ping
    STATE_READY=0
    for _ in $(seq 1 40); do
      if tauri-pilot --socket "$CHECK_SOCKET" state --json >/tmp/veslo-tauribuild-state.json 2>/tmp/veslo-tauribuild-state.err; then
        STATE_READY=1
        break
      fi
      sleep 0.25
    done
    if [[ "$STATE_READY" -ne 1 ]]; then
      echo "Pilot state did not become available during isolated launch check." >&2
      cat /tmp/veslo-tauribuild-state.err >&2 || true
      tail -100 /tmp/veslo-tauribuild-app.log >&2 || true
      exit 1
    fi
    kill "$CHECK_PID" >/dev/null 2>&1 || true
    wait "$CHECK_PID" >/dev/null 2>&1 || true
    CHECK_PID=""
  else
    echo "Live Pilot check skipped because tauri-pilot CLI is not on PATH."
  fi
fi

cat <<EOF
Tauri Pilot release-profile build complete.
App: $APP_BUNDLE
DMG: $DMG
Updater tarball: $TARBALL
Pilot: 0.7.2 bridge present
Repo files restored: yes
EOF
