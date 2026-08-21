# Veyora Docker deployment

This directory is the single entry point for deploying Veyora with
Docker Compose. It contains the canonical topology file, the
environment template, and the container definitions for the Envoy
gateway and the static web client.

## Quick start

1. Install Docker Engine with Compose v2 (`docker compose version`).

2. Create your environment file:

   ```bash
   cp .env.example .env
   ```

3. Set at least `VEYORA_DB_PASSWORD` in `.env` (a unique random value,
   for example `openssl rand -hex 32`).

4. Start the stack:

   ```bash
   docker compose up -d
   ```

5. Open the web client at `http://127.0.0.1:3000` and create a vault.

## What is `.env`?

`.env` is the local startup file. Copy it from `.env.example` for a
default deployment. Compose reads every variable from it — image
source, ports, authentication mode, and optional TLS settings. The
annotated `.env.example` documents the full set.

## Directory layout

| Path | Purpose |
| --- | --- |
| `docker-compose.yaml` | Canonical topology: PostgreSQL, migrator, API, worker, gateway, web, backup |
| `.env.example` | Annotated environment template |
| `gateway/` | Envoy gateway image: Dockerfile, entrypoint, Envoy templates |
| `web/` | Static web client image: Dockerfile, nginx configuration |
| `Dockerfile.mirror` | Re-tagging definition for pinned foundation images |
| `certs/` | TLS certificates at runtime (git-ignored) |
| `backups/` | Snapshot output of the optional backup profile (git-ignored) |

The Rust service images (api, worker, migrator, backup, restore,
sandbox) are built from the `backend/` Dockerfiles at the repository
root; the compose build contexts point there.

## Optional profiles

The backup service is disabled by default. Enable the daily snapshot
loop with:

```bash
docker compose --profile backup up -d backup
```

Snapshots are written to `./backups` with one-week retention.

## Building from source

The default `docker compose up` pulls the published multi-architecture
images. To build every application image from the local sources
instead:

```bash
docker compose build
docker compose up -d
```

For a database-only container during Rust development (published on
`127.0.0.1:5432`):

```bash
docker compose up postgres
```

## TLS termination

Provide a certificate chain and private key, then uncomment the
`VEYORA_GATEWAY_TLS_*` entries in `.env`:

```bash
mkdir -p certs
cp /etc/letsencrypt/live/vault.example.com/fullchain.pem certs/
cp /etc/letsencrypt/live/vault.example.com/privkey.pem certs/
```

With `VEYORA_GATEWAY_TLS_CERT_FILE=/certs/fullchain.pem` and
`VEYORA_GATEWAY_TLS_KEY_FILE=/certs/privkey.pem` set, the gateway
terminates TLS (default host port 8443) and redirects plain HTTP.
See [../docs/DEPLOYMENT-TLS.md](../docs/DEPLOYMENT-TLS.md) for the
full walkthrough.

## Going beyond localhost

- Set `VEYORA_API_AUTH=token` and a strong `VEYORA_API_TOKEN`.
- Publish the TLS port (`VEYORA_GATEWAY_TLS_PORT=443`) and place the
  gateway behind your firewall or reverse proxy.
- Consider `VEYORA_API_CORS_ORIGINS` and `VEYORA_API_RATE_LIMIT` from
  the hardening section of `.env.example`.

The [operator guide](../docs/OPERATOR-GUIDE.md) covers the reviewed
deployment checklist.
