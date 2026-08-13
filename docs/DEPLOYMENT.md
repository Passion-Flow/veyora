# Deployment guide

Veyora currently provides a localhost-only evaluation stack and a
production-shaped image topology. Neither is a supported production release.
Use inert data until the cryptographic implementation and your exact deployment
have received independent review.

## Local preview

### Requirements

- Docker Engine with Docker Compose
- Git
- `curl` and Python 3 for the optional smoke test

### Configure

```bash
git clone https://github.com/Passion-Flow/veyora.git
cd veyora
cp .env.example .env
```

Set `VEYORA_DB_PASSWORD` in `.env` to a unique development-only value. The
checked-in example intentionally leaves it blank so Compose fails closed until
you choose one.

### Start

```bash
docker compose config --quiet
docker compose up --build -d
docker compose ps
```

| Endpoint | Default address | Purpose |
| --- | --- | --- |
| Web client | `http://127.0.0.1:3000` | Browser UI and same-origin `/api` proxy |
| Gateway | `http://127.0.0.1:8080` | Local API diagnostics and smoke testing |

PostgreSQL and the Rust API are not published to the host by the base topology.
The worker and migrator use the private Compose network.

### Verify

```bash
./scripts/smoke-test.sh http://127.0.0.1:8080
docker compose logs --tail=100 api gateway web worker
```

The smoke test writes and tombstones an explicitly inert ciphertext fixture.
It must never be modified to use real credentials.

### Stop

```bash
docker compose down
```

This keeps the PostgreSQL volume. To deliberately remove the local database,
run `docker compose down --volumes` after confirming that no required data is
stored there.

## Source development

Start only PostgreSQL:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up postgres
```

Then run the API in another terminal:

```bash
cd backend
DATABASE_URL=postgres://veyora:YOUR_PASSWORD@127.0.0.1:5432/veyora \
VEYORA_STORE=postgres \
VEYORA_API_BIND=127.0.0.1:8080 \
VEYORA_API_AUTH=disabled \
VEYORA_API_MAX_BODY_BYTES=262144 \
cargo run --locked -p api
```

Serve the static client from the repository root:

```bash
make run-web
```

## Configuration

The local Compose topology passes every required service value explicitly.

| Variable | Local default | Purpose |
| --- | --- | --- |
| `VEYORA_DB_PASSWORD` | none; required | PostgreSQL password |
| `VEYORA_DB_NAME` | `veyora` | PostgreSQL database |
| `VEYORA_DB_USER` | `veyora` | PostgreSQL role |
| `VEYORA_GATEWAY_PORT` | `8080` | Localhost gateway port |
| `VEYORA_WEB_PORT` | `3000` | Localhost web port |
| `VEYORA_API_AUTH` | `disabled` | API authentication mode for local evaluation |
| `VEYORA_API_TOKEN` | empty | Bearer token when token mode is selected |
| `VEYORA_API_MAX_BODY_BYTES` | `262144` | Request-body limit |
| `VEYORA_WORKER_POLL_SECONDS` | `60` | Worker polling interval |
| `VEYORA_GATEWAY_ROUTE_TIMEOUT_SECONDS` | `30` | Envoy upstream timeout |
| `VEYORA_WEB_PROXY_TIMEOUT_SECONDS` | `30` | nginx upstream timeout |

The bundled browser client does not attach the optional API bearer token. Token
mode is intended for API-only use or a separately reviewed authentication
integration. Do not interpret `VEYORA_API_AUTH=disabled` as suitable for direct
internet exposure.

## Build and publish images

The publishing script is registry-neutral and builds Veyora images for
`linux/amd64` and `linux/arm64`.

```bash
docker login ghcr.io

REGISTRY=ghcr.io \
NAMESPACE=your-account \
VERSION=v1.0.0-preview \
./scripts/build-and-push.sh
```

No prebuilt Veyora image is guaranteed by this repository. Confirm image
digests, provenance, vulnerability scans, and registry visibility before use.

## Production-shaped topology

After publishing the images, provide explicit settings and validate the file:

```bash
REGISTRY=ghcr.io \
NAMESPACE=your-account \
VERSION=v1.0.0-preview \
VEYORA_DB_PASSWORD='replace-me' \
VEYORA_API_AUTH=disabled \
docker compose -f docker-compose.prod.yml config --quiet
```

The production-shaped file still binds host ports to `127.0.0.1`. Put a
reviewed, owner-controlled TLS and authentication layer in front of those
ports. Do not change the bind address to a public interface without reviewing
the full threat model and access-control design.

## Backup and restore

The backend contains one-shot backup and restore binaries for opaque logical
snapshots. A ciphertext-only format reduces server visibility but does not make
a backup harmless: metadata, availability, rollback, corruption, and deletion
risks remain. Validate recovery into a fresh destination before relying on any
backup process.

## Pre-deployment checklist

- Independent cryptographic and application-security review completed
- Exact container digests recorded and verified
- TLS termination and forwarded-header trust reviewed
- Authentication appropriate for the client and exposure model
- Database and service secrets injected outside Git
- Host ports, firewall rules, and Compose networks reviewed
- Logs, metrics, traces, and backups checked for sensitive metadata
- Backup restore and rollback tested with inert data
- Resource limits, monitoring, upgrades, and incident response defined
