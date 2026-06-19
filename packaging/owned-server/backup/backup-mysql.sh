#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: backup-mysql.sh <db-service> <database-name> <output.sql>

Environment:
  COMPOSE_FILE     Compose file path. Default: packaging/owned-server/compose.yml
  ENV_FILE         Compose env file. Default: /srv/veslo/env/production.env
  DOCKER_COMPOSE   Compose command. Default: docker compose
  MYSQL_DUMP_MODE  "compose" or "direct". Default: compose

Example:
  DOCKER_COMPOSE="sudo docker compose" backup-mysql.sh den-db den /srv/veslo/backups/den.sql
USAGE
}

if [[ $# -ne 3 ]]; then
  usage
  exit 2
fi

service_name="$1"
database_name="$2"
output_path="$3"

case "$service_name" in
  den-db|ai-gateway-db) ;;
  *)
    echo "Unsupported database service: $service_name" >&2
    echo "Expected den-db or ai-gateway-db." >&2
    exit 2
    ;;
esac

if [[ -e "$output_path" ]]; then
  echo "Refusing to overwrite existing backup: $output_path" >&2
  exit 2
fi

output_dir="$(dirname "$output_path")"
mkdir -p "$output_dir"

compose_file="${COMPOSE_FILE:-packaging/owned-server/compose.yml}"
env_file="${ENV_FILE:-/srv/veslo/env/production.env}"
docker_compose="${DOCKER_COMPOSE:-docker compose}"
dump_mode="${MYSQL_DUMP_MODE:-compose}"
read -r -a compose_cmd <<< "$docker_compose"

tmp_path="${output_path}.tmp.$$"
cleanup() {
  rm -f "$tmp_path"
}
trap cleanup EXIT

case "$dump_mode" in
  compose)
    "${compose_cmd[@]}" -f "$compose_file" --env-file "$env_file" exec -T "$service_name" \
      sh -c 'MYSQL_PWD="${MYSQL_ROOT_PASSWORD:?missing MYSQL_ROOT_PASSWORD}" mysqldump --single-transaction --routines --triggers --events -uroot "$1"' \
      sh "$database_name" > "$tmp_path"
    ;;
  direct)
    case "$service_name" in
      den-db)
        mysql_host="${DEN_DB_HOST:-den-db}"
        mysql_port="${DEN_DB_PORT:-3306}"
        mysql_root_password="${DEN_DB_ROOT_PASSWORD:?missing DEN_DB_ROOT_PASSWORD}"
        ;;
      ai-gateway-db)
        mysql_host="${AI_GATEWAY_DB_HOST:-ai-gateway-db}"
        mysql_port="${AI_GATEWAY_DB_PORT:-3306}"
        mysql_root_password="${AI_GATEWAY_DB_ROOT_PASSWORD:?missing AI_GATEWAY_DB_ROOT_PASSWORD}"
        ;;
    esac

    MYSQL_PWD="$mysql_root_password" mysqldump \
      --single-transaction \
      --routines \
      --triggers \
      --events \
      -h "$mysql_host" \
      -P "$mysql_port" \
      -uroot \
      "$database_name" > "$tmp_path"
    ;;
  *)
    echo "Unsupported MYSQL_DUMP_MODE: $dump_mode" >&2
    echo "Expected compose or direct." >&2
    exit 2
    ;;
esac

mv "$tmp_path" "$output_path"
trap - EXIT

echo "Backup written: $output_path"
