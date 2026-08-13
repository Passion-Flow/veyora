#!/usr/bin/env bash
# Veyora multi-arch image build + push script.
#
# Builds all 8 Veyora images for linux/amd64 + linux/arm64 and pushes them to
# an operator-selected OCI registry.
#
# Usage:
#   REGISTRY=ghcr.io NAMESPACE=your-account VERSION=v1.0.0-preview ./scripts/build-and-push.sh
#
# Prerequisites:
#   docker buildx (included in Docker 19.03+)
#   docker login to the target registry

set -euo pipefail

REGISTRY="${REGISTRY:?REGISTRY is required (for example, ghcr.io)}"
NAMESPACE="${NAMESPACE:?NAMESPACE is required (for example, your account or organization)}"
VERSION="${VERSION:-v1.0.0-preview}"
PLATFORMS="linux/amd64,linux/arm64"

echo "=== Veyora multi-arch build ==="
echo "  Registry:  $REGISTRY"
echo "  Namespace: $NAMESPACE"
echo "  Version:   $VERSION"
echo "  Platforms: $PLATFORMS"
echo ""

# Ensure buildx multi-platform builder exists
if ! docker buildx inspect veyora-builder >/dev/null 2>&1; then
  echo "Creating buildx builder..."
  docker buildx create --name veyora-builder --use
else
  docker buildx use veyora-builder
fi

# --- Build and push Veyora services ---
SERVICES=("api" "worker" "migrator" "backup" "restore" "sandbox")

for svc in "${SERVICES[@]}"; do
  IMAGE="$REGISTRY/$NAMESPACE/veyora-$svc:$VERSION"
  echo ""
  echo "=== Building $svc -> $IMAGE ==="
  docker buildx build \
    --platform "$PLATFORMS" \
    --tag "$IMAGE" \
    --tag "$REGISTRY/$NAMESPACE/veyora-$svc:latest" \
    -f "backend/Dockerfile.$svc" \
    --push \
    .
  echo "  ✓ Pushed $IMAGE"
done

# --- Web client ---
WEB_IMAGE="$REGISTRY/$NAMESPACE/veyora-web:$VERSION"
echo ""
echo "=== Building web -> $WEB_IMAGE ==="
docker buildx build \
  --platform "$PLATFORMS" \
  --tag "$WEB_IMAGE" \
  --tag "$REGISTRY/$NAMESPACE/veyora-web:latest" \
  -f deployment/web/Dockerfile \
  --push \
  deployment/web/
echo "  ✓ Pushed $WEB_IMAGE"

# --- Gateway (Envoy) ---
GW_IMAGE="$REGISTRY/$NAMESPACE/veyora-gateway:$VERSION"
echo ""
echo "=== Building gateway -> $GW_IMAGE ==="
docker buildx build \
  --platform "$PLATFORMS" \
  --tag "$GW_IMAGE" \
  --tag "$REGISTRY/$NAMESPACE/veyora-gateway:latest" \
  -f deployment/Dockerfile.gateway.build \
  --push \
  .
echo "  ✓ Pushed $GW_IMAGE"

echo ""
echo "=== DONE: All images pushed ==="
echo ""
echo "Services:"
for svc in api worker migrator backup restore sandbox web gateway; do
  echo "  $REGISTRY/$NAMESPACE/veyora-$svc:$VERSION"
done
