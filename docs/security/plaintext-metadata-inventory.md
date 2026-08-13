# Plaintext and metadata inventory

This inventory makes Veyora's intended data boundary explicit. It describes the
public preview and should be checked against the exact build and deployment
before use.

## Data handling

| Data class | Client memory | API / worker | PostgreSQL | Logs / metrics | Backup |
| --- | --- | --- | --- | --- | --- |
| Master password | Temporarily required for unlock | Forbidden | Forbidden | Forbidden | Forbidden |
| Root and derived keys | Required while unlocked | Forbidden | Forbidden | Forbidden | Forbidden |
| Plaintext vault fields | Required for local display and editing | Forbidden | Forbidden | Forbidden | Forbidden |
| Local search index | Client-only | Forbidden | Forbidden | Forbidden | Forbidden |
| Recovery secrets | Client-only during recovery operations | Forbidden | Forbidden | Forbidden | Encrypted or separately protected only |
| Ciphertext envelope | Present | Allowed | Allowed | Content forbidden | Allowed |
| Record identifier | Present | Allowed | Allowed | Avoid or bound | Allowed |
| Revision and tombstone state | Present | Allowed | Allowed | Aggregate only | Allowed |
| Request timing and status | Observable | Observable | Limited | Allowed with retention limits | Not required |
| Record counts | Observable | Observable | Observable | Aggregate only | Observable |
| Database credentials | Not required by browser | Required by bounded services | Authenticates access | Values forbidden | Forbidden |
| API bearer token | Optional API clients | Compared by API | Forbidden | Value forbidden | Forbidden |

## Client-local exposure

While the vault is unlocked, plaintext and keys may exist in browser and
WebAssembly memory. Clipboard use, rendering, browser developer tools, crash
reports, extensions, accessibility APIs, operating-system swap, and screen
capture can expand that exposure. Automatic locking and memory clearing reduce
some risk but do not guarantee erasure across the full platform.

## Infrastructure metadata

Ciphertext-only services can still infer or expose meaningful metadata:

- when and how often the vault is used;
- approximate record and ciphertext sizes;
- record identifiers, revisions, tombstones, and update patterns;
- source network information at ingress;
- health, readiness, error class, and service timing; and
- backup size, frequency, and retention.

Operators should minimize collection, avoid high-cardinality identifiers in
telemetry, define retention, restrict access, and verify that support or debug
flows do not capture request bodies.

## Logging rules

Never log:

- passwords, tokens, keys, recovery material, or secret-file contents;
- plaintext or decrypted template fields;
- ciphertext bodies or full request bodies;
- authorization headers or database URLs containing credentials; or
- user-entered labels, notes, usernames, hostnames, or relationship data.

Prefer bounded error codes, aggregate counters, redacted configuration names,
and request IDs that do not encode vault meaning.

## Backup implications

An opaque backup is still security-sensitive. It can reveal metadata, enable
offline analysis, be deleted or rolled back, and become undecryptable if key
material is lost. Encrypt backup transport and storage, separate recovery
material, restrict access, define retention, and regularly test restore into a
fresh destination with inert data.
