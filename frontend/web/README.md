# Veyora web client

The monochrome web client for Veyora. Framework-free ES modules served as
static files; all cryptography runs in the browser through the Rust/WASM
security kernel, and the records API only ever sees opaque ciphertext.

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

The kernel artifacts (`src/wasm/`) are generated from `security-kernel`:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.127

cd security-kernel
cargo build --locked --target wasm32-unknown-unknown --lib -p kernel-wasm --release
wasm-bindgen --target web \
  --out-dir ../frontend/web/src/wasm \
  --out-name veyora_kernel \
  target/wasm32-unknown-unknown/release/kernel_wasm.wasm
```

`src/core/kernel.js` wraps the generated module-level exports
(`derivePasswordKey`, `sealRecord`, `openRecord`, `generateRecoveryKit`, …).
If the module fails to load, a `DemoKernel` fallback keeps the UI usable
with a pass-through record transform; the active mode is in
`state.kernelMode`.

## Architecture

```
src/
  config.js          every tunable (no magic values in views)
  styles/tokens.css  design tokens — the only place visual values live
  i18n/              catalog loader, fallback chains, ICU plural subset
  core/
    kernel.js        WasmKernel / DemoKernel adapters (same interface)
    records.js       seal → PUT / fetch → open sync over the records API
    vault.js         device metadata (salt, vault id, recovery kit)
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
node --test "test/*.test.mjs"       # unit tests: i18n plurals/fallbacks,
                                    # strength tiers, schema, hex codec,
                                    # real WASM kernel seal/open + tamper,
                                    # sync-layer error mapping (stubbed fetch)
```

The kernel tests execute the checked-in WASM bindings directly, so a broken
crypto build fails in seconds instead of in a browser. The browser smoke
(`scripts/test-browser.mjs`, wired into CI) covers the live flow end to end:
create vault → recovery kit → seal & store → reload → wrong password
rejected → decrypt → reveal → delete → lock.

End-to-end (browser, real kernel + real API): create vault → recovery kit →
create entry (sealed, stored as ciphertext) → reload → wrong password must
fail decryption → correct password restores the entry.
