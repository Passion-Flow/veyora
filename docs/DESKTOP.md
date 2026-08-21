# Veyora desktop client

The desktop client packages the static web client as a native
application for Windows and macOS using Tauri 2. It follows the
thin-client model: the server keeps running as a Docker deployment on
your own infrastructure, and the desktop app connects to it. All vault
UI, the WebAssembly security kernel, and end-to-end encryption run
inside the app's system WebView (WebView2 on Windows, WKWebView on
macOS); the server only ever receives ciphertext.

An iPhone client is on the roadmap. Until it ships, iPhone and iPad
users can install the web client as a PWA (Share → Add to Home Screen)
against the same server.

## Installers

| Platform | Artifact | Produced by |
| --- | --- | --- |
| Windows | `Veyora_<version>_x64-setup.exe` (NSIS) | `make desktop-build` on Windows |
| macOS | `Veyora.app`, `Veyora_<version>_universal.dmg` | `make desktop-build` on macOS |

Release builds are also attached to GitHub Releases by the desktop
release workflow on every `v*` tag.

## Build from source

Prerequisites:

- Rust (the pinned toolchain from `rust-toolchain.toml`)
- Node.js 22 or newer
- Windows: WebView2 runtime (preinstalled on Windows 10/11)
- macOS: Xcode command-line tools

```bash
make desktop-dev     # run against a live server (connect screen appears)
make desktop-build   # produce installers under frontend/desktop/src-tauri/target/release/bundle/
```

## Connect to a server

On first launch the app shows a connect screen:

- **Server URL** — the gateway address that serves `/healthz`, for
  example `https://vault.example.com` or `http://192.168.1.10:8080`.
  Entering the plain-HTTP web port (default 3000) fails the health
  check; use the gateway instead.
- **API token** — only when the server runs `VEYORA_API_AUTH=token`.

The values are stored in the WebView's localStorage under the same keys
the web client reads (`veyora-api-url`, `veyora-api-token`). Use
**Connection → Change Server…** (Ctrl/Cmd+Shift+L) to reset them.

## Server-side notes

- **CORS**: with `VEYORA_API_CORS_ORIGINS` set, the allowlist must
  include the desktop origins `http://tauri.localhost` (Windows) and
  `tauri://localhost` (macOS). An empty allowlist permits all origins.
- **Plain HTTP on macOS**: WKWebView may refuse plain-`http` LAN
  addresses. Prefer HTTPS (see [DEPLOYMENT-TLS.md](DEPLOYMENT-TLS.md))
  when connecting a macOS client.
- **Authentication**: the client sends `Authorization: Bearer <token>`
  on every API request once a token is stored.
- **Certificates**: the WebView only trusts standard CA chains.
  Self-signed certificates (typical for local TLS experiments) are
  rejected with a connection error — use a Let's Encrypt certificate
  or an internal CA installed into the OS trust store.

## Unsigned builds

The macOS disk images are not code-signed. The first launch requires
Gatekeeper approval: right-click `Veyora.app` → Open, or run
`xattr -cr /Applications/Veyora.app` after copying it out of the DMG.
Windows SmartScreen may show a similar prompt ("More info" → "Run
anyway"). A signing certificate can be introduced later through the
release workflow's environment variables.
