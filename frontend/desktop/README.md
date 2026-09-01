# Veyora desktop app

Tauri 2 shell that packages a complete standalone vault for Windows and
macOS. The vault UI, the WebAssembly security kernel, and all encryption
run inside the system WebView; the encrypted-records API and its SQLite
storage run in-process behind a loopback port. The first-run screen makes
choosing the storage location the first action, and the Vault menu exposes
storage controls (change location, storage info, open folder, JSON
export/import).

See [docs/DESKTOP.md](../../docs/DESKTOP.md) for building, packaging, and
storage details.
