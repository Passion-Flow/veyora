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

use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use backend_persistence::{
    GenericEncryptedRecordV1, OpaqueStore, PROTOCOL_VERSION, RecordSummary, SUITE_ID, StoreError,
};
use postgres::Client;

const DEFAULT_POOL_SIZE: usize = 8;
const DEFAULT_ACQUIRE_TIMEOUT_MS: u64 = 3_000;
const DEFAULT_STATEMENT_TIMEOUT_MS: u64 = 15_000;
const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 300;

/// Explicit, bounded pool policy (DB-002: pool maximum, acquisition
/// timeout, statement timeout, idle timeout). Values parse from the
/// environment so operators tune capacity, never unbounded behavior.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PoolConfig {
    max_size: usize,
    acquire_timeout: Duration,
    statement_timeout: Duration,
    idle_timeout: Duration,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            max_size: DEFAULT_POOL_SIZE,
            acquire_timeout: Duration::from_millis(DEFAULT_ACQUIRE_TIMEOUT_MS),
            statement_timeout: Duration::from_millis(DEFAULT_STATEMENT_TIMEOUT_MS),
            idle_timeout: Duration::from_secs(DEFAULT_IDLE_TIMEOUT_SECS),
        }
    }
}

impl PoolConfig {
    /// Environment overrides: `VEYORA_DB_POOL_MAX`,
    /// `VEYORA_DB_ACQUIRE_TIMEOUT_MS`, `VEYORA_DB_STATEMENT_TIMEOUT_MS`,
    /// `VEYORA_DB_IDLE_TIMEOUT_SECS`. Unset or unparseable values keep the
    /// documented default; parsed values floor at their smallest legal unit.
    fn from_environment() -> Self {
        let raw = |name: &str| std::env::var(name).ok();
        Self::from_overrides(
            raw("VEYORA_DB_POOL_MAX"),
            raw("VEYORA_DB_ACQUIRE_TIMEOUT_MS"),
            raw("VEYORA_DB_STATEMENT_TIMEOUT_MS"),
            raw("VEYORA_DB_IDLE_TIMEOUT_SECS"),
        )
    }

    /// Apply optional string overrides; unparseable or absent values keep
    /// the documented default and parsed values floor at their smallest
    /// legal unit.
    fn from_overrides(
        pool_max: Option<String>,
        acquire_ms: Option<String>,
        statement_ms: Option<String>,
        idle_secs: Option<String>,
    ) -> Self {
        let mut config = Self::default();
        if let Some(value) = pool_max
            .as_deref()
            .and_then(|raw| raw.parse::<usize>().ok())
        {
            config.max_size = value.max(1);
        }
        if let Some(value) = acquire_ms
            .as_deref()
            .and_then(|raw| raw.parse::<u64>().ok())
        {
            config.acquire_timeout = Duration::from_millis(value.max(1));
        }
        if let Some(value) = statement_ms
            .as_deref()
            .and_then(|raw| raw.parse::<u64>().ok())
        {
            config.statement_timeout = Duration::from_millis(value.max(1));
        }
        if let Some(value) = idle_secs.as_deref().and_then(|raw| raw.parse::<u64>().ok()) {
            config.idle_timeout = Duration::from_secs(value.max(1));
        }
        config
    }
}

/// Atomically reserve one connection slot below `max`; false means the pool
/// is at its hard cap (DB-002: bounded, fail-closed).
fn reserve_slot(outstanding: &AtomicUsize, max: usize) -> bool {
    let mut current = outstanding.load(Ordering::Acquire);
    loop {
        if current >= max {
            return false;
        }
        match outstanding.compare_exchange_weak(
            current,
            current + 1,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return true,
            Err(observed) => current = observed,
        }
    }
}

/// A connection pool for synchronous PostgreSQL clients with bounded
/// acquisition, statement, and idle timeouts plus explicit shutdown
/// draining (DB-002). Waiters block on a condition variable until a
/// connection returns, the acquire timeout elapses (fail closed as
/// `StoreUnavailable`), or the pool shuts down.
struct ConnectionPool {
    url: String,
    config: PoolConfig,
    state: Mutex<PoolState>,
    available: Condvar,
    /// Checked-out plus idle connections; never exceeds `config.max_size`.
    outstanding: AtomicUsize,
}

struct PoolState {
    /// Idle connections with the instant they became idle.
    idle: Vec<(Client, Instant)>,
    closed: bool,
}

impl ConnectionPool {
    fn connect(url: &str, config: PoolConfig) -> Result<Self, StoreError> {
        let initial = open_connection(url, config)?;
        Ok(Self {
            url: url.to_string(),
            config,
            state: Mutex::new(PoolState {
                idle: vec![(initial, Instant::now())],
                closed: false,
            }),
            available: Condvar::new(),
            outstanding: AtomicUsize::new(1),
        })
    }

