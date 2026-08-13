#!/usr/bin/env bash
# Veyora smoke test: start API, create a record, retrieve it, verify, shut down.
# Usage: ./scripts/smoke-test.sh [API_URL]
#
# Exit codes: 0 = pass, 1 = fail, 2 = API unreachable

set -euo pipefail

API="${1:-http://127.0.0.1:8080}"
RECORD_ID="smoke-$(date +%s)"
CIPHERTEXT="deadbeef"
CIPHERTEXT_HASH="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

echo "=== Veyora Smoke Test ==="
echo "API: $API"
echo "Record: $RECORD_ID"
echo ""

# 1. Health check
echo -n "1. Health check... "
HEALTH=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "$API/healthz" || echo "000")
if [ "$HEALTH" != "200" ]; then
  echo "FAIL (got $HEALTH)"
  exit 2
fi
echo "OK"

# 2. Ready check
echo -n "2. Ready check... "
READY=$(curl -s -m 5 "$API/readyz" 2>/dev/null || echo '{}')
READY_STATE=$(echo "$READY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ready',False))" 2>/dev/null || echo "False")
if [ "$READY_STATE" != "True" ]; then
  echo "FAIL (not ready)"
  exit 1
fi
echo "OK"

# 3. Create record
echo -n "3. PUT record... "
PUT_STATUS=$(curl -s -m 5 -o /dev/null -w "%{http_code}" \
  -X PUT "$API/records/$RECORD_ID" \
  -H "content-type: application/json" \
  -d "{\"protocol_version\":1,\"suite_id\":1,\"deployment_id\":\"0f\",\"vault_id\":\"1f\",\"record_id\":\"$RECORD_ID\",\"revision\":1,\"ciphertext\":\"$CIPHERTEXT\",\"ciphertext_hash\":\"$CIPHERTEXT_HASH\",\"ciphertext_length\":4,\"tombstone\":false,\"template_envelope_hash\":\"$(python3 -c 'print("0"*64)')\",\"manifest_binding\":\"$(python3 -c 'print("0"*64)')\"}" \
  || echo "000")
if [ "$PUT_STATUS" != "201" ]; then
  echo "FAIL (got $PUT_STATUS)"
  exit 1
fi
echo "OK (201)"

# 4. Retrieve record
echo -n "4. GET record... "
GET_CT=$(curl -s -m 5 "$API/records/$RECORD_ID" 2>/dev/null | \
  python3 -c "import sys,json; print(json.load(sys.stdin).get('ciphertext',''))" 2>/dev/null || echo "")
if [ "$GET_CT" != "$CIPHERTEXT" ]; then
  echo "FAIL (ciphertext mismatch)"
  exit 1
fi
echo "OK (ciphertext matches)"

# 5. List records
echo -n "5. LIST records... "
LIST_COUNT=$(curl -s -m 5 "$API/records" 2>/dev/null | \
  python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
if [ "$LIST_COUNT" -lt 1 ]; then
  echo "FAIL (no records)"
  exit 1
fi
echo "OK ($LIST_COUNT record(s))"

# 6. Delete record
echo -n "6. DELETE record... "
DEL_STATUS=$(curl -s -m 5 -o /dev/null -w "%{http_code}" \
  -X DELETE "$API/records/$RECORD_ID" \
  -H "content-type: application/json" \
  -d '{"expected_prior_revision":1}' \
  || echo "000")
if [ "$DEL_STATUS" != "200" ]; then
  echo "FAIL (got $DEL_STATUS)"
  exit 1
fi
echo "OK (tombstoned)"

# 7. Verify tombstone
echo -n "7. Verify tombstone... "
TOMB=$(curl -s -m 5 "$API/records/$RECORD_ID" 2>/dev/null | \
  python3 -c "import sys,json; print(json.load(sys.stdin).get('tombstone',False))" 2>/dev/null || echo "False")
if [ "$TOMB" != "True" ]; then
  echo "FAIL (not tombstoned)"
  exit 1
fi
echo "OK"

# 8. Metrics
echo -n "8. Metrics endpoint... "
METRICS=$(curl -s -m 5 "$API/metrics" 2>/dev/null || echo "")
if echo "$METRICS" | grep -q "veyora_requests_total"; then
  echo "OK"
else
  echo "FAIL (no metrics)"
  exit 1
fi

echo ""
echo "=== ALL CHECKS PASSED ==="
