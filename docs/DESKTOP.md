# Veyora desktop app

The desktop app is a complete standalone vault for Windows and macOS,
packaged with Tauri 2. Everything runs inside the app: the vault UI and the
WebAssembly security kernel execute in the system WebView (WebView2 on
Windows, WKWebView on macOS), while the full encrypted-records API and its
SQLite storage run in-process behind a loopback port. No server deployment,
account, or network connection is required — install it and use it.

The local database holds only opaque ciphertext. Records are encrypted
end-to-end inside the app by the Rust security kernel and stay locked
without your master password.

## Installers

| Platform | Artifact | Produced by |
| --- | --- | --- |
| Windows | `Veyora_<version>_x64-setup.exe` (NSIS) | `make desktop-build` on Windows |
| macOS | `Veyora.app`, `Veyora_<version>_universal.dmg` | `make desktop-build` on macOS |

Release builds are also attached to GitHub Releases by the desktop
release workflow on every `v*` tag.

## Storage location

The first thing the app asks on first launch is **where to store the
vault**. The chosen folder holds:

```text
<your folder>/vault.db          the encrypted vault (ciphertext only)
<your folder>/backups/          rolling startup snapshots (vault-<ms>.db)
```

- Pick any folder you control — including external or network drives.
- Pointing the first-run picker at a folder that already contains a
  `vault.db` opens that vault, so copying the folder to another computer
  carries the vault with it.
- The OS app-data directory keeps only a small `settings.json` pointer to
  your chosen folder plus backup preferences.

### Vault menu

| Action | What it does |
| --- | --- |
| Change Storage Location… | Moves `vault.db` and the backup history to a newly picked folder (the old folder is kept until you delete it), then restarts the app |
| Storage Info… | Shows the current location, record count, database size, and backup count |
| Open Storage Folder | Reveals the vault folder in Finder / Explorer |
| Export Backup… | Writes all records to a JSON file — the same format as the server `backup` tool |
| Import Backup… | Loads records from such a JSON file (already-present records are skipped), including exports from a self-hosted server deployment |

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
make desktop-build   # produce installers under frontend/desktop/src-tauri/target/release/bundle/
```

The embedded SQLite store compiles from source (rusqlite "bundled"); no
system SQLite is required.

## Moving data between the desktop app and a server deployment

The desktop app and the Docker server deployment share the same record
format. Export from one side (desktop: Vault → Export Backup…; server: the
`backup` service) and import on the other (desktop: Vault → Import
Backup…; server: the `restore` service). Records stay ciphertext the whole
way; both sides decrypt with the same master password.

## Security notes

- The embedded API binds `127.0.0.1` on a random free port and only ever
  sees ciphertext; authentication to the vault is the master password
  itself (Argon2id inside the WebView), not the local API.
- If the WASM kernel fails to load, the desktop app refuses to start the
  vault instead of silently falling back to a non-cryptographic demo mode.
- The app is a single-user local trust boundary: other local processes can
  reach the loopback API, but only ever obtain ciphertext. A per-launch
  token is a possible future hardening.

## Unsigned builds

The macOS disk images are not code-signed. The first launch requires
Gatekeeper approval: right-click `Veyora.app` → Open, or run
`xattr -cr /Applications/Veyora.app` after copying it out of the DMG.
Windows SmartScreen may show a similar prompt ("More info" → "Run
anyway"). A signing certificate can be introduced later through the
release workflow's environment variables.
