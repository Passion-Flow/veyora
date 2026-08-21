# Veyora desktop client

Tauri 2 shell that packages the static web client (`frontend/web`) as a
native desktop application for Windows and macOS. The vault UI, the
WebAssembly security kernel, and all encryption run inside the system
WebView; the shell only adds the first-run "connect to your server"
flow and a Connection menu.

See [docs/DESKTOP.md](../../docs/DESKTOP.md) for building, packaging,
and connecting to a Veyora server.
