# Veyora backend

The backend workspace contains the ciphertext API, storage adapters, database
migrations, and bounded operational services. It is designed to store and move
opaque protocol records without receiving plaintext vault fields or client key
material.

## Workspace layout

| Path | Responsibility |
| --- | --- |
| `services/api/` | Axum HTTP API, authentication, request limits, health, readiness, metrics, and graceful shutdown |
| `services/worker/` | PostgreSQL maintenance polling and tombstone monitoring |
| `services/migrator/` | Ordered and idempotent SQL migration runner |
| `services/backup/` | Opaque logical snapshot export |
| `services/restore/` | Opaque snapshot import into a destination database |
| `services/sandbox/` | Bounded record-format validation without network or database access |
| `crates/persistence/` | Storage interface and in-memory implementation |
| `crates/postgres/` | PostgreSQL implementation and migrations |
| `crates/config/` | Explicit configuration model and generated registry projection |
| `crates/contracts-generated/` | Checked-in Rust representations of shared contracts |

## Test

```bash
cargo test --locked --workspace --all-targets
cargo check --locked --workspace --all-targets
```

## Run the API with in-memory storage

```bash
VEYORA_STORE=in-memory \
VEYORA_API_BIND=127.0.0.1:8080 \
VEYORA_API_AUTH=disabled \
VEYORA_API_MAX_BODY_BYTES=262144 \
cargo run --locked -p api
```

This mode is for local evaluation only. PostgreSQL development and the complete
container topology are documented in [the deployment guide](../docs/DEPLOYMENT.md).

## Configuration

The API fails when a required setting is absent or malformed. `VEYORA_STORE`
selects `postgres` or development-only `in-memory` storage. PostgreSQL mode also
requires `DATABASE_URL`. API binding, authentication mode, and the request-body
limit are always explicit; token mode additionally requires a non-empty
`VEYORA_API_TOKEN`.

See [docker/.env.example](../docker/.env.example) for the Compose-facing values.

## Security boundary

Backend code must not accept plaintext credential fields, master-password
material, root keys, recovery secrets, or decrypted search indexes. Record
payloads remain opaque, errors avoid echoing sensitive values, and operational
metrics must not include record content or high-cardinality identifiers.
