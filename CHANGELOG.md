# Changelog

Notable changes to Veyora are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioned releases
will follow [Semantic Versioning](https://semver.org/) once a stable release
process is established.

## [Unreleased]

### Added

- Initial public source preview with a clean repository history
- English-first project documentation and multilingual translation gateway
- Public repository integrity checks and simplified continuous integration
- Localhost-only default port publishing for the Compose preview
- Monochrome web client (`frontend/web`): framework-free ES modules, design
  tokens, full i18n (10 locales with RTL and ICU plurals), dashboard with
  drawer detail, error boundaries, and accessibility semantics
- Real security-kernel integration in the browser: Argon2id derivation,
  XChaCha20-Poly1305 seal/open, checksummed recovery kits, CAS record sync
- Password verifier record: even an empty vault rejects a wrong master
  password
- Generic login CSV import/export per the interchange contract, with the
  entry type riding in `tags_json` for lossless round trips
- Master-password rotation: verifies the current password, re-keys every
  record under a fresh salt, and best-effort-rolls-back on mid-flight
  server failures
- Localized JSON error envelopes negotiated from `Accept-Language`
  (Content-Language/Vary headers) across the API surface
- Content-Security-Policy on the web container, live request metrics,
  constant-time bearer-token comparison
- Web client unit tests (Node `--test`, 34 cases incl. real-WASM kernel
  and CSV contract suites) wired into CI alongside the locale checker

### Changed

- Web container packages `frontend/web`; the legacy single-file client has
  been removed and `make run-web` / `make build-wasm` target the new client

### Fixed

- Unlock distinguishes connectivity failures from wrong-password failures
- Editing or favoriting an entry refreshes its updated timestamp
- Render failures keep the last good DOM instead of a blank screen

### Changed

- Completed the explicit environment wiring required by the API, gateway, web,
  worker, and migrator containers
- Made container-registry publishing provider-neutral
- Clarified preview status, security boundaries, and noncommercial licensing

## Preview feature set

The current source tree includes:

- a portable Rust security kernel with WebAssembly and native FFI surfaces;
- Argon2id, HKDF-SHA-256, XChaCha20-Poly1305, Ed25519, canonical CBOR,
  synchronization manifests, password generation, and recovery-kit primitives;
- Rust API, worker, migrator, backup, restore, and sandbox binaries;
- PostgreSQL and in-memory persistence adapters;
- a static browser client using the checked-in WebAssembly kernel;
- Envoy, nginx, Docker, and Docker Compose deployment sources; and
- protocol schemas, inert examples, provenance records, and known-answer
  vectors.

No production-ready or independently audited release has been published.
