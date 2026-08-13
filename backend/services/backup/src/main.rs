//! Veyora backup service.
//!
//! Operator-controlled database snapshot exporter. Reads all opaque encrypted
//! records from PostgreSQL and writes them to stdout as a JSON array. The
//! records are opaque ciphertext — no cleartext, key material, or vault meaning
//! is ever handled.
//!
//! Usage: DATABASE_URL=... ./backup > snapshot.json

use std::env;
use std::io::{self, Write};
use std::process::ExitCode;

fn main() -> ExitCode {
    let database_url = match env::var("DATABASE_URL") {
        Ok(url) => url,
        Err(_) => {
            eprintln!("DATABASE_URL is required");
            return ExitCode::from(1);
        }
    };

    match export_snapshot(&database_url) {
        Ok(count) => {
            eprintln!("backup: exported {count} record(s)");
            ExitCode::from(0)
        }
        Err(msg) => {
            eprintln!("backup failed: {msg}");
            ExitCode::from(1)
        }
    }
}

fn export_snapshot(database_url: &str) -> Result<usize, String> {
    let mut client = postgres::Client::connect(database_url, postgres::NoTls)
        .map_err(|e| format!("connect: {e}"))?;

    let rows = client
        .query(
            "SELECT record_id, revision, protocol_version, suite_id, deployment_id, \
             vault_id, ciphertext, ciphertext_hash, ciphertext_length, tombstone, \
             template_envelope_hash, manifest_binding \
             FROM records ORDER BY record_id",
            &[],
        )
        .map_err(|e| format!("query: {e}"))?;

    let stdout = io::stdout();
    let mut out = stdout.lock();
    writeln!(out, "[").map_err(|e| format!("write: {e}"))?;

    for (i, row) in rows.iter().enumerate() {
        if i > 0 {
            writeln!(out, ",").map_err(|e| format!("write: {e}"))?;
        }
        let record_id: String = row.get(0);
        let revision: i64 = row.get(1);
        let protocol_version: i32 = row.get(2);
        let suite_id: i32 = row.get(3);
        let deployment_id: String = row.get(4);
        let vault_id: String = row.get(5);
        let ciphertext: String = row.get(6);
        let ciphertext_hash: String = row.get(7);
        let ciphertext_length: i64 = row.get(8);
        let tombstone: bool = row.get(9);
        let template_envelope_hash: String = row.get(10);
        let manifest_binding: String = row.get(11);

        write!(
            out,
            r#"  {{"protocol_version":{}, "suite_id":{}, "deployment_id":"{}", "vault_id":"{}", "record_id":"{}", "revision":{}, "ciphertext":"{}", "ciphertext_hash":"{}", "ciphertext_length":{}, "tombstone":{}, "template_envelope_hash":"{}", "manifest_binding":"{}"}}"#,
            protocol_version, suite_id, deployment_id, vault_id, record_id,
            revision, ciphertext, ciphertext_hash, ciphertext_length,
            tombstone, template_envelope_hash, manifest_binding
        )
        .map_err(|e| format!("write: {e}"))?;
    }

    writeln!(out, "\n]").map_err(|e| format!("write: {e}"))?;
    Ok(rows.len())
}
