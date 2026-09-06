# Veyora Operator Guide

## Overview

This guide covers deploying, monitoring, backing up, and troubleshooting
a Veyora instance. It assumes Docker Engine with Docker Compose.

## Quick start

```bash
git clone https://github.com/Passion-Flow/veyora.git
cd veyora
cp deploy/compose/.env.example deploy/compose/.env
# Edit deploy/compose/.env with production values (see below)
cd deploy/compose
docker compose up -d
```

The web client is available at `http://127.0.0.1:3000` and the API at
`http://127.0.0.1:8080`.

## Environment variables

### Required

| Variable | Example | Description |
|----------|---------|-------------|
| `VEYORA_DB_PASSWORD` | (openssl rand -hex 32) | PostgreSQL password |
| `VEYORA_API_BIND` | `0.0.0.0:8080` | API listen address |
| `VEYORA_API_AUTH` | `token` | `disabled` or `token` |
| `VEYORA_API_TOKEN` | (openssl rand -hex 32) | Bearer token (when auth=token) |
| `VEYORA_API_MAX_BODY_BYTES` | `262144` | Request body limit |

### Recommended (production)

| Variable | Example | Description |
|----------|---------|-------------|
| `VEYORA_API_CORS_ORIGINS` | `https://vault.example.com` | Comma-separated origin allowlist |
| `VEYORA_API_RATE_LIMIT` | `120` | Requests per minute per IP |
| `VEYORA_WEB_PROXY_TIMEOUT_SECONDS` | `30` | Upstream read timeout |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `VEYORA_STORE` | `in-memory` | `postgres` for persistence |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `VEYORA_WORKER_POLL_SECONDS` | `60` | Worker poll interval |

## Services

| Service | Port | Purpose |
|---------|------|---------|
| `gateway` | 8080 | Envoy reverse proxy (TLS termination) |
| `api` | 8080 (internal) | Rust HTTP API (ciphertext storage) |
| `web` | 3000 | nginx serving the static client |
| `postgres` | 5432 (loopback) | PostgreSQL |
| `worker` | — | Background maintenance |
| `migrator` | — | One-shot database migrations |

## Operations

All `docker compose` commands below run from the `deploy/compose/` directory.

### Starting and stopping

```bash
docker compose up -d          # Start all services
docker compose ps             # Check status
docker compose logs -f api    # Follow API logs
docker compose down           # Stop (preserves data volume)
make purge-data CONFIRM=destroy-veyora-data
                              # DESTRUCTIVE (run from the repository root):
                              # stop and delete the veyora-pg volume (every
                              # encrypted record); ./backups and files
                              # outside Compose are not touched
```

### Database migrations

Migrations run automatically when the `api` service starts with
`VEYORA_STORE=postgres`. To run manually:

```bash
docker compose run --rm migrator
```

### Backup

The `backup` service exports the full database as a JSON file containing
opaque ciphertext (no plaintext):

```bash
docker compose run --rm backup > backup-$(date +%Y%m%d).json
```

Schedule daily backups with cron:

```bash
echo "0 2 * * * cd /opt/veyora/docker && docker compose run --rm backup > backups/\$(date +\%Y\%m\%d).json && find backups -name '*.json' -mtime +30 -delete" | crontab -
```

### Restore

```bash
docker compose run --rm restore < backup-20260815.json
```

> **Warning**: Restore replaces ALL records in the database. Existing
> data is lost.

### Health checks

```bash
curl http://localhost:8080/healthz   # Liveness (always 200)
curl http://localhost:8080/readyz    # Readiness (checks DB)
curl http://localhost:8080/version   # Version info
curl http://localhost:8080/metrics   # Prometheus metrics
```

### Monitoring

The `/metrics` endpoint exposes:

```
veyora_requests_total    # Total HTTP requests
veyora_puts_total        # Record PUT operations
veyora_gets_total        # Record GET operations
veyora_deletes_total     # Record DELETE operations
veyora_uptime_seconds    # Process uptime
```

Scrape with Prometheus:

```yaml
scrape_configs:
  - job_name: 'veyora'
    static_configs:
      - targets: ['localhost:8080']
```

Recommended alerts:

| Alert | Condition | Severity |
|-------|-----------|----------|
| Service down | `up{job="veyora"} == 0` for 1m | Critical |
| High error rate | `rate(http_requests_total{status=~"5.."}[5m]) > 0.01` | Warning |
| Restart loop | `changes(process_start_time_seconds[10m]) > 3` | Critical |

