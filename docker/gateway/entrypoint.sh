#!/bin/bash
# Veyora gateway entrypoint — selects TLS or plain-HTTP config at startup.
#
# TLS mode (VEYORA_GATEWAY_TLS_CERT_FILE set):
#   Renders envoy-tls.yaml with certificate paths and port assignments.
#   Listens on TLS_PORT (default 8443) + HTTP redirect on HTTP_PORT (8080).
#
# Plain mode (no certificates):
#   Uses envoy-plain.yaml directly (simple proxy, no redirect).
#   Listens on HTTP_PORT only.
set -eu

: "${VEYORA_GATEWAY_HTTP_PORT:=8080}"
: "${VEYORA_API_UPSTREAM_HOST:?VEYORA_API_UPSTREAM_HOST is required}"
: "${VEYORA_API_UPSTREAM_PORT:?VEYORA_API_UPSTREAM_PORT is required}"
: "${VEYORA_GATEWAY_ROUTE_TIMEOUT_SECONDS:?VEYORA_GATEWAY_ROUTE_TIMEOUT_SECONDS is required}"

if [ -n "${VEYORA_GATEWAY_TLS_CERT_FILE:-}" ] && [ -n "${VEYORA_GATEWAY_TLS_KEY_FILE:-}" ]; then
  # ── TLS mode ──
  VEYORA_GATEWAY_TLS_PORT="${VEYORA_GATEWAY_TLS_PORT:-8443}"

  if [ ! -f "${VEYORA_GATEWAY_TLS_CERT_FILE}" ]; then
    echo "veyora-gateway: TLS certificate not found: ${VEYORA_GATEWAY_TLS_CERT_FILE}" >&2
    exit 1
  fi
  if [ ! -f "${VEYORA_GATEWAY_TLS_KEY_FILE}" ]; then
    echo "veyora-gateway: TLS private key not found: ${VEYORA_GATEWAY_TLS_KEY_FILE}" >&2
    exit 1
  fi

  echo "veyora-gateway: TLS on :${VEYORA_GATEWAY_TLS_PORT}, redirect on :${VEYORA_GATEWAY_HTTP_PORT}" >&2

  cp /etc/envoy/envoy-tls.yaml /etc/envoy/envoy.yaml
  sed -i \
    -e "s/__VEYORA_GATEWAY_TLS_PORT__/${VEYORA_GATEWAY_TLS_PORT}/g" \
    -e "s/__VEYORA_GATEWAY_HTTP_PORT__/${VEYORA_GATEWAY_HTTP_PORT}/g" \
    -e "s|__VEYORA_GATEWAY_TLS_CERT_FILE__|${VEYORA_GATEWAY_TLS_CERT_FILE}|g" \
    -e "s|__VEYORA_GATEWAY_TLS_KEY_FILE__|${VEYORA_GATEWAY_TLS_KEY_FILE}|g" \
    -e "s/__VEYORA_API_UPSTREAM_HOST__/${VEYORA_API_UPSTREAM_HOST}/g" \
    -e "s/__VEYORA_API_UPSTREAM_PORT__/${VEYORA_API_UPSTREAM_PORT}/g" \
    -e "s/__VEYORA_GATEWAY_ROUTE_TIMEOUT_SECONDS__/${VEYORA_GATEWAY_ROUTE_TIMEOUT_SECONDS}/g" \
    /etc/envoy/envoy.yaml
else
  # ── Plain HTTP mode (no redirect, no TLS) ──
  echo "veyora-gateway: plain HTTP proxy on :${VEYORA_GATEWAY_HTTP_PORT}" >&2

  cp /etc/envoy/envoy-plain.yaml /etc/envoy/envoy.yaml
  sed -i \
    -e "s/port_value: 8080/port_value: ${VEYORA_GATEWAY_HTTP_PORT}/" \
    -e "s/address: api/address: ${VEYORA_API_UPSTREAM_HOST}/" \
    -e "s/port_value: 8080/port_value: ${VEYORA_API_UPSTREAM_PORT}/" \
    -e "s/timeout: 30s/timeout: ${VEYORA_GATEWAY_ROUTE_TIMEOUT_SECONDS}s/" \
    /etc/envoy/envoy.yaml
fi

exec envoy -c /etc/envoy/envoy.yaml --log-level error
