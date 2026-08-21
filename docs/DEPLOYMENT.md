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
cp docker/.env.example docker/.env
```

Set `VEYORA_DB_PASSWORD` in `docker/.env` to a unique development-only value.
The checked-in example intentionally leaves it blank so Compose fails closed
until you choose one.

### Start

```bash
cd docker
docker compose config --quiet
docker compose up -d
docker compose ps
```

No local application build or registry login is performed. Compose pulls the
public Veyora `v1.0.0` images from GitHub Container Registry. The shared tag
publishes both `linux/amd64` and `linux/arm64`; Docker resolves the correct image
for the host automatically.

| Endpoint | Default address | Purpose |
| --- | --- | --- |
| Web client | `http://127.0.0.1:3000` | Browser UI and same-origin `/api` proxy |
| Gateway | `http://127.0.0.1:8080` | Local API diagnostics and smoke testing |
| PostgreSQL | `127.0.0.1:5432` | Loopback-only publication for source development |

The Rust API itself is not published to the host. The worker and migrator use
the private Compose network.

### Verify

From the repository root:

```bash
./scripts/smoke-test.sh http://127.0.0.1:8080
cd docker && docker compose logs --tail=100 api gateway web worker
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
cd docker && docker compose up postgres
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

## Container distribution

Every application and foundation is published under one architecture-neutral
release tag. The public GitHub Container Registry packages are the default for
open-source deployments:

| Image | Public default |
| --- | --- |
| `veyora-<component>:v1.0.0` | `ghcr.io/passion-flow` |

The component set is `postgres`, `nginx`, `envoy`, `rust`, `debian`, `api`,
`worker`, `migrator`, `backup`, `restore`, `sandbox`, `web`, and `gateway`.

To pull from another registry (a private mirror, for example), log in according
to your registry access policy and set these values in `docker/.env`:

```dotenv
REGISTRY=your-registry.example.com
NAMESPACE=your-namespace
VERSION=v1.0.0
```

Do not store registry passwords or tokens in `docker/.env`, Compose files,
shell history, or the repository.

## Build and publish images

The publishing script is registry-neutral and builds Veyora images for
`linux/amd64` and `linux/arm64`. Its defaults target the official GitHub
Container Registry namespace and the `v1.0.0` release tag. Authenticate
through a secure credential flow before running it:

```bash
docker login ghcr.io

./scripts/build-and-push.sh
```

Publish to a different registry by overriding the variables:

```bash
REGISTRY=your-registry.example.com NAMESPACE=your-namespace \
  ./scripts/build-and-push.sh
```

The script first mirrors the pinned PostgreSQL, nginx, Envoy, Rust, and Debian
foundations as `veyora-postgres`, `veyora-nginx`, `veyora-envoy`,
`veyora-rust`, and `veyora-debian`. It then publishes `veyora-api`,
`veyora-worker`, `veyora-migrator`, `veyora-backup`, `veyora-restore`,
`veyora-sandbox`, `veyora-web`, and `veyora-gateway` from those foundations.
All 13 repositories receive one architecture-neutral `v1.0.0` tag backed by a
two-platform OCI image index. The script inspects every published index and
fails unless both target platforms are present. Confirm image digests,
vulnerability scans, and registry access policy before production use.

## Publish the public GHCR images

The manual **Publish container images** GitHub Actions workflow accepts a
`vMAJOR.MINOR.PATCH` version. It uses the repository-scoped `GITHUB_TOKEN`,
links the packages to this public repository, publishes the same 13
multi-platform images, and verifies both platforms in every resulting OCI index
without registry credentials. No long-lived registry token is stored in the
repository.

For contributor builds that must use the current source tree instead of the
published images:

```bash
cd docker
docker compose build
docker compose up -d
```

## Production-shaped configuration

The single Compose file carries both the local preview and the
production-shaped settings. Provide explicit values and validate:

```bash
cd docker
VEYORA_DB_PASSWORD='replace-me' \
VEYORA_API_AUTH=token \
VEYORA_API_TOKEN='replace-me' \
docker compose config --quiet
```

The topology still binds the plain-HTTP host ports to `127.0.0.1`. Put a
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
