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

/// Format a Unix timestamp as an ISO-8601 UTC instant
/// (`YYYY-MM-DDTHH:MM:SSZ`) using only std (DEP-014: operational logs carry
/// UTC timestamps). Civil-from-days (Howard Hinnant's algorithm), valid for
/// the full positive Unix epoch range.
#[must_use]
pub fn format_utc(seconds: u64) -> String {
    let days = i64::try_from(seconds / 86_400).unwrap_or(i64::MAX);
    let secs_of_day = seconds % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs_of_day / 3_600,
        (secs_of_day % 3_600) / 60,
        secs_of_day % 60
    )
}

/// Current instant as an ISO-8601 UTC string (see [`format_utc`]).
#[must_use]
pub fn utc_now_iso() -> String {
    format_utc(utc_now_epoch())
}

/// Current instant as whole seconds since the Unix epoch (retention math
/// and tombstone stamps; DEP-014 keeps every clock UTC-based).
#[must_use]
pub fn utc_now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

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
/// The vault scope of a record operation: `(vault_id, record_id)` is the
/// storage identity, so identical record IDs in different Vaults never
/// collide or cross (PRD DATA-001). Until authenticated pairing principals
/// exist (ADR 0005), the caller declares the scope; the server still
/// enforces it on every read and write instead of returning global rows.
pub type VaultScope<'a> = (&'a str, &'a str);

