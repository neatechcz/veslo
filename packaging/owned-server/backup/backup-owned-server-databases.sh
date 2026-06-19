#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

backup_mysql="$script_dir/backup-mysql.sh"
alert_helper="$script_dir/send-lettr-alert.mjs"

backup_root="${BACKUP_ROOT:-/srv/veslo/backups}"
env_file="${ENV_FILE:-/srv/veslo/env/production.env}"
compose_file="${COMPOSE_FILE:-packaging/owned-server/compose.yml}"
docker_compose="${DOCKER_COMPOSE:-docker compose}"
zstd_bin="${ZSTD_BIN:-zstd}"
node_bin="${NODE_BIN:-node}"
timestamp="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
lock_file="${BACKUP_LOCK_FILE:-$backup_root/.backup.lock}"

staging_dir="$backup_root/.in-progress/$timestamp"
failed_dir="$backup_root/.failed/$timestamp"
final_dir="$backup_root/$timestamp"

failure_step=""
failure_message=""

send_failure_alert() {
  local artifacts_path="${1:-}"
  local host
  local subject
  local body
  local alert_status

  host="$(hostname 2>/dev/null || printf 'unknown')"
  subject="Veslo backup failed on $host at $timestamp"
  body="$(cat <<BODY
Veslo owned-server database backup failed.

Host: $host
Timestamp: $timestamp
Step: $failure_step
Message: $failure_message
Failed artifacts: ${artifacts_path:-none}
BODY
)"

  set +e
  (
    set +e
    set -a
    if [[ -f "$env_file" ]]; then
      # shellcheck disable=SC1090
      . "$env_file" 2>/dev/null
    fi
    set +a

    BACKUP_ALERT_SUBJECT="$subject" "$node_bin" "$alert_helper" <<< "$body"
  )
  alert_status=$?
  set -e

  if (( alert_status != 0 )); then
    echo "Failed to send backup failure alert (exit $alert_status)." >&2
  fi
}

fail_backup() {
  failure_step="$1"
  failure_message="$2"
  local artifacts_path=""

  echo "Backup failed during $failure_step: $failure_message" >&2

  if [[ -d "$staging_dir" ]]; then
    mkdir -p "$backup_root/.failed"
    rm -rf "$failed_dir"
    if mv "$staging_dir" "$failed_dir"; then
      artifacts_path="$failed_dir"
    else
      echo "Failed to move staging artifacts to $failed_dir." >&2
    fi
  fi

  send_failure_alert "$artifacts_path"
  exit 1
}

if ! mkdir -p "$backup_root" "$(dirname "$lock_file")"; then
  fail_backup "prepare" "Failed to create backup root or lock directory"
fi

if ! exec 9>"$lock_file"; then
  fail_backup "lock" "Failed to open backup lock file: $lock_file"
fi

if ! flock -n 9; then
  fail_backup "lock" "Another backup run is active; could not acquire $lock_file"
fi

if ! command -v "$zstd_bin" >/dev/null 2>&1; then
  fail_backup "preflight" "Required zstd executable not found: $zstd_bin"
fi

if ! mkdir -p "$backup_root/.in-progress" "$backup_root/.failed"; then
  fail_backup "prepare" "Failed to create backup staging directories"
fi

if [[ -e "$staging_dir" || -e "$final_dir" ]]; then
  fail_backup "prepare" "Backup timestamp already exists: $timestamp"
fi

if ! mkdir -p "$staging_dir"; then
  fail_backup "prepare" "Failed to create staging directory: $staging_dir"
fi

dump_compress_verify() {
  local service_name="$1"
  local database_name="$2"
  local output_name="$3"

  local raw_path="$staging_dir/$output_name.sql"
  local compressed_name="$output_name.sql.zst"
  local compressed_path="$staging_dir/$compressed_name"
  local checksum_path="$compressed_path.sha256"

  if ! COMPOSE_FILE="$compose_file" \
    ENV_FILE="$env_file" \
    DOCKER_COMPOSE="$docker_compose" \
    "$backup_mysql" "$service_name" "$database_name" "$raw_path"; then
    fail_backup "$output_name dump" "Failed to dump $service_name/$database_name"
  fi

  if ! "$zstd_bin" -3 -q -c "$raw_path" > "$compressed_path"; then
    fail_backup "$output_name compression" "Failed to compress $raw_path with zstd"
  fi

  if ! "$zstd_bin" -t "$compressed_path" >/dev/null; then
    fail_backup "$output_name verification" "zstd integrity check failed for $compressed_name"
  fi

  if ! "$zstd_bin" -dc "$compressed_path" | grep -E '(^-- MySQL dump|CREATE[[:space:]]+(TABLE|DATABASE)|DROP[[:space:]]+TABLE|INSERT[[:space:]]+INTO|/\*!|LOCK TABLES)' >/dev/null; then
    fail_backup "$output_name content check" "Compressed dump does not look like a MySQL dump: $compressed_name"
  fi

  if ! (
    cd "$staging_dir"
    sha256sum "$compressed_name" > "$checksum_path"
  ); then
    fail_backup "$output_name checksum" "Failed to write checksum for $compressed_name"
  fi

  rm -f "$raw_path"
}

json_file_entry() {
  local name="$1"
  local service_name="$2"
  local database_name="$3"
  local path="$staging_dir/$name"
  local checksum_path="$path.sha256"
  local checksum
  local size

  checksum="$(awk '{print $1}' "$checksum_path")"
  size="$(wc -c < "$path" | tr -d '[:space:]')"

  cat <<JSON
    {
      "name": "$name",
      "service": "$service_name",
      "database": "$database_name",
      "sha256": "$checksum",
      "size_bytes": $size
    }
JSON
}

write_manifest() {
  {
    cat <<JSON
{
  "status": "success",
  "timestamp": "$timestamp",
  "files": [
JSON
    json_file_entry "den.sql.zst" "den-db" "den"
    printf ',\n'
    json_file_entry "ai-gateway.sql.zst" "ai-gateway-db" "veslo_ai_gateway"
    cat <<JSON

  ]
}
JSON
  } > "$staging_dir/manifest.json"
}

prune_old_successful_sets() {
  local successful_sets=()
  local set_path
  local set_name
  local prune_count

  while IFS= read -r set_path; do
    set_name="$(basename "$set_path")"
    if [[ -f "$set_path/manifest.json" ]] && grep -Eq '"status"[[:space:]]*:[[:space:]]*"success"' "$set_path/manifest.json"; then
      successful_sets+=("$set_name")
    fi
  done < <(find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' -print | sort)

  prune_count=$((${#successful_sets[@]} - 2))
  if (( prune_count <= 0 )); then
    return 0
  fi

  for set_name in "${successful_sets[@]:0:$prune_count}"; do
    rm -rf "$backup_root/$set_name"
  done
}

dump_compress_verify "den-db" "den" "den"
dump_compress_verify "ai-gateway-db" "veslo_ai_gateway" "ai-gateway"
if ! write_manifest; then
  fail_backup "manifest" "Failed to write backup manifest"
fi

if ! mv "$staging_dir" "$final_dir"; then
  fail_backup "promote" "Failed to promote staging backup to $final_dir"
fi

if ! prune_old_successful_sets; then
  fail_backup "retention" "Failed to prune old successful backup sets"
fi

echo "Backup set written: $final_dir"
