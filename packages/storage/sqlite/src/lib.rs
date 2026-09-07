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
        const MIGRATIONS: [&str; 2] = [
            include_str!("../migrations/0001_records.sql"),
            include_str!("../migrations/0002_records_vault_scope.sql"),
        ];
        for migration in MIGRATIONS {
            conn.execute_batch(migration)
                .map_err(|_| StoreError::StoreUnavailable)?;
        }
        // DATA-008 retention stamp: SQLite cannot express `ADD COLUMN IF
        // NOT EXISTS`, so the ensure step checks the table info first. Any
        // tombstone left over from before this column keeps a NULL stamp;
        // backfilling with the current epoch starts its retention window
        // now, which never purges earlier than the operator expects.
        let has_stamp: bool = {
            let mut stmt = conn
                .prepare("SELECT count(*) FROM pragma_table_info('records') WHERE name = 'tombstoned_at'")
                .map_err(|_| StoreError::StoreUnavailable)?;
            let count: i64 = stmt
                .query_row([], |row| row.get(0))
                .map_err(|_| StoreError::StoreUnavailable)?;
            count > 0
        };
        if !has_stamp {
            conn.execute_batch(
                "ALTER TABLE records ADD COLUMN tombstoned_at INTEGER;
                 UPDATE records
                    SET tombstoned_at = CAST(strftime('%s','now') AS INTEGER)
                  WHERE tombstone = 1 AND tombstoned_at IS NULL;",
            )
            .map_err(|_| StoreError::StoreUnavailable)?;
        }
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// The distinct vault IDs present in this local database. A desktop
    /// local vault holds exactly one; an empty database holds none.
    pub fn vault_ids(&self) -> Result<Vec<String>, StoreError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT DISTINCT vault_id FROM records ORDER BY vault_id")
            .map_err(|_| StoreError::StoreUnavailable)?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| StoreError::StoreUnavailable)?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row.map_err(|_| StoreError::StoreUnavailable)?);
        }
        Ok(ids)
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

    fn list_rows(
        &self,
        sql: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<GenericEncryptedRecordV1>, StoreError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(sql)
            .map_err(|_| StoreError::StoreUnavailable)?;
        let rows = stmt
            .query_map(params, Self::row_to_record)
            .map_err(|_| StoreError::StoreUnavailable)?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row.map_err(|_| StoreError::StoreUnavailable)?);
        }
        Ok(records)
    }
}

