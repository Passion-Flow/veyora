# Threat model

This threat model describes the Veyora public preview. It records intended
boundaries and known limitations; it is not an audit, certification, or claim
that every mitigation is complete.

## Security objectives

Veyora aims to:

1. keep plaintext vault fields, master-password material, root keys, and record
   keys inside authorized clients;
2. detect modification of authenticated encrypted records;
3. prevent stale writes through server-authoritative compare-and-set revisions;
4. keep backups and synchronization artifacts opaque to infrastructure; and
5. fail explicitly when required configuration or protocol input is invalid.

Availability, anonymity, endpoint integrity, and protection from a fully
compromised client are not guaranteed.

## Assets

- master passwords and password-derived material;
- vault root, record, device, manifest, and recovery keys;
- plaintext credential fields and local search indexes;
- recovery kits and encrypted backup material;
- authorization credentials and active sessions;
- ciphertext integrity, record revisions, and deletion state; and
- sensitive metadata such as access timing, record counts, and relationships.

## Trust boundaries

### Trusted client boundary

The browser, loaded web application, WebAssembly kernel, operating system,
memory, clipboard, display, and input devices can observe plaintext. A
compromise anywhere in this boundary may expose the unlocked vault.

### Untrusted service boundary

Envoy, the Rust API, worker, PostgreSQL, backup storage, and operational systems
are expected to handle opaque records and limited metadata. They are not
entrusted with plaintext vault fields or client root keys.

### Build and delivery boundary

Source dependencies, compiler toolchains, container bases, CI, registries, TLS
ingress, and static asset delivery can alter executable code. A malicious build
can capture plaintext even when the server protocol is otherwise ciphertext
only.

## Adversaries

The design considers:

- a curious or compromised database operator;
- a malicious API or synchronization service;
- an attacker with a stolen encrypted database or backup;
- a network attacker outside correctly configured TLS;
- a remote caller attempting malformed, oversized, replayed, or conflicting
  requests;
- a compromised dependency, image, registry, or delivery path; and
- an attacker with access to a lost device or copied recovery material.

## Threats and controls

| Threat | Current control | Residual risk |
| --- | --- | --- |
| Database or backup disclosure | Client-side authenticated encryption; opaque logical snapshots | Metadata, ciphertext volume, timing, and offline password guessing remain |
| Record modification | XChaCha20-Poly1305 authentication and protocol-bound associated data | A malicious client or altered build can produce valid malicious content |
| Stale or conflicting writes | Compare-and-set revisions and explicit conflict responses | Availability attacks and malicious omission remain possible |
| Weak master password | Argon2id derivation with explicit parameters | Human-chosen passwords may still have insufficient entropy |
| Nonce or randomness failure | OS-backed randomness in the client kernel | A compromised runtime or platform RNG defeats this assumption |
| Malformed or oversized input | Strict schemas, bounded decoding, request-body limits, and fail-fast configuration | Parser and implementation defects remain possible |
| Server learns plaintext | Client-side encryption boundary and ciphertext-only backend types | Browser compromise, debug tooling, or accidental logging can violate the boundary |
| Network interception | Production is expected to use owner-controlled TLS ingress | The repository does not configure or validate public TLS automatically |
| Unauthorized API access | Optional bearer mode and external ingress controls | The bundled browser does not attach the bearer token; authentication integration needs review |
| Supply-chain modification | Lockfiles, pinned toolchains, CI, and deterministic vectors | No complete reproducible-build or signed-release guarantee exists |
| Recovery-material theft | Recovery artifacts are designed to be encrypted and integrity checked | Copied material cannot be recalled and may enable offline attacks |
| Lost or corrupted data | Opaque backup/restore services and revisioned records | Recovery procedures have not been independently validated for production |

## Malicious server model

A malicious service can deny access, omit records, replay an older consistent
view, reorder responses, observe traffic metadata, or return conflicting state.
Authenticated encryption can protect record contents from undetected mutation,
but it cannot force availability or freshness by itself. Clients need trusted
checkpoints and explicit conflict handling for stronger rollback detection.

## Client compromise

An unlocked client necessarily handles plaintext and keys. Veyora cannot defend
against a browser extension, injected script, operating-system compromise,
screen capture, keylogger, malicious accessibility tool, process inspection, or
modified WebAssembly module with equivalent client privileges. Deployment must
therefore protect the asset-delivery path and the endpoint itself.

## Recovery and rotation

Recovery is a high-authority operation. A safe process must authenticate the
intended account state, use fresh key material, avoid silently overwriting an
active destination, and preserve enough evidence to detect rollback or partial
rotation. Losing both the required recovery material and every authorized
device can make the vault unrecoverable by design; the server must not be able
to bypass client cryptography.

## Deployment requirements

- Bind preview services to localhost only.
- Terminate public TLS at reviewed owner-controlled ingress.
- Keep PostgreSQL and internal services off public networks.
- Store database, API, backup, and signing secrets outside Git and image layers.
- Review proxy headers, authentication, origin policy, CSP, CORS, and caching.
- Restrict logs, traces, metrics, crash dumps, and support bundles.
- Pin and verify exact container images before deployment.
- Test restore into a fresh destination using inert data.

## Out of scope for the preview

- protection from a compromised client or build;
- guaranteed anonymity or traffic-analysis resistance;
- multi-user sharing and collaborative authorization;
- browser extension or autofill security;
- hardware-backed key guarantees;
- a completed independent cryptographic audit; and
- a supported production incident-response or recovery service.

Report potential vulnerabilities through the private process in
[SECURITY.md](../../SECURITY.md).

## Feature-specific analysis (2026-08 update)

### TOTP (RFC 6238)

TOTP secrets are stored inside the encrypted entry JSON (`totpSecret`
field, Base32). The server never sees them. Code generation uses
WebCrypto HMAC-SHA-1 entirely in the browser; no network request is
involved. The countdown display is purely visual; no timing information
leaks to the server.

### Trash / tombstone restore

Tombstoned records retain their ciphertext on the server. Restoring
re-PUTs the same ciphertext with `tombstone: false`. An attacker with
server access could enumerate tombstoned record IDs, but without the
key the ciphertext is indistinguishable from active records.

### Password health analysis (reuse + age)

Computed entirely client-side over decrypted entries. Results render as
UI badges; no data leaves the browser.

### CSV import/export

Import: parsing and encryption happen in the browser; the server
receives only sealed ciphertext via the batch endpoint. Export:
decryption happens in the browser; the CSV file is generated client-side
and downloaded directly. No server involvement.

### Master password rotation

Re-encryption happens in the browser: derive a new root key from the
new password over a fresh salt, re-seal every record, CAS-update on the
server. Mid-flight failure triggers best-effort rollback (re-seal under
the old key). Documented limitation: a rollback failure may leave some
records encrypted under the new key while the salt stays old — the user
would need the new password to access those specific records.

### Password verifier record

A reserved record (`veyora-verifier-v1`) with known plaintext ensures
even an empty vault rejects wrong passwords, preventing "unlock with
anything" on a fresh installation. The verifier is opaque to the server
(it is sealed like any other record).
