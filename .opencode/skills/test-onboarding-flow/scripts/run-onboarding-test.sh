#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
PORT_TO_CHECK="${PORT:-5173}"
APP_ID_DEV="com.neatech.veslo.dev"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This helper currently supports the macOS desktop dev setup only." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required" >&2
  exit 1
fi

if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"$PORT_TO_CHECK" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $PORT_TO_CHECK is already in use." >&2
    echo "Stop any existing 'pnpm dev' or 'pnpm dev:ui' process before running the onboarding test." >&2
    exit 1
  fi
fi

remove_path() {
  local target="$1"
  if [[ -e "$target" ]]; then
    echo "[onboarding-test] removing $target"
    rm -rf "$target"
  fi
}

ORCHESTRATOR_DATA_DIR="${VESLO_DATA_DIR:-$HOME/.veslo/veslo-orchestrator-dev}"

remove_path "$HOME/Library/Application Support/$APP_ID_DEV"
remove_path "$HOME/Library/Caches/$APP_ID_DEV"
remove_path "$HOME/Library/Caches/veslo"
remove_path "$HOME/Library/WebKit/veslo"
remove_path "$ORCHESTRATOR_DATA_DIR"

cd "$ROOT_DIR"

echo "[onboarding-test] launching Veslo dev without cloud auto-connect env"

exec env \
  VITE_VESLO_URL="" \
  VITE_VESLO_URL_DEV="" \
  VITE_VESLO_URL_TEST="" \
  VITE_VESLO_URL_PROD="" \
  VITE_VESLO_URL_PRODUCTION="" \
  VITE_VESLO_LOGIN_URL="" \
  VITE_VESLO_LOGIN_URL_DEV="" \
  VITE_VESLO_LOGIN_URL_TEST="" \
  VITE_VESLO_LOGIN_URL_PROD="" \
  VITE_VESLO_LOGIN_URL_PRODUCTION="" \
  VITE_VESLO_TOKEN="" \
  VITE_VESLO_TOKEN_DEV="" \
  VITE_VESLO_TOKEN_TEST="" \
  VITE_VESLO_TOKEN_PROD="" \
  VITE_VESLO_TOKEN_PRODUCTION="" \
  VITE_VESLO_WORKSPACE_ID="" \
  VITE_VESLO_WORKSPACE_ID_DEV="" \
  VITE_VESLO_WORKSPACE_ID_TEST="" \
  VITE_VESLO_WORKSPACE_ID_PROD="" \
  VITE_VESLO_WORKSPACE_ID_PRODUCTION="" \
  VITE_VESLO_PORT="" \
  pnpm dev
