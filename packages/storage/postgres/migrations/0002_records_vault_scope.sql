-- DATA-001: the storage identity of a record is (vault_id, record_id).
-- The original table keyed rows by record_id alone, so the same record ID
-- written for two different Vaults collided and leaked rows across the
-- boundary. This migration replaces the primary key with the scoped pair;
-- existing single-vault deployments keep every row unchanged.
ALTER TABLE records DROP CONSTRAINT records_pkey;
ALTER TABLE records ADD PRIMARY KEY (vault_id, record_id);
