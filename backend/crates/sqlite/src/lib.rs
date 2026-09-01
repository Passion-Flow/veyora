//! Local SQLite backing store for the [`OpaqueStore`] port.
//!
//! Single-file persistence for the standalone desktop client: opaque
//! client-encrypted records in one database file inside a user-chosen
//! directory. Mirrors the managed-PostgreSQL adapter's transactional
//! compare-and-set semantics with WAL journaling so a crash never loses a
//! committed revision.
//!
//! As everywhere in the backend, this holds only opaque client-encrypted
//! ciphertext. It never decrypts, never accepts cleartext, and never handles
//! authentication material or keys.

#![forbid(unsafe_code)]

use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};

use backend_persistence::{
    GenericEncryptedRecordV1, OpaqueStore, PROTOCOL_VERSION, RecordSummary, SUITE_ID, StoreError,
};
use rusqlite::{Connection, OptionalExtension};

/// Synchronous SQLite backing store over a single database file.
///
/// The API layer already wraps every store call in `spawn_blocking`, and the
/// `Mutex` serializes access to the one connection, so transactional
/// compare-and-set needs no additional coordination.
pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    /// Open (or create) the database at `path` and apply the records schema.
    /// Idempotent: safe to call on every startup.
    ///
    /// WAL journaling with `synchronous = FULL` trades write throughput for
    /// the strongest crash-durability SQLite offers — the right trade for a
    /// local credential vault.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).map_err(|_| StoreError::StoreUnavailable)?;
        }
        let conn = Connection::open(path).map_err(|_| StoreError::StoreUnavailable)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(|_| StoreError::StoreUnavailable)?;
        conn.execute_batch(include_str!("../migrations/0001_records.sql"))
            .map_err(|_| StoreError::StoreUnavailable)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Fold the write-ahead log back into the database file so the file (and
    /// any copy of it) is self-contained. Used before backups and storage
    /// relocation.
    pub fn checkpoint(&self) -> Result<(), StoreError> {
        self.lock()
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|_| StoreError::StoreUnavailable)?;
        Ok(())
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn validate(record: &GenericEncryptedRecordV1) -> Result<(), StoreError> {
        if record.protocol_version != PROTOCOL_VERSION
            || record.suite_id != SUITE_ID
            || record.revision == 0
            || record.ciphertext.is_empty()
            || record.record_id.is_empty()
            || record.ciphertext_hash.is_empty()
        {
            return Err(StoreError::InvalidRecord);
        }
        Ok(())
    }

    fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<GenericEncryptedRecordV1> {
        Ok(GenericEncryptedRecordV1 {
            protocol_version: row.get::<_, i64>("protocol_version")? as u16,
            suite_id: row.get::<_, i64>("suite_id")? as u16,
            deployment_id: row.get("deployment_id")?,
            vault_id: row.get("vault_id")?,
            record_id: row.get("record_id")?,
            revision: row.get::<_, i64>("revision")? as u64,
            ciphertext: row.get("ciphertext")?,
            ciphertext_hash: row.get("ciphertext_hash")?,
            ciphertext_length: row.get::<_, i64>("ciphertext_length")? as u64,
            tombstone: row.get::<_, i64>("tombstone")? != 0,
            template_envelope_hash: row.get("template_envelope_hash")?,
            manifest_binding: row.get("manifest_binding")?,
        })
    }

    fn list_rows(&self, sql: &str) -> Result<Vec<GenericEncryptedRecordV1>, StoreError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(sql)
            .map_err(|_| StoreError::StoreUnavailable)?;
        let rows = stmt
            .query_map([], Self::row_to_record)
            .map_err(|_| StoreError::StoreUnavailable)?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row.map_err(|_| StoreError::StoreUnavailable)?);
        }
        Ok(records)
    }
}

const SELECT_REVISION: &str = "SELECT revision FROM records WHERE record_id = ?1";
const SELECT_RECORD: &str = "SELECT record_id, revision, protocol_version, suite_id, \
     deployment_id, vault_id, ciphertext, ciphertext_hash, ciphertext_length, tombstone, \
     template_envelope_hash, manifest_binding FROM records";
const INSERT_RECORD: &str = "
    INSERT INTO records
      (record_id, revision, protocol_version, suite_id, deployment_id, vault_id,
       ciphertext, ciphertext_hash, ciphertext_length, tombstone,
       template_envelope_hash, manifest_binding)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)";
