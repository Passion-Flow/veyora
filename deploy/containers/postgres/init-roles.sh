#!/bin/bash
# Veyora least-privilege database roles (PRD DB-004).
#
# Runs once on first database initialization (docker-entrypoint-initdb.d).
# It creates two login roles so each service exercises only the privileges
# its operations need:
#   veyora_migrator — schema ownership/DDL for the migrator service
#   veyora_app      — DML only (SELECT/INSERT/UPDATE/DELETE) for the API,
#                     worker, backup, and restore services
# Table-level DML grants happen in the records migration itself, applied by
# the migrator role as the table owner.
set -euo pipefail

# Prefer role-specific passwords; operators may keep the shared deployment
# password for both roles by leaving the specific variables unset.
APP_PASSWORD="${VEYORA_DB_APP_PASSWORD:-$VEYORA_DB_PASSWORD}"
MIGRATOR_PASSWORD="${VEYORA_DB_MIGRATOR_PASSWORD:-$VEYORA_DB_PASSWORD}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$APP_PASSWORD" \
  -v migrator_password="$MIGRATOR_PASSWORD" <<'EOSQL'
-- DDL role: may create and alter objects in the public schema.
CREATE ROLE veyora_migrator LOGIN PASSWORD :'migrator_password';
GRANT CREATE, USAGE ON SCHEMA public TO veyora_migrator;

-- DML role: may use the schema but never create, alter, or drop objects.
CREATE ROLE veyora_app LOGIN PASSWORD :'app_password';
GRANT USAGE ON SCHEMA public TO veyora_app;
EOSQL
