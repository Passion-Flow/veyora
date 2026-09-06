# macOS ARM64 native preview build (sequence-9 local slice)

Not release evidence: the bundle is **unsigned, ad hoc linker-signed only**,
and covers one of the four native targets. It is recorded as the locally
verifiable slice of E2E-009/INST-002 — the app builds as a real native
package for the current host and its bytes are reproducible against this
manifest.

## Artifact

- `Veyora_1.0.0_aarch64.dmg` — 5.2 MiB, built by `make desktop-build`
  (Tauri v2 bundler, release profile) on the current host
  (darwin 25.6.0, arm64).
- SHA-256: `ceed78ee9ea1e857bdc8107df92e6d121f5057f3037f7050b220f0286c887617`
- `Veyora.app` — Mach-O thin arm64, `codesign` reports
  `flags=0x20002(adhoc,linker-signed)` (no identity, no notarization).

## Honest limits (why sequence 9 stays open)

- No Developer ID signature or notarization (no credentials available
  locally); INST-003's "no `xattr -cr` required" claim cannot be made for
  this bundle.
- Only the macOS ARM64 target was built; macOS Intel, Windows AMD64, and
  Windows ARM64 remain (E2E-009 requires all four).
- The updater manifest/signature corpus (UPD-001..004) is not exercised.
- The DMG is a build-directory artifact, not the immutable release asset
  INST-001 requires.

## Reproduce

```
make desktop-build
shasum -a 256 apps/desktop/src-tauri/.build/cargo/release/bundle/dmg/Veyora_1.0.0_aarch64.dmg
```

(The hash is stable only for identical toolchains and dependency sets; it
pins this build, not the artifact lineage.)