const UPDATE_RECORD: &str = "
    UPDATE records SET
      revision = ?1, ciphertext = ?2, ciphertext_hash = ?3, ciphertext_length = ?4,
      tombstone = ?5, template_envelope_hash = ?6, manifest_binding = ?7,
      deployment_id = ?8, vault_id = ?9, protocol_version = ?10, suite_id = ?11
    WHERE record_id = ?12";

impl OpaqueStore for SqliteStore {
    fn put(
        &self,
        record: GenericEncryptedRecordV1,
        expected_prior_revision: Option<u64>,
    ) -> Result<u64, StoreError> {
        Self::validate(&record)?;
        let mut conn = self.lock();
        let tx = conn
            .transaction()
            .map_err(|_| StoreError::StoreUnavailable)?;
        let prior: Option<i64> = tx
            .query_row(SELECT_REVISION, [&record.record_id], |row| {
                row.get::<_, i64>(0)
            })
            .optional()
            .map_err(|_| StoreError::StoreUnavailable)?;
        let next: i64 = match (prior, expected_prior_revision) {
            (None, None) => 1,
            (None, Some(_)) => return Err(StoreError::Conflict),
            (Some(existing), Some(expected)) if existing as u64 == expected => existing + 1,
            _ => return Err(StoreError::Conflict),
        };
        let written = if prior.is_some() {
            tx.execute(
                UPDATE_RECORD,
                rusqlite::params![
                    next,
                    record.ciphertext,
                    record.ciphertext_hash,
                    record.ciphertext_length as i64,
                    record.tombstone as i64,
                    record.template_envelope_hash,
                    record.manifest_binding,
                    record.deployment_id,
                    record.vault_id,
                    record.protocol_version as i64,
                    record.suite_id as i64,
                    record.record_id,
                ],
            )
        } else {
            tx.execute(
                INSERT_RECORD,
                rusqlite::params![
                    record.record_id,
                    next,
                    record.protocol_version as i64,
                    record.suite_id as i64,
                    record.deployment_id,
                    record.vault_id,
                    record.ciphertext,
                    record.ciphertext_hash,
                    record.ciphertext_length as i64,
                    record.tombstone as i64,
                    record.template_envelope_hash,
                    record.manifest_binding,
                ],
            )
        }
        .map_err(|_| StoreError::StoreUnavailable)?;
        if written != 1 {
            return Err(StoreError::StoreUnavailable);
        }
        tx.commit().map_err(|_| StoreError::StoreUnavailable)?;
        Ok(next as u64)
    }

    fn get(&self, record_id: &str) -> Result<GenericEncryptedRecordV1, StoreError> {
        self.lock()
            .query_row(
                &format!("{SELECT_RECORD} WHERE record_id = ?1"),
                [record_id],
                Self::row_to_record,
            )
            .optional()
            .map_err(|_| StoreError::StoreUnavailable)?
            .ok_or(StoreError::NotFound)
    }

    fn list(&self) -> Result<Vec<RecordSummary>, StoreError> {
        let records = self.list_rows(&format!("{SELECT_RECORD} ORDER BY record_id"))?;
        Ok(records
            .into_iter()
            .map(|record| RecordSummary {
                record_id: record.record_id,
                revision: record.revision,
                tombstone: record.tombstone,
                ciphertext_hash: record.ciphertext_hash,
            })
            .collect())
    }

    fn list_bodies(&self) -> Result<Vec<GenericEncryptedRecordV1>, StoreError> {
        self.list_rows(&format!("{SELECT_RECORD} ORDER BY record_id"))
    }

    fn tombstone(&self, record_id: &str, expected_prior_revision: u64) -> Result<u64, StoreError> {
        let mut conn = self.lock();
        let tx = conn
            .transaction()
            .map_err(|_| StoreError::StoreUnavailable)?;
        let prior: i64 = tx
            .query_row(SELECT_REVISION, [record_id], |row| row.get::<_, i64>(0))
            .optional()
            .map_err(|_| StoreError::StoreUnavailable)?
            .ok_or(StoreError::NotFound)?;
        if prior as u64 != expected_prior_revision {
            return Err(StoreError::Conflict);
        }
        let next = prior + 1;
        let updated = tx
            .execute(
                "UPDATE records SET revision = ?1, tombstone = 1 WHERE record_id = ?2",
                rusqlite::params![next, record_id],
            )
            .map_err(|_| StoreError::StoreUnavailable)?;
        if updated != 1 {
            return Err(StoreError::StoreUnavailable);
        }
        tx.commit().map_err(|_| StoreError::StoreUnavailable)?;
        Ok(next as u64)
    }

