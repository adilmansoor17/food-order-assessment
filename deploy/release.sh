#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 || "$1" != /* || ! -d "$1" || ! "$2" =~ ^https://[^/]+/?$ ]]; then
  echo 'Usage: deploy/release.sh EXISTING_BACKUP_DIRECTORY https://your-domain.example' >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
if [[ ! -f .env ]]; then
  echo 'A production .env file is required.' >&2
  exit 2
fi
if ! env_mode="$(stat -c '%a' .env 2>/dev/null)"; then
  env_mode="$(stat -f '%Lp' .env)"
fi
if (( (8#$env_mode & 077) != 0 )); then
  echo 'Production .env must be readable only by its owner (chmod 600 .env).' >&2
  exit 2
fi

public_url="${2%/}"
compose=(docker compose --env-file .env -f compose.prod.yaml)
"${compose[@]}" config --quiet
"${compose[@]}" pull
"${compose[@]}" up -d --wait postgres redis rabbitmq
"$repo_root/deploy/backup.sh" "$1"
"${compose[@]}" run --rm migrate
"${compose[@]}" up -d --wait --wait-timeout 180 --no-deps api worker web caddy

for ((attempt = 1; attempt <= 30; attempt++)); do
  if curl --fail --silent --show-error "$public_url/v1/health/ready" >/dev/null 2>&1; then
    echo "Release ready: $public_url"
    exit 0
  fi
  sleep 2
done

echo "Readiness failed at $public_url/v1/health/ready. Inspect service logs before traffic promotion." >&2
"${compose[@]}" ps >&2
exit 1
