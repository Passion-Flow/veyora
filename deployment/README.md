# Veyora deployment sources

This directory contains the Envoy gateway image and the static browser client.
The root Compose files assemble them with the Rust services and PostgreSQL.

## Layout

| Path | Purpose |
| --- | --- |
| `envoy.yaml` | Envoy configuration template |
| `Dockerfile.gateway.build` | Gateway image and fail-fast template rendering |
| `web/index.html` | Static vault client |
| `web/wasm/` | Checked-in WebAssembly kernel artifacts |
| `web/nginx.conf` | Static delivery and same-origin `/api` proxy |
| `web/Dockerfile` | Web image and explicit runtime configuration |
| `config/registry.generated.json` | Read-only deployment configuration projection |

Every template variable required by the gateway and web image is supplied
explicitly by the Compose topology. The local preview binds published ports to
`127.0.0.1`; it does not provide public TLS or production authentication.

See [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) for startup, image publishing,
configuration, and hardening guidance.
