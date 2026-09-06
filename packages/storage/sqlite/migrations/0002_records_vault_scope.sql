-- DATA-001: the storage identity of a record is (vault_id, record_id).
-- Same rationale as the PostgreSQL 0002 migration: record IDs from
-- different Vaults must never collide or cross. Local Vaults hold one
-- Vault per database, so existing rows are unaffected.
CREATE TABLE IF NOT EXISTS records_scoped (
    vault_id              TEXT    NOT NULL,
    record_id             TEXT    NOT NULL,
    revision              INTEGER NOT NULL CHECK (revision >= 1),
    protocol_version      INTEGER NOT NULL,
    suite_id              INTEGER NOT NULL,
    deployment_id         TEXT    NOT NULL,
    ciphertext            TEXT    NOT NULL,
    ciphertext_hash       TEXT    NOT NULL,
    ciphertext_length     INTEGER NOT NULL,
    tombstone             INTEGER NOT NULL,
    template_envelope_hash TEXT   NOT NULL,
    manifest_binding      TEXT    NOT NULL,
    PRIMARY KEY (vault_id, record_id)
);
INSERT INTO records_scoped
  (vault_id, record_id, revision, protocol_version, suite_id, deployment_id,
   ciphertext, ciphertext_hash, ciphertext_length, tombstone,
   template_envelope_hash, manifest_binding)
SELECT vault_id, record_id, revision, protocol_version, suite_id, deployment_id,
       ciphertext, ciphertext_hash, ciphertext_length, tombstone,
       template_envelope_hash, manifest_binding
FROM records;
DROP TABLE records;
ALTER TABLE records_scoped RENAME TO records;
