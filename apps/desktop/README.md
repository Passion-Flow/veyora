# Veyora desktop app

Experimental Tauri 2 shell for the intended local Vault mode on Windows and
macOS. The vault UI, the WebAssembly security kernel, and record encryption
run inside the system WebView; the encrypted-records API and its SQLite
storage run in-process behind a loopback port. The first-run screen offers
the four Welcome routes — create a new vault, open an existing vault,
import into a new vault, and the advanced self-hosted connection (which
opens the service address in the browser; desktop connected pairing is not
part of this preview) — and the Vault menu exposes
storage controls (change location, storage info, open folder, JSON
export/import).

Use inert test data only. Packages are unsigned and have not passed the
four-native installation, recovery, backup, update, or uninstall gates.

See [docs/DESKTOP.md](../../docs/DESKTOP.md) for building, packaging, and
storage details.
