#!/usr/bin/env bash
# Veyora one-command production deployment.
#
# Usage (from the repository root):
#   ./scripts/deploy.sh                          # Interactive setup
#   ./scripts/deploy.sh --domain vault.example.com  # Non-interactive
#
# Prerequisites:
#   - Docker Engine + Docker Compose
#   - OpenSSL (for password generation)
#   - TLS certificates (Let's Encrypt or your CA)
#   - docker/.env created from docker/.env.example
set -euo pipefail

ENV_FILE="docker/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — create it first:" >&2
  echo "  cp docker/.env.example docker/.env" >&2
  exit 1
fi

set -a; source "$ENV_FILE"; set +a
REGISTRY="${REGISTRY:-ghcr.io}"
NAMESPACE="${NAMESPACE:-passion-flow}"
VERSION="${VERSION:-v1.0.0}"
DOMAIN=""
CERT_DIR="./certs"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2"; shift 2 ;;
    --cert-dir) CERT_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "╔══════════════════════════════════════════════╗"
echo "║     Veyora Production Deployment             ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Step 1: Generate secrets if not set
if [ -z "${VEYORA_DB_PASSWORD:-}" ]; then
  VEYORA_DB_PASSWORD=$(openssl rand -hex 32)
  echo "VEYORA_DB_PASSWORD=$VEYORA_DB_PASSWORD" >> "$ENV_FILE"
  echo "✓ Generated database password"
fi
if [ -z "${VEYORA_API_TOKEN:-}" ] && [ "${VEYORA_API_AUTH:-}" = "token" ]; then
  VEYORA_API_TOKEN=$(openssl rand -hex 32)
  echo "VEYORA_API_TOKEN=$VEYORA_API_TOKEN" >> "$ENV_FILE"
  echo "✓ Generated API token"
  export VEYORA_API_TOKEN
fi

# Step 2: Check TLS certificates
if [ -n "$DOMAIN" ]; then
  CERT_PATH="/etc/letsencrypt/live/$DOMAIN"
  if [ ! -f "$CERT_PATH/fullchain.pem" ]; then
    echo "⚠ TLS certificate not found at $CERT_PATH"
    echo "  Run: sudo certbot certonly --standalone -d $DOMAIN"
    exit 1
  fi
  export VEYORA_GATEWAY_TLS_CERT_FILE="/certs/fullchain.pem"
  export VEYORA_GATEWAY_TLS_KEY_FILE="/certs/privkey.pem"
  export VEYORA_TLS_CERT_DIR="$CERT_PATH"
else
  echo "⚠ No domain specified — deploying without TLS (development mode)"
  echo "  For production: ./scripts/deploy.sh --domain your.domain.com"
fi

# Step 3: Set production defaults
export VEYORA_API_AUTH="${VEYORA_API_AUTH:-token}"
export VEYORA_API_CORS_ORIGINS="${VEYORA_API_CORS_ORIGINS:-}"
export VEYORA_API_RATE_LIMIT="${VEYORA_API_RATE_LIMIT:-120}"

# Step 4: Pull latest images
echo "── Pulling images ──"
cd docker
docker compose pull 2>&1 | grep "Pulled" | head -6 || true

# Step 5: Start the stack
echo "── Starting services ──"
docker compose up -d

# Step 6: Wait for health
echo "── Waiting for services ──"
for service in postgres api gateway web; do
  for i in $(seq 1 30); do
    STATUS=$(docker compose ps --format json 2>/dev/null | \
      python3 -c "import json,sys; [print(s.get('Health','')) for s in json.load(sys.stdin) if s.get('Service')=='$service']" 2>/dev/null || echo "")
    [ "$STATUS" = "healthy" ] && break
    sleep 2
  done
  echo "  $service: ${STATUS:-started}"
done

# Step 7: Verify
echo "── Verification ──"
PROTOCOL="http"
[ -n "$DOMAIN" ] && PROTOCOL="https"
GATEWAY_URL="$PROTOCOL://127.0.0.1:8080"

HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_URL/healthz" \
  -H "Authorization: Bearer ${VEYORA_API_TOKEN:-}" 2>/dev/null || echo "000")
WEB=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3000/" 2>/dev/null || echo "000")

echo "  API health: $HEALTH"
echo "  Web client: $WEB"

if [ "$HEALTH" = "200" ] && [ "$WEB" = "200" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════╗"
  echo "║  ✓ Deployment successful                     ║"
  echo "╚══════════════════════════════════════════════╝"
  echo ""
  echo "  Web client: http://127.0.0.1:3000"
  [ -n "$DOMAIN" ] && echo "  Public URL:  https://$DOMAIN"
  echo ""
  echo "  Next steps:"
  echo "    1. Open the web client and create your vault"
  echo "    2. Save the recovery kit offline"
  echo "    3. Set up DNS pointing to this server"
  echo "    4. Configure automated backups:"
  echo "       cd docker && docker compose --profile backup up -d backup"
else
  echo "⚠ Some services may not be ready. Check logs:"
  echo "  cd docker && docker compose logs"
fi
