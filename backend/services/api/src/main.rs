//! Veyora API server entrypoint.
//!
//! Ciphertext-only HTTP boundary over the [`backend_persistence::OpaqueStore`]
//! port. Configuration is fully explicit and fails fast: every required
//! variable must be present in the environment (see `.env.example` for
//! the documented set), and the backing store is chosen by `VEYORA_STORE`
//! (`postgres` or the development-only `in-memory`) — never inferred from
//! whether `DATABASE_URL` happens to be set.

use std::sync::Arc;

use api::{AppState, AuthMode, Config, app};
use backend_persistence::{InMemoryStore, OpaqueStore};
use backend_postgres::PostgresStore;

fn build_store(store_kind: &str) -> Result<Arc<dyn OpaqueStore>, String> {
    match store_kind {
        "postgres" => {
            let url = std::env::var("DATABASE_URL")
                .map_err(|_| "VEYORA_STORE=postgres requires DATABASE_URL".to_string())?;
            let store = PostgresStore::connect(&url)
                .map_err(|e| format!("DATABASE_URL is set but the connection failed: {e}"))?;
            store.migrate().map_err(|_| {
                "records migration failed; cannot start without a valid schema".to_string()
            })?;
            Ok(Arc::new(store))
        }
        "in-memory" => Ok(Arc::new(InMemoryStore::new())),
        other => Err(format!(
            "VEYORA_STORE must be 'postgres' or 'in-memory' (got {other:?})"
        )),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut problems: Vec<String> = Vec::new();
    let store_kind = std::env::var("VEYORA_STORE").unwrap_or_else(|_| {
        problems.push("VEYORA_STORE is required ('postgres' or 'in-memory')".into());
        String::new()
    });
    let config = match Config::from_env_problems() {
        Ok(config) => config,
        Err(mut config_problems) => {
            problems.append(&mut config_problems);
            Config {
                bind: String::new(),
                auth_mode: AuthMode::Disabled,
                max_body_bytes: 0,
                cors_origins: Vec::new(),
                rate_limit_per_minute: 0,
            }
        }
    };
    if !problems.is_empty() {
        for problem in &problems {
            eprintln!("veyora-api: configuration error: {problem}");
        }
        eprintln!(
            "veyora-api: refusing to start with an incomplete configuration; \
             every required variable is documented in .env.example"
        );
        std::process::exit(1);
    }

    eprintln!(
        "veyora-api: starting on {} (store: {}, auth: {})",
        config.bind,
        store_kind,
        match config.auth_mode {
            AuthMode::Disabled => "disabled",
            AuthMode::BearerToken(_) => "bearer-token",
        }
    );
    // The synchronous postgres client spins its own driver runtime on connect;
    // build the store on a blocking thread so that happens outside this runtime.
    let store = tokio::task::spawn_blocking(move || build_store(&store_kind))
        .await
        .map_err(|e| format!("store initialization panicked: {e}"))??;
    let listener = tokio::net::TcpListener::bind(&config.bind).await?;
    let state = AppState::new(store, config);

    // Graceful shutdown: drain in-flight requests on SIGTERM/SIGINT (Ctrl+C).
    let shutdown = async {
        tokio::signal::ctrl_c().await.expect("signal handler");
        eprintln!("veyora-api: shutting down (draining connections)...");
    };

    axum::serve(listener, app(state))
        .with_graceful_shutdown(shutdown)
        .await?;
    eprintln!("veyora-api: stopped.");
    Ok(())
}