const SELECT_REVISION: &str = "SELECT revision FROM records WHERE vault_id = ?1 AND record_id = ?2";
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
      deployment_id = ?8, vault_id = ?9, protocol_version = ?10, suite_id = ?11,
      tombstoned_at = CASE WHEN ?5 = 0 THEN NULL ELSE tombstoned_at END
    WHERE vault_id = ?12 AND record_id = ?13";

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
            .query_row(
                SELECT_REVISION,
                rusqlite::params![record.vault_id, record.record_id],
                |row| row.get::<_, i64>(0),
            )
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
                    record.vault_id,
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

    fn put_batch(
        &self,
        records: Vec<GenericEncryptedRecordV1>,
        expected_prior_revisions: Vec<Option<u64>>,
    ) -> Result<Vec<u64>, StoreError> {
        for record in &records {
            Self::validate(record)?;
        }
        let mut conn = self.lock();
        let tx = conn
            .transaction()
            .map_err(|_| StoreError::StoreUnavailable)?;
        let mut revisions = Vec::with_capacity(records.len());
        // One transaction for the whole batch: an early error return drops
        // the transaction and rolls every row back (DATA-007).
        for (record, expected) in records.into_iter().zip(expected_prior_revisions) {
            let prior: Option<i64> = tx
                .query_row(
                    SELECT_REVISION,
                    rusqlite::params![record.vault_id, record.record_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(|_| StoreError::StoreUnavailable)?;
            let next: i64 = match (prior, expected) {
                (None, None) => 1,
                (None, Some(_)) => return Err(StoreError::Conflict),
                (Some(existing), Some(want)) if existing as u64 == want => existing + 1,
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
                        record.vault_id,
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
            };
            if written.map(|n| n != 1).unwrap_or(true) {
                return Err(StoreError::StoreUnavailable);
            }
            revisions.push(next as u64);
        }
        tx.commit().map_err(|_| StoreError::StoreUnavailable)?;
        Ok(revisions)
    }

    fn get(&self, vault_id: &str, record_id: &str) -> Result<GenericEncryptedRecordV1, StoreError> {
        self.lock()
            .query_row(
                &format!("{SELECT_RECORD} WHERE vault_id = ?1 AND record_id = ?2"),
                rusqlite::params![vault_id, record_id],
                Self::row_to_record,
            )
            .optional()
            .map_err(|_| StoreError::StoreUnavailable)?
            .ok_or(StoreError::NotFound)
    }

    fn list(
        &self,
        vault_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<RecordSummary>, StoreError> {
        let records = self.list_rows(
            &format!("{SELECT_RECORD} WHERE vault_id = ?1 ORDER BY record_id LIMIT ?2 OFFSET ?3"),
            rusqlite::params![vault_id, (limit as i64), (offset as i64)],
        )?;
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

    fn list_bodies(
        &self,
        vault_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<GenericEncryptedRecordV1>, StoreError> {
        self.list_rows(
            &format!("{SELECT_RECORD} WHERE vault_id = ?1 ORDER BY record_id LIMIT ?2 OFFSET ?3"),
            rusqlite::params![vault_id, (limit as i64), (offset as i64)],
        )
    }

    fn tombstone(
        &self,
        vault_id: &str,
        record_id: &str,
        expected_prior_revision: u64,
    ) -> Result<u64, StoreError> {
        let mut conn = self.lock();
        let tx = conn
            .transaction()
            .map_err(|_| StoreError::StoreUnavailable)?;
        let prior: i64 = tx
            .query_row(
                SELECT_REVISION,
                rusqlite::params![vault_id, record_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|_| StoreError::StoreUnavailable)?
            .ok_or(StoreError::NotFound)?;
        if prior as u64 != expected_prior_revision {
            return Err(StoreError::Conflict);
        }
        let next = prior + 1;
        let stamp = backend_persistence::utc_now_epoch() as i64;
        let updated = tx
            .execute(
                "UPDATE records SET revision = ?1, tombstone = 1, tombstoned_at = ?4\n                 WHERE vault_id = ?2 AND record_id = ?3",
                rusqlite::params![next, vault_id, record_id, stamp],
            )
            .map_err(|_| StoreError::StoreUnavailable)?;
        if updated != 1 {
            return Err(StoreError::StoreUnavailable);
        }
        tx.commit().map_err(|_| StoreError::StoreUnavailable)?;
        Ok(next as u64)
    }

    fn rekey_vault(
        &self,
        vault_id: &str,
        to_vault_id: &str,
        records: Vec<GenericEncryptedRecordV1>,
    ) -> Result<u64, StoreError> {
        for record in &records {
            Self::validate(record)?;
        }
        if to_vault_id.is_empty() || to_vault_id == vault_id {
            return Err(StoreError::InvalidRecord);
        }
        let mut conn = self.lock();
        let tx = conn
            .transaction()
            .map_err(|_| StoreError::StoreUnavailable)?;
        let mut moved = 0u64;
        // One transaction: any target collision or failure rolls every
        // insert and the scope deletion back with it.
        for mut record in records {
            let exists = tx
                .query_row(
                    SELECT_REVISION,
                    rusqlite::params![to_vault_id, record.record_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|_| StoreError::StoreUnavailable)?;
            if exists.is_some() {
                return Err(StoreError::Conflict);
            }
            record.vault_id = to_vault_id.to_string();
            record.revision = 1;
            tx.execute(
                INSERT_RECORD,
                rusqlite::params![
                    record.record_id,
                    1i64,
                    record.protocol_version,
                    record.suite_id,
                    record.deployment_id,
                    record.vault_id,
                    record.ciphertext,
                    record.ciphertext_hash,
                    record.ciphertext_length,
                    record.tombstone,
                    record.template_envelope_hash,
                    record.manifest_binding,
                ],
            )
            .map_err(|_| StoreError::StoreUnavailable)?;
            // A row that arrives tombstoned must carry a deletion stamp,
            // or the retention purge could never remove it.
            if record.tombstone {
                let stamp = backend_persistence::utc_now_epoch() as i64;
                tx.execute(
                    "UPDATE records SET tombstoned_at = ?1 WHERE vault_id = ?2 AND record_id = ?3",
                    rusqlite::params![stamp, to_vault_id, record.record_id],
                )
                .map_err(|_| StoreError::StoreUnavailable)?;
            }
            moved += 1;
        }
        tx.execute(
            "DELETE FROM records WHERE vault_id = ?1",
            rusqlite::params![vault_id],
        )
        .map_err(|_| StoreError::StoreUnavailable)?;
        tx.commit().map_err(|_| StoreError::StoreUnavailable)?;
        Ok(moved)
    }

    fn tombstoned_at(&self, vault_id: &str, record_id: &str) -> Result<Option<u64>, StoreError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT tombstoned_at FROM records WHERE vault_id = ?1 AND record_id = ?2")
            .map_err(|_| StoreError::StoreUnavailable)?;
        let stamp: Option<i64> = stmt
            .query_row(rusqlite::params![vault_id, record_id], |row| row.get(0))
            .optional()
            .map_err(|_| StoreError::StoreUnavailable)?
            .ok_or(StoreError::NotFound)?;
        Ok(stamp.map(|seconds| seconds as u64))
    }

    fn purge_tombstoned_before(
        &self,
        vault_id: &str,
        before_epoch_seconds: u64,
    ) -> Result<u64, StoreError> {
        self.lock()
            .execute(
                "DELETE FROM records
                  WHERE vault_id = ?1 AND tombstone = 1
                    AND tombstoned_at IS NOT NULL AND tombstoned_at <= ?2",
                rusqlite::params![
                    vault_id,
                    (i64::try_from(before_epoch_seconds).unwrap_or(i64::MAX))
                ],
            )
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

    const VAULT: &str = "1010101010101010101010101010101f";

    #[test]
    fn rekey_stamps_tombstoned_rows_for_purge() {
        let path = temp_db_path();
        cleanup(&path);
        let store = SqliteStore::open(&path).expect("open");
        store.put(record("trashed", 1), None).unwrap();
        store.tombstone(VAULT, "trashed", 1).unwrap();
        let mut moved = record("trashed", 1);
        moved.tombstone = true;
        let purged_scope = "ee0000000000000000000000000000f";
        moved.vault_id = purged_scope.to_string();
        store.rekey_vault(VAULT, purged_scope, vec![moved]).unwrap();
        let stamp = store.tombstoned_at(purged_scope, "trashed").unwrap();
        assert!(
            stamp.is_some(),
            "the rekeyed tombstone carries a stamp (got {stamp:?})"
        );
        assert_eq!(
            store
                .purge_tombstoned_before(purged_scope, u64::MAX)
                .unwrap(),
            1
        );
        drop(store);
        cleanup(&path);
    }

    #[test]
    fn sqlite_passes_shared_contract() {
        let path = std::env::temp_dir().join("veyora-sqlite-contract-test.db");
        cleanup(&path); // a failed earlier run may have left the database
        let store = SqliteStore::open(&path).expect("open");
        backend_persistence::contract::run(&store);
        backend_persistence::contract::run_concurrently(&store);
        drop(store);
        cleanup(&path);
    }

    #[test]
    fn retention_purges_only_expired_tombstones() {
        let path = std::env::temp_dir().join("veyora-sqlite-retention-test.db");
        cleanup(&path); // a failed earlier run may have left the database
        let store = SqliteStore::open(&path).expect("open");
        store.put(record("old-trash", 1), None).unwrap();
        store.put(record("new-trash", 1), None).unwrap();
        store.put(record("live-one", 1), None).unwrap();
        store.tombstone(VAULT, "old-trash", 1).unwrap();
        store.tombstone(VAULT, "new-trash", 1).unwrap();
        // Backdate one deletion stamp through the database itself: only a
        // direct SQL debug channel can prove the age window (40 days old
        // vs a 30-day policy), not just the cutoff boundary.
        {
            let conn = rusqlite::Connection::open(&path).expect("backdate connection");
            conn.execute(
                "UPDATE records SET tombstoned_at = ?1 WHERE record_id = 'old-trash'",
                rusqlite::params![((backend_persistence::utc_now_epoch() - 40 * 86_400) as i64)],
            )
            .expect("backdate");
        }
        let cutoff = backend_persistence::utc_now_epoch() - 30 * 86_400;
        assert_eq!(store.purge_tombstoned_before(VAULT, cutoff).unwrap(), 1);
        assert_eq!(store.get(VAULT, "old-trash"), Err(StoreError::NotFound));
        // The fresh tombstone and every live row survive the sweep.
        assert!(store.get(VAULT, "new-trash").unwrap().tombstone);
        assert!(store.get(VAULT, "live-one").unwrap().revision >= 1);
        drop(store);
        cleanup(&path);
    }

    #[test]
    fn batch_commits_all_or_rolls_back_all() {
        let path = std::env::temp_dir().join("veyora-sqlite-batch-test.db");
        let store = SqliteStore::open(&path).expect("open");
        store.put(record("seed", 1), None).unwrap();
        // One stale CAS row aborts the whole batch: nothing is applied.
        let err = store
            .put_batch(
                vec![record("fresh", 1), record("seed", 2)],
                vec![None, Some(99)],
            )
            .unwrap_err();
        assert_eq!(err, StoreError::Conflict);
        assert_eq!(store.get(VAULT, "seed").unwrap().revision, 1);
        assert_eq!(store.get(VAULT, "fresh"), Err(StoreError::NotFound));
        // A valid batch commits atomically.
        let revisions = store
            .put_batch(
                vec![record("multi-a", 1), record("multi-b", 1)],
                vec![None, None],
            )
            .unwrap();
        assert_eq!(revisions, vec![1, 1]);
        drop(store);
        cleanup(&path);
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
        assert_eq!(store.get(VAULT, "sqlite-inert").unwrap().revision, 2);
        assert_eq!(
            store.put(updated, Some(99)).unwrap_err(),
            StoreError::Conflict
        );
        assert_eq!(
            store.put(record("sqlite-inert", 1), None).unwrap_err(),
            StoreError::Conflict
        );
        // Tombstone + purge mirror the Postgres adapter; the current epoch
        // is the "purge everything tombstoned now" cutoff (DATA-008).
        assert_eq!(store.tombstone(VAULT, "sqlite-inert", 2).unwrap(), 3);
        assert!(store.get(VAULT, "sqlite-inert").unwrap().tombstone);
        assert_eq!(
            store
                .purge_tombstoned_before(VAULT, backend_persistence::utc_now_epoch())
                .unwrap(),
            1
        );
        assert_eq!(
            store.get(VAULT, "sqlite-inert").unwrap_err(),
            StoreError::NotFound
        );
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
            .list(VAULT, 100_000, 0)
            .unwrap()
            .into_iter()
            .map(|s| s.record_id)
            .collect();
        assert_eq!(ids, vec!["persist-a".to_string(), "persist-b".to_string()]);
        assert_eq!(store.list_bodies(VAULT, 100_000, 0).unwrap().len(), 2);
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
        let reloaded = store.list_bodies(VAULT, 100_000, 0).unwrap().pop().unwrap();
        assert_eq!(reloaded, original);
        drop(store);
        cleanup(&path);
    }
}
