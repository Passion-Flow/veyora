# Veyora desktop app

Audience: desktop users and shell developers.
Owner: desktop maintainers.

The desktop app is an experimental local-Vault implementation for Windows and
macOS, packaged with Tauri 2. The vault UI and the
WebAssembly security kernel execute in the system WebView (WebView2 on
Windows, WKWebView on macOS), while the full encrypted-records API and its
SQLite storage run in-process behind a loopback port. No server deployment,
account, or network connection is required after a source build.

> [!CAUTION]
> Use inert test data only. There is no supported Stable installer. Recovery,
> portable encrypted backup, signing/notarization, updates, uninstall, and the
> four-native release matrix are incomplete.

The local database holds only opaque ciphertext. Records are encrypted
end-to-end inside the app by the Rust security kernel and stay locked
without your master password.

## Installers

| Platform | Artifact | Produced by |
| --- | --- | --- |
| Windows | `Veyora_<version>_x64-setup.exe` (NSIS) | `make desktop-build` on Windows |
| macOS | `Veyora.app`, `Veyora_<version>_universal.dmg` | `make desktop-build` on macOS |

These are unsigned developer artifacts, not verified downloads. The release
workflow is constrained to the product version and preview channel in
`release/version.json`, but the resulting bundles do not satisfy the Stable
installation requirements.

## Storage location

The first thing the app asks on first launch is **where to store the
vault**. The chosen folder holds:

```text
<your folder>/vault.db          the encrypted vault (ciphertext only)
<your folder>/backups/          rolling startup snapshots (vault-<ms>.db)
```

- Pick any folder you control — including external or network drives.
- The first-run screen offers the four Welcome routes: `Create a new vault`
  (refuses a folder that already contains a `vault.db` — use Open instead),
  `Open an existing vault` (requires one, so copying the folder to another
  computer carries the vault with it), `Import from another password
  manager` (creates a vault, then the next screen offers the import), and
  `Advanced: connect to a self-hosted server` (opens the service address in
  the browser; desktop connected pairing is not part of this preview).
- The first-run screen is a modal dialog for assistive technology
  (`role="dialog"`, named by its heading), its waiting/error line is a live
  status region, focus starts on the first route action, the connect address
  opens on Enter, and keyboard focus is visibly outlined.
- The OS app-data directory keeps only a small `settings.json` pointer to
  your chosen folder plus backup preferences.

### Vault menu

| Action | What it does |
| --- | --- |
| Change Storage Location… | Moves `vault.db` and the backup history to a newly picked folder (the old folder is kept until you delete it), then restarts the app |
| Storage Info… | Shows the current location, record count, database size, and backup count |
| Open Storage Folder | Reveals the vault folder in Finder / Explorer |
| Export Backup… | Despite the preview label, writes an experimental opaque JSON snapshot; this is not a portable encrypted backup |
| Import Backup… | Loads an experimental opaque JSON snapshot; conflict and clean-restore guarantees are incomplete |

### Startup snapshots

By default every launch first copies the (checkpointed) database into
`backups/`, keeping the last 10 snapshots. These preferences live in
`settings.json` next to the app data directory.

## Build from source

Prerequisites:

- Rust (the pinned toolchain from `src-tauri/rust-toolchain.toml`)
- Node.js 22 or newer
- Windows: WebView2 runtime (preinstalled on Windows 10/11)
- macOS: Xcode command-line tools

```bash
make desktop-dev     # run the standalone app from source
make desktop-build   # produce unsigned preview bundles under the Tauri target directory
```

The embedded SQLite store compiles from source (rusqlite "bundled"); no
system SQLite is required.

## Moving data between modes

Cross-mode migration is not a supported capability. The desktop and backend
can move opaque record snapshots, but the current format omits the complete
Vault identity, key-wrapper, compatibility, integrity, and result semantics
required for a portable encrypted backup. Do not treat a successful JSON
round trip as recovery evidence.

## Security notes

- The embedded API binds `127.0.0.1` on a random free port and only ever
  sees ciphertext; authentication to the vault is the master password
  itself (Argon2id inside the WebView), not the local API.
- If the WASM kernel fails to load, the desktop app refuses to start the
  vault instead of silently falling back to a non-cryptographic demo mode.
- The app is a single-user local trust boundary. Other same-user processes can
  reach the loopback API and can observe or modify opaque record envelopes;
  the endpoint and WebView remain inside the trusted boundary.

## Unsigned preview bundles

The current macOS and Windows bundles are not signed, notarized, or verified
as trusted consumer installations. Veyora does not recommend bypassing
Gatekeeper, SmartScreen, or Smart App Control. Build and run from source with
inert data in a development environment, or wait for a signed prerelease that
publishes the required evidence.