    /// Check out a connection, waiting up to the acquire timeout for a
    /// returning connection when the pool is at its hard cap.
    fn get(&self) -> Result<PooledConnection<'_>, StoreError> {
        let deadline = Instant::now() + self.config.acquire_timeout;
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            if state.closed {
                return Err(StoreError::StoreUnavailable);
            }
            // Idle-expired connections are discarded, not reused; their
            // slots return to the cap accounting (idle timeout).
            while state
                .idle
                .last()
                .is_some_and(|(_, idle_since)| idle_since.elapsed() >= self.config.idle_timeout)
            {
                let (client, _) = state.idle.pop().expect("checked some above");
                drop(client);
                self.outstanding.fetch_sub(1, Ordering::AcqRel);
            }
            if let Some((mut client, _)) = state.idle.pop() {
                // A reused idle connection is probed before hand-out: a
                // database restart strands dead sockets in the pool, and
                // handing them out again would fail every store call
                // forever (readiness would never recover after the blip).
                drop(state); // never hold the pool lock across a probe
                match client.simple_query("SELECT 1") {
                    Ok(_) => {
                        return Ok(PooledConnection {
                            pool: self,
                            client: Some(client),
                        });
                    }
                    Err(_) => {
                        drop(client); // close the dead socket, free its slot
                        self.outstanding.fetch_sub(1, Ordering::AcqRel);
                        self.available.notify_all();
                        state = self.state.lock().unwrap_or_else(|p| p.into_inner());
                        continue;
                    }
                }
            }
            // Under the cap: open a new connection immediately.
            if reserve_slot(&self.outstanding, self.config.max_size) {
                match open_connection(&self.url, self.config) {
                    Ok(client) => {
                        return Ok(PooledConnection {
                            pool: self,
                            client: Some(client),
                        });
                    }
                    Err(error) => {
                        self.outstanding.fetch_sub(1, Ordering::AcqRel);
                        return Err(error);
                    }
                }
            }
            // At the cap: wait for a return, closure, or the deadline.
            let now = Instant::now();
            if now >= deadline {
                return Err(StoreError::StoreUnavailable);
            }
            let (guard, _) = self
                .available
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(|p| p.into_inner());
            state = guard;
        }
    }

    /// Shut the pool down: idle connections close immediately and the call
    /// waits (bounded by the acquire timeout) for checked-out connections
    /// to return so their statements finish before the process exits.
    fn shutdown(&self) {
        let deadline = Instant::now() + self.config.acquire_timeout;
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.closed = true;
        state.idle.clear(); // drops (closes) every idle connection
        while self.outstanding.load(Ordering::Acquire) > 0 && Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let (guard, _) = self
                .available
                .wait_timeout(state, remaining)
                .unwrap_or_else(|p| p.into_inner());
            state = guard;
        }
    }

    /// Return path used by [`PooledConnection::drop`]: the connection goes
    /// back to the idle list unless the pool is closed or full, in which
    /// case it closes and releases its slot.
    fn release(&self, client: Option<Client>) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let keep = !state.closed && state.idle.len() < self.config.max_size;
        if let Some(client) = client {
            if keep {
                state.idle.push((client, Instant::now()));
            } else {
                drop(client);
                self.outstanding.fetch_sub(1, Ordering::AcqRel);
            }
        }
        self.available.notify_all();
    }
}

/// Remote-database TLS policy (DB-003): TLS modes are configurable and
/// default safely — a non-loopback TCP host requires verified TLS unless
/// the operator explicitly acknowledges an unencrypted private network.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TlsMode {
    /// Plaintext; only chosen automatically for loopback/unix targets.
    None,
    /// rustls with verified server certificates.
    Required,
    /// Plaintext on a non-loopback host, explicitly acknowledged by the
    /// operator (compose's private container network).
    AcknowledgedInsecure,
}

/// Resolve the TLS policy for one parsed connection target.
///
/// `VEYORA_DB_TLS_MODE` accepts `verify-full` (always TLS),
/// `disabled-insecure` (no TLS, any host), and `auto` (default): TLS is
/// required for every non-loopback TCP host and no-TLS is kept for
/// loopback and Unix-socket targets.
fn tls_mode_for(pg_config: &postgres::Config) -> Result<TlsMode, StoreError> {
    let override_mode = std::env::var("VEYORA_DB_TLS_MODE").unwrap_or_default();
    tls_mode_with_override(pg_config, &override_mode)
}