    fn purge_tombstoned(&self) -> Result<u64, StoreError> {
        self.lock()
            .execute("DELETE FROM records WHERE tombstone = 1", [])
            .map(|purged| purged as u64)
            .map_err(|_| StoreError::StoreUnavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Unique temp path per test run; SQLite also creates `-wal`/`-shm`
    /// sidecar files, so tests remove all three on cleanup.
    fn temp_db_path() -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("veyora-sqlite-test-{}-{n}.db", std::process::id()))
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
        let mut wal = path.as_os_str().to_os_string();
        wal.push("-wal");
        let _ = std::fs::remove_file(&wal);
        let mut shm = path.as_os_str().to_os_string();
        shm.push("-shm");
        let _ = std::fs::remove_file(&shm);
    }

    fn record(id: &str, revision: u64) -> GenericEncryptedRecordV1 {
        GenericEncryptedRecordV1 {
            protocol_version: 1,
            suite_id: 1,
            deployment_id: "0000000000000000000000000000000f".to_string(),
            vault_id: "1010101010101010101010101010101f".to_string(),
            record_id: id.to_string(),
            revision,
            ciphertext: "a5".repeat(32),
            ciphertext_hash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
                .to_string(),
            ciphertext_length: 32,
            tombstone: false,
            template_envelope_hash:
                "0000000000000000000000000000000000000000000000000000000000000001".to_string(),
            manifest_binding: "0000000000000000000000000000000000000000000000000000000000000002"
                .to_string(),
        }
    }

    #[test]
    fn round_trips_and_cas_conflicts() {
        let path = temp_db_path();
        let store = SqliteStore::open(&path).expect("open");
        assert_eq!(store.put(record("sqlite-inert", 1), None).unwrap(), 1);
        let updated = record("sqlite-inert", 1);
        assert_eq!(store.put(updated.clone(), Some(1)).unwrap(), 2);
        assert_eq!(store.get("sqlite-inert").unwrap().revision, 2);
        assert_eq!(
            store.put(updated, Some(99)).unwrap_err(),
            StoreError::Conflict
        );
        assert_eq!(
            store.put(record("sqlite-inert", 1), None).unwrap_err(),
            StoreError::Conflict
        );
        // Tombstone + purge mirror the Postgres adapter.
        assert_eq!(store.tombstone("sqlite-inert", 2).unwrap(), 3);
        assert!(store.get("sqlite-inert").unwrap().tombstone);
        assert_eq!(store.purge_tombstoned().unwrap(), 1);
        assert_eq!(store.get("sqlite-inert").unwrap_err(), StoreError::NotFound);
        drop(store);
        cleanup(&path);
    }

    #[test]
    fn reopen_preserves_committed_records() {
        let path = temp_db_path();
        {
            let store = SqliteStore::open(&path).expect("open");
            store.put(record("persist-a", 1), None).unwrap();
            store.put(record("persist-b", 1), None).unwrap();
            store.checkpoint().unwrap();
        }
        // A fresh store over the same file must see the committed records —
        // the property that separates this adapter from the volatile
        // InMemoryStore.
        let store = SqliteStore::open(&path).expect("reopen");
        let ids: Vec<String> = store
            .list()
            .unwrap()
            .into_iter()
            .map(|s| s.record_id)
            .collect();
        assert_eq!(ids, vec!["persist-a".to_string(), "persist-b".to_string()]);
        assert_eq!(store.list_bodies().unwrap().len(), 2);
        drop(store);
        cleanup(&path);
    }

    #[test]
    fn rejects_invalid_records() {
        let path = temp_db_path();
        let store = SqliteStore::open(&path).expect("open");
        let mut bad = record("sqlite-bad", 1);
        bad.protocol_version = 999;
        assert_eq!(store.put(bad, None).unwrap_err(), StoreError::InvalidRecord);
        let mut empty = record("sqlite-empty", 1);
        empty.ciphertext = String::new();
        assert_eq!(
            store.put(empty, None).unwrap_err(),
            StoreError::InvalidRecord
        );
        drop(store);
        cleanup(&path);
    }

    #[test]
    fn list_bodies_round_trips_every_field() {
        let path = temp_db_path();
        let store = SqliteStore::open(&path).expect("open");
        let original = record("fields", 1);
        store.put(original.clone(), None).unwrap();
        let reloaded = store.list_bodies().unwrap().pop().unwrap();
        assert_eq!(reloaded, original);
        drop(store);
        cleanup(&path);
    }
}
