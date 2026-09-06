//! Embedded Veyora API server.
//!
//! The standalone desktop app runs the full records API in-process on an
//! ephemeral loopback port. The server owns nothing platform-specific: it is
//! the same `api::app` router the server deployment uses, configured for a
//! single-user local trust boundary:
//!
//! * bind `127.0.0.1:0` — reachable only from this machine, no fixed port;
//! * `AuthMode::Disabled` — the server only ever sees opaque ciphertext, and
//!   the vault's real gate (master password → Argon2id → record keys) lives
//!   in the WebView's WASM kernel, not in this API;
//! * wildcard CORS — the WebView origin differs per platform
//!   (`tauri://localhost` on macOS, `http://tauri.localhost` on Windows);
//! * no rate limit — there is no remote client and no proxy headers.
//!
//! The server runs on a dedicated thread with its own Tokio runtime so it is
//! independent from Tauri's event loop. SQLite is crash-safe, so ending the
//! process at window close never loses a committed revision.

use std::sync::Arc;
use std::time::Duration;

use backend_persistence::OpaqueStore;
use backend_sqlite::SqliteStore;

/// Request-body ceiling for the local API. Generous on purpose: there are no
/// adversarial clients on the loopback interface, and `POST /records/batch`
/// may carry several records that are each close to the per-record ciphertext
/// ceiling (`RECORD_CIPHERTEXT_MAX_BYTES` ≈ 16 MiB).
const MAX_BODY_BYTES: usize = 128 * 1024 * 1024;

/// A running embedded API bound to a loopback port.
#[derive(Clone)]
pub struct EmbeddedServer {
    port: u16,
    store: Arc<SqliteStore>,
}

impl EmbeddedServer {
    #[must_use]
    pub fn port(&self) -> u16 {
        self.port
    }

    #[must_use]
    pub fn store(&self) -> Arc<SqliteStore> {
        self.store.clone()
    }

    /// Bind the API on an ephemeral loopback port and serve until the process
    /// exits. Returns once the listener is accepting connections.
    pub fn start(store: Arc<SqliteStore>) -> Result<Self, String> {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u16, String>>();
        let server_store = store.clone() as Arc<dyn OpaqueStore>;
        std::thread::Builder::new()
            .name("veyora-embedded-api".to_string())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready_tx.send(Err(format!("build tokio runtime: {error}")));
                        return;
                    }
                };
                runtime.block_on(async move {
                    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
                        Ok(listener) => listener,
                        Err(error) => {
                            let _ = ready_tx.send(Err(format!("bind loopback: {error}")));
                            return;
                        }
                    };
                    let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(0);
                    let config = api::Config {
                        bind: "127.0.0.1:0".to_string(),
                        auth_mode: api::AuthMode::Disabled,
                        max_body_bytes: MAX_BODY_BYTES,
                        cors_origins: Vec::new(),
                        rate_limit_per_minute: 0,
                    };
                    let state = api::AppState::new(server_store, config);
                    if ready_tx.send(Ok(port)).is_err() {
                        return;
                    }
                    if let Err(error) = axum::serve(listener, api::app(state)).await {
                        eprintln!("veyora embedded api stopped: {error}");
                    }
                });
            })
            .map_err(|error| format!("spawn server thread: {error}"))?;
        match ready_rx.recv_timeout(Duration::from_secs(15)) {
            Ok(Ok(port)) => Ok(Self { port, store }),
            Ok(Err(error)) => Err(error),
            Err(_) => Err("the embedded server did not start in time".to_string()),
        }
    }
}
