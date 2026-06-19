#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runner="$script_dir/backup-owned-server-databases.sh"

daily_utc_time="${BACKUP_DAILY_UTC_TIME:-02:15:00}"
random_delay_seconds="${BACKUP_RANDOM_DELAY_SECONDS:-900}"
run_on_start="${BACKUP_RUN_ON_START:-0}"

validate_daily_time() {
  if [[ ! "$daily_utc_time" =~ ^[0-2][0-9]:[0-5][0-9]:[0-5][0-9]$ ]]; then
    echo "Invalid BACKUP_DAILY_UTC_TIME: $daily_utc_time" >&2
    exit 2
  fi

  local hour="${daily_utc_time%%:*}"
  if (( 10#$hour > 23 )); then
    echo "Invalid BACKUP_DAILY_UTC_TIME hour: $daily_utc_time" >&2
    exit 2
  fi

  if [[ ! "$random_delay_seconds" =~ ^[0-9]+$ ]]; then
    echo "Invalid BACKUP_RANDOM_DELAY_SECONDS: $random_delay_seconds" >&2
    exit 2
  fi
}

random_delay() {
  if (( random_delay_seconds <= 0 )); then
    printf '0'
    return 0
  fi

  local value
  value="$(od -An -N4 -tu4 /dev/urandom | tr -d '[:space:]')"
  printf '%s' "$(( value % (random_delay_seconds + 1) ))"
}

seconds_until_next_run() {
  local now
  local today
  local target
  local delay

  now="$(date -u +%s)"
  today="$(date -u +%Y-%m-%d)"
  target="$(date -u -d "$today $daily_utc_time UTC" +%s)"
  if (( now >= target )); then
    target="$(( target + 86400 ))"
  fi

  delay="$(random_delay)"
  printf '%s' "$(( target + delay - now ))"
}

run_backup() {
  echo "Starting owned-server database backup at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  "$runner"
}

validate_daily_time

if [[ "$run_on_start" == "1" || "$run_on_start" == "true" ]]; then
  run_backup
fi

while true; do
  sleep_seconds="$(seconds_until_next_run)"
  echo "Next owned-server database backup in ${sleep_seconds}s at daily UTC time $daily_utc_time"
  sleep "$sleep_seconds"
  run_backup
done
