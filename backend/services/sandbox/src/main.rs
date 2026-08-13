//! Veyora sandbox service.
//!
//! Off-by-default one-shot bounded ciphertext validator. Reads a JSON record
//! from stdin, validates the opaque ciphertext format (protocol version, suite
//! ID, non-empty ciphertext, hash length), and exits 0 (valid) or 1 (invalid).
//!
//! No network, no database, no secrets, no volumes. This service exists to
//! provide a safe isolated environment for ciphertext format validation.

use std::io::Read;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        eprintln!("sandbox: failed to read stdin");
        return ExitCode::from(1);
    }

    match validate_record(&input) {
        Ok(()) => {
            println!("sandbox: record format valid");
            ExitCode::from(0)
        }
        Err(msg) => {
            eprintln!("sandbox: {msg}");
            ExitCode::from(1)
        }
    }
}

fn validate_record(json_str: &str) -> Result<(), String> {
    let record: serde_json::Value =
        serde_json::from_str(json_str).map_err(|e| format!("parse JSON: {e}"))?;

    let obj = record.as_object().ok_or("record must be a JSON object")?;

    let pv = obj
        .get("protocol_version")
        .ok_or("missing protocol_version")?
        .as_u64()
        .ok_or("protocol_version not a number")?;
    if pv != 1 {
        return Err(format!("protocol_version must be 1, got {pv}"));
    }

    let sid = obj
        .get("suite_id")
        .ok_or("missing suite_id")?
        .as_u64()
        .ok_or("suite_id not a number")?;
    if sid != 1 {
        return Err(format!("suite_id must be 1, got {sid}"));
    }

    let ciphertext = obj
        .get("ciphertext")
        .and_then(|v| v.as_str())
        .ok_or("missing or non-string ciphertext")?;
    if ciphertext.is_empty() {
        return Err("ciphertext must not be empty".into());
    }
    if !ciphertext.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("ciphertext must be hex-encoded".into());
    }
    if ciphertext.len() < 2 {
        return Err("ciphertext too short".into());
    }

    let ciphertext_hash = obj
        .get("ciphertext_hash")
        .and_then(|v| v.as_str())
        .ok_or("missing or non-string ciphertext_hash")?;
    if ciphertext_hash.len() != 64 {
        return Err(format!(
            "ciphertext_hash must be 64 hex chars, got {}",
            ciphertext_hash.len()
        ));
    }
    if !ciphertext_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("ciphertext_hash must be hex-encoded".into());
    }

    let record_id = obj
        .get("record_id")
        .and_then(|v| v.as_str())
        .ok_or("missing or non-string record_id")?;
    if record_id.is_empty() {
        return Err("record_id must not be empty".into());
    }

    Ok(())
}
