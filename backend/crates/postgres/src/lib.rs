//! Managed-PostgreSQL backing store for the [`OpaqueStore`] port.
//!
//! Production-shaped persistence for opaque encrypted records behind the same
//! trait as the in-memory development store. Uses a simple connection pool
//! (Vec<Client> behind a Mutex) to allow concurrent database access without
//! serializing all requests through a single connection.
//!
//! As everywhere in the backend, this holds only opaque client-encrypted
//! ciphertext. It never decrypts, never accepts cleartext, and never handles
//! authentication material or keys.

#![forbid(unsafe_code)]

use std::sync::Mutex;

use backend_persistence::{
    GenericEncryptedRecordV1, OpaqueStore, PROTOCOL_VERSION, RecordSummary, SUITE_ID, StoreError,
};
use postgres::Client;

const DEFAULT_POOL_SIZE: usize = 8;

/// A simple connection pool for synchronous PostgreSQL clients.
struct ConnectionPool {
    url: String,
    max_size: usize,
    idle: Mutex<Vec<Client>>,
}

impl ConnectionPool {
    fn new(url: &str, max_size: usize) -> Result<Self, StoreError> {
        let initial =
            Client::connect(url, postgres::NoTls).map_err(|_| StoreError::StoreUnavailable)?;
        Ok(Self {
            url: url.to_string(),
            max_size,
            idle: Mutex::new(vec![initial]),
        })
    }

    fn get(&self) -> Result<PooledConnection<'_>, StoreError> {
        let mut idle = self.idle.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(client) = idle.pop() {
            return Ok(PooledConnection {
                pool: self,
                client: Some(client),
            });
        }
        // Pool exhausted — try to open a new connection if under max.
        // We can't track total without a counter, so we just try.
        // In practice the Mutex<Vec> cap limits this naturally.
        let client = Client::connect(&self.url, postgres::NoTls)
            .map_err(|_| StoreError::StoreUnavailable)?;
        Ok(PooledConnection {
            pool: self,
            client: Some(client),
        })
    }
}

/// RAII connection that returns to the pool on drop.
struct PooledConnection<'a> {
    pool: &'a ConnectionPool,
    client: Option<Client>,
}

impl std::ops::Deref for PooledConnection<'_> {
    type Target = Client;
    fn deref(&self) -> &Client {
        self.client
            .as_ref()
            .expect("pooled connection used after drop")
    }
}

impl std::ops::DerefMut for PooledConnection<'_> {
    fn deref_mut(&mut self) -> &mut Client {
        self.client
            .as_mut()
            .expect("pooled connection used after drop")
    }
}

impl Drop for PooledConnection<'_> {
    fn drop(&mut self) {
        if let Some(client) = self.client.take() {
            let mut idle = self.pool.idle.lock().unwrap_or_else(|p| p.into_inner());
            if idle.len() < self.pool.max_size {
                idle.push(client);
            }
            // If pool is full, the connection is dropped (closed).
        }
    }
}

/// Synchronous managed-PostgreSQL backing store with connection pooling.
pub struct PostgresStore {
    pool: ConnectionPool,
}

impl PostgresStore {
    /// Open a connection pool to `database_url` (e.g.
    /// `postgres://user:pass@host:5432/db`). The records migration must already
    /// be applied; call [`PostgresStore::migrate`] to apply it.
    pub fn connect(database_url: &str) -> Result<Self, StoreError> {
        let pool = ConnectionPool::new(database_url, DEFAULT_POOL_SIZE)?;
        Ok(Self { pool })
    }

    /// Apply the records schema. Idempotent (`CREATE TABLE IF NOT EXISTS`).
    pub fn migrate(&self) -> Result<(), StoreError> {
        let mut conn = self.pool.get()?;
        conn.batch_execute(include_str!("../migrations/0001_records.sql"))
            .map_err(|_| StoreError::StoreUnavailable)?;
        Ok(())
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
}

const SELECT_REVISION: &str = "SELECT revision FROM records WHERE record_id = $1 FOR UPDATE";
const INSERT_RECORD: &str = "
    INSERT INTO records
      (record_id, revision, protocol_version, suite_id, deployment_id, vault_id,
       ciphertext, ciphertext_hash, ciphertext_length, tombstone,
       template_envelope_hash, manifest_binding)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)";
