//! Ciphertext-only opaque-record store for the Veyora API.
//!
//! The backend stores and retrieves opaque per-record ciphertext only. It never
//! decrypts, never accepts cleartext, and never handles authentication material,
//! keys, or template meaning. It stores opaque per-record ciphertext plus the
//! server-visible metadata the protocol attaches to it (revision, hashes,
//! tombstone state). All bytes handled here are already client-encrypted.
//!
//! This crate is dependency-free and surface-free so it remains part of the
//! auditable backend layer. The [`OpaqueStore`] trait is the persistence port;
//! [`InMemoryStore`] is the runnable development backing store. A managed-PostgreSQL
//! implementation is the production backing store and slots in behind the same
//! trait without changing any caller.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

/// Re-export the opaque record shape so callers depend on the persistence port
/// alone and the internal edge graph stays closed at `api -> backend-persistence`.
pub use veyora_contracts_generated::GenericEncryptedRecordV1;
pub use veyora_contracts_generated::{PROTOCOL_VERSION, SUITE_ID};

/// A closed store error surface; messages never include record bytes.
#[derive(Debug, Eq, PartialEq)]
pub enum StoreError {
    Conflict,
    NotFound,
    InvalidRecord,
    StoreUnavailable,
}

impl StoreError {
    #[must_use]
    pub const fn stable_code(&self) -> &'static str {
        match self {
            Self::Conflict => "PM-STORE-CONFLICT",
            Self::NotFound => "PM-STORE-NOT-FOUND",
            Self::InvalidRecord => "PM-STORE-INVALID-RECORD",
            Self::StoreUnavailable => "PM-STORE-UNAVAILABLE",
        }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.stable_code())
    }
}

impl std::error::Error for StoreError {}

/// The persistence port for opaque encrypted records.
///
/// Revisions are monotonic per record. `put` is compare-and-set on the expected
/// prior revision (`None` for a new record); a mismatch yields [`StoreError::Conflict`].
pub trait OpaqueStore: Send + Sync {
    fn put(
        &self,
        record: GenericEncryptedRecordV1,
        expected_prior_revision: Option<u64>,
    ) -> Result<u64, StoreError>;
    fn get(&self, record_id: &str) -> Result<GenericEncryptedRecordV1, StoreError>;
    fn list(&self) -> Result<Vec<RecordSummary>, StoreError>;
    fn tombstone(&self, record_id: &str, expected_prior_revision: u64) -> Result<u64, StoreError>;
    /// Purge tombstoned records. Returns the count of records removed.
    /// The InMemoryStore always returns 0 (tombstones are retained for sync);
    /// PostgresStore executes DELETE WHERE tombstone = true.
    fn purge_tombstoned(&self) -> Result<u64, StoreError> {
        Ok(0) // Default: no-op (retention is a server policy decision)
    }
}

/// Server-visible metadata for a record list. Never carries cleartext or meaning.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecordSummary {
    pub record_id: String,
    pub revision: u64,
    pub tombstone: bool,
    pub ciphertext_hash: String,
}

/// Runnable development backing store, process-local and in-memory.
///
/// Suitable for the inert demo and for tests. A production deployment uses a
/// managed-PostgreSQL backing store behind the same trait.
pub struct InMemoryStore {
    rows: Mutex<HashMap<String, GenericEncryptedRecordV1>>,
}

impl Default for InMemoryStore {
    fn default() -> Self {
        Self {
            rows: Mutex::new(HashMap::new()),
        }
    }
}

impl InMemoryStore {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

fn validate(record: &GenericEncryptedRecordV1) -> Result<(), StoreError> {
    if record.protocol_version != veyora_contracts_generated::PROTOCOL_VERSION
        || record.suite_id != veyora_contracts_generated::SUITE_ID
        || record.revision == 0
        || record.ciphertext.is_empty()
        || record.record_id.is_empty()
        || record.ciphertext_hash.is_empty()
    {
        return Err(StoreError::InvalidRecord);
    }
    Ok(())
}

fn summary(record: &GenericEncryptedRecordV1) -> RecordSummary {
    RecordSummary {
        record_id: record.record_id.clone(),
        revision: record.revision,
        tombstone: record.tombstone,
        ciphertext_hash: record.ciphertext_hash.clone(),
    }
}

impl OpaqueStore for InMemoryStore {
    fn put(
        &self,
        mut record: GenericEncryptedRecordV1,
        expected_prior_revision: Option<u64>,
    ) -> Result<u64, StoreError> {
        validate(&record)?;
        let mut rows = self.rows.lock().unwrap_or_else(PoisonError::into_inner);
        let prior_revision = rows
            .get(record.record_id.as_str())
            .map(|existing| existing.revision);
        match (prior_revision, expected_prior_revision) {
            (None, None) => {
                record.revision = 1;
                rows.insert(record.record_id.clone(), record);
                Ok(1)
            }
            (None, Some(_)) => Err(StoreError::Conflict),
            (Some(existing), Some(expected)) if existing == expected => {
                record.revision = existing + 1;
                rows.insert(record.record_id.clone(), record);
                Ok(existing + 1)
            }
            _ => Err(StoreError::Conflict),
        }
    }

