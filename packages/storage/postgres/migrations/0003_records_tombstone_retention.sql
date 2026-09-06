-- DATA-008: tombstones carry their deletion time so retention can purge
-- consistently. The stamp is whole seconds since the Unix epoch (UTC);
-- live records keep NULL. Any tombstone left from before this column had
-- no observable deletion time — backfilling with the migration-run epoch
-- starts its retention window now, which never purges earlier than the
-- operator expects. Idempotent on every startup.

ALTER TABLE records ADD COLUMN IF NOT EXISTS tombstoned_at BIGINT;

UPDATE records
   SET tombstoned_at = (EXTRACT(EPOCH FROM NOW()))::BIGINT
 WHERE tombstone = TRUE AND tombstoned_at IS NULL;
