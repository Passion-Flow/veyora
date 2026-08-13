# Veyora security kernel

The security kernel is the portable Rust implementation of Veyora's encrypted
domain. It owns cryptographic operations, canonical encoding, identifiers,
session policy, recovery primitives, deterministic vectors, WebAssembly
bindings, and native FFI surfaces.

## Crates

| Crate | Purpose |
| --- | --- |
| `kernel-core` | Protocol types, cryptography, encoding, manifests, sessions, recovery, and password generation |
| `kernel-wasm` | Browser-facing WebAssembly bindings |
| `kernel-ffi` | Narrow native and Android JNI bindings |

## Test

```bash
cargo test --locked --workspace --all-targets
```

The repository includes known-answer vectors and independent oracle programs
under `vectors/` and `oracles/`. Vector material is inert protocol evidence, not
live key material. Some oracle programs intentionally bind exact external
binary versions and paths and are therefore evidence-generation tools rather
than portable default tests.

## Build WebAssembly

Install the pinned Rust toolchain, the `wasm32-unknown-unknown` target, and a
compatible `wasm-bindgen-cli`, then run from the repository root:

```bash
make build-wasm
```

The checked-in browser artifacts live in `deployment/web/wasm/`.

## Security status

Passing source and vector tests is not an independent cryptographic audit and
does not establish production safety. Changes to algorithms, parameters,
encoding, associated data, domain separation, key lifecycle, recovery, or FFI
boundaries require focused review and compatibility analysis.
