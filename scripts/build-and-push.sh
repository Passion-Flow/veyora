#!/usr/bin/env bash
# Veyora multi-arch image build + push script.
#
# Publishes 5 mirrored foundations and 8 Veyora application images for
# linux/amd64 + linux/arm64 to an operator-selected OCI registry.
#
# Usage (the defaults publish the official Veyora images):
#   ./scripts/build-and-push.sh
#
# Registry-neutral override:
#   REGISTRY=ghcr.io NAMESPACE=your-account VERSION=v1.0.0 ./scripts/build-and-push.sh
#
# Networks without direct Docker Hub access can route the pinned upstream
# foundations through a trustworthy mirror. Digests are content-addressed,
# so a mirror yields byte-identical images:
#   UPSTREAM_MIRROR=docker.m.daocloud.io ./scripts/build-and-push.sh
#
# Prerequisites:
#   docker buildx (included in Docker 19.03+)
#   docker login to the target registry

set -euo pipefail

REGISTRY="${REGISTRY:-crpi-ew8juv9423tvogc4.cn-hongkong.personal.cr.aliyuncs.com}"
NAMESPACE="${NAMESPACE:-passion_project}"
VERSION="${VERSION:-v1.0.0}"
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
docker buildx inspect --bootstrap >/dev/null

# --- Mirror every external build/runtime foundation ---
# Keeping these in the Veyora namespace makes production pulls deterministic
# and removes Docker Hub from the deployment path.
FOUNDATIONS=("postgres" "nginx" "envoy" "rust" "debian")
UPSTREAM_IMAGES=(
  "postgres:16-bookworm@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8"
  "nginx:1.29.5-alpine@sha256:1eff5a5f3fcf8431a0abb7eddf5471fec24e5e1905a2581aeacdb07a4479b92b"
  "envoyproxy/envoy:v1.31.10@sha256:caa5b411be1633b90023592a34a7e010c933d6e60206c758f631485e53006865"
  "rust:1.93.1-slim@sha256:c0a38f5662afdb298898da1d70b909af4bda4e0acff2dc52aea6360a9b9c6956"
  "debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241"
)

# Optional Docker Hub mirror prefix (see header notes).
UPSTREAM_MIRROR="${UPSTREAM_MIRROR:-}"
# SKIP_MIRRORS=1 re-runs only the application builds — for when the
# foundations are already mirrored (e.g. resumed runs, or mirrors that were
# pushed out-of-band because an upstream digest became unavailable).
resolve_upstream() {
  if [ -z "$UPSTREAM_MIRROR" ]; then
    printf '%s\n' "$1"
    return
  fi
  local repo="${1%%@*}" digest="${1##*@}"
  case "$repo" in
    # Namespaced upstreams keep their path; official images live under library/.
    */*) printf '%s/%s@%s\n' "$UPSTREAM_MIRROR" "$repo" "$digest" ;;
    *)   printf '%s/library/%s@%s\n' "$UPSTREAM_MIRROR" "$repo" "$digest" ;;
  esac
}

if [ "${SKIP_MIRRORS:-0}" != "1" ]; then
  for index in "${!FOUNDATIONS[@]}"; do
    foundation="${FOUNDATIONS[$index]}"
    upstream="$(resolve_upstream "${UPSTREAM_IMAGES[$index]}")"
    image="$REGISTRY/$NAMESPACE/veyora-$foundation:$VERSION"
    echo ""
    echo "=== Mirroring $upstream -> $image ==="
    docker buildx build \
      --platform "$PLATFORMS" \
      --provenance=false \
      --build-arg "BASE_IMAGE=$upstream" \
      --tag "$image" \
      -f docker/Dockerfile.mirror \
      --push \
      .
    echo "  ✓ Pushed $image"
  done
fi

# --- Build and push Veyora services ---
SERVICES=("api" "worker" "migrator" "backup" "restore" "sandbox")

for svc in "${SERVICES[@]}"; do
  IMAGE="$REGISTRY/$NAMESPACE/veyora-$svc:$VERSION"
  echo ""
  echo "=== Building $svc -> $IMAGE ==="
  docker buildx build \
    --platform "$PLATFORMS" \
    --provenance=false \
    --build-arg "RUST_IMAGE=$REGISTRY/$NAMESPACE/veyora-rust:$VERSION" \
    --build-arg "DEBIAN_IMAGE=$REGISTRY/$NAMESPACE/veyora-debian:$VERSION" \
    --tag "$IMAGE" \
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
  --provenance=false \
  --build-arg "NGINX_IMAGE=$REGISTRY/$NAMESPACE/veyora-nginx:$VERSION" \
  --tag "$WEB_IMAGE" \
  -f deployment/web/Dockerfile \
  --push \
  .
echo "  ✓ Pushed $WEB_IMAGE"

# --- Gateway (Envoy) ---
GW_IMAGE="$REGISTRY/$NAMESPACE/veyora-gateway:$VERSION"
echo ""
echo "=== Building gateway -> $GW_IMAGE ==="
docker buildx build \
  --platform "$PLATFORMS" \
  --provenance=false \
  --build-arg "ENVOY_IMAGE=$REGISTRY/$NAMESPACE/veyora-envoy:$VERSION" \
  --tag "$GW_IMAGE" \
  -f deployment/Dockerfile.gateway.build \
  --push \
  .
echo "  ✓ Pushed $GW_IMAGE"

echo ""
echo "=== DONE: All images pushed ==="
echo ""
echo "Images:"
for svc in postgres nginx envoy rust debian api worker migrator backup restore sandbox web gateway; do
  image="$REGISTRY/$NAMESPACE/veyora-$svc:$VERSION"
  manifest="$(docker buildx imagetools inspect "$image")"
  for platform in linux/amd64 linux/arm64; do
    if ! grep -Fq "Platform:  $platform" <<<"$manifest"; then
      echo "ERROR: $image is missing $platform" >&2
      exit 1
    fi
  done
  echo "  ✓ $image (linux/amd64, linux/arm64)"
done
