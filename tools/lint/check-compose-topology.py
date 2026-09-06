#!/usr/bin/env python3
"""Enforce the deployment network-exposure topology (PRD DEP-003).

Only the reviewed gateway TLS edge port may bind all interfaces. Every other
published host port must be loopback-only, and internal services (api,
worker, migrator, backup, restore, validator) must publish no host ports at
all. The check renders the canonical Compose file with dummy required
variables and inspects the resolved port bindings, so exposure drift fails
`make check` instead of waiting for a port scan.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = ROOT / "deploy/compose/compose.yaml"

# Services that must not publish any host port.
INTERNAL_SERVICES = {
    "api",
    "worker",
    "migrator",
    "backup",
    "restore",
    "validator",
}
# The single reviewed public edge: the gateway's TLS listener.
PUBLIC_SERVICE = "gateway"
PUBLIC_TARGET_PORT = 8443
LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def rendered_services() -> dict:
    env = dict(os.environ)
    # Dummy values only satisfy required-variable interpolation; they never
    # reach a running container because nothing is started.
    env.update(
        {
            "VEYORA_DB_PASSWORD": "topology-check",
            "VEYORA_API_AUTH": "disabled",
        }
    )
    result = subprocess.run(
        [
            "docker",
            "compose",
            "-f",
            str(COMPOSE_FILE),
            "config",
            "--format",
            "json",
        ],
        capture_output=True,
        text=True,
        env=env,
        check=True,
    )
    return json.loads(result.stdout)["services"]


def validate(services: dict) -> list[str]:
    errors: list[str] = []
    for name, service in sorted(services.items()):
        ports = service.get("ports", [])
        if name in INTERNAL_SERVICES and ports:
            errors.append(
                f"{name} is an internal service and must not publish host ports "
                f"(found {[p.get('published') for p in ports]})"
            )
        for port in ports:
            host_ip = port.get("host_ip")
            target = port.get("target")
            if name == PUBLIC_SERVICE and target == PUBLIC_TARGET_PORT:
                # The reviewed TLS edge may bind all interfaces; an explicit
                # loopback binding would also be acceptable.
                continue
            if host_ip not in LOOPBACK:
                errors.append(
                    f"{name} publishes port {port.get('published')} on "
                    f"{host_ip or 'all interfaces'}; only {PUBLIC_SERVICE}'s TLS "
                    f"port {PUBLIC_TARGET_PORT} may be non-loopback"
                )
    if PUBLIC_SERVICE not in services:
        errors.append(f"missing expected service: {PUBLIC_SERVICE}")
    else:
        tls_ports = [
            p
            for p in services[PUBLIC_SERVICE].get("ports", [])
            if p.get("target") == PUBLIC_TARGET_PORT
        ]
        if not tls_ports:
            errors.append(
                f"{PUBLIC_SERVICE} must publish its TLS port {PUBLIC_TARGET_PORT}"
            )
    return errors


def main() -> int:
    try:
        services = rendered_services()
    except subprocess.CalledProcessError as error:
        print(f"compose topology check: docker compose config failed: {error}", file=sys.stderr)
        return 2
    errors = validate(services)
    for error in errors:
        print(f"compose topology check: {error}", file=sys.stderr)
    if errors:
        return 1
    print("compose topology check: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
