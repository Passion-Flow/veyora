//! Veyora worker service.
//!
//! Background processor that periodically polls the database for operational
//! maintenance tasks: counting tombstoned records, logging vault health
//! metrics, and enforcing the Trash retention policy (DATA-008) —
//! tombstones older than `VEYORA_TRASH_RETENTION_DAYS` (default 30) are
//! purged through the same store method the API's explicit purge uses, so
//! the delete semantics live in exactly one place.

use std::env;
use std::process::ExitCode;
use std::thread;
use std::time::Duration;

use backend_persistence::utc_now_epoch;
use worker::{RetentionPolicy, run_retention};

fn main() -> ExitCode {
    let database_url = match env::var("DATABASE_URL") {
        Ok(url) => url,
        Err(_) => {
            eprintln!("DATABASE_URL is required; the worker needs a database");
            return ExitCode::from(1);
        }
    };

    // Explicit configuration: the poll interval must be provided and must be a
    // valid number of seconds — no silent default (see .env.example).
    let poll_interval: u64 = match env::var("VEYORA_WORKER_POLL_SECONDS") {
        Ok(raw) => match raw.parse::<u64>() {
            Ok(seconds) if seconds > 0 => seconds,
            _ => {
                eprintln!("VEYORA_WORKER_POLL_SECONDS must be a positive integer (got {raw:?})");
                return ExitCode::from(1);
            }
        },
        Err(_) => {
            eprintln!("VEYORA_WORKER_POLL_SECONDS is required (e.g. 60)");
            return ExitCode::from(1);
        }
    };

    let policy =
        match RetentionPolicy::from_env(env::var("VEYORA_TRASH_RETENTION_DAYS").ok().as_deref()) {
            Ok(policy) => policy,
            Err(message) => {
                eprintln!("{message}");
                return ExitCode::from(1);
            }
        };
    let policy_line = match policy {
        RetentionPolicy::Days(days) => format!("{days}d"),
        RetentionPolicy::Disabled => "disabled".to_string(),
    };

    eprintln!(
        "{} worker: polling every {poll_interval}s against configured PostgreSQL, trash retention={policy_line}",
        backend_persistence::utc_now_iso()
    );

    loop {
        match poll_once(&database_url, &policy) {
            Ok(stats) => {
                eprintln!(
                    "{} worker: total={}, tombstoned={}, purged={}, health=ok",
                    backend_persistence::utc_now_iso(),
                    stats.total,
                    stats.tombstoned,
                    stats.purged
                );
            }
            Err(msg) => {
                eprintln!(
                    "{} worker: poll failed: {msg}",
                    backend_persistence::utc_now_iso()
                );
            }
        }
        thread::sleep(Duration::from_secs(poll_interval));
    }
}

struct VaultStats {
    total: i64,
    tombstoned: i64,
    purged: u64,
}

fn poll_once(database_url: &str, policy: &RetentionPolicy) -> Result<VaultStats, String> {
    let mut client = postgres::Client::connect(database_url, postgres::NoTls)
        .map_err(|e| format!("connect: {e}"))?;

    let total: i64 = client
        .query_one("SELECT count(*) FROM records", &[])
        .map(|row| row.get(0))
        .map_err(|e| format!("count total: {e}"))?;

    let tombstoned: i64 = client
        .query_one("SELECT count(*) FROM records WHERE tombstone = true", &[])
        .map(|row| row.get(0))
        .map_err(|e| format!("count tombstoned: {e}"))?;

    // Retention (DATA-008): the store owns the delete semantics; the worker
    // only derives the cutoff and walks every vault scope in the database.
    let purged = {
        let store = backend_postgres::PostgresStore::connect(database_url)
            .map_err(|e| format!("retention store: {e}"))?;
        let vaults = store
            .vault_ids()
            .map_err(|e| format!("list vaults: {e:?}"))?;
        run_retention(&store, &vaults, policy, utc_now_epoch())
            .map_err(|e| format!("retention purge: {e:?}"))?
    };

    Ok(VaultStats {
        total,
        tombstoned,
        purged,
    })
}
