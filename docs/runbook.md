# Operator runbook — failure modes and recovery

Audience: on-call operators.
Owner: release-engineering.
[`OPERATOR-GUIDE.md`](OPERATOR-GUIDE.md) (setup) and
[`DEPLOYMENT-TLS.md`](DEPLOYMENT-TLS.md) (TLS topology).

Every diagnostic below starts from the same place: `docker compose ps` and
`docker compose logs --tail=100 <service>` from `deploy/compose/`. The API
exposes `GET /healthz` (process alive) and `GET /readyz` (store reachable;
`503` means the database dependency is failing while the process itself is
healthy — do not restart the container for a `readyz` failure).

## Symptom index

| Symptom | Section |
| --- | --- |
| Browsers show certificate warnings or the origin fails to load | [TLS](#tls-failures) |
| Clients get `401`/`PM-API-UNAUTHORIZED` or pairing fails | [Authentication](#authentication-failures) |
| Browser console shows CORS errors | [CORS](#cors-failures) |
| `readyz` returns 503, records time out | [Database](#database-failures) |
| Containers restart-loop after an upgrade | [Migration](#migration-failures) |
| `./backups` empty or backup loop failing | [Backup](#backup-failures) |
| Restore refuses or reports counts | [Restore](#restore-failures) |
| Writes fail, logs show I/O errors | [Storage exhaustion](#storage-exhaustion) |
| TOTP codes wrong, sessions expire oddly | [Clock drift](#clock-drift) |
| Client reports incompatible protocol/version | [Client/server version mismatch](#client-server-version-mismatch) |

## TLS failures

Symptoms: browser certificate warnings, `curl https://…` fails, gateway logs
TLS handshake errors, HTTP does not redirect.

1. Check certificate files are mounted read-only and readable inside the
   container: `docker compose exec gateway ls -l /certs`.
2. Check expiry: `openssl x509 -enddate -noout -in <cert>`.
3. The gateway refuses to start with a configured-but-missing certificate
   file (fail closed): unset `VEYORA_GATEWAY_TLS_CERT_FILE`/`VEYORA_GATEWAY_TLS_KEY_FILE`
   only for an intentional plain-HTTP local preview, never in production.
4. After replacing certificates, restart only the gateway:
   `docker compose restart gateway`.

## Authentication failures

Symptoms: every API call returns `401` with `PM-API-UNAUTHORIZED`; pairing
codes rejected.

1. `VEYORA_API_AUTH` must be `token` (or the scoped mode once shipped) in
   production; `disabled` is a local-preview setting only.
2. Verify the exact token reaches the API:
   `curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer <token>' http://127.0.0.1:8080/healthz`
   — `healthz` needs no auth; use `/records` for the authenticated check.
3. Secrets never appear in logs or `docker compose config` output beyond the
   environment mechanism; if a token may have leaked, rotate it by changing
   `VEYORA_API_TOKEN` and recreating the API: `docker compose up -d api`.
4. Repeated failures trigger the per-minute rate limit (`429`,
   `PM-API-RATE-LIMITED`, `Retry-After` header); raise
   `VEYORA_API_RATE_LIMIT` only after ruling out an attack.

## CORS failures

Symptoms: browser console reports blocked cross-origin requests; preflight
`OPTIONS` fails.

1. Set `VEYORA_API_CORS_ORIGINS` to the exact Web origin(s), for example
   `https://vault.example.com` — no trailing slash, no wildcard with
   credentials.
2. Verify preflight:
   `curl -s -i -X OPTIONS http://127.0.0.1:8080/records -H 'Origin: https://vault.example.com' -H 'Access-Control-Request-Method: GET'`
   must return the origin (not `*`) and `authorization, content-type` in
   `Access-Control-Allow-Headers`.
3. In the supported same-origin topology the Web container proxies `/api/`,
   so CORS is only needed for explicitly separated origins.

## Database failures

Symptoms: `readyz` returns `503` with `ready:false`; record writes fail with
`PM-STORE-UNAVAILABLE`; connection exhaustion.

1. `docker compose logs postgres` first; `docker compose ps postgres` must
   show `(healthy)`.
2. The connection pool is bounded (default 8, `VEYORA_DB_POOL_MAX`): pool
   exhaustion fails closed with `PM-STORE-UNAVAILABLE` rather than opening
   unlimited connections — check for slow queries or too many API replicas
   before raising the limit, and never exceed the PostgreSQL `max_connections`
   budget across all services.
3. After a hard host crash, PostgreSQL recovers its write-ahead log itself;
   if the volume is corrupted, restore from the latest backup
   (see [Restore](#restore-failures)) into a fresh volume rather than
   attempting in-place repair.

## Migration failures

Symptoms: the migrator exits non-zero after an upgrade; the API stays
created/pending because `migrator: service_completed_successfully` never
satisfies.

1. `docker compose logs migrator`: migrations are ordered and idempotent; a
   failed run leaves either the old schema or the new one — never a mix.
2. Fix the underlying cause (usually the database being unreachable or out
   of disk), then re-run: `docker compose up -d migrator`.
3. Roll back binaries only together with the supported data-format policy:
   check the release notes' supported rollback limits before pointing an
   older image version at a newer schema.

## Backup failures

Symptoms: `./backups` empty; the backup loop container exits or writes
nothing.

1. The backup profile must be started explicitly:
   `docker compose --profile backup up -d backup`.
2. The container runs as uid 10001: the host directory must be writable by
   it — create it once with
   `install -d -o 10001 -g 10001 ./backups`.
3. Backups are opaque database snapshots of ciphertext only; they never
   contain keys or plaintext. Verify one restores (see below) before relying
   on it.

## Restore failures

Symptoms: restore refuses, or the counts look wrong.

1. Restore reports actual inserted/replaced/skipped/failed counts; the input
   row count is never treated as a success count.
2. Restores into a non-empty destination follow an explicit policy — decide
   reject/merge/replace before running; silent conflict skipping does not
   exist.
3. The destructive drill (`tests/integration/backup-restore.sh`) detaches
   the primary and restores into an empty target; use it to validate a
   backup before an emergency.

## Storage exhaustion

Symptoms: writes fail with `PM-STORE-UNAVAILABLE`, PostgreSQL logs `No
space left on device`, backups stop appearing.

1. Check `docker system df` and the volume/host disk (`df -h`).
2. Free space by pruning stale images (`docker image prune`), never by
   deleting `veyora-pg` or `./backups` content.
3. After freeing space, confirm recovery: `curl http://127.0.0.1:8080/readyz`
   returns `200` with `ready:true`.
4. Space pressure never silently corrupts records: failed writes fail closed
   and the last committed state remains.

## Clock drift

Symptoms: TOTP codes generated by clients disagree with relying parties;
sessions seem to expire early or late; backup filenames duplicate.

1. Run time synchronization (for example `systemd-timesyncd`/`chrony`) on
   the host; containers inherit the host clock.
2. Revisions and expiry decisions are server-authoritative; fixing the clock
   restores correct behavior without data changes. Do not move the clock
   backward across a running backup day boundary.

## Client/server version mismatch

Symptoms: the client reports protocol incompatibility or unexpected error
codes.

1. Compare `curl http://127.0.0.1:8080/version` with the client's Diagnostics
   panel (version and protocol version).
2. Clients refuse unsupported protocol versions fail-closed rather than
   guessing; upgrade the older side. The compatibility policy and supported
   ranges live in the release notes for each version.

## Trash retention not purging

Symptoms: tombstoned rows accumulate; Trash entries never disappear;
worker logs show `purged=0` indefinitely.

1. Check the worker's policy line at startup
   (`trash retention=30d` or `disabled`) and the
   `VEYORA_TRASH_RETENTION_DAYS` environment variable on the worker
   service (`0` disables purging entirely — the worker only monitors).
2. Retention purges tombstones whose deletion stamp is older than the
   window; a stamp backfilled by the 0003 migration starts its window at
   the migration run, so pre-migration Trash entries disappear at most
   one window after upgrade — never earlier than an operator expects.
3. The cutoff saturates at the epoch instead of underflowing, so a clock
   set before the retention window deletes nothing extra (see the
   worker's unit tests).

## Destructive operations

Only two paths delete deployment data, both explicit:

- `docker compose down` — stops services, keeps the `veyora-pg` volume.
- `make purge-data CONFIRM=destroy-veyora-data` (repository root) — stops
  services and deletes the `veyora-pg` volume, i.e. every encrypted record.
  `./backups` and anything outside Compose are untouched; there is no
  undelete.