pub trait OpaqueStore: Send + Sync {
    fn put(
        &self,
        record: GenericEncryptedRecordV1,
        expected_prior_revision: Option<u64>,
    ) -> Result<u64, StoreError>;
    fn get(&self, vault_id: &str, record_id: &str) -> Result<GenericEncryptedRecordV1, StoreError>;
    fn list(
        &self,
        vault_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<RecordSummary>, StoreError>;
    /// Full-record listing for single-round-trip hydration (`?embed=bodies`).
    fn list_bodies(
        &self,
        vault_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<GenericEncryptedRecordV1>, StoreError>;
    fn tombstone(
        &self,
        vault_id: &str,
        record_id: &str,
        expected_prior_revision: u64,
    ) -> Result<u64, StoreError>;
    /// Atomic batch write (DATA-007): every record commits in one
    /// transaction — a single invalid or conflicting row rolls the whole
    /// batch back, so the store never holds a partial import. On success
    /// returns the assigned revision for each record in input order.
    fn put_batch(
        &self,
        records: Vec<GenericEncryptedRecordV1>,
        expected_prior_revisions: Vec<Option<u64>>,
    ) -> Result<Vec<u64>, StoreError> {
        // Reference implementation: sequential puts. Adapters MUST override
        // this with a true single-transaction version; the fallback exists
        // only so custom test doubles stay constructible.
        let mut revisions = Vec::with_capacity(records.len());
        for (record, expected) in records.into_iter().zip(expected_prior_revisions) {
            revisions.push(self.put(record, expected)?);
        }
        Ok(revisions)
    }

    /// The server-authoritative current revision of one record, read
    /// fresh from storage. Conflict responses carry this value (DATA-005)
    /// so clients can resolve without guessing.
    fn current_revision(&self, vault_id: &str, record_id: &str) -> Result<u64, StoreError> {
        self.get(vault_id, record_id).map(|record| record.revision)
    }

    /// Atomic vault rekey (Master Password change): insert every record
    /// under `to_vault_id` and delete every row of `vault_id` in one
    /// transaction. Any failure — an invalid row, or a target row that
    /// already exists — rolls the whole operation back, so the vault is
    /// always reachable under exactly one scope. Adapters MUST override
    /// this with a true single-transaction version.
    fn rekey_vault(
        &self,
        vault_id: &str,
        to_vault_id: &str,
        records: Vec<GenericEncryptedRecordV1>,
    ) -> Result<u64, StoreError> {
        let mut moved = 0u64;
        for mut record in records {
            record.vault_id = to_vault_id.to_string();
            record.revision = 1;
            self.put(record, None)?;
            moved += 1;
        }
        let doomed = self.list(vault_id, usize::MAX, 0)?;
        for summary in doomed {
            self.tombstone(vault_id, &summary.record_id, summary.revision)?;
        }
        self.purge_tombstoned_before(vault_id, u64::MAX)?;
        Ok(moved)
    }

    /// The deletion stamp of one record (DATA-008): `Ok(None)` for a live
    /// record, `Err(NotFound)` when the record does not exist. Retention
    /// math and Trash-age displays read this; it is never client data.
    fn tombstoned_at(&self, vault_id: &str, record_id: &str) -> Result<Option<u64>, StoreError>;

    /// Purge tombstoned records in the given vault whose deletion stamp is
    /// at or before `before_epoch_seconds` (DATA-008 retention). Returns
    /// the count removed. The current epoch purges every tombstone now;
    /// a stamp minus one purges nothing — callers derive policy cutoffs.
    fn purge_tombstoned_before(
        &self,
        vault_id: &str,
        before_epoch_seconds: u64,
    ) -> Result<u64, StoreError>;
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
    rows: Mutex<HashMap<(String, String), GenericEncryptedRecordV1>>,
    /// Deletion stamps for retention (DATA-008): absent = live record.
    tombstoned_at: Mutex<HashMap<(String, String), u64>>,
}

impl Default for InMemoryStore {
    fn default() -> Self {
        Self {
            rows: Mutex::new(HashMap::new()),
            tombstoned_at: Mutex::new(HashMap::new()),
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
        || record.vault_id.is_empty()
        || record.ciphertext_hash.is_empty()
    {
        return Err(StoreError::InvalidRecord);
    }
    Ok(())
}

/// Page a sorted listing (DATA-006): every list call is bounded by an
/// explicit limit and offset.
fn paged<T>(mut rows: Vec<T>, limit: usize, offset: usize) -> Vec<T> {
    if offset >= rows.len() {
        rows.clear();
        return rows;
    }
    rows.drain(..offset);
    rows.truncate(limit);
    rows
}

fn summary(record: &GenericEncryptedRecordV1) -> RecordSummary {
    RecordSummary {
        record_id: record.record_id.clone(),
        revision: record.revision,
        tombstone: record.tombstone,
        ciphertext_hash: record.ciphertext_hash.clone(),
    }
}

fn scoped<'a>(
    rows: &'a mut HashMap<(String, String), GenericEncryptedRecordV1>,
    vault_id: &str,
    record_id: &str,
) -> Option<&'a mut GenericEncryptedRecordV1> {
    rows.get_mut(&(vault_id.to_string(), record_id.to_string()))
}

impl OpaqueStore for InMemoryStore {
    fn put(
        &self,
        mut record: GenericEncryptedRecordV1,
        expected_prior_revision: Option<u64>,
    ) -> Result<u64, StoreError> {
        validate(&record)?;
        let live = !record.tombstone;
        let mut rows = self.rows.lock().unwrap_or_else(PoisonError::into_inner);
        let key = (record.vault_id.clone(), record.record_id.clone());
        let prior_revision = rows.get(&key).map(|existing| existing.revision);
        let assigned = match (prior_revision, expected_prior_revision) {
            (None, None) => {
                record.revision = 1;
                rows.insert(key.clone(), record);
                1
            }
            (None, Some(_)) => return Err(StoreError::Conflict),
            (Some(existing), Some(expected)) if existing == expected => {
                record.revision = existing + 1;
                rows.insert(key.clone(), record);
                existing + 1
            }
            _ => return Err(StoreError::Conflict),
        };
        drop(rows);
        // A live write clears any prior deletion stamp (restore path).
        if live {
            self.tombstoned_at
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&key);
        }
        Ok(assigned)
    }

    fn get(&self, vault_id: &str, record_id: &str) -> Result<GenericEncryptedRecordV1, StoreError> {
        self.rows
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&(vault_id.to_string(), record_id.to_string()))
            .cloned()
            .ok_or(StoreError::NotFound)
    }