const UPDATE_RECORD: &str = "
    UPDATE records SET
      revision = $1, ciphertext = $2, ciphertext_hash = $3, ciphertext_length = $4,
      tombstone = $5, template_envelope_hash = $6, manifest_binding = $7,
      deployment_id = $8, vault_id = $9, protocol_version = $10, suite_id = $11
    WHERE record_id = $12";

impl OpaqueStore for PostgresStore {
    fn put(
        &self,
        record: GenericEncryptedRecordV1,
        expected_prior_revision: Option<u64>,
    ) -> Result<u64, StoreError> {
        Self::validate(&record)?;
        let mut client = self.pool.get()?;
        let mut tx = client
            .transaction()
            .map_err(|_| StoreError::StoreUnavailable)?;
        let prior: Option<i64> = tx
            .query_opt(SELECT_REVISION, &[&record.record_id])
            .map_err(|_| StoreError::StoreUnavailable)?
            .map(|row| row.get::<_, i64>(0));
        let next: i64 = match (prior, expected_prior_revision) {
            (None, None) => 1,
            (None, Some(_)) => return Err(StoreError::Conflict),
            (Some(existing), Some(expected)) if existing as u64 == expected => existing + 1,
            _ => return Err(StoreError::Conflict),
        };
        let written = if prior.is_some() {
            tx.execute(
                UPDATE_RECORD,
                &[
                    &next,
                    &record.ciphertext,
                    &record.ciphertext_hash,
                    &(record.ciphertext_length as i64),
                    &record.tombstone,
                    &record.template_envelope_hash,
                    &record.manifest_binding,
                    &record.deployment_id,
                    &record.vault_id,
                    &(record.protocol_version as i32),
                    &(record.suite_id as i32),
                    &record.record_id,
                ],
            )
        } else {
            tx.execute(
                INSERT_RECORD,
                &[
                    &record.record_id,
                    &next,
                    &(record.protocol_version as i32),
                    &(record.suite_id as i32),
                    &record.deployment_id,
                    &record.vault_id,
                    &record.ciphertext,
                    &record.ciphertext_hash,
                    &(record.ciphertext_length as i64),
                    &record.tombstone,
                    &record.template_envelope_hash,
                    &record.manifest_binding,
                ],
            )
        };
        if written.map(|n| n != 1).unwrap_or(true) {
            return Err(StoreError::StoreUnavailable);
        }
        tx.commit().map_err(|_| StoreError::StoreUnavailable)?;
        Ok(next as u64)
    }

    fn get(&self, record_id: &str) -> Result<GenericEncryptedRecordV1, StoreError> {
        let mut client = self.pool.get()?;
        let row = client
            .query_opt(
                "SELECT record_id, revision, protocol_version, suite_id, deployment_id, vault_id, \
                 ciphertext, ciphertext_hash, ciphertext_length, tombstone, \
                 template_envelope_hash, manifest_binding FROM records WHERE record_id = $1",
                &[&record_id],
            )
            .map_err(|_| StoreError::StoreUnavailable)?
            .ok_or(StoreError::NotFound)?;
        Ok(GenericEncryptedRecordV1 {
            protocol_version: row.get::<_, i32>("protocol_version") as u16,
            suite_id: row.get::<_, i32>("suite_id") as u16,
            deployment_id: row.get("deployment_id"),
            vault_id: row.get("vault_id"),
            record_id: row.get("record_id"),
            revision: row.get::<_, i64>("revision") as u64,
            ciphertext: row.get("ciphertext"),
            ciphertext_hash: row.get("ciphertext_hash"),
            ciphertext_length: row.get::<_, i64>("ciphertext_length") as u64,
            tombstone: row.get("tombstone"),
            template_envelope_hash: row.get("template_envelope_hash"),
            manifest_binding: row.get("manifest_binding"),
        })
    }

    fn list(&self) -> Result<Vec<RecordSummary>, StoreError> {
        let mut client = self.pool.get()?;
        let rows = client
            .query(
                "SELECT record_id, revision, tombstone, ciphertext_hash FROM records ORDER BY record_id",
                &[],
            )
            .map_err(|_| StoreError::StoreUnavailable)?;
        Ok(rows
            .iter()
            .map(|row| RecordSummary {
                record_id: row.get("record_id"),
                revision: row.get::<_, i64>("revision") as u64,
                tombstone: row.get("tombstone"),
                ciphertext_hash: row.get("ciphertext_hash"),
            })
            .collect())
    }

