-- Veyora opaque-record table. The backend stores only opaque per-record
-- ciphertext plus server-visible metadata. No column carries cleartext,
-- authentication material, keys, or template meaning.

CREATE TABLE IF NOT EXISTS records (
    record_id              TEXT    PRIMARY KEY,
    revision               INTEGER NOT NULL CHECK (revision >= 1),
    protocol_version       INTEGER NOT NULL,
    suite_id               INTEGER NOT NULL,
    deployment_id          TEXT    NOT NULL,
    vault_id               TEXT    NOT NULL,
    ciphertext             TEXT    NOT NULL,
    ciphertext_hash        TEXT    NOT NULL,
    ciphertext_length      INTEGER NOT NULL,
    tombstone              INTEGER NOT NULL,
    template_envelope_hash TEXT    NOT NULL,
    manifest_binding       TEXT    NOT NULL
);
