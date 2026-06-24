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

require_env VESLO_MACOS_TARGET_TRIPLE
require_env VESLO_NOTARY_AUTH_MODE
require_env APPLE_SIGNING_IDENTITY
require_env APPLE_CERTIFICATE
require_env APPLE_CERTIFICATE_PASSWORD
require_env TAURI_SIGNING_PRIVATE_KEY
require_env TAURI_SIGNING_PRIVATE_KEY_PASSWORD

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
[ -n "$app_tar_path" ] || app_tar_path="$macos_bundle_dir/$(basename "$app_path").tar.gz"
app_tar_sig_path="$app_tar_path.sig"

dmg_path="$(find "$dmg_bundle_dir" -maxdepth 1 -type f -name "*.dmg" | sort | head -n 1 || true)"
[ -n "$dmg_path" ] || fail "No DMG found in $dmg_bundle_dir"

submit_notary() {
  local file_path="$1"
  local label="$2"
  local output_json="$RUNNER_TEMP/notary-$target_triple-$label.json"

  rm -f "$output_json"
  echo "Submitting $label for notarization: $file_path"
  if ! xcrun notarytool submit "$file_path" \
    "${notary_args[@]}" \
    --wait \
    --timeout "$notary_timeout" \
    --output-format json > "$output_json"; then
    cat "$output_json" >&2 || true
    local submission_id
    submission_id="$(node -e "const fs=require('fs');try{const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(d.id||'')}catch{}" "$output_json")"
    if [ -n "$submission_id" ]; then
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

import_codesign_certificate

app_zip="$RUNNER_TEMP/veslo-$target_triple.app.zip"
rm -f "$app_zip"
ditto -c -k --keepParent "$app_path" "$app_zip"
submit_notary "$app_zip" "app"

echo "Stapling app bundle"
xcrun stapler staple "$app_path"
xcrun stapler validate "$app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"
spctl -a -vvv -t exec "$app_path"

echo "Recreating updater tarball from stapled app"
rm -f "$app_tar_path" "$app_tar_sig_path"
app_parent="$(dirname "$app_path")"
app_name="$(basename "$app_path")"
(
  cd "$app_parent"
  COPYFILE_DISABLE=1 tar -czf "$app_tar_path" "$app_name"
)

updater_key_path="$RUNNER_TEMP/tauri-updater-signing.key"
printf "%s" "$TAURI_SIGNING_PRIVATE_KEY" > "$updater_key_path"
chmod 600 "$updater_key_path"
pnpm --filter @neatech/veslo exec tauri signer sign "$app_tar_path" \
  --private-key-path "$updater_key_path" \
  --password "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" > "$app_tar_sig_path"
[ -s "$app_tar_sig_path" ] || fail "Updater signature was not written: $app_tar_sig_path"

echo "Recreating DMG from stapled app bundle"
dmg_staging="$RUNNER_TEMP/veslo-dmg-$target_triple"
rm -rf "$dmg_staging"
mkdir -p "$dmg_staging"
ditto "$app_path" "$dmg_staging/$app_name"
rm -f "$dmg_path"
hdiutil create -volname "Veslo by Neatech" -srcfolder "$dmg_staging" -ov -format UDZO "$dmg_path"
codesign --force --sign "$APPLE_SIGNING_IDENTITY" "$dmg_path"
codesign --verify --verbose=2 "$dmg_path"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "asset_arch=$asset_arch"
    echo "app_tar_path=$app_tar_path"
    echo "app_tar_sig_path=$app_tar_sig_path"
    echo "dmg_path=$dmg_path"
  } >> "$GITHUB_OUTPUT"
fi

echo "Prepared notarized macOS assets for $target_triple"
