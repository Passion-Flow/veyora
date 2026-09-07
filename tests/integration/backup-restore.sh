#!/usr/bin/env bash
# Veyora backup/restore verification drill.
#
# Creates test data in PostgreSQL, backs it up, wipes the database,
# restores from the backup, and verifies byte-level integrity.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:port/dbname ./tests/integration/backup-restore.sh
#
# Prerequisites:
#   - PostgreSQL running and migrated (make migrate)
#   - backup and restore binaries built (cargo build -p backup -p restore)

set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required (e.g. postgres://veyora:pass@localhost:5432/veyora)}"
BACKUP_BIN="${BACKUP_BIN:-.build/cargo/debug/backup}"
RESTORE_BIN="${RESTORE_BIN:-.build/cargo/debug/restore}"
TEMP_DIR=$(mktemp -d)

trap 'rm -rf "$TEMP_DIR"' EXIT

echo "=== Veyora Backup/Restore Drill ==="
echo "Database: $DATABASE_URL"
echo ""

# Step 1: Create a test record with known ciphertext (unique per run so a
# re-run against a surviving store cannot 409; writes carry the declared
# vault scope per DATA-004). The row is kernel-shaped — hex ids, a real
# SHA-256 over the ciphertext bytes, and a byte-accurate length — so the
# scheduled-backup verifier (veyora-restore --verify) accepts it exactly
# like a client-sealed row.
KNOWN_CT="deadbeef$(printf '%010x' "$(date +%s)")"
KNOWN_HASH=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(bytes.fromhex(sys.argv[1])).hexdigest())' "$KNOWN_CT")
RECORD_ID="$(printf '%032x' $(( $(date +%s) % 4294967296 )))"
VAULT="$(printf '0%.0s' {1..32})"
echo "── Step 1: Creating test record ──"
API="${VEYORA_API_URL:-http://127.0.0.1:8080}"
curl -s --fail -X PUT "$API/records/$RECORD_ID?vault=$VAULT" \
  -H "Content-Type: application/json" \
  -d "{\"protocol_version\":1,\"suite_id\":1,\"deployment_id\":\"$VAULT\",\"vault_id\":\"$VAULT\",\"record_id\":\"$RECORD_ID\",\"revision\":1,\"ciphertext\":\"$KNOWN_CT\",\"ciphertext_hash\":\"$KNOWN_HASH\",\"ciphertext_length\":$(( ${#KNOWN_CT} / 2 )),\"tombstone\":false,\"template_envelope_hash\":\"$(printf '0%.0s' {1..64})\",\"manifest_binding\":\"$(printf '0%.0s' {1..64})\"}"
echo ""

# Step 2: Backup, then verify the snapshot the way the scheduled loop does
# (DEP-011): structure plus a fresh SHA-256 over every ciphertext. A
# corrupted hash must fail the verifier — that is the negative control
# proving the check cannot pass vacuously.
echo "── Step 2: Backing up ──"
DATABASE_URL="$DATABASE_URL" "$BACKUP_BIN" > "$TEMP_DIR/backup.json"
BACKUP_COUNT=$(grep -c record_id "$TEMP_DIR/backup.json")
echo "Backed up $BACKUP_COUNT record(s) to $TEMP_DIR/backup.json"
if "$RESTORE_BIN" --verify < "$TEMP_DIR/backup.json" 2>"$TEMP_DIR/verify.log"; then
  echo "✓ PASS: snapshot verifies (integrity + structure)"
else
  echo "✗ FAIL: snapshot failed verification:"
  cat "$TEMP_DIR/verify.log"
  exit 1
fi
python3 - "$TEMP_DIR/backup.json" > "$TEMP_DIR/corrupt.json" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))
first = rows[0]["ciphertext_hash"]
rows[0]["ciphertext_hash"] = ("0" if first[-1] != "0" else "1") + first[1:]
json.dump(rows, sys.stdout)
PY
if "$RESTORE_BIN" --verify < "$TEMP_DIR/corrupt.json" >/dev/null 2>&1; then
  echo "✗ FAIL: a corrupted ciphertext hash passed verification"
  exit 1
else
  echo "✓ PASS: corrupted hash is rejected by the verifier"
fi

# Step 3: Wipe every record so the restore is proven against an empty
# destination. psql wins; otherwise the postgres container via docker.
echo "── Step 3: Wiping database ──"
echo "WARNING: This will DELETE all records in DATABASE_URL."
if command -v psql >/dev/null 2>&1; then
  psql "$DATABASE_URL" -c "TRUNCATE records"
elif command -v docker >/dev/null 2>&1 \
  && [ -n "${VEYORA_POSTGRES_CONTAINER:-}" ]; then
  docker exec "$VEYORA_POSTGRES_CONTAINER" sh -c \
    "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c 'TRUNCATE records'"
else
  echo "no psql and no VEYORA_POSTGRES_CONTAINER; cannot wipe" >&2
  exit 1
fi

# Step 4: Restore
echo "── Step 4: Restoring from backup ──"
DATABASE_URL="$DATABASE_URL" "$RESTORE_BIN" < "$TEMP_DIR/backup.json"

# Step 5: Verify
echo "── Step 5: Verifying restoration ──"
RESTORED_CT=$(curl -s --fail "$API/records/$RECORD_ID?vault=$VAULT" | grep -o "\"ciphertext\":\"$KNOWN_CT\"")
if [ -n "$RESTORED_CT" ]; then
  echo "✓ PASS: Ciphertext integrity verified"
  echo "✓ Backup/restore drill completed successfully"
else
  echo "✗ FAIL: Restored ciphertext does not match original"
  exit 1
fi

echo ""
echo "=== Drill Complete ==="
