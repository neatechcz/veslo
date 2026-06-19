#!/usr/bin/env bash
set -euo pipefail
umask 077

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

failure_step=""
failure_message=""
node_alert_available=0

strip_simple_quotes() {
  local value="$1"
  local first=""
  local last=""

  if (( ${#value} >= 2 )); then
    first="${value:0:1}"
    last="${value: -1}"
    if [[ "$first" == "$last" && ( "$first" == "'" || "$first" == '"' ) ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi

  printf '%s' "$value"
}

read_alert_env_file() {
  alert_LETTR_API_KEY="${LETTR_API_KEY:-}"
  alert_AUTH_EMAIL_ADDRESS="${AUTH_EMAIL_ADDRESS:-}"
  alert_AUTH_EMAIL_FROM_NAME="${AUTH_EMAIL_FROM_NAME:-}"
  alert_BACKUP_ALERT_EMAIL_RECIPIENTS="${BACKUP_ALERT_EMAIL_RECIPIENTS:-}"
  alert_AI_GATEWAY_ALERT_EMAIL_RECIPIENTS="${AI_GATEWAY_ALERT_EMAIL_RECIPIENTS:-}"

  if [[ ! -f "$env_file" ]]; then
    return 0
  fi

  local line
  local key
  local value

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue

    key="${line%%=*}"
    value="${line#*=}"

    case "$key" in
      LETTR_API_KEY)
        alert_LETTR_API_KEY="$(strip_simple_quotes "$value")"
        ;;
      AUTH_EMAIL_ADDRESS)
        alert_AUTH_EMAIL_ADDRESS="$(strip_simple_quotes "$value")"
        ;;
      AUTH_EMAIL_FROM_NAME)
        alert_AUTH_EMAIL_FROM_NAME="$(strip_simple_quotes "$value")"
        ;;
      BACKUP_ALERT_EMAIL_RECIPIENTS)
        alert_BACKUP_ALERT_EMAIL_RECIPIENTS="$(strip_simple_quotes "$value")"
        ;;
      AI_GATEWAY_ALERT_EMAIL_RECIPIENTS)
        alert_AI_GATEWAY_ALERT_EMAIL_RECIPIENTS="$(strip_simple_quotes "$value")"
        ;;
    esac
  done < "$env_file"
}

remove_raw_staged_sql_artifacts() {
  if [[ ! -d "$staging_dir" ]]; then
    return 0
  fi

  local raw_path
  while IFS= read -r -d '' raw_path; do
    if ! rm -f -- "$raw_path"; then
      return 1
    fi
  done < <(find "$staging_dir" -type f -name '*.sql' -print0)
}

secure_dir() {
  chmod 0700 "$1"
}

secure_file() {
  chmod 0600 "$1"
}

secure_backup_tree() {
  local dir="$1"

  if [[ ! -d "$dir" ]]; then
    return 0
  fi

  find "$dir" -type d -exec chmod 0700 {} +
  find "$dir" -type f -exec chmod 0600 {} +
}

validate_node_runtime() {
  if ! command -v "$node_bin" >/dev/null 2>&1; then
    echo "Required NODE_BIN is not executable or not found: $node_bin"
    return 1
  fi

  if ! "$node_bin" -e 'if (typeof fetch !== "function") { process.exit(1); }' >/dev/null 2>&1; then
    echo "Required NODE_BIN must be Node 18+ (Node.js 18 or newer) with global fetch support: $node_bin"
    return 1
  fi
}

