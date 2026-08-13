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

### `GET /records`
List all record summaries (opaque metadata only, no ciphertext).
```json
[
  {"record_id": "github", "revision": 1, "tombstone": false, "ciphertext_hash": "abc..."}
]
```

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
Batch PUT multiple records. Each record is processed independently.
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
| HTTP | Body code | Meaning |
|------|-----------|---------|
| 400 | `PM-STORE-INVALID-RECORD` | Malformed record |
| 400 | `PM-API-ROUTE-MISMATCH` | Path/body record_id differ |
| 404 | `PM-STORE-NOT-FOUND` | Record doesn't exist |
| 409 | `PM-STORE-CONFLICT` | CAS revision mismatch |
| 503 | `PM-STORE-UNAVAILABLE` | Database unreachable |

## CORS
All responses include `Access-Control-Allow-Origin: *`.
OPTIONS preflight returns `204 No Content`.

## Security
- The API **never** handles plaintext, master-password material, or keys.
- All record bodies are opaque ciphertext, encrypted client-side.
- Production uses Envoy Gateway for strict origin/CSP enforcement.