fn tls_mode_with_override(
    pg_config: &postgres::Config,
    override_mode: &str,
) -> Result<TlsMode, StoreError> {
    let remote_tcp = pg_config.get_hosts().iter().any(|host| match host {
        postgres::config::Host::Tcp(name) => {
            !(name.is_empty()
                || name == "localhost"
                || name
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback()))
        }
        postgres::config::Host::Unix(_) => false,
    });
    match override_mode {
        "verify-full" => Ok(TlsMode::Required),
        "disabled-insecure" => Ok(if remote_tcp {
            TlsMode::AcknowledgedInsecure
        } else {
            TlsMode::None
        }),
        "" | "auto" => Ok(if remote_tcp {
            TlsMode::Required
        } else {
            TlsMode::None
        }),
        // Unknown modes fail closed rather than guessing (DB-003, PRD
        // fail-closed principle).
        other => {
            let _ = other;
            Err(StoreError::StoreUnavailable)
        }
    }
}

/// Build the rustls connector for [`TlsMode::Required`]: Mozilla's root
/// store plus, when `VEYORA_DB_TLS_CA_FILE` is set, the operator's private
/// CA certificate(s).
fn tls_connector() -> Result<postgres_rustls::MakeTlsConnector, StoreError> {
    let ca_file = std::env::var("VEYORA_DB_TLS_CA_FILE").ok();
    tls_connector_with_ca(ca_file.as_deref())
}

fn tls_connector_with_ca(
    ca_path: Option<&str>,
) -> Result<postgres_rustls::MakeTlsConnector, StoreError> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    if let Some(ca_path) = ca_path {
        let pem = std::fs::read(ca_path).map_err(|_| StoreError::StoreUnavailable)?;
        for certificate in rustls_pemfile::certs(&mut pem.as_slice()) {
            let certificate = certificate.map_err(|_| StoreError::StoreUnavailable)?;
            roots
                .add(certificate)
                .map_err(|_| StoreError::StoreUnavailable)?;
        }
    }
    // The ring provider is a non-default cargo feature here; install it as
    // the process-level provider (idempotent) before building the config.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut client_config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    postgres_rustls::set_postgresql_alpn(&mut client_config);
    Ok(postgres_rustls::MakeTlsConnector::new(
        tokio_rustls::TlsConnector::from(std::sync::Arc::new(client_config)),
    ))
}

