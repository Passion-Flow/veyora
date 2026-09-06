# Veyora API Reference

Base URL: `http://127.0.0.1:8080` (or `VEYORA_API_BIND`)

## Health & Readiness

### `GET /healthz`
Liveness probe. Always returns `200 OK`.

### `GET /readyz`
Readiness probe. Checks database connectivity.
```json
{"ready": true, "record_count": 3}
```

### `GET /metrics`
Prometheus-format counters.
```
veyora_requests_total 42
veyora_puts_total 10
veyora_gets_total 30
veyora_deletes_total 2
veyora_uptime_seconds 3600
```

## Records

Every records read, listing, deletion, and purge takes a required `vault`
query parameter (`?vault=<vault_id>`) naming the vault scope: the server
returns and mutates only that vault's rows, and identical record IDs in
different vaults never collide (DATA-001/DATA-002). Writes (`PUT`,
`POST /records/batch`) carry the vault in the record envelope instead; a
request without a declared scope fails with `PM-API-BAD-QUERY`. Until
authenticated pairing principals ship (ADR 0005, Proposed), the scope is
client-declared — but it is enforced on every query rather than returning
global rows.

### `GET /records`
List record summaries for the declared vault (opaque metadata only, no
ciphertext).
```json
[
  {"record_id": "github", "revision": 1, "tombstone": false, "ciphertext_hash": "abc..."}
]
```

### `GET /records?embed=bodies`
Single-round-trip hydration: returns full record DTOs (including ciphertext)
instead of summaries, so a client can unlock a whole vault with one request
instead of one GET per record. The response shape matches `GET /records/{id}`.

### `GET /records/{id}`
Retrieve one opaque encrypted record (full ciphertext).
```json
{
  "protocol_version": 1, "suite_id": 1,
  "deployment_id": "0f", "vault_id": "1f",
  "record_id": "github", "revision": 1,
  "ciphertext": "aabbcc...", "ciphertext_hash": "def...",
  "ciphertext_length": 48, "tombstone": false,
  "template_envelope_hash": "000...", "manifest_binding": "000..."
}
```

### `PUT /records/{id}`
Create or update an opaque encrypted record. Server assigns the revision via CAS.
- No `expected_prior_revision` → create (must not exist).
- With `expected_prior_revision: N` → CAS update (record must be at revision N).
- Returns `201 Created` with `{"revision": N}` on success.
- Returns `409 Conflict` if the CAS precondition fails.
- Returns `400 Bad Request` if the path ID differs from the body.

### `POST /records/batch`
Atomic import (DATA-007): every record in the body commits in one
database transaction; a single invalid or conflicting row rolls the
whole batch back. All records must declare the same vault scope (the
envelope's `vault_id`). The response reports exact counts (API-010):
`requested` is the input row count, `committed` is what the
transaction applied — for an all-or-nothing batch that is every row
or none (failures return the error envelope with nothing applied).
```json
// Request: array of record DTOs
[{"record_id": "a", ...}, {"record_id": "b", ...}]

// Response: per-record results
[
  {"record_id": "a", "ok": true, "revision": 1, "error": null},
  {"record_id": "b", "ok": false, "revision": null, "error": "PM-STORE-CONFLICT"}
]
```

### `DELETE /records/{id}`
Tombstone a record (soft delete). Requires the expected prior revision for CAS.
```json
{"expected_prior_revision": 1}
```
Returns `200 OK` with `{"revision": 2}` on success.

## Error Codes

Error responses share one JSON envelope. The ASCII `code` is the stable
contract; `message` is a fixed English debugging aid and is never localized
(LANG-003). Clients render localized prose from their own locale catalogs
keyed by the code; the web client ships `apiError.*` keys in
`apps/web/locales/`.

```json
{"error": {"code": "PM-STORE-CONFLICT", "message": "Revision conflict: the record changed elsewhere."}}
```

| HTTP | Body code | Meaning |
|------|-----------|---------|
| 400 | `PM-STORE-INVALID-RECORD` | Malformed record |
| 400 | `PM-API-ROUTE-MISMATCH` | Path/body record_id differ |
| 400 | `PM-API-BAD-BODY` | Request body could not be parsed |
| 400 | `PM-API-BAD-QUERY` | Query string could not be parsed |
| 401 | `PM-API-UNAUTHORIZED` | Missing/invalid bearer token (auth mode `token`) |
| 404 | `PM-STORE-NOT-FOUND` | Record doesn't exist |
| 409 | `PM-STORE-CONFLICT` | CAS revision mismatch |
| 413 | `PM-API-BODY-TOO-LARGE` | Body exceeds `VEYORA_API_MAX_BODY_BYTES` |
| 429 | `PM-API-RATE-LIMITED` | Too many requests; retry after the `Retry-After` window |
| 503 | `PM-STORE-UNAVAILABLE` | Database unreachable |

The catalog is closed: this table and the code catalog in
`services/api/src/error_catalog.rs` are kept in sync by a blocking test
(`documentation_and_catalog_are_in_sync`), and every `PM-*` literal used in
the API sources must appear in the catalog
(`every_source_code_literal_is_cataloged`). Malformed request bodies and
query strings are rejected through the same JSON envelope, never through
the framework's default plain-text error.

## CORS
All responses include `Access-Control-Allow-Origin: *`.
OPTIONS preflight returns `204 No Content`.

## Security
- The API **never** handles plaintext, master-password material, or keys.
- All record bodies are opaque ciphertext, encrypted client-side.
- Production uses Envoy Gateway for strict origin/CSP enforcement.