    fn list(
        &self,
        vault_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<RecordSummary>, StoreError> {
        let rows = self.rows.lock().unwrap_or_else(PoisonError::into_inner);
        let mut summaries: Vec<RecordSummary> = rows
            .values()
            .filter(|record| record.vault_id == vault_id)
            .map(summary)
            .collect();
        summaries.sort_by(|a, b| a.record_id.cmp(&b.record_id));
        Ok(paged(summaries, limit, offset))
    }

    fn list_bodies(
        &self,
        vault_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<GenericEncryptedRecordV1>, StoreError> {
        let rows = self.rows.lock().unwrap_or_else(PoisonError::into_inner);
        let mut records: Vec<GenericEncryptedRecordV1> = rows
            .values()
            .filter(|record| record.vault_id == vault_id)
            .cloned()
            .collect();
        records.sort_by(|a, b| a.record_id.cmp(&b.record_id));
        Ok(paged(records, limit, offset))
    }

    fn put_batch(
        &self,
        records: Vec<GenericEncryptedRecordV1>,
        expected_prior_revisions: Vec<Option<u64>>,
    ) -> Result<Vec<u64>, StoreError> {
        // Validate every row first (DATA-007): one invalid record aborts the
        // whole batch before any mutation.
        for record in &records {
            validate(record)?;
        }
        let mut rows = self.rows.lock().unwrap_or_else(PoisonError::into_inner);
        // Plan the writes against the current state; only a fully valid plan
        // is applied, so a mid-batch conflict leaves every row untouched.
        let mut plan = Vec::with_capacity(records.len());
        for (mut record, expected) in records.into_iter().zip(expected_prior_revisions) {
            let key = (record.vault_id.clone(), record.record_id.clone());
            let prior_revision = rows.get(&key).map(|existing| existing.revision);
            let next = match (prior_revision, expected) {
                (None, None) => 1,
                (None, Some(_)) => return Err(StoreError::Conflict),
                (Some(existing), Some(want)) if existing == want => existing + 1,
                _ => return Err(StoreError::Conflict),
            };
            record.revision = next;
            plan.push((key, record, next));
        }
        let revisions: Vec<u64> = plan.iter().map(|(_, _, next)| *next).collect();
        let mut stamps = self
            .tombstoned_at
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        for (key, record, _) in plan {
            if !record.tombstone {
                stamps.remove(&key);
            }
            rows.insert(key, record);
        }
        Ok(revisions)
    }

    fn tombstone(
        &self,
        vault_id: &str,
        record_id: &str,
        expected_prior_revision: u64,
    ) -> Result<u64, StoreError> {
        let mut rows = self.rows.lock().unwrap_or_else(PoisonError::into_inner);
        let existing = scoped(&mut rows, vault_id, record_id).ok_or(StoreError::NotFound)?;
        if existing.revision != expected_prior_revision {
            return Err(StoreError::Conflict);
        }
        existing.tombstone = true;
        existing.revision = expected_prior_revision + 1;
        drop(rows);
        self.tombstoned_at
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                (vault_id.to_string(), record_id.to_string()),
                utc_now_epoch(),
            );
        Ok(expected_prior_revision + 1)
    }

    fn rekey_vault(
        &self,
        vault_id: &str,
        to_vault_id: &str,
        mut records: Vec<GenericEncryptedRecordV1>,
    ) -> Result<u64, StoreError> {
        for record in &records {
            validate(record)?;
        }
        if to_vault_id.is_empty() || to_vault_id == vault_id {
            return Err(StoreError::InvalidRecord);
        }
        let mut rows = self.rows.lock().unwrap_or_else(PoisonError::into_inner);
        // Plan first, apply only when every target slot is free: a
        // mid-plan conflict leaves both scopes untouched.
        for record in &records {
            if rows.contains_key(&(to_vault_id.to_string(), record.record_id.clone())) {
                return Err(StoreError::Conflict);
            }
        }
        for record in records.iter_mut() {
            record.vault_id = to_vault_id.to_string();
            record.revision = 1;
        }
        rows.retain(|(vault, _), _| vault != vault_id);
        let moved = records.len() as u64;
        let mut stamps = self
            .tombstoned_at
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        stamps.retain(|(vault, _), _| vault != vault_id);
        let now = utc_now_epoch();
        for record in records {
            let key = (record.vault_id.clone(), record.record_id.clone());
            if record.tombstone {
                // A tombstoned rekey row must carry a deletion stamp, or
                // the retention purge could never remove it.
                stamps.insert(key.clone(), now);
            }
            rows.insert(key, record);
        }
        drop(rows);
        drop(stamps);
        Ok(moved)
    }

    fn tombstoned_at(&self, vault_id: &str, record_id: &str) -> Result<Option<u64>, StoreError> {
        let rows = self.rows.lock().unwrap_or_else(PoisonError::into_inner);
        rows.get(&(vault_id.to_string(), record_id.to_string()))
            .ok_or(StoreError::NotFound)?;
        Ok(self
            .tombstoned_at
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&(vault_id.to_string(), record_id.to_string()))
            .copied())
    }

