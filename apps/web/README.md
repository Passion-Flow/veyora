# Veyora web client

The monochrome web client for Veyora. Framework-free ES modules served as
static files; all cryptography runs in the browser through the Rust/WASM
security kernel. Boot stops with a blocking error if that kernel is missing,
invalid, or fails its startup self-test.

This client is an experimental connected-mode preview. Use inert test data
only. The current service authentication, recovery flow, and production HTTPS
topology do not meet the stable requirements in the product PRD.

## Run locally

```bash
# 1. API (in-memory store) on :8080
make run

# 2. Web client on :3000 (writes veyora-config.js pointing at the API)
make run-web
```

The client resolves the API origin in this order: a stored
`veyora-api-url` override, the injected `window.VEYORA_API_BASE_URL`
(rendered by `veyora-config.js`), then a localhost heuristic.

## Build the WASM kernel

The kernel artifacts (`src/wasm/`) have exactly one generation command and
one destination (`apps/web/src/wasm/`), recorded in
`tools/codegen/manifest.json`:

```bash
make build-wasm
```

It requires the pinned Rust toolchain, the `wasm32-unknown-unknown` target,
and `wasm-bindgen-cli` 0.2.127. The tracked bytes are digest-pinned in
`release/kernel-assets.json`; `make check-codegen` and the repository check
reject drift.

`src/core/kernel.js` wraps the generated module-level exports
(`derivePasswordKey`, `sealRecord`, `openRecord`, `generateRecoveryKit`, …).
It validates the required export surface and runs an authenticated
seal/open/tamper self-test before exposing the adapter to Vault code. The
generated JavaScript binding and WASM bytes must also match the reviewed
SHA-256 identities in `release/kernel-assets.json`. There is no JavaScript
cryptography fallback in distributable source.

## Architecture

```
src/
  config.js          every tunable (no magic values in views)
  styles/tokens.css  design tokens — the only place visual values live
  i18n/              catalog loader, fallback chains, ICU plural subset
  core/
    kernel.js        fail-closed Rust/WASM kernel adapter and startup self-test
    records.js       seal → PUT / fetch → open sync over the records API
    vault.js         device metadata (salt, vault id, protocol-only recovery material)
    state.js         UI state
  data/schema.js     item templates — drives the modal and detail views
  views/             entry-flow (login), dashboard, drawer, modals
locales/             message catalogs (contract: contracts/i18n/catalog-v1)
tools/
  check-locales.mjs  catalog integrity checker (CI-able)
  dev-server.py      no-store static server for development
```

## Internationalization

- Catalogs follow `contracts/i18n/catalog-v1` (messages keyed by dot paths,
  `text` or ICU `plural` forms).
- Lookup chain: exact locale → primary language → `en`.
- Locale-aware dates and numbers via `Intl`; RTL is driven by the catalog's
  `direction` field (Arabic ships RTL).
- Add a language by dropping `locales/<tag>.json` and registering the tag in
  `src/i18n/registry.js`. `node tools/check-locales.mjs` validates key
  parity, placeholders, and plural branches.

## Testing

```bash
node tools/check-locales.mjs        # catalog integrity (10 locales shipped)
node --test "test/*.test.mjs"       # real WASM, fail-closed loading,
                                    # known-plaintext network canary,
                                    # i18n, schema, and sync boundaries
```

The kernel tests require the checked-in WASM bindings and cover missing,
corrupt, incomplete, policy-blocked, and plaintext-exposing candidates. No
missing-kernel case is skipped. The browser smoke (`tests/e2e/web/test-browser.mjs`,
wired into CI) covers the current preview flow with inert data.

Recovery-looking material in the current UI is encoding evidence only; it does
not yet unwrap the existing Vault Key in a clean environment and must not be
relied upon as a working Recovery Key.
