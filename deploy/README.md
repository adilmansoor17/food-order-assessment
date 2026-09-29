# Production Compose runbook

`compose.prod.yaml` is a single-host deployment recipe. It runs production API, web, and worker images behind Caddy, plus PostgreSQL, Redis, and RabbitMQ with persistent volumes. The data services have no published host ports. A single host remains a failure domain; use off-host backups and a larger managed topology for measured high concurrency.

The API trusts one proxy hop in production for per-client authentication rate limits. Keep it reachable only through the included Caddy service; if another proxy or CDN is added, verify its forwarded-IP handling and re-test rate limits before release.

## Prepare the host

Install Docker Engine with Compose and make the domain in `APP_DOMAIN` resolve to this host. Open inbound TCP 80 and 443 for Caddy and certificate issuance. Copy `.env.example` to `.env` and set production values for `APP_DOMAIN`, `API_IMAGE`, `WEB_IMAGE`, PostgreSQL/RabbitMQ/Redis passwords, every JWT/OTP secret, SMTP, Twilio, and bank instructions. Keep `DEMO_PAYMENTS_ENABLED=false`: production startup rejects simulated payments. Use independent `openssl rand -hex 32` values for URL-embedded Redis and RabbitMQ passwords so their generated connection URLs remain valid. Generate `OTP_ENCRYPTION_KEY` with `openssl rand -base64 32`. Run `chmod 600 .env`; the release script rejects group/world-readable credentials. Never commit `.env`.

Images are published to GHCR from a `v*` Git tag after all CI checks pass. Configure `API_IMAGE` and `WEB_IMAGE` to the **same** verified tag, preferably its recorded digest. PostgreSQL, Redis, RabbitMQ, and Caddy are pinned by digest in `compose.prod.yaml`; update those pins in a separately tested dependency release. If the packages are private, log in to `ghcr.io` on the host using a read-only package token. Do not put the login token in `.env`.

## Release

Create an existing, restricted backup directory outside the repository and confirm the encrypted off-host backup destination and restore credentials are available. Run `deploy/release.sh /absolute/backup-directory https://your-domain.example`. It validates Compose, pulls images, starts data services, writes a restricted local pre-migration PostgreSQL dump, applies versioned migrations, starts API/worker/web/Caddy, and checks `/v1/health/ready`. Transfer the dump through the approved encrypted off-host path immediately; the script does not perform or prove that transfer. Confirm `/docs`, a real browser checkout, queue consumption, and provider delivery separately before public signup.

The migration is forward only. A rollback switches `API_IMAGE` and `WEB_IMAGE` back to the previous verified tag and runs `docker compose --env-file .env -f compose.prod.yaml up -d --no-deps api worker web`; this is safe only when that previous version accepts the applied schema. Keep the previous tag and database dump until the release is accepted. Inspect status with `docker compose --env-file .env -f compose.prod.yaml ps` and service logs with `docker compose --env-file .env -f compose.prod.yaml logs --tail=200 api worker caddy`.

## Backup and restore check

Schedule `deploy/backup.sh /absolute/backup-directory`, transfer each `.dump` and `.sha256` off-host, and monitor the newest usable copy. The script creates a restricted custom-format `pg_dump` and checksum. Periodically use `deploy/restore-into-test-db.sh /absolute/backup.dump food_ordering_drill_restore` to restore into a **new** disposable database on the same PostgreSQL service; it refuses names without the `_restore` suffix and never overwrites the application database. Check restored order counts and application behavior before dropping the drill database. A same-host drill does not establish recovery from total host loss; test an off-host copy on a separate host as well.

## Limits to verify before calling it live

- Run migrations, smoke checks, and browser tests against the exact release image and domain.
- Verify SMTP and real SMS delivery, RabbitMQ retry/dead-letter behavior, bank instructions, Caddy certificates, and off-host restore.
- Record observed order throughput and queue lag. The PDF's five-million-parallel-orders scenario is a scaling design objective; this single-host recipe has no verified capacity claim.