    fn purge_tombstoned_before(
        &self,
        vault_id: &str,
        before_epoch_seconds: u64,
    ) -> Result<u64, StoreError> {
        let rows = self.rows.lock().unwrap_or_else(PoisonError::into_inner);
        let stamps = self
            .tombstoned_at
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let expired: Vec<(String, String)> = rows
            .iter()
            .filter(|((vault, id), record)| {
                vault == vault_id
                    && record.tombstone
                    && stamps
                        .get(&(vault.clone(), id.clone()))
                        .is_some_and(|stamp| *stamp <= before_epoch_seconds)
            })
            .map(|((vault, id), _)| (vault.clone(), id.clone()))
            .collect();
        drop(rows);
        let mut rows = self.rows.lock().unwrap_or_else(PoisonError::into_inner);
        let mut stamps = stamps;
        for key in &expired {
            rows.remove(key);
            stamps.remove(key);
        }
        Ok(expired.len() as u64)
    }
}

/// Shared behavioral contract suite (PRD DATA-010): every storage adapter
/// MUST pass these identical assertions. SQLite and PostgreSQL run this
/// module from their own test harnesses so the two adapters can never drift
/// apart — a behavior change for one is a behavior change for both.
///
/// The suite is deterministic without time control: purge boundaries are
/// derived from the observable `tombstoned_at` stamp (cutoff `stamp - 1`
/// keeps the row, cutoff `stamp` removes it). Age-window semantics with a
/// backdated stamp are additionally proven per adapter through its native
/// debug channel (direct SQL against a test database).
pub mod contract {
    use crate::{GenericEncryptedRecordV1, OpaqueStore, StoreError};

    /// The contract's vault scopes. Public so adapter harnesses can clean
    /// exactly these rows from a shared live database without wiping other
    /// tests' fixtures (the rekey target included).
    pub const VAULT_A: &str = "cafe000000000000000000000000000a";
    pub const VAULT_B: &str = "cafe000000000000000000000000000b";
    pub const REKEY_TARGET: &str = "cafe000000000000000000000000000c";

    fn record(vault: &str, id: &str, revision: u64) -> GenericEncryptedRecordV1 {
        debug_assert!(revision >= 1, "input rows must satisfy validation");
        GenericEncryptedRecordV1 {
            record_id: id.to_string(),
            revision,
            protocol_version: veyora_contracts_generated::PROTOCOL_VERSION,
            suite_id: veyora_contracts_generated::SUITE_ID,
            deployment_id: format!("deployment-{vault}"),
            vault_id: vault.to_string(),
            ciphertext: format!("ciphertext-{vault}-{id}"),
            ciphertext_hash: format!("hash-{vault}-{id}"),
            ciphertext_length: 32,
            tombstone: false,
            template_envelope_hash: "0".repeat(64),
            manifest_binding: "1".repeat(64),
        }
    }

    fn assert_eq_or_panic<T: PartialEq + std::fmt::Debug>(left: T, right: T, what: &str) {
        assert_eq!(left, right, "contract violation: {what}");
    }

