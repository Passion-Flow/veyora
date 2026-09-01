# Changelog

Notable changes to Veyora are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioned releases
will follow [Semantic Versioning](https://semver.org/) once a stable release
process is established.

## [Unreleased]

## [0.0.1] - 2026-09-01

First tagged desktop release: the desktop app becomes a complete
standalone vault (embedded records API + local SQLite storage) for
Windows and macOS.

### Added

- Desktop app (`frontend/desktop`): a Tauri 2 **standalone** vault for
  Windows (NSIS `.exe`/MSI) and macOS (DMG) — the encrypted-records API
  and a SQLite store (`backend/crates/sqlite`) run in-process behind a
  loopback port, so the app works with no server deployment. First-run
  screen makes choosing the storage location the first action; Vault
  menu exposes change-location (with migration), storage info, open
  folder, and JSON export/import compatible with the server
  `backup`/`restore` tools; rolling startup snapshots in the chosen
  folder. Release workflow builds both platforms on `v*` tags
- Optional bearer-token support in the web client (`veyora-api-token`
  localStorage override) so browser and desktop clients work against
  token-auth deployments
- English-only source guard: the repository checker rejects Han, Kana,
  and Hangul text outside the i18n allowlist (locale catalogs, i18n
  docs, the localized error catalog, its assertions, README badges)
- `desktop-dev`, `desktop-build`, and `desktop-check` Makefile targets;
  desktop client guide (`docs/DESKTOP.md`)

### Changed

- API CORS allow-methods now includes `POST`, so browser-side clients on
  other origins (the desktop WebView) can reach `POST /records/batch`;
  request IDs are generated from a per-process counter instead of reading
  `/dev/urandom`, which silently failed on Windows
- Backend architecture test recognizes `backend-sqlite` (store-adapter
  crate location, migrations directory, dependency edge)
- Single Docker deployment entry: the four root Compose files and the
  `deployment/` directory are consolidated into `docker/` with one
  canonical `docker-compose.yaml` (image pulls by default, inline
  source builds, `backup` profile, TLS, loopback database port),
  an annotated `.env.example`, and a deployment README
- Governance documents moved under `docs/` (brand guidelines, code of
  conduct, copyright and trademark policies); the unreferenced
  `TRADEMARKS.md` alias is removed
- `scripts/build-and-push.sh` defaults to the public GHCR namespace;
  the browser-test dependency (playwright-core) moved from the root
  `package.json` to `scripts/`
- Repository checker iterates tracked files only, so local `target/`
  and `node_modules/` trees no longer trip it

### Fixed

- `publish-images.yml` built the web image with the wrong context
  (`deployment/web` instead of the repository root)
- The Compose file now passes `VEYORA_API_CORS_ORIGINS` and
  `VEYORA_API_RATE_LIMIT` through to the API service

- Row action menu: every record row has a kebab (⋯) overflow menu with
  edit and delete; delete uses the same armed two-step confirmation as the
  drawer and tombstones into the trash. Dismisses on outside press,
  Escape, scroll, and re-render; the trigger toggles and reports
  `aria-expanded`/`role="menu"` semantics. New `action.more` catalog key
  in all 10 locales; browser smoke test covers open/dismiss, prefilled
  edit, and armed delete
- Brand identity: the shield mark now drives favicons (light/dark scheme),
  the Apple touch icon, PWA `any`/`maskable` icons, and the login and
  topbar wordmarks (CSS-mask tinted, theme-adaptive); Service Worker
  cache rotated to v3
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

### Added

- PWA manifest for install-to-homescreen
- Search result highlighting (`<mark>` tags)
- Sort and tab selection persist across sessions
- Focus trap in modals and drawer (WAI-ARIA dialog pattern)
- `prefers-reduced-motion` respected for all animations
- Comprehensive E2E browser test (`scripts/test-browser-full.mjs`)
  covering TOTP, trash restore, password rotation, keyboard navigation,
  health badges, search highlighting, and language switching
- TLS deployment guide (`docs/DEPLOYMENT-TLS.md`)
- User guide (`docs/USER-GUIDE.md`)
- Operator guide (`docs/OPERATOR-GUIDE.md`)
- Threat model updated with TOTP, trash, health analysis, CSV
  interchange, and password rotation analysis
- Backup service in production Compose (daily, 7-day retention)
- `.env.example` documents `VEYORA_API_CORS_ORIGINS` and
  `VEYORA_API_RATE_LIMIT`

### Fixed

- Vault scoping on shared stores: `fetchAll`/`fetchTrash` now filter
  server listings by the device's `vault_id` before verifier lookup, so
  records left over from another vault (e.g. a reset that did not purge
  the server) can no longer fail unlock with a spurious wrong-password
  error or leak into listings
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
