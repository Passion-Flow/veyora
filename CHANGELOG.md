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
