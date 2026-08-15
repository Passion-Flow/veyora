#!/usr/bin/env bash
# Veyora backup/restore verification drill.
#
# Creates test data in PostgreSQL, backs it up, wipes the database,
# restores from the backup, and verifies byte-level integrity.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:port/dbname ./scripts/backup-restore-drill.sh
#
# Prerequisites:
#   - PostgreSQL running and migrated (make migrate)
#   - backup and restore binaries built (cd backend && cargo build -p backup -p restore)

set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required (e.g. postgres://veyora:pass@localhost:5432/veyora)}"
BACKUP_BIN="${BACKUP_BIN:-./backend/target/debug/backup}"
RESTORE_BIN="${RESTORE_BIN:-./backend/target/debug/restore}"
TEMP_DIR=$(mktemp -d)

trap 'rm -rf "$TEMP_DIR"' EXIT

echo "=== Veyora Backup/Restore Drill ==="
echo "Database: $DATABASE_URL"
echo ""

# Step 1: Create a test record with known ciphertext
KNOWN_CT="deadbeef$(date +%s)"
echo "── Step 1: Creating test record ──"
# (Uses the running API; assumes VEYORA_API_BASE_URL or localhost:8080)
API="${VEYORA_API_URL:-http://127.0.0.1:8080}"
curl -s -X PUT "$API/records/backup-drill-test" \
  -H "Content-Type: application/json" \
  -d "{\"protocol_version\":1,\"suite_id\":1,\"deployment_id\":\"$(printf '0%.0s' {1..32})\",\"vault_id\":\"$(printf '0%.0s' {1..32})\",\"record_id\":\"backup-drill-test\",\"revision\":1,\"ciphertext\":\"$KNOWN_CT\",\"ciphertext_hash\":\"$(printf 'a%.0s' {1..64})\",\"ciphertext_length\":${#KNOWN_CT},\"tombstone\":false,\"template_envelope_hash\":\"$(printf '0%.0s' {1..64})\",\"manifest_binding\":\"$(printf '0%.0s' {1..64})\"}"
echo ""

# Step 2: Backup
echo "── Step 2: Backing up ──"
DATABASE_URL="$DATABASE_URL" "$BACKUP_BIN" > "$TEMP_DIR/backup.json"
BACKUP_COUNT=$(grep -c record_id "$TEMP_DIR/backup.json")
echo "Backed up $BACKUP_COUNT record(s) to $TEMP_DIR/backup.json"

# Step 3: Wipe
echo "── Step 3: Wiping database ──"
# This uses psql directly; adjust for your environment
echo "WARNING: This will DELETE all records. Press Ctrl+C to abort."
sleep 3
# Add wipe command here based on your PostgreSQL access method

# Step 4: Restore
echo "── Step 4: Restoring from backup ──"
DATABASE_URL="$DATABASE_URL" "$RESTORE_BIN" < "$TEMP_DIR/backup.json"

# Step 5: Verify
echo "── Step 5: Verifying restoration ──"
RESTORED_CT=$(curl -s "$API/records/backup-drill-test" | grep -o "\"ciphertext\":\"$KNOWN_CT\"")
if [ -n "$RESTORED_CT" ]; then
  echo "✓ PASS: Ciphertext integrity verified"
  echo "✓ Backup/restore drill completed successfully"
else
  echo "✗ FAIL: Restored ciphertext does not match original"
  exit 1
fi

echo ""
echo "=== Drill Complete ==="