    fn get(&self, record_id: &str) -> Result<GenericEncryptedRecordV1, StoreError> {
        self.rows
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(record_id)
            .cloned()
            .ok_or(StoreError::NotFound)
    }

    fn list(&self) -> Result<Vec<RecordSummary>, StoreError> {
        let rows = self.rows.lock().unwrap_or_else(PoisonError::into_inner);
        let mut summaries: Vec<RecordSummary> = rows.values().map(summary).collect();
        summaries.sort_by(|a, b| a.record_id.cmp(&b.record_id));
        Ok(summaries)
    }

    fn tombstone(&self, record_id: &str, expected_prior_revision: u64) -> Result<u64, StoreError> {
        let mut rows = self.rows.lock().unwrap_or_else(PoisonError::into_inner);
        let existing = rows.get_mut(record_id).ok_or(StoreError::NotFound)?;
        if existing.revision != expected_prior_revision {
            return Err(StoreError::Conflict);
        }
        existing.tombstone = true;
        existing.revision = expected_prior_revision + 1;
        Ok(existing.revision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, revision: u64, tombstone: bool) -> GenericEncryptedRecordV1 {
        GenericEncryptedRecordV1 {
            protocol_version: 1,
            suite_id: 1,
            deployment_id: "0000000000000000000000000000000f".to_string(),
            vault_id: "1010101010101010101010101010101f".to_string(),
            record_id: id.to_string(),
            revision,
            ciphertext: "a5".repeat(1040),
            ciphertext_hash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
                .to_string(),
            ciphertext_length: 1040,
            tombstone,
            template_envelope_hash:
                "0000000000000000000000000000000000000000000000000000000000000001".to_string(),
            manifest_binding: "0000000000000000000000000000000000000000000000000000000000000002"
                .to_string(),
        }
    }

    #[test]
    fn put_new_then_get_round_trips() {
        let store = InMemoryStore::new();
        let rev = store.put(record("record-aaaa", 1, false), None).unwrap();
        assert_eq!(rev, 1);
        let got = store.get("record-aaaa").unwrap();
        assert_eq!(got.record_id, "record-aaaa");
        assert!(!got.tombstone);
    }

    #[test]
    fn put_with_wrong_expected_revision_conflicts() {
        let store = InMemoryStore::new();
        store.put(record("record-bbbb", 1, false), None).unwrap();
        // The store assigned revision 1; a CAS claiming the prior was 99 mismatches.
        let err = store
            .put(record("record-bbbb", 2, false), Some(99))
            .unwrap_err();
        assert_eq!(err, StoreError::Conflict);
    }

    #[test]
    fn cas_update_advances_revision() {
        let store = InMemoryStore::new();
        store.put(record("record-cccc", 1, false), None).unwrap();
        let next = store.put(record("record-cccc", 2, false), Some(1)).unwrap();
        assert_eq!(next, 2);
        assert_eq!(store.get("record-cccc").unwrap().revision, 2);
    }

    #[test]
    fn missing_record_is_not_found() {
        let store = InMemoryStore::new();
        assert_eq!(store.get("absent").unwrap_err(), StoreError::NotFound);
    }

    #[test]
    fn list_is_sorted_and_stable() {
        let store = InMemoryStore::new();
        store.put(record("record-zeta", 1, false), None).unwrap();
        store.put(record("record-alpha", 1, false), None).unwrap();
        let ids: Vec<_> = store
            .list()
            .unwrap()
            .into_iter()
            .map(|s| s.record_id)
            .collect();
        assert_eq!(ids, vec!["record-alpha", "record-zeta"]);
    }

    #[test]
    fn tombstone_sets_flag_and_advances() {
        let store = InMemoryStore::new();
        store.put(record("record-dddd", 3, false), None).unwrap();
        let rev = store.tombstone("record-dddd", 1).unwrap();
        assert_eq!(rev, 2);
        assert!(store.get("record-dddd").unwrap().tombstone);
    }

    #[test]
    fn tombstone_with_stale_revision_conflicts() {
        let store = InMemoryStore::new();
        store.put(record("record-eeee", 1, false), None).unwrap();
        store.tombstone("record-eeee", 1).unwrap();
        assert_eq!(
            store.tombstone("record-eeee", 1).unwrap_err(),
            StoreError::Conflict
        );
    }

    #[test]
    fn invalid_record_rejected() {
        let store = InMemoryStore::new();
        let mut bad = record("record-ffff", 1, false);
        bad.protocol_version = 99;
        assert_eq!(store.put(bad, None).unwrap_err(), StoreError::InvalidRecord);
    }
}