validate_backup_timestamp() {
  if [[ ! "$timestamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
    printf 'Invalid backup timestamp: expected UTC format YYYYMMDDTHHMMSSZ, got: %s\n' "$timestamp" >&2
    exit 1
  fi
}

send_failure_alert() {
  local artifacts_path="${1:-}"
  local host
  local subject
  local body
  local alert_status
  local alert_LETTR_API_KEY
  local alert_AUTH_EMAIL_ADDRESS
  local alert_AUTH_EMAIL_FROM_NAME
  local alert_BACKUP_ALERT_EMAIL_RECIPIENTS
  local alert_AI_GATEWAY_ALERT_EMAIL_RECIPIENTS

  if (( node_alert_available != 1 )); then
    echo "Backup failure alert not sent because NODE_BIN is unavailable or lacks global fetch support: $node_bin" >&2
    return 0
  fi

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
    read_alert_env_file

    LETTR_API_KEY="$alert_LETTR_API_KEY" \
      AUTH_EMAIL_ADDRESS="$alert_AUTH_EMAIL_ADDRESS" \
      AUTH_EMAIL_FROM_NAME="$alert_AUTH_EMAIL_FROM_NAME" \
      BACKUP_ALERT_EMAIL_RECIPIENTS="$alert_BACKUP_ALERT_EMAIL_RECIPIENTS" \
      AI_GATEWAY_ALERT_EMAIL_RECIPIENTS="$alert_AI_GATEWAY_ALERT_EMAIL_RECIPIENTS" \
      BACKUP_ALERT_SUBJECT="$subject" \
      "$node_bin" "$alert_helper" <<< "$body"
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
    if ! mkdir -p "$backup_root/.failed"; then
      echo "Failed to prepare failed artifacts directory: $backup_root/.failed" >&2
    elif ! secure_dir "$backup_root/.failed"; then
      echo "Failed to harden failed artifacts directory permissions: $backup_root/.failed" >&2
    elif ! rm -rf -- "$failed_dir"; then
      echo "Failed to remove previous failed artifacts directory: $failed_dir" >&2
    elif ! remove_raw_staged_sql_artifacts; then
      echo "Failed to remove raw SQL files from failed staging artifacts; not preserving failed artifacts." >&2
    elif ! mv "$staging_dir" "$failed_dir"; then
      echo "Failed to move staging artifacts to $failed_dir." >&2
    elif ! secure_backup_tree "$failed_dir"; then
      echo "Failed to harden failed artifact permissions: $failed_dir" >&2
      artifacts_path="$failed_dir"
    else
      artifacts_path="$failed_dir"
    fi
  fi

  send_failure_alert "$artifacts_path"
  exit 1
}

validate_backup_timestamp

staging_dir="$backup_root/.in-progress/$timestamp"
failed_dir="$backup_root/.failed/$timestamp"
final_dir="$backup_root/$timestamp"

node_preflight_message=""
if ! node_preflight_message="$(validate_node_runtime)"; then
  failure_step="preflight"
  failure_message="$node_preflight_message"
  echo "Backup failed during $failure_step: $failure_message" >&2
  send_failure_alert ""
  exit 1
fi
node_alert_available=1

if ! mkdir -p "$backup_root" "$(dirname "$lock_file")"; then
  fail_backup "prepare" "Failed to create backup root or lock directory"
fi

if ! secure_dir "$backup_root"; then
  fail_backup "prepare" "Failed to harden backup root permissions: $backup_root"
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

if ! secure_dir "$backup_root/.in-progress" || ! secure_dir "$backup_root/.failed"; then
  fail_backup "prepare" "Failed to harden backup staging directory permissions"
fi

if [[ -e "$staging_dir" || -e "$final_dir" ]]; then
  fail_backup "prepare" "Backup timestamp already exists: $timestamp"
fi

if ! mkdir -p "$staging_dir"; then
  fail_backup "prepare" "Failed to create staging directory: $staging_dir"
fi

if ! secure_dir "$staging_dir"; then
  fail_backup "prepare" "Failed to harden staging directory permissions: $staging_dir"
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

  if ! secure_file "$raw_path"; then
    fail_backup "$output_name permissions" "Failed to harden raw dump permissions: $raw_path"
  fi

  if ! "$zstd_bin" -3 -q -c "$raw_path" > "$compressed_path"; then
    fail_backup "$output_name compression" "Failed to compress $raw_path with zstd"
  fi

  if ! secure_file "$compressed_path"; then
    fail_backup "$output_name permissions" "Failed to harden compressed dump permissions: $compressed_path"
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

  if ! secure_file "$checksum_path"; then
    fail_backup "$output_name permissions" "Failed to harden checksum permissions: $checksum_path"
  fi

  if ! rm -f -- "$raw_path"; then
    fail_backup "$output_name raw SQL cleanup" "Failed to remove raw SQL dump after compression: $raw_path"
  fi
}

json_file_entry() {
  local name="$1"
  local service_name="$2"
  local database_name="$3"
  local path="$staging_dir/$name"
  local checksum_path="$path.sha256"
  local checksum
  local size

  if [[ ! -f "$path" ]]; then
    fail_backup "manifest" "Missing compressed dump for manifest: $name"
  fi

  if ! IFS=' ' read -r checksum _ < "$checksum_path"; then
    fail_backup "manifest" "Missing checksum metadata for manifest: $name"
  fi

  if [[ ! "$checksum" =~ ^[a-f0-9]{64}$ ]]; then
    fail_backup "manifest" "Invalid checksum metadata for manifest: $name"
  fi

  if ! size="$(wc -c < "$path")"; then
    fail_backup "manifest" "Failed to read compressed dump size for manifest: $name"
  fi
  size="${size//[[:space:]]/}"

  if [[ ! "$size" =~ ^[0-9]+$ ]]; then
    fail_backup "manifest" "Invalid compressed dump size for manifest: $name"
  fi

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
  local manifest_tmp="$staging_dir/manifest.json.tmp"

  if ! {
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
  } > "$manifest_tmp"; then
    fail_backup "manifest" "Failed to write backup manifest"
  fi

  if ! mv "$manifest_tmp" "$staging_dir/manifest.json"; then
    fail_backup "manifest" "Failed to move backup manifest into place"
  fi

  if ! secure_file "$staging_dir/manifest.json"; then
    fail_backup "manifest" "Failed to harden backup manifest permissions"
  fi
}

prune_old_successful_sets() {
  local successful_sets=()
  local candidate_sets
  local set_path
  local set_name
  local prune_count

  if ! candidate_sets="$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z' -print | sort)"; then
    fail_backup "retention" "Failed to list successful backup sets"
  fi

  while IFS= read -r set_path; do
    [[ -z "$set_path" ]] && continue
    set_name="$(basename "$set_path")"
    if [[ -f "$set_path/manifest.json" ]] && grep -Eq '"status"[[:space:]]*:[[:space:]]*"success"' "$set_path/manifest.json"; then
      successful_sets+=("$set_name")
    fi
  done <<< "$candidate_sets"

  prune_count=$((${#successful_sets[@]} - 2))
  if (( prune_count <= 0 )); then
    return 0
  fi

  for set_name in "${successful_sets[@]:0:$prune_count}"; do
    if ! rm -rf -- "$backup_root/$set_name"; then
      fail_backup "retention" "Failed to delete old successful backup set: $backup_root/$set_name"
    fi
  done
}

dump_compress_verify "den-db" "den" "den"
dump_compress_verify "ai-gateway-db" "veslo_ai_gateway" "ai-gateway"
write_manifest

if ! mv "$staging_dir" "$final_dir"; then
  fail_backup "promote" "Failed to promote staging backup to $final_dir"
fi

if ! secure_backup_tree "$final_dir"; then
  fail_backup "promote" "Failed to harden final backup permissions: $final_dir"
fi

prune_old_successful_sets

echo "Backup set written: $final_dir"