    /// Run the full adapter contract. Panics (test failure) on any breach.
    pub fn run(store: &dyn OpaqueStore) {
        // 1. Round trip: server-assigned revisions, scoped reads.
        let assigned = store
            .put(record(VAULT_A, "acme", 1), None)
            .expect("put assigns a revision");
        assert_eq_or_panic(assigned, 1, "first put assigns revision 1");
        let got = store
            .get(VAULT_A, "acme")
            .expect("stored record reads back");
        assert_eq_or_panic(
            got.ciphertext,
            format!("ciphertext-{VAULT_A}-acme"),
            "ciphertext round trips",
        );
        assert!(!got.tombstone, "new records are live");

        // 2. Compare-and-set: stale expectations are refused.
        let stale = store.put(record(VAULT_A, "acme", 1), Some(999));
        assert!(
            matches!(stale, Err(StoreError::Conflict)),
            "stale CAS conflicts"
        );

        // 3. Vault scoping (DATA-001): identical record ids never collide.
        store
            .put(record(VAULT_B, "acme", 1), None)
            .expect("same id in another vault is a distinct record");
        let foreign = store
            .get(VAULT_B, "acme")
            .expect("foreign-vault record exists");
        assert_eq_or_panic(
            foreign.deployment_id,
            format!("deployment-{VAULT_B}"),
            "the two vaults' rows stay isolated",
        );
        assert!(matches!(
            store.get(VAULT_A, "nope"),
            Err(StoreError::NotFound)
        ));

        // 4. Bounded listings follow (limit, offset) in stable id order.
        store
            .put(record(VAULT_A, "beta", 1), None)
            .expect("put beta");
        let page = store.list(VAULT_A, 1, 1).expect("list page");
        assert_eq_or_panic(page.len(), 1, "limit is honored");
        assert_eq_or_panic(page[0].record_id.as_str(), "beta", "offset is honored");

        // 5. Batches are all-or-nothing (DATA-007): one conflicting row
        //    rolls the entire batch back.
        let batch_ok = vec![record(VAULT_A, "gamma", 1), record(VAULT_A, "delta", 1)];
        let revisions = store
            .put_batch(batch_ok.clone(), vec![None, None])
            .expect("clean batch commits");
        assert_eq_or_panic(revisions, vec![1, 1], "batch assigns revisions in order");
        let batch_conflict = vec![record(VAULT_A, "epsilon", 1), record(VAULT_A, "gamma", 1)];
        let rejected = store.put_batch(batch_conflict, vec![None, Some(99)]);
        assert!(
            matches!(rejected, Err(StoreError::Conflict)),
            "conflicting batch rolls back"
        );
        assert!(
            matches!(store.get(VAULT_A, "epsilon"), Err(StoreError::NotFound)),
            "a rolled-back batch leaves no partial rows"
        );

        // 6. Tombstones stamp their deletion time (DATA-008); restore (a
        //    live put) clears the stamp and bumps the revision.
        store.tombstone(VAULT_A, "beta", 1).expect("tombstone");
        let stamp = store
            .tombstoned_at(VAULT_A, "beta")
            .expect("stamp is observable")
            .expect("a tombstone carries a stamp");
        assert!(stamp > 0, "stamps are epoch seconds");
        assert_eq_or_panic(
            store
                .tombstoned_at(VAULT_A, "acme")
                .expect("live rows answer")
                .is_none(),
            true,
            "live rows carry no stamp",
        );
        let mut restored = record(VAULT_A, "beta", 2);
        restored.tombstone = false;
        store
            .put(restored, Some(2))
            .expect("restore rewrites the row");
        assert_eq_or_panic(
            store
                .tombstoned_at(VAULT_A, "beta")
                .expect("restored row answers")
                .is_none(),
            true,
            "restore clears the deletion stamp",
        );

        // 7. Retention purge is cutoff-scoped, vault-scoped, and never
        //    removes live rows or fresh tombstones (DATA-008).
        store
            .tombstone(VAULT_A, "beta", 3)
            .expect("re-tombstone beta");
        let fresh = store
            .tombstoned_at(VAULT_A, "beta")
            .expect("stamp observable")
            .expect("fresh stamp");
        assert_eq_or_panic(
            store
                .purge_tombstoned_before(VAULT_A, fresh - 1)
                .expect("purge before the stamp"),
            0,
            "a tombstone younger than the cutoff survives",
        );
        assert!(
            store.get(VAULT_A, "beta").is_ok(),
            "the surviving tombstone is still readable for restore"
        );
        assert_eq_or_panic(
            store
                .purge_tombstoned_before(VAULT_A, fresh)
                .expect("purge at the stamp"),
            1,
            "the cutoff itself purges",
        );
        assert!(matches!(
            store.get(VAULT_A, "beta"),
            Err(StoreError::NotFound)
        ));
        assert_eq_or_panic(
            store
                .purge_tombstoned_before(VAULT_B, u64::MAX)
                .expect("other vault purge"),
            0,
            "live rows in another vault are never purged",
        );
        assert!(
            store.get(VAULT_A, "acme").is_ok() && store.get(VAULT_B, "acme").is_ok(),
            "live records survive every purge",
        );

        // 8. Atomic rekey (Master Password change): the whole vault moves
        //    scopes in one operation, Trash state travels (a tombstoned
        //    row arrives with a deletion stamp, so retention can still
        //    purge it), and a target collision refuses without effects.
        let vault_c = REKEY_TARGET;
        store
            .tombstone(VAULT_A, "delta", 1)
            .expect("tombstone delta before the rekey");
        let summaries = store.list(VAULT_A, 500, 0).expect("list vault A");
        assert!(!summaries.is_empty(), "vault A holds rows before the rekey");
        assert!(
            summaries.iter().any(|summary| summary.tombstone),
            "the trash state exists before the rekey",
        );
        let moved_records: Vec<_> = summaries
            .iter()
            .map(|summary| {
                let mut record = record(vault_c, summary.record_id.as_str(), 1);
                record.ciphertext = format!("rekeyed-{}", summary.record_id);
                record.tombstone = summary.tombstone;
                record
            })
            .collect();
        let moved = store
            .rekey_vault(VAULT_A, vault_c, moved_records)
            .expect("rekey commits");
        assert_eq_or_panic(moved, summaries.len() as u64, "every row moved");
        assert!(
            store.list(VAULT_A, 500, 0).expect("old scope").is_empty(),
            "the old scope is empty after the rekey",
        );
        assert_eq_or_panic(
            store.list(vault_c, 500, 0).expect("new scope").len(),
            summaries.len(),
            "the new scope holds every row (tombstones included)",
        );
        assert_eq_or_panic(
            store
                .purge_tombstoned_before(vault_c, u64::MAX)
                .expect("purge"),
            1,
            "a tombstoned rekey row carries a purgeable deletion stamp",
        );
        let collision = store.rekey_vault(VAULT_B, vault_c, vec![record(vault_c, "acme", 1)]);
        assert!(
            matches!(collision, Err(StoreError::Conflict)),
            "a rekey into an occupied scope refuses",
        );
        assert_eq_or_panic(
            store.list(VAULT_B, 500, 0).expect("vault B intact").len(),
            1,
            "the refused rekey left the source vault intact",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_passes_shared_contract() {
        contract::run(&InMemoryStore::new());
    }

    const VAULT: &str = "1010101010101010101010101010101f";

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
        let got = store.get(VAULT, "record-aaaa").unwrap();
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
        assert_eq!(store.get(VAULT, "record-cccc").unwrap().revision, 2);
    }

    #[test]
    fn missing_record_is_not_found() {
        let store = InMemoryStore::new();
        assert_eq!(
            store.get(VAULT, "absent").unwrap_err(),
            StoreError::NotFound
        );
    }

    #[test]
    fn list_is_sorted_and_stable() {
        let store = InMemoryStore::new();
        store.put(record("record-zeta", 1, false), None).unwrap();
        store.put(record("record-alpha", 1, false), None).unwrap();
        let ids: Vec<_> = store
            .list(VAULT, 100_000, 0)
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
        let rev = store.tombstone(VAULT, "record-dddd", 1).unwrap();
        assert_eq!(rev, 2);
        assert!(store.get(VAULT, "record-dddd").unwrap().tombstone);
    }

    #[test]
    fn tombstone_with_stale_revision_conflicts() {
        let store = InMemoryStore::new();
        store.put(record("record-eeee", 1, false), None).unwrap();
        store.tombstone(VAULT, "record-eeee", 1).unwrap();
        assert_eq!(
            store.tombstone(VAULT, "record-eeee", 1).unwrap_err(),
            StoreError::Conflict
        );
    }

    #[test]
    fn batch_commits_all_or_rolls_back_all() {
        // DATA-007: one conflicting row aborts the whole batch.
        let store = InMemoryStore::new();
        store.put(record("seed", 1, false), None).unwrap();
        let stale = record("seed", 2, false);
        // Claim a wrong prior revision for the seeded row.
        let batch = vec![record("fresh", 1, false), stale.clone()];
        let err = store.put_batch(batch, vec![None, Some(99)]).unwrap_err();
        assert_eq!(err, StoreError::Conflict);
        // Nothing applied: the fresh row is absent, the seed is untouched.
        assert_eq!(store.get(VAULT, "seed").unwrap().revision, 1);
        assert_eq!(store.get(VAULT, "fresh"), Err(StoreError::NotFound));

        // A fully valid batch commits every row atomically with its
        // assigned revisions.
        let revisions = store
            .put_batch(
                vec![record("multi-a", 1, false), record("multi-b", 1, false)],
                vec![None, None],
            )
            .unwrap();
        assert_eq!(revisions, vec![1, 1]);
        assert!(store.get(VAULT, "multi-a").is_ok());
        assert!(store.get(VAULT, "multi-b").is_ok());
    }

    #[test]
    fn invalid_record_rejected() {
        let store = InMemoryStore::new();
        let mut bad = record("record-ffff", 1, false);
        bad.protocol_version = 99;
        assert_eq!(store.put(bad, None).unwrap_err(), StoreError::InvalidRecord);
    }

    #[test]
    fn utc_format_matches_known_instants() {
        assert_eq!(super::format_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(super::format_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(super::format_utc(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(super::format_utc(86_399), "1970-01-01T23:59:59Z");
    }
}
