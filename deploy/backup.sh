#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || "$1" != /* || ! -d "$1" ]]; then
  echo 'Usage: deploy/backup.sh EXISTING_BACKUP_DIRECTORY' >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
if [[ ! -f .env ]]; then
  echo 'A production .env file is required.' >&2
  exit 2
fi

umask 077
backup_dir="$(cd "$1" && pwd)"
backup_file="$backup_dir/food-ordering-$(date -u +%Y%m%dT%H%M%SZ).dump"
temporary_file="$(mktemp "$backup_file.XXXXXX")"
trap 'rm -f "$temporary_file"' EXIT

docker compose --env-file .env -f compose.prod.yaml exec -T postgres \
  sh -c 'exec pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "$temporary_file"
test -s "$temporary_file"
mv "$temporary_file" "$backup_file"
trap - EXIT
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$backup_file" > "$backup_file.sha256"
else
  shasum -a 256 "$backup_file" > "$backup_file.sha256"
fi
echo "Backup saved: $backup_file"
echo 'Copy the dump and checksum to the configured off-host backup destination.'
