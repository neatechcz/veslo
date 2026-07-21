#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: validate-live-auth-env.sh <production|staging> <env-file>" >&2
  exit 2
fi

deployment="$1"
env_file="$2"

case "$deployment" in
  production|staging) ;;
  *)
    echo "unsupported live deployment label: $deployment" >&2
    exit 2
    ;;
esac

if [ ! -r "$env_file" ]; then
  echo "$deployment auth email verification configuration is invalid: env file is not readable" >&2
  exit 1
fi

read_env_value() {
  key="$1"
  awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      value = $0
      sub("^[[:space:]]*" key "[[:space:]]*=[[:space:]]*", "", value)
      sub("[[:space:]\\r]+$", "", value)
      if (length(value) >= 2) {
        first = substr(value, 1, 1)
        last = substr(value, length(value), 1)
        if ((first == "\"" && last == "\"") || (first == "\047" && last == "\047")) {
          value = substr(value, 2, length(value) - 2)
        }
      }
      sub("^[[:space:]]+", "", value)
      sub("[[:space:]\\r]+$", "", value)
      result = value
    }
    END { print result }
  ' "$env_file"
}

invalid=()
verification_flag="$(read_env_value DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED | tr '[:upper:]' '[:lower:]')"
if [ "$verification_flag" != "true" ]; then
  invalid+=("DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED must be true")
fi

for key in LETTR_API_KEY AUTH_EMAIL_ADDRESS; do
  if [ -z "$(read_env_value "$key")" ]; then
    invalid+=("$key must be configured")
  fi
done

if [ "${#invalid[@]}" -ne 0 ]; then
  echo "$deployment auth email verification configuration is invalid:" >&2
  for message in "${invalid[@]}"; do
    echo "- $message" >&2
  done
  exit 1
fi

echo "$deployment auth email verification configuration is valid"