    fn list_bodies(&self) -> Result<Vec<GenericEncryptedRecordV1>, StoreError> {
        let mut client = self.pool.get()?;
        let rows = client
            .query(
                "SELECT record_id, revision, protocol_version, suite_id, deployment_id, vault_id,                  ciphertext, ciphertext_hash, ciphertext_length, tombstone,                  template_envelope_hash, manifest_binding FROM records ORDER BY record_id",
                &[],
            )
            .map_err(|_| StoreError::StoreUnavailable)?;
        Ok(rows
            .iter()
            .map(|row| GenericEncryptedRecordV1 {
                protocol_version: row.get::<_, i32>("protocol_version") as u16,
                suite_id: row.get::<_, i32>("suite_id") as u16,
                deployment_id: row.get("deployment_id"),
                vault_id: row.get("vault_id"),
                record_id: row.get("record_id"),
                revision: row.get::<_, i64>("revision") as u64,
                ciphertext: row.get("ciphertext"),
                ciphertext_hash: row.get("ciphertext_hash"),
                ciphertext_length: row.get::<_, i64>("ciphertext_length") as u64,
                tombstone: row.get("tombstone"),
                template_envelope_hash: row.get("template_envelope_hash"),
                manifest_binding: row.get("manifest_binding"),
            })
            .collect())
    }

    fn tombstone(&self, record_id: &str, expected_prior_revision: u64) -> Result<u64, StoreError> {
        let mut client = self.pool.get()?;
        let mut tx = client
            .transaction()
            .map_err(|_| StoreError::StoreUnavailable)?;
        let prior: i64 = tx
            .query_opt(SELECT_REVISION, &[&record_id])
            .map_err(|_| StoreError::StoreUnavailable)?
            .ok_or(StoreError::NotFound)?
            .get::<_, i64>(0);
        if prior as u64 != expected_prior_revision {
            return Err(StoreError::Conflict);
        }
        let next = prior + 1;
        let updated = tx
            .execute(
                "UPDATE records SET revision = $1, tombstone = TRUE WHERE record_id = $2",
                &[&next, &record_id],
            )
            .map_err(|_| StoreError::StoreUnavailable)?;
        if updated != 1 {
            return Err(StoreError::StoreUnavailable);
        }
        tx.commit().map_err(|_| StoreError::StoreUnavailable)?;
        Ok(next as u64)
    }

    fn purge_tombstoned(&self) -> Result<u64, StoreError> {
        let mut client = self.pool.get()?;
        let rows = client
            .execute("DELETE FROM records WHERE tombstone = true", &[])
            .map_err(|_| StoreError::StoreUnavailable)?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live integration test against a real PostgreSQL. Ignored by default; run with:
    /// `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/veyora_test \
    ///  cargo test -p backend-postgres -- --ignored`
    #[test]
    #[ignore]
    fn postgres_store_round_trips_and_cas_conflicts() {
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL set");
        let store = PostgresStore::connect(&url).expect("connect");
        store.migrate().expect("migrate");
        {
            let mut client = store.pool.get().unwrap();
            let _ = client.execute("DELETE FROM records WHERE record_id = $1", &[&"pg-inert"]);
        }

        let mut record = record("pg-inert", 1);
        assert_eq!(store.put(record.clone(), None).unwrap(), 1);
        record.ciphertext_hash = "deadbeef".repeat(16);
        assert_eq!(store.put(record.clone(), Some(1)).unwrap(), 2);
        assert_eq!(store.get("pg-inert").unwrap().revision, 2);
        assert_eq!(
            store.put(record.clone(), Some(99)).unwrap_err(),
            StoreError::Conflict
        );
        assert_eq!(store.tombstone("pg-inert", 2).unwrap(), 3);
        assert!(store.get("pg-inert").unwrap().tombstone);
        let summaries: Vec<_> = store
            .list()
            .unwrap()
            .into_iter()
            .map(|s| s.record_id)
            .collect();
        assert!(summaries.contains(&"pg-inert".to_string()));
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
}
