//! Veyora worker service.
//!
//! Background processor that periodically polls the database for operational
//! maintenance tasks: counting tombstoned records, logging vault health
//! metrics, and reporting readiness. In production this also processes the
//! transactional outbox; this v1 slice handles tombstone monitoring.

use std::env;
use std::process::ExitCode;
use std::thread;
use std::time::Duration;

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

    eprintln!("worker: polling every {poll_interval}s against configured PostgreSQL");

    loop {
        match poll_once(&database_url) {
            Ok(stats) => {
                eprintln!(
                    "worker: total={}, tombstoned={}, health=ok",
                    stats.total, stats.tombstoned
                );
            }
            Err(msg) => {
                eprintln!("worker: poll failed: {msg}");
            }
        }
        thread::sleep(Duration::from_secs(poll_interval));
    }
}

struct VaultStats {
    total: i64,
    tombstoned: i64,
}

fn poll_once(database_url: &str) -> Result<VaultStats, String> {
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

    Ok(VaultStats { total, tombstoned })
}
