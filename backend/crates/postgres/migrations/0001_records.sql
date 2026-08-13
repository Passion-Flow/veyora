-- Veyora opaque-record table. The backend stores only opaque per-record
-- ciphertext plus server-visible metadata. No column carries cleartext,
-- authentication material, keys, or template meaning.

CREATE TABLE IF NOT EXISTS records (
    record_id              TEXT    PRIMARY KEY,
    revision               BIGINT  NOT NULL,
    protocol_version       INTEGER NOT NULL,
    suite_id               INTEGER NOT NULL,
    deployment_id          TEXT    NOT NULL,
    vault_id               TEXT    NOT NULL,
    ciphertext             TEXT    NOT NULL,
    ciphertext_hash        TEXT    NOT NULL,
    ciphertext_length      BIGINT  NOT NULL,
    tombstone              BOOLEAN NOT NULL,
    template_envelope_hash TEXT    NOT NULL,
    manifest_binding       TEXT    NOT NULL
);

-- Revision must be strictly positive and server-assigned. Idempotent so the
-- migration is safe to apply on every startup.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'records_revision_positive'
    ) THEN
        ALTER TABLE records ADD CONSTRAINT records_revision_positive CHECK (revision >= 1);
    END IF;
END $$;
