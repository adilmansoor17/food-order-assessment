#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 || "$1" != /* || ! -f "$1" || ! "$2" =~ ^[a-z][a-z0-9_]*_restore$ ]]; then
  echo 'Usage: deploy/restore-into-test-db.sh BACKUP.dump NEW_DATABASE_NAME_ending_in_restore' >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
if [[ ! -f .env ]]; then
  echo 'A production .env file is required.' >&2
  exit 2
fi

backup_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
target_database="$2"
if [[ -f "$backup_file.sha256" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$(dirname "$backup_file")" && sha256sum -c "$(basename "$backup_file").sha256")
  else
    (cd "$(dirname "$backup_file")" && shasum -a 256 -c "$(basename "$backup_file").sha256")
  fi
fi

docker compose --env-file .env -f compose.prod.yaml exec -T postgres \
  sh -c 'exec createdb -U "$POSTGRES_USER" "$1"' restore "$target_database"
docker compose --env-file .env -f compose.prod.yaml exec -T postgres \
  sh -c 'exec pg_restore --no-owner --no-privileges --single-transaction --exit-on-error -U "$POSTGRES_USER" -d "$1"' restore "$target_database" \
  < "$backup_file"
docker compose --env-file .env -f compose.prod.yaml exec -T postgres \
  sh -c 'exec psql -U "$POSTGRES_USER" -d "$1" -Atc "SELECT count(*) FROM orders"' restore "$target_database"
echo "Restore completed into disposable database: $target_database"
echo 'Inspect it, then drop the disposable database manually after verification.'
