#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: restore-mysql.sh --apply <db-service> <database-name> <input.sql>

Environment:
  COMPOSE_FILE     Compose file path. Default: packaging/owned-server/compose.yml
  ENV_FILE         Compose env file. Default: /srv/veslo/env/production.env
  DOCKER_COMPOSE   Compose command. Default: docker compose

Example:
  DOCKER_COMPOSE="sudo docker compose" restore-mysql.sh --apply den-db den /srv/veslo/backups/den.sql
USAGE
}

if [[ "${1:-}" != "--apply" ]]; then
  echo "Refusing to restore without --apply." >&2
  usage
  exit 2
fi
shift

if [[ $# -ne 3 ]]; then
  usage
  exit 2
fi

service_name="$1"
database_name="$2"
input_path="$3"

case "$service_name" in
  den-db|ai-gateway-db) ;;
  *)
    echo "Unsupported database service: $service_name" >&2
    echo "Expected den-db or ai-gateway-db." >&2
    exit 2
    ;;
esac

if [[ ! -f "$input_path" ]]; then
  echo "Input dump does not exist: $input_path" >&2
  exit 2
fi

compose_file="${COMPOSE_FILE:-packaging/owned-server/compose.yml}"
env_file="${ENV_FILE:-/srv/veslo/env/production.env}"
docker_compose="${DOCKER_COMPOSE:-docker compose}"
read -r -a compose_cmd <<< "$docker_compose"

cat >&2 <<WARNING
WARNING: restoring $input_path into database '$database_name' on service '$service_name'.
This is destructive for any existing rows and schema objects contained in the dump.
WARNING

cat "$input_path" | "${compose_cmd[@]}" -f "$compose_file" --env-file "$env_file" exec -T "$service_name" \
  sh -c 'MYSQL_PWD="${MYSQL_ROOT_PASSWORD:?missing MYSQL_ROOT_PASSWORD}" mysql -uroot "$1"' \
  sh "$database_name"

echo "Restore applied: $input_path -> $service_name/$database_name"
