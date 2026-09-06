#!/usr/bin/env bash
# Veyora header-contract smoke test (PRD DEP-009, SEC-WEB-001..003):
# compares the security headers served by a live web origin against the
# versioned contract contracts/web/security-headers-v1.json.
#
# Usage: ./tests/smoke/headers.sh [WEB_URL]
#   WEB_URL defaults to http://127.0.0.1:3311 (the local compose preview
#   started with VEYORA_WEB_PORT=3311).
#
# Exit codes: 0 = pass, 1 = mismatch/missing header, 2 = origin unreachable.

set -euo pipefail

WEB="${1:-http://127.0.0.1:3311}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONTRACT="$REPO_ROOT/contracts/web/security-headers-v1.json"

echo "=== Veyora Header Contract Smoke Test ==="
echo "Web origin: $WEB"
echo ""

# The origin must be reachable at all.
STATUS=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "$WEB/" || echo "000")
if [ "$STATUS" != "200" ]; then
  echo "FAIL: web origin unreachable (got $STATUS)"
  exit 2
fi

FAILURES=0
check_header() {
  local name="$1" expected="$2"
  local actual
  actual=$(curl -s -m 5 -D - -o /dev/null "$WEB/" | python3 -c '
import sys
name = sys.argv[1].lower()
for line in sys.stdin.read().replace("\r", "").splitlines():
    if ":" in line:
        key, _, value = line.partition(":")
        if key.strip().lower() == name:
            print(value.strip())
            break
' "$name")
  if [ -z "$actual" ]; then
    echo "FAIL: $name missing from the live origin"
    FAILURES=$((FAILURES + 1))
  elif [ "$actual" != "$expected" ]; then
    echo "FAIL: $name mismatch"
    echo "  contract: $expected"
    echo "  live:     $actual"
    FAILURES=$((FAILURES + 1))
  else
    echo "OK: $name"
  fi
}

# Every contract header must be served with the exact contract value. The
# CSP connect-src is rendered from VEYORA_CSP_CONNECT_SRC (default 'self'),
# which equals the contract value; any other rendering must still be
# compared literally so the contract stays the authority.
while IFS=$'\t' read -r name value; do
  check_header "$name" "$value"
done < <(python3 -c '
import json
contract = json.load(open("'"$CONTRACT"'"))
for name, value in contract["headers"].items():
    print(f"{name}\t{value}")
')

# Forbidden evaluations: JavaScript unsafe-eval must never appear; the
# narrow wasm-unsafe-eval allowance is fine only inside script-src.
CSP=$(curl -s -m 5 -D - -o /dev/null "$WEB/" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-security-policy"{$1=""; sub(/^: /,""); print; exit}')
if printf '%s' "$CSP" | grep -q "script-src[^;]*'unsafe-eval'"; then
  echo "FAIL: script-src contains forbidden 'unsafe-eval'"
  FAILURES=$((FAILURES + 1))
fi
if ! printf '%s' "$CSP" | grep -q "object-src 'none'"; then
  echo "FAIL: CSP must contain object-src 'none'"
  FAILURES=$((FAILURES + 1))
fi
if ! printf '%s' "$CSP" | grep -q "base-uri 'none'"; then
  echo "FAIL: CSP must contain base-uri 'none'"
  FAILURES=$((FAILURES + 1))
fi
if ! printf '%s' "$CSP" | grep -q "frame-ancestors 'none'"; then
  echo "FAIL: CSP must contain frame-ancestors 'none'"
  FAILURES=$((FAILURES + 1))
fi

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "=== $FAILURES FAILURE(S) ==="
  exit 1
fi
echo "=== ALL HEADER CHECKS PASSED ==="
