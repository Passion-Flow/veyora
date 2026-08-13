//! Veyora restore service.
//!
//! Operator-controlled database snapshot importer. Reads a JSON array of opaque
//! encrypted records from stdin and applies them to a fresh PostgreSQL
//! destination. Records are inserted with INSERT OR no-op (idempotent by
//! record_id primary key) in a single transaction.
//!
//! Usage: DATABASE_URL=... ./restore < snapshot.json

use std::env;
use std::io::Read;
use std::process::ExitCode;

fn main() -> ExitCode {
    let database_url = match env::var("DATABASE_URL") {
        Ok(url) => url,
        Err(_) => {
            eprintln!("DATABASE_URL is required");
            return ExitCode::from(1);
        }
    };

    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        eprintln!("restore: failed to read stdin");
        return ExitCode::from(1);
    }

    match import_snapshot(&database_url, &input) {
        Ok(count) => {
            eprintln!("restore: imported {count} record(s)");
            ExitCode::from(0)
        }
        Err(msg) => {
            eprintln!("restore failed: {msg}");
            ExitCode::from(1)
        }
    }
}

fn import_snapshot(database_url: &str, json_str: &str) -> Result<usize, String> {
    let records: Vec<serde_json::Value> =
        serde_json::from_str(json_str).map_err(|e| format!("parse JSON: {e}"))?;

    let mut client = postgres::Client::connect(database_url, postgres::NoTls)
        .map_err(|e| format!("connect: {e}"))?;

    let mut tx = client.transaction().map_err(|e| format!("begin tx: {e}"))?;

    for record in &records {
        let record_id = record
            .get("record_id")
            .and_then(|v| v.as_str())
            .ok_or("record missing record_id")?;
        let revision = record
            .get("revision")
            .and_then(|v| v.as_i64())
            .ok_or("record missing revision")?;
        let protocol_version: i32 = record
            .get("protocol_version")
            .and_then(|v| v.as_i64())
            .unwrap_or(1) as i32;
        let suite_id: i32 = record.get("suite_id").and_then(|v| v.as_i64()).unwrap_or(1) as i32;
        let deployment_id = record
            .get("deployment_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let vault_id = record
            .get("vault_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let ciphertext = record
            .get("ciphertext")
            .and_then(|v| v.as_str())
            .ok_or("record missing ciphertext")?;
        let ciphertext_hash = record
            .get("ciphertext_hash")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let ciphertext_length: i64 = record
            .get("ciphertext_length")
            .and_then(|v| v.as_i64())
            .unwrap_or(ciphertext.len() as i64);
        let tombstone = record
            .get("tombstone")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let template_envelope_hash = record
            .get("template_envelope_hash")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let manifest_binding = record
            .get("manifest_binding")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        tx.execute(
            "INSERT INTO records (record_id, revision, protocol_version, suite_id, \
             deployment_id, vault_id, ciphertext, ciphertext_hash, ciphertext_length, \
             tombstone, template_envelope_hash, manifest_binding) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) \
             ON CONFLICT (record_id) DO NOTHING",
            &[
                &record_id,
                &revision,
                &protocol_version,
                &suite_id,
                &deployment_id,
                &vault_id,
                &ciphertext,
                &ciphertext_hash,
                &ciphertext_length,
                &tombstone,
                &template_envelope_hash,
                &manifest_binding,
            ],
        )
        .map_err(|e| format!("insert {record_id}: {e}"))?;
    }

    tx.commit().map_err(|e| format!("commit: {e}"))?;
    Ok(records.len())
}
