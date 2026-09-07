//! Veyora restore service.
//!
//! Operator-controlled database snapshot importer. Reads a JSON array of opaque
//! encrypted records from stdin and applies them to a fresh PostgreSQL
//! destination. Records are inserted with INSERT OR no-op (idempotent by
//! record_id primary key) in a single transaction.
//!
//! `--verify` checks a snapshot's integrity instead of importing it: every
//! record must satisfy the structural storage invariants and carry a
//! ciphertext hash that matches a fresh SHA-256 over its bytes (DEP-011
//! verification half — safe to run against any snapshot, touches nothing).
//!
//! Usage:
//!   DATABASE_URL=... ./restore < snapshot.json
//!   ./restore --verify < snapshot.json

use std::env;
use std::io::Read;
use std::process::ExitCode;

use sha2::{Digest, Sha256};

fn main() -> ExitCode {
    let verify_only = env::args().any(|arg| arg == "--verify");
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        eprintln!("restore: failed to read stdin");
        return ExitCode::from(1);
    }

    if verify_only {
        return match verify_snapshot(&input) {
            Ok((records, tombstones)) => {
                eprintln!(
                    "{} restore: verified {records} record(s), {tombstones} tombstone(s)",
                    backend_persistence::utc_now_iso()
                );
                ExitCode::from(0)
            }
            Err(msg) => {
                eprintln!("verify failed: {msg}");
                ExitCode::from(1)
            }
        };
    }

    let database_url = match env::var("DATABASE_URL") {
        Ok(url) => url,
        Err(_) => {
            eprintln!("DATABASE_URL is required");
            return ExitCode::from(1);
        }
    };

    match import_snapshot(&database_url, &input) {
        Ok(count) => {
            eprintln!(
                "{} restore: imported {count} record(s)",
                backend_persistence::utc_now_iso()
            );
            ExitCode::from(0)
        }
        Err(msg) => {
            eprintln!("restore failed: {msg}");
            ExitCode::from(1)
        }
    }
}

/// Whether `text` is exactly `len` lowercase hexadecimal characters.
fn is_lower_hex(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Decode a lowercase hex string into bytes.
fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

/// Verify a snapshot without touching any database: structural invariants
/// per record plus a fresh SHA-256 over each ciphertext's bytes compared to
/// its stored hash, and (vault, record) id uniqueness.
fn verify_snapshot(json_str: &str) -> Result<(usize, usize), String> {
    let records: Vec<serde_json::Value> =
        serde_json::from_str(json_str).map_err(|e| format!("parse JSON: {e}"))?;
    let mut seen = std::collections::BTreeSet::new();
    let mut tombstones = 0usize;
    for (index, record) in records.iter().enumerate() {
        let where_ = || format!("record {index}");
        let text_field = |name: &str| -> Result<String, String> {
            record
                .get(name)
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .ok_or_else(|| format!("{}: missing {name}", where_()))
        };
        let vault_id = text_field("vault_id")?;
        let record_id = text_field("record_id")?;
        let deployment_id = text_field("deployment_id")?;
        let ciphertext = text_field("ciphertext")?;
        let ciphertext_hash = text_field("ciphertext_hash")?;
        let template_envelope_hash = text_field("template_envelope_hash")?;
        let manifest_binding = text_field("manifest_binding")?;
        let revision = record
            .get("revision")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| format!("{}: missing revision", where_()))?;
        let ciphertext_length = record
            .get("ciphertext_length")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| format!("{}: missing ciphertext_length", where_()))?;
        let tombstone = record
            .get("tombstone")
            .and_then(|v| v.as_bool())
            .ok_or_else(|| format!("{}: missing tombstone", where_()))?;

        let label = format!("record {index} ({record_id})");
        for (name, value, len) in [
            ("deployment_id", &deployment_id, 32),
            ("vault_id", &vault_id, 32),
            ("record_id", &record_id, 32),
            ("ciphertext_hash", &ciphertext_hash, 64),
            ("template_envelope_hash", &template_envelope_hash, 64),
            ("manifest_binding", &manifest_binding, 64),
        ] {
            if !is_lower_hex(value, len) {
                return Err(format!(
                    "{label}: {name} must be {len} lowercase hex characters"
                ));
            }
        }
        if revision == 0 {
            return Err(format!("{label}: revision must be at least 1"));
        }
        let bytes = decode_hex(&ciphertext)
            .ok_or_else(|| format!("{label}: ciphertext must be lowercase hex"))?;
        if bytes.is_empty() {
            return Err(format!("{label}: ciphertext is empty"));
        }
        if ciphertext_length != bytes.len() as u64 {
            return Err(format!(
                "{label}: ciphertext_length {ciphertext_length} does not match {} ciphertext bytes",
                bytes.len()
            ));
        }
        let digest = Sha256::digest(&bytes);
        let computed: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        if computed != ciphertext_hash {
            return Err(format!(
                "{label}: ciphertext hash mismatch (stored {ciphertext_hash}, computed {computed})"
            ));
        }
        if !seen.insert((vault_id.clone(), record_id.clone())) {
            return Err(format!(
                "{label}: duplicate (vault_id, record_id) in snapshot"
            ));
        }
        if tombstone {
            tombstones += 1;
        }
    }
    Ok((records.len(), tombstones))
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
             ON CONFLICT (vault_id, record_id) DO NOTHING",
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
