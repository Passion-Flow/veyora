# Veyora Production TLS Deployment Guide

This guide covers deploying Veyora with TLS termination via the bundled
Envoy gateway, suitable for public internet exposure.

## Topology

```
Internet ──TLS:443──► Envoy Gateway ──► nginx (web client) ──► Browser
                              │
                              └──► API :8080 ──► PostgreSQL
```

## 1. Prerequisites

- A domain name with DNS A/AAAA record pointing to your server
- TLS certificate (Let's Encrypt via certbot, or your CA)
- Docker Engine + Docker Compose
- Open ports: 80 (redirect), 443 (TLS)

## 2. Obtain TLS certificates

```bash
sudo apt install certbot
sudo certbot certonly --standalone -d vault.example.com
```

Certificates land in `/etc/letsencrypt/live/vault.example.com/`.

## 3. Configure environment

```bash
cp docker/.env.example docker/.env
```

Edit `docker/.env` with production values:

```bash
# REQUIRED: strong database password
VEYORA_DB_PASSWORD=<generate-with: openssl rand -hex 32>

# REQUIRED: API authentication token
VEYORA_API_AUTH=token
VEYORA_API_TOKEN=<generate-with: openssl rand -hex 32>

# Security hardening
VEYORA_API_CORS_ORIGINS=https://vault.example.com
VEYORA_API_RATE_LIMIT=120

# TLS termination (gateway) — uncomment in .env and set the host
# certificate directory plus the in-container paths
VEYORA_TLS_CERT_DIR=/etc/letsencrypt/live/vault.example.com
VEYORA_GATEWAY_TLS_CERT_FILE=/certs/fullchain.pem
VEYORA_GATEWAY_TLS_KEY_FILE=/certs/privkey.pem
VEYORA_GATEWAY_TLS_PORT=443
```

## 4. Envoy TLS listener

The gateway's Envoy configuration (`docker/gateway/envoy.yaml`) terminates
TLS. Mount the certificates and start the stack:

```bash
cd docker && docker compose up -d
```

Verify TLS:

```bash
curl -v https://vault.example.com/healthz
curl -v https://vault.example.com/ -o /dev/null -w "%{ssl_verify_result}\n"
```

## 5. Certificate renewal

Add a cron job to renew certificates and reload Envoy:

```bash
echo "0 3 * * * certbot renew --quiet && cd /path/to/veyora/docker && docker compose exec gateway kill -HUP 1" | sudo crontab -
```

## 6. Security checklist

Before exposing to the public internet:

- [ ] `VEYORA_API_AUTH=token` with a strong token
- [ ] `VEYORA_API_CORS_ORIGINS` set to your domain (no wildcard)
- [ ] `VEYORA_API_RATE_LIMIT` set (recommended: 120/min)
- [ ] TLS certificate valid and auto-renewing
- [ ] PostgreSQL not exposed to the public internet
- [ ] Regular backups configured (see §7)
- [ ] Firewall: only 80/443 open
- [ ] `docker compose logs` monitored for anomalies

## 7. Automated backups

The Compose topology ships an optional backup profile. From the `docker/`
directory:

```bash
docker compose --profile backup up -d backup
```

This runs a full opaque snapshot daily and retains 7 days under `backups/`.

## 8. Monitoring

The API exposes Prometheus metrics at `/metrics`:

```
veyora_requests_total 12345
veyora_puts_total 678
veyora_uptime_seconds 86400
```

Scrape with Prometheus and alert on:
- `veyora_requests_total` rate drop (service down)
- HTTP 5xx rate > 1% (backend errors)
- `veyora_uptime_seconds` reset (restart loop)

## References

- OWASP API Security Top 10 (2023): API6 (unrestricted access)
- NIST SP 800-63B: §5.2.2 (rate limiting on auth endpoints)
- RFC 9110 §9.6: CORS security considerations
- Envoy proxy TLS termination: envoyproxy.io/docs/envoy/latest/intro/arch_overview/security