/// Open one bounded connection: the session-level statement timeout makes a
/// wedged query fail instead of pinning its pooled connection forever.
fn open_connection(url: &str, config: PoolConfig) -> Result<Client, StoreError> {
    let pg_config: postgres::Config = url.parse().map_err(|_| StoreError::StoreUnavailable)?;
    let mut client = match tls_mode_for(&pg_config)? {
        TlsMode::None | TlsMode::AcknowledgedInsecure => pg_config
            .connect(postgres::NoTls)
            .map_err(|_| StoreError::StoreUnavailable)?,
        TlsMode::Required => pg_config
            .connect(tls_connector()?)
            .map_err(|_| StoreError::StoreUnavailable)?,
    };
    client
        .batch_execute(&format!(
            "SET statement_timeout = {}",
            config.statement_timeout.as_millis()
        ))
        .map_err(|_| StoreError::StoreUnavailable)?;
    Ok(client)
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
        self.pool.release(self.client.take());
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
    ///
    /// Pool policy is explicit and bounded (DB-002): maximum size, acquire
    /// timeout, statement timeout, and idle timeout default to 8 connections,
    /// 3 s, 15 s, and 300 s, overridable through `VEYORA_DB_POOL_MAX`,
    /// `VEYORA_DB_ACQUIRE_TIMEOUT_MS`, `VEYORA_DB_STATEMENT_TIMEOUT_MS`, and
    /// `VEYORA_DB_IDLE_TIMEOUT_SECS`. Exhaustion fails closed as
    /// `StoreUnavailable` instead of opening unlimited connections.
    pub fn connect(database_url: &str) -> Result<Self, StoreError> {
        let pool = ConnectionPool::connect(database_url, PoolConfig::from_environment())?;
        Ok(Self { pool })
    }

    /// Verify the records schema is present without applying it: the
    /// DML-only role (DB-004) uses this at startup because the migrator
    /// service owns DDL.
    pub fn verify_schema(&self) -> Result<(), StoreError> {
        let mut conn = self.pool.get()?;
        conn.query_one("SELECT count(*) FROM records", &[])
            .map_err(|_| StoreError::StoreUnavailable)?;
        Ok(())
    }

    /// The distinct vault IDs present in the database (retention iterates
    /// exactly these scopes; an empty database holds none).
    pub fn vault_ids(&self) -> Result<Vec<String>, StoreError> {
        let mut conn = self.pool.get()?;
        let rows = conn
            .query(
                "SELECT DISTINCT vault_id FROM records ORDER BY vault_id",
                &[],
            )
            .map_err(|_| StoreError::StoreUnavailable)?;
        Ok(rows.into_iter().map(|row| row.get(0)).collect())
    }

    /// Drain the pool for shutdown: idle connections close immediately and
    /// checked-out connections finish their statements before the bounded
    /// wait elapses (DB-002 shutdown behavior).
    pub fn shutdown(&self) {
        self.pool.shutdown();
    }

    /// Apply the records schema. Idempotent: 0001/0003 are written to be
    /// so, and the scoped primary key from 0002 is re-expressed as a
    /// conditional block (the operator migrator applies the file form
    /// exactly once; this path serves development databases that never
    /// ran it and must still reach the real current schema).
    pub fn migrate(&self) -> Result<(), StoreError> {
        let mut conn = self.pool.get()?;
        conn.batch_execute(include_str!("../migrations/0001_records.sql"))
            .map_err(|_| StoreError::StoreUnavailable)?;
        conn.batch_execute(
            "DO $$
             BEGIN
                 IF NOT EXISTS (
                     SELECT 1 FROM pg_constraint
                      WHERE conrelid = 'records'::regclass AND contype = 'p'
                        AND pg_get_constraintdef(oid) ILIKE '%vault_id%'
                 ) THEN
                     ALTER TABLE records DROP CONSTRAINT IF EXISTS records_pkey;
                     ALTER TABLE records ADD PRIMARY KEY (vault_id, record_id);
                 END IF;
             END $$;",
        )
        .map_err(|_| StoreError::StoreUnavailable)?;
        // A no-op ALTER still takes a table lock; skip 0003 entirely once
        // the column exists so concurrent migrates on one database (the
        // ignored live tests run in parallel) never contend.
        let has_stamp: bool = conn
            .query_opt(
                "SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'records' AND column_name = 'tombstoned_at'",
                &[],
            )
            .map_err(|_| StoreError::StoreUnavailable)?
            .is_some();
        if !has_stamp {
            conn.batch_execute(include_str!(
                "../migrations/0003_records_tombstone_retention.sql"
            ))
            .map_err(|_| StoreError::StoreUnavailable)?;
        }
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

const SELECT_REVISION: &str =
    "SELECT revision FROM records WHERE vault_id = $1 AND record_id = $2 FOR UPDATE";
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
      deployment_id = $8, vault_id = $9, protocol_version = $10, suite_id = $11,
      tombstoned_at = CASE WHEN $5 = FALSE THEN NULL ELSE tombstoned_at END
    WHERE vault_id = $12 AND record_id = $13";

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
            .query_opt(SELECT_REVISION, &[&record.vault_id, &record.record_id])
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
                    &record.vault_id,
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

    fn put_batch(
        &self,
        records: Vec<GenericEncryptedRecordV1>,
        expected_prior_revisions: Vec<Option<u64>>,
    ) -> Result<Vec<u64>, StoreError> {
        for record in &records {
            Self::validate(record)?;
        }
        let mut client = self.pool.get()?;
        let mut tx = client
            .transaction()
            .map_err(|_| StoreError::StoreUnavailable)?;
        let mut revisions = Vec::with_capacity(records.len());
        // Every row executes inside one transaction; any error returns early
        // and drops the transaction, rolling the batch back (DATA-007).
        for (record, expected) in records.into_iter().zip(expected_prior_revisions) {
            let prior: Option<i64> = tx
                .query_opt(SELECT_REVISION, &[&record.vault_id, &record.record_id])
                .map_err(|_| StoreError::StoreUnavailable)?
                .map(|row| row.get::<_, i64>(0));
            let next: i64 = match (prior, expected) {
                (None, None) => 1,
                (None, Some(_)) => return Err(StoreError::Conflict),
                (Some(existing), Some(want)) if existing as u64 == want => existing + 1,
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
                        &record.vault_id,
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
            revisions.push(next as u64);
        }
        tx.commit().map_err(|_| StoreError::StoreUnavailable)?;
        Ok(revisions)
    }

    fn get(&self, vault_id: &str, record_id: &str) -> Result<GenericEncryptedRecordV1, StoreError> {
        let mut client = self.pool.get()?;
        let row = client
            .query_opt(
                "SELECT record_id, revision, protocol_version, suite_id, deployment_id, vault_id, \
                 ciphertext, ciphertext_hash, ciphertext_length, tombstone, \
                 template_envelope_hash, manifest_binding FROM records
                 WHERE vault_id = $1 AND record_id = $2",
                &[&vault_id, &record_id],
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

    fn list(
        &self,
        vault_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<RecordSummary>, StoreError> {
        let mut client = self.pool.get()?;
        let rows = client
            .query(
                "SELECT record_id, revision, tombstone, ciphertext_hash FROM records\n                 WHERE vault_id = $1 ORDER BY record_id\n                 LIMIT $2 OFFSET $3",
                &[&vault_id, &(limit as i64), &(offset as i64)],
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

    fn list_bodies(
        &self,
        vault_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<GenericEncryptedRecordV1>, StoreError> {
        let mut client = self.pool.get()?;
        let rows = client
            .query(
                "SELECT record_id, revision, protocol_version, suite_id, deployment_id, vault_id,\n                 ciphertext, ciphertext_hash, ciphertext_length, tombstone,\n                 template_envelope_hash, manifest_binding FROM records\n                 WHERE vault_id = $1 ORDER BY record_id\n                 LIMIT $2 OFFSET $3",
                &[&vault_id, &(limit as i64), &(offset as i64)],
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

    fn tombstone(
        &self,
        vault_id: &str,
        record_id: &str,
        expected_prior_revision: u64,
    ) -> Result<u64, StoreError> {
        let mut client = self.pool.get()?;
        let mut tx = client
            .transaction()
            .map_err(|_| StoreError::StoreUnavailable)?;
        let prior: i64 = tx
            .query_opt(SELECT_REVISION, &[&vault_id, &record_id])
            .map_err(|_| StoreError::StoreUnavailable)?
            .ok_or(StoreError::NotFound)?
            .get::<_, i64>(0);
        if prior as u64 != expected_prior_revision {
            return Err(StoreError::Conflict);
        }
        let next = prior + 1;
        let stamp = backend_persistence::utc_now_epoch() as i64;
        let updated = tx
            .execute(
                "UPDATE records SET revision = $1, tombstone = TRUE, tombstoned_at = $4\n                 WHERE vault_id = $2 AND record_id = $3",
                &[&next, &vault_id, &record_id, &stamp],
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
        let mut client = self.pool.get()?;
        let mut tx = client
            .transaction()
            .map_err(|_| StoreError::StoreUnavailable)?;
        let mut moved = 0u64;
        // Inserts and the scope deletion share one transaction: any error
        // drops it and the vault stays whole under the old scope.
        for mut record in records {
            let exists = tx
                .query_opt(SELECT_REVISION, &[&to_vault_id, &record.record_id])
                .map_err(|_| StoreError::StoreUnavailable)?;
            if exists.is_some() {
                return Err(StoreError::Conflict);
            }
            record.vault_id = to_vault_id.to_string();
            record.revision = 1;
            tx.execute(
                INSERT_RECORD,
                &[
                    &record.record_id,
                    &1i64,
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
            .map_err(|_| StoreError::StoreUnavailable)?;
            // A row that arrives tombstoned must carry a deletion stamp,
            // or the retention purge could never remove it.
            if record.tombstone {
                let stamp = backend_persistence::utc_now_epoch() as i64;
                tx.execute(
                    "UPDATE records SET tombstoned_at = $1 WHERE vault_id = $2 AND record_id = $3",
                    &[&stamp, &to_vault_id, &record.record_id],
                )
                .map_err(|_| StoreError::StoreUnavailable)?;
            }
            moved += 1;
        }
        tx.execute("DELETE FROM records WHERE vault_id = $1", &[&vault_id])
            .map_err(|_| StoreError::StoreUnavailable)?;
        tx.commit().map_err(|_| StoreError::StoreUnavailable)?;
        Ok(moved)
    }

    fn tombstoned_at(&self, vault_id: &str, record_id: &str) -> Result<Option<u64>, StoreError> {
        let mut client = self.pool.get()?;
        let stamp: Option<i64> = client
            .query_opt(
                "SELECT tombstoned_at FROM records WHERE vault_id = $1 AND record_id = $2",
                &[&vault_id, &record_id],
            )
            .map_err(|_| StoreError::StoreUnavailable)?
            .ok_or(StoreError::NotFound)?
            .get(0);
        Ok(stamp.map(|seconds| seconds as u64))
    }

    fn purge_tombstoned_before(
        &self,
        vault_id: &str,
        before_epoch_seconds: u64,
    ) -> Result<u64, StoreError> {
        let mut client = self.pool.get()?;
        let cutoff = i64::try_from(before_epoch_seconds).unwrap_or(i64::MAX);
        let rows = client
            .execute(
                "DELETE FROM records
                  WHERE vault_id = $1 AND tombstone = TRUE
                    AND tombstoned_at IS NOT NULL AND tombstoned_at <= $2",
                &[&vault_id, &cutoff],
            )
            .map_err(|_| StoreError::StoreUnavailable)?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ignored live tests share one database and each runs `migrate()`
    /// whose migration files take table locks (GRANT/ALTER); serializing the
    /// suite mirrors the operator world, where exactly one migrator runs.
    static LIVE_DB: Mutex<()> = Mutex::new(());

    #[test]
    fn pool_slot_reservation_respects_the_hard_cap() {
        let outstanding = AtomicUsize::new(0);
        assert!(reserve_slot(&outstanding, 3));
        assert!(reserve_slot(&outstanding, 3));
        assert!(reserve_slot(&outstanding, 3));
        // At the cap: fail closed instead of opening another connection.
        assert!(!reserve_slot(&outstanding, 3));
        assert_eq!(outstanding.load(Ordering::Acquire), 3);
        // Releasing a slot makes room for exactly one more reservation.
        outstanding.fetch_sub(1, Ordering::AcqRel);
        assert!(reserve_slot(&outstanding, 3));
        assert!(!reserve_slot(&outstanding, 3));
        // A max of zero can never reserve (defensive; config floors at 1).
        let zero = AtomicUsize::new(0);
        assert!(!reserve_slot(&zero, 0));
    }

    #[test]
    fn tls_policy_requires_tls_for_remote_hosts_by_default() {
        let remote: postgres::Config = "postgres://user:pass@db.example.com:5432/veyora"
            .parse()
            .unwrap();
        assert_eq!(
            tls_mode_with_override(&remote, "").unwrap(),
            TlsMode::Required
        );
        assert_eq!(
            tls_mode_with_override(&remote, "auto").unwrap(),
            TlsMode::Required
        );
        // The explicit private-network acknowledgment is the only no-TLS
        // path to a remote host.
        assert_eq!(
            tls_mode_with_override(&remote, "disabled-insecure").unwrap(),
            TlsMode::AcknowledgedInsecure
        );
        assert_eq!(
            tls_mode_with_override(&remote, "verify-full").unwrap(),
            TlsMode::Required
        );
        // Unknown modes fail closed.
        assert!(tls_mode_with_override(&remote, " opportunistic ").is_err());
    }

    #[test]
    fn tls_policy_keeps_no_tls_for_local_targets() {
        for url in [
            "postgres://user:pass@127.0.0.1:5432/veyora",
            "postgres://user:pass@localhost:5432/veyora",
            "postgres://user@%2Fvar%2Frun%2Fpostgresql/veyora",
        ] {
            let local: postgres::Config = url.parse().unwrap();
            assert_eq!(
                tls_mode_with_override(&local, "").unwrap(),
                TlsMode::None,
                "local target {url} must stay without TLS by default"
            );
        }
    }

    #[test]
    fn tls_connector_fails_closed_on_a_missing_private_ca() {
        // A configured-but-missing CA file must fail closed rather than
        // silently skipping the private roots and verifying against the
        // public set only.
        assert!(matches!(
            tls_connector_with_ca(Some("/nonexistent/ca.pem")),
            Err(StoreError::StoreUnavailable)
        ));
    }

    #[test]
    fn pool_policy_defaults_are_bounded() {
        let config = PoolConfig::default();
        assert_eq!(config.max_size, 8);
        assert_eq!(config.acquire_timeout, Duration::from_millis(3_000));
        assert_eq!(config.statement_timeout, Duration::from_millis(15_000));
        assert_eq!(config.idle_timeout, Duration::from_secs(300));
    }

    #[test]
    fn pool_policy_overrides_floor_at_the_smallest_legal_unit() {
        // Unparseable and out-of-range overrides keep the documented
        // defaults; every legal override floors at its smallest unit.
        let config = PoolConfig::from_overrides(
            Some("0".to_string()),
            Some("not-a-number".to_string()),
            Some("0".to_string()),
            Some("45".to_string()),
        );
        assert_eq!(config.max_size, 1);
        assert_eq!(config.acquire_timeout, Duration::from_millis(3_000));
        assert_eq!(config.statement_timeout, Duration::from_millis(1));
        assert_eq!(config.idle_timeout, Duration::from_secs(45));
        // Absent overrides keep every default.
        let config = PoolConfig::from_overrides(None, None, None, None);
        assert_eq!(config, PoolConfig::default());
    }

    /// Live shared behavioral contract (DATA-010): PostgreSQL passes the
    /// identical suite the SQLite adapter runs, so the two adapters cannot
    /// drift. Ignored by default; run with the round-trip test's DATABASE_URL.
    #[test]
    #[ignore]
    fn postgres_passes_shared_contract() {
        let _live = LIVE_DB.lock().unwrap_or_else(|p| p.into_inner());
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL set");
        let store = PostgresStore::connect(&url).expect("connect");
        store.migrate().expect("migrate");
        {
            // Clean only the contract's vault scopes (the rekey and
            // concurrency targets included): a live database is shared
            // with the other ignored tests, which run in parallel.
            let mut client = store.pool.get().unwrap();
            let _ = client.execute(
                "DELETE FROM records WHERE vault_id = $1 OR vault_id = $2 OR vault_id = $3 OR vault_id = $4",
                &[
                    &backend_persistence::contract::VAULT_A,
                    &backend_persistence::contract::VAULT_B,
                    &backend_persistence::contract::REKEY_TARGET,
                    &backend_persistence::contract::VAULT_CONC,
                ],
            );
        }
        backend_persistence::contract::run(&store);
        backend_persistence::contract::run_concurrently(&store);
    }

    /// Live age-window retention (DATA-008): a stamp backdated through the
    /// database itself is purged by the 30-day cutoff while a fresh
    /// tombstone and every live row survive the sweep.
    #[test]
    #[ignore]
    fn postgres_retention_purges_only_expired_tombstones() {
        let _live = LIVE_DB.lock().unwrap_or_else(|p| p.into_inner());
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL set");
        let store = PostgresStore::connect(&url).expect("connect");
        store.migrate().expect("migrate");
        let vault = "1010101010101010101010101010101f";
        {
            let mut client = store.pool.get().unwrap();
            let _ = client.execute("DELETE FROM records WHERE vault_id = $1", &[&vault]);
        }
        store.put(record("pg-old-trash", 1), None).unwrap();
        store.put(record("pg-new-trash", 1), None).unwrap();
        store.put(record("pg-live-one", 1), None).unwrap();
        store.tombstone(vault, "pg-old-trash", 1).unwrap();
        store.tombstone(vault, "pg-new-trash", 1).unwrap();
        {
            let mut client = store.pool.get().unwrap();
            client
                .execute(
                    "UPDATE records SET tombstoned_at = $1 WHERE record_id = 'pg-old-trash'",
                    &[&((backend_persistence::utc_now_epoch() - 40 * 86_400) as i64)],
                )
                .unwrap();
        }
        let cutoff = backend_persistence::utc_now_epoch() - 30 * 86_400;
        assert_eq!(store.purge_tombstoned_before(vault, cutoff).unwrap(), 1);
        assert_eq!(store.get(vault, "pg-old-trash"), Err(StoreError::NotFound));
        assert!(store.get(vault, "pg-new-trash").unwrap().tombstone);
        assert!(store.get(vault, "pg-live-one").unwrap().revision >= 1);
    }

    /// Live integration test against a real PostgreSQL. Ignored by default; run with:
    /// `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/veyora_test \
    ///  cargo test -p backend-postgres -- --ignored`
    #[test]
    #[ignore]
    fn postgres_store_round_trips_and_cas_conflicts() {
        let _live = LIVE_DB.lock().unwrap_or_else(|p| p.into_inner());
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL set");
        let store = PostgresStore::connect(&url).expect("connect");
        store.migrate().expect("migrate");
        {
            // Scope the cleanup to this test's vault: the ignored live
            // tests share one database and run in parallel.
            let vault = "1010101010101010101010101010101f";
            let mut client = store.pool.get().unwrap();
            let _ = client.execute("DELETE FROM records WHERE vault_id = $1", &[&vault]);
        }

        let mut record = record("pg-inert", 1);
        assert_eq!(store.put(record.clone(), None).unwrap(), 1);
        record.ciphertext_hash = "deadbeef".repeat(16);
        assert_eq!(store.put(record.clone(), Some(1)).unwrap(), 2);
        assert_eq!(
            store
                .get("1010101010101010101010101010101f", "pg-inert")
                .unwrap()
                .revision,
            2
        );
        assert_eq!(
            store.put(record.clone(), Some(99)).unwrap_err(),
            StoreError::Conflict
        );
        assert_eq!(
            store
                .tombstone("1010101010101010101010101010101f", "pg-inert", 2)
                .unwrap(),
            3
        );
        assert!(
            store
                .get("1010101010101010101010101010101f", "pg-inert")
                .unwrap()
                .tombstone
        );
        let summaries: Vec<_> = store
            .list("1010101010101010101010101010101f", 100_000, 0)
            .unwrap()
            .into_iter()
            .map(|s| s.record_id)
            .collect();
        assert!(summaries.contains(&"pg-inert".to_string()));

        // Every pooled connection carries the session-level statement
        // timeout (DB-002) — prove it on a freshly opened one.
        {
            let mut client = store.pool.get().unwrap();
            let row = client
                .query_one(
                    "SELECT setting FROM pg_settings WHERE name = 'statement_timeout'",
                    &[],
                )
                .expect("statement_timeout setting");
            // pg_settings reports milliseconds regardless of how SHOW
            // renders the value on this server version.
            assert_eq!(row.get::<_, String>(0), "15000");
        }
        // DATA-001/E2E-005 collision scope: the same record ID in a second
        // vault is an independent row; each vault's listing sees only its own.
        {
            // `record` (the loop variable above) shadows the helper; build
            // the colliding row from it instead.
            let mut other = record.clone();
            other.vault_id = "2020202020202020202020202020202f".to_string();
            other.revision = 1;
            other.tombstone = false;
            assert_eq!(store.put(other, None).unwrap(), 1);
            let a: Vec<_> = store
                .list("1010101010101010101010101010101f", 100_000, 0)
                .unwrap()
                .into_iter()
                .map(|s| s.record_id)
                .collect();
            let b: Vec<_> = store
                .list("2020202020202020202020202020202f", 100_000, 0)
                .unwrap()
                .into_iter()
                .map(|s| s.record_id)
                .collect();
            assert!(a.contains(&"pg-inert".to_string()));
            assert!(b.contains(&"pg-inert".to_string()));
            let other_get = store
                .get("2020202020202020202020202020202f", "pg-inert")
                .unwrap();
            assert_eq!(
                other_get.revision, 1,
                "the second vault's row is independent"
            );
            assert_eq!(
                store
                    .get("1010101010101010101010101010101f", "pg-inert")
                    .unwrap()
                    .revision,
                3
            );
            let mut client = store.pool.get().unwrap();
            let cleanup_vault = "2020202020202020202020202020202f".to_string();
            let _ = client.execute("DELETE FROM records WHERE vault_id = $1", &[&cleanup_vault]);
        }

        // DATA-007 live proof: one stale CAS row rolls the whole batch back.
        // (`record` the helper is shadowed by the local binding above, so
        // build the rows from clones of it.)
        {
            let mut seed = record.clone();
            seed.record_id = "batch-live".to_string();
            seed.revision = 1;
            seed.tombstone = false;
            store.put(seed.clone(), None).unwrap();
            store.put(seed.clone(), Some(1)).unwrap();
            let mut fresh = record.clone();
            fresh.record_id = "batch-fresh".to_string();
            fresh.revision = 1;
            fresh.tombstone = false;
            let mut stale = seed.clone();
            stale.revision = 99;
            let err = store
                .put_batch(vec![fresh, stale], vec![None, Some(99)])
                .unwrap_err();
            assert_eq!(err, StoreError::Conflict);
            assert_eq!(
                store.get(VAULT, "batch-live").unwrap().revision,
                2,
                "committed rows are untouched by the rolled-back batch"
            );
            assert_eq!(
                store.get(VAULT, "batch-fresh"),
                Err(StoreError::NotFound),
                "no partial batch survives"
            );
            let mut client = store.pool.get().unwrap();
            // Scoped cleanup: the live tests share one database in parallel.
            let _ = client.execute(
                "DELETE FROM records WHERE vault_id = $1 OR vault_id = $2",
                &[
                    &"1010101010101010101010101010101f".to_string(),
                    &"2020202020202020202020202020202f".to_string(),
                ],
            );
        }

        // Shutdown drains: after it returns, further checkouts fail closed.
        store.shutdown();
        assert!(matches!(
            store.pool.get(),
            Err(StoreError::StoreUnavailable)
        ));
    }

    /// Live TLS integration test (DB-003). Ignored by default; run with:
    /// `DATABASE_URL=postgres://veyora:pw@127.0.0.1:5432/veyora \
    ///  VEYORA_DB_TLS_MODE=verify-full \
    ///  VEYORA_DB_TLS_CA_FILE=/path/to/ca.pem \
    ///  cargo test -p backend-postgres tls -- --ignored`
    /// against a PostgreSQL with `ssl=on` whose certificate chains to the
    /// given CA and covers the client's target name.
    #[test]
    #[ignore]
    fn postgres_store_connects_over_verified_tls() {
        let _live = LIVE_DB.lock().unwrap_or_else(|p| p.into_inner());
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL set");
        let store = PostgresStore::connect(&url).expect("connect over verified TLS");
        store.migrate().expect("migrate");
        assert!(store.list(VAULT, 100_000, 0).is_ok());
        store.shutdown();
    }

    /// Live least-privilege role test (DB-004). Ignored by default; run
    /// against a role-initialized Compose database with:
    /// `DATABASE_URL=postgres://veyora_app:<pw>@127.0.0.1:5432/veyora \
    ///  DATABASE_URL_MIGRATOR=postgres://veyora_migrator:<pw>@127.0.0.1:5432/veyora \
    ///  cargo test -p backend-postgres least_privilege -- --ignored`
    /// The DML role must be denied DDL (migrate fails) yet work for data
    /// operations; the DDL role must be able to migrate.
    #[test]
    #[ignore]
    fn least_privilege_roles_are_enforced() {
        let _live = LIVE_DB.lock().unwrap_or_else(|p| p.into_inner());
        let app_url = std::env::var("DATABASE_URL").expect("DATABASE_URL set");
        let migrator_url =
            std::env::var("DATABASE_URL_MIGRATOR").expect("DATABASE_URL_MIGRATOR set");

        // The DDL role can apply migrations.
        let migrator = PostgresStore::connect(&migrator_url).expect("migrator connects");
        migrator.migrate().expect("migrator role applies DDL");

        // The DML role is correctly denied schema DDL...
        let app = PostgresStore::connect(&app_url).expect("app role connects");
        assert!(
            app.migrate().is_err(),
            "the DML role must not be able to run DDL migrations"
        );
        // ...and the schema-verification path used at startup succeeds.
        app.verify_schema().expect("app role verifies schema");
        // Data operations work for the DML role.
        assert!(
            app.list(VAULT, 100_000, 0).is_ok(),
            "app role can read records"
        );
        app.shutdown();
        migrator.shutdown();
    }

    const VAULT: &str = "1010101010101010101010101010101f";

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
