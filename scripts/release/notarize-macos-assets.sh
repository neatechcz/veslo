#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "$*" >&2
  exit 1
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail "$name is required"
  fi
}

repo_root="${GITHUB_WORKSPACE:-$(pwd)}"
target_triple="${VESLO_MACOS_TARGET_TRIPLE:-}"
auth_mode="${VESLO_NOTARY_AUTH_MODE:-}"
notary_timeout="${VESLO_NOTARY_TIMEOUT:-30m}"
require_updater_artifacts="${VESLO_REQUIRE_UPDATER_ARTIFACTS:-true}"

require_env VESLO_MACOS_TARGET_TRIPLE
require_env VESLO_NOTARY_AUTH_MODE
require_env APPLE_SIGNING_IDENTITY
require_env APPLE_CERTIFICATE
require_env APPLE_CERTIFICATE_PASSWORD

case "$target_triple" in
  aarch64-apple-darwin)
    asset_arch="aarch64"
    ;;
  x86_64-apple-darwin)
    asset_arch="x64"
    ;;
  *)
    fail "Unsupported macOS target: $target_triple"
    ;;
esac

case "$auth_mode" in
  api-key)
    require_env APPLE_API_KEY
    require_env APPLE_API_ISSUER
    require_env APPLE_API_KEY_PATH
    notary_args=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
    ;;
  apple-id)
    require_env APPLE_ID
    require_env APPLE_PASSWORD
    require_env APPLE_TEAM_ID
    notary_args=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
    ;;
  *)
    fail "Unsupported notarization auth mode: $auth_mode"
    ;;
esac

bundle_root="$repo_root/packages/desktop/src-tauri/target/$target_triple/release/bundle"
macos_bundle_dir="$bundle_root/macos"
dmg_bundle_dir="$bundle_root/dmg"

app_path="$(find "$macos_bundle_dir" -maxdepth 1 -type d -name "*.app" | sort | head -n 1 || true)"
[ -n "$app_path" ] || fail "No .app bundle found in $macos_bundle_dir"

app_tar_path="$(find "$macos_bundle_dir" -maxdepth 1 -type f -name "*.app.tar.gz" | sort | head -n 1 || true)"
app_tar_sig_path=""
if [ -n "$app_tar_path" ]; then
  app_tar_sig_path="$app_tar_path.sig"
  [ -s "$app_tar_sig_path" ] || fail "No updater signature found: $app_tar_sig_path"
elif [ "$require_updater_artifacts" = "true" ]; then
  fail "No updater tarball found in $macos_bundle_dir"
else
  echo "No updater tarball found in $macos_bundle_dir; continuing because VESLO_REQUIRE_UPDATER_ARTIFACTS=false"
fi

dmg_path="$(find "$dmg_bundle_dir" -maxdepth 1 -type f -name "*.dmg" | sort | head -n 1 || true)"
[ -n "$dmg_path" ] || fail "No DMG found in $dmg_bundle_dir"

submit_notary() {
  local file_path="$1"
  local label="$2"
  local output_json="$RUNNER_TEMP/notary-$target_triple-$label.json"
  local output_log="$RUNNER_TEMP/notary-$target_triple-$label.stderr.log"

  rm -f "$output_json" "$output_log"
  echo "Submitting $label for notarization: $file_path"

  set +e
  xcrun notarytool submit "$file_path" \
    "${notary_args[@]}" \
    --wait \
    --timeout "$notary_timeout" \
    --output-format json \
    > "$output_json" \
    2> "$output_log"
  local submit_status=$?
  set -e

  if [ "$submit_status" -ne 0 ]; then
    cat "$output_json" >&2 || true
    cat "$output_log" >&2 || true
    local submission_id
    submission_id="$(node - "$output_json" "$output_log" <<'NODE'
const fs = require("node:fs");

for (const filePath of process.argv.slice(2)) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    continue;
  }

  for (const line of text.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line.trim());
      if (parsed && typeof parsed.id === "string" && parsed.id) {
        process.stdout.write(parsed.id);
        process.exit(0);
      }
    } catch {
      // not a JSON status line
    }
  }
}
NODE
)"
    if [ -n "$submission_id" ]; then
      echo "Fetching notarization info for $submission_id" >&2
      xcrun notarytool info "$submission_id" "${notary_args[@]}" --output-format json >&2 || true
      echo "Fetching notarization log for $submission_id" >&2
      xcrun notarytool log "$submission_id" "${notary_args[@]}" >&2 || true
    fi
    fail "Notarization failed for $label"
  fi

  cat "$output_json"
  local status
  status="$(node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(d.status||'')" "$output_json")"
  [ "$status" = "Accepted" ] || fail "Unexpected notarization status for $label: $status"
}

import_codesign_certificate() {
  local cert_path="$RUNNER_TEMP/apple-codesign.p12"
  local keychain_path="$RUNNER_TEMP/veslo-notary-signing.keychain-db"
  local keychain_password
  keychain_password="$(openssl rand -base64 24)"

  printf "%s" "$APPLE_CERTIFICATE" | base64 --decode > "$cert_path"
  security create-keychain -p "$keychain_password" "$keychain_path"
  security set-keychain-settings -lut 21600 "$keychain_path"
  security unlock-keychain -p "$keychain_password" "$keychain_path"
  security import "$cert_path" \
    -P "$APPLE_CERTIFICATE_PASSWORD" \
    -A \
    -t cert \
    -f pkcs12 \
    -k "$keychain_path"
  security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain_path"

  existing_keychains="$(security list-keychains -d user | tr -d ' "')"
  # shellcheck disable=SC2086
  security list-keychains -d user -s "$keychain_path" $existing_keychains
}

echo "Verifying signed app bundle"
codesign --verify --deep --strict --verbose=2 "$app_path"

import_codesign_certificate

echo "Signing and notarizing DMG"
codesign --force --sign "$APPLE_SIGNING_IDENTITY" "$dmg_path"
codesign --verify --verbose=2 "$dmg_path"
submit_notary "$dmg_path" "dmg"
xcrun stapler staple "$dmg_path"
xcrun stapler validate "$dmg_path"
spctl -a -vvv -t open --context context:primary-signature "$dmg_path"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "asset_arch=$asset_arch"
    echo "dmg_path=$dmg_path"
    if [ -n "$app_tar_path" ]; then
      echo "app_tar_path=$app_tar_path"
      echo "app_tar_sig_path=$app_tar_sig_path"
    fi
  } >> "$GITHUB_OUTPUT"
fi

echo "Prepared notarized macOS assets for $target_triple"
