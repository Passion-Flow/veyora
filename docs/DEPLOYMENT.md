# Deployment guide

Audience: operators self-hosting the preview stack.
Owner: release-engineering.

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
cp deploy/compose/.env.example deploy/compose/.env
```

Set `VEYORA_DB_PASSWORD` in `deploy/compose/.env` to a unique development-only value.
The checked-in example intentionally leaves it blank so Compose fails closed
until you choose one.

### Start

```bash
cd deploy/compose
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
./tests/smoke/api.sh http://127.0.0.1:8080
cd deploy/compose && docker compose logs --tail=100 api gateway web worker
```

The smoke test writes and tombstones an explicitly inert ciphertext fixture.
It must never be modified to use real credentials.

### Stop

```bash
docker compose down
```

This keeps the PostgreSQL volume. To deliberately remove the local database,
run `make purge-data CONFIRM=destroy-veyora-data` (or `docker compose down
--volumes`): this deletes the named `veyora-pg` volume — every encrypted
record stored by the deployment. The `./backups` bind-mounted directory and
anything outside Compose are not touched; there is no undelete.

## Source development

Start only PostgreSQL:

```bash
cd deploy/compose && docker compose up postgres
```

Then run the API in another terminal:

```bash
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

The Compose file references one architecture-neutral preview tag for each
application and foundation image. Those references are source-development
defaults, not proof that every registry asset exists or passed release gates:

| Image | Public default |
| --- | --- |
| `veyora-<component>:v1.0.0` | `ghcr.io/passion-flow` |

The component set is `postgres`, `nginx`, `envoy`, `rust`, `debian`, `api`,
`worker`, `migrator`, `backup`, `restore`, `validator`, `web`, and `gateway`.

To pull from another registry (a private mirror, for example), log in according
to your registry access policy and set these values in `deploy/compose/.env`:

```dotenv
REGISTRY=your-registry.example.com
NAMESPACE=your-namespace
VERSION=v1.0.0
```

Do not store registry passwords or tokens in `deploy/compose/.env`, Compose files,
shell history, or the repository.

## Build and publish images

The publishing script is intended to build Veyora images for `linux/amd64` and
`linux/arm64`. Its defaults target the project GitHub Container Registry
namespace and the `v1.0.0` preview tag. Authenticate through a secure
credential flow before running it:

```bash
docker login ghcr.io

./tools/release/publish-containers.sh
```

Publish to a different registry by overriding the variables:

```bash
REGISTRY=your-registry.example.com NAMESPACE=your-namespace \
  ./tools/release/publish-containers.sh
```

The script first mirrors the pinned PostgreSQL, nginx, Envoy, Rust, and Debian
foundations as `veyora-postgres`, `veyora-nginx`, `veyora-envoy`,
`veyora-rust`, and `veyora-debian`. It then publishes `veyora-api`,
`veyora-worker`, `veyora-migrator`, `veyora-backup`, `veyora-restore`,
`veyora-validator`, `veyora-web`, and `veyora-gateway` from those foundations.
All 13 repositories receive one architecture-neutral `v1.0.0` tag backed by a
two-platform OCI image index. The script inspects every published index and
fails unless both target platforms are present. Confirm image digests,
vulnerability scans, and registry access policy before production use.

## Publish the public GHCR images

The manual **Publish container images** workflow accepts only the exact tag in
`release/version.json`. Its source is designed to use the repository-scoped
`GITHUB_TOKEN`, link packages to this repository, publish the same 13
multi-platform images, and inspect both target platforms. A successful remote
run and recorded digests remain required evidence; workflow source alone is
not publication proof.

For contributor builds that must use the current source tree instead of the
published images:

```bash
cd deploy/compose
docker compose build
docker compose up -d
```

## Production-shaped configuration

The single Compose file carries both the local preview and the
production-shaped settings. Provide explicit values and validate:

```bash
cd deploy/compose
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