## TLS termination

Summary: mount Let's Encrypt certificates into the Envoy gateway
container and enable the TLS variables in `deploy/compose/.env`
(see [DEPLOYMENT-TLS.md](DEPLOYMENT-TLS.md) for the complete guide).

## Troubleshooting

### API won't start

Check for missing environment variables:

```bash
docker compose logs api | grep "configuration error"
```

Each missing variable is listed with its expected format.

### Database connection failures

```bash
docker compose logs db
docker compose exec db pg_isready
```

Verify `DATABASE_URL` matches the PostgreSQL credentials.

### Web client loads but entries don't appear

1. Check API health: `curl http://localhost:8080/readyz`
2. Check browser console for JavaScript errors
3. Verify `VEYORA_API_BASE_URL` in `veyora-config.js` (served by nginx)
4. Check CORS if the API is on a different origin

### Rate limiting blocks legitimate users

Increase `VEYORA_API_RATE_LIMIT` or remove the variable to disable.
The default is disabled (development mode).

### Recovery kit doesn't work

The preview does not implement a Recovery Key that unwraps the existing Vault
Key. Recovery-looking UI from older builds is not recovery evidence and must
not be relied upon. Preserve the affected opaque storage unchanged and do not
overwrite it with a new empty Vault. A supported recovery procedure is blocked
until `REC-001` through `REC-005` and `E2E-003` are complete.

## Security hardening checklist

- [ ] `VEYORA_API_AUTH=token` with a strong token
- [ ] `VEYORA_API_CORS_ORIGINS` set to your domain (no wildcard)
- [ ] `VEYORA_API_RATE_LIMIT` ≥ 60
- [ ] TLS certificates valid and auto-renewing
- [ ] PostgreSQL not exposed to the public internet
- [ ] Regular backups configured and tested
- [ ] `docker compose logs` monitored
- [ ] Firewall allows only 80/443
- [ ] Strong database password (`openssl rand -hex 32`)
- [ ] `.env` file permissions restricted (`chmod 600 .env`)

## Upgrade procedure

Each upgrade runs a bounded preflight → backup → switch → verify sequence.
Release images are digest-pinned through the mirrored foundation images, and
release notes state the supported upgrade origins and rollback limits for the
version pair being deployed.

1. **Preflight.** Read the release notes for data/contract migrations,
   breaking changes, and supported rollback limits. Confirm the target
   version matches the release channel policy and note the currently running
   versions:

   ```bash
   curl -s http://127.0.0.1:8080/version   # record this output
   ```

2. **Verified backup.** Produce a fresh snapshot and confirm it exists
   before touching anything (`--entrypoint` bypasses the scheduled-loop
   entrypoint for a one-shot run; the output directory must be writable by
   uid 10001 — see the [backup runbook](runbook.md#backup-failures)):

   ```bash
   docker compose run --rm --entrypoint veyora-backup backup > backups/pre-upgrade.json
   ls -l backups/ | tail -3
   ```

3. **Switch.** Pull the pinned images and recreate; the migrator runs once
   and must complete before the API starts:

   ```bash
   git pull
   docker compose pull
   docker compose up -d
   ```

4. **Verify.** Health, readiness, migration success, and a real round trip
   (the smoke script runs from the repository root):

   ```bash
   docker compose ps                      # all services healthy
   docker compose logs --tail=50 migrator # migration completed
   curl http://127.0.0.1:8080/readyz      # {"ready":true,...}
   ```

   ```bash
   cd <repository root> && ./tests/smoke/api.sh http://127.0.0.1:8080
   ```

5. **Rollback decision.** If verification fails: fix forward when the
   release notes say the schema is compatible. Rolling back binaries is only
   valid within the documented data-format limits — an older binary must
   never run against a newer committed schema. When in doubt, stop the API
   (`docker compose stop api`) and restore from the step-2 backup into a
   fresh volume instead of mixing versions (see
   [`runbook.md`](runbook.md)).

Zero-downtime upgrades are supported via the API's graceful shutdown
(`SIGTERM` drain, bounded by its stop-grace window); the migrator gate makes
the switch itself transactional.

## Support

- GitHub Issues: https://github.com/Passion-Flow/veyora/issues
- Security reports: see SECURITY.md (do not post publicly)
