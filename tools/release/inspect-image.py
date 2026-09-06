#!/usr/bin/env python3
"""Inspect a container image's declared architectures (PRD DEP-007, 14.4).

Usage:
  python3 tools/release/inspect-image.py <image-reference> [--require amd64,arm64]

Prints one `<os>/<arch>[/<variant>]` line per platform entry in the image's
OCI index (or the single platform of an image manifest), then exits 0. With
--require, every listed architecture must appear as a linux platform entry,
otherwise the tool exits 1 — the release-evidence use: every published image
must expose linux/amd64 and linux/arm64.

Registry references (tags or digests) are inspected with
`docker buildx imagetools`; a locally built single-platform image can be
inspected by passing its local name when `docker buildx imagetools` cannot
resolve it, in which case `docker image inspect` reports the one platform.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys


def run(command: list[str]) -> str:
    result = subprocess.run(
        command, check=True, capture_output=True, text=True
    )
    return result.stdout


def registry_platforms(reference: str) -> list[str]:
    # --raw prints the registry's OCI manifest: an index with per-platform
    # manifests, or a single image manifest.
    document = json.loads(
        run(["docker", "buildx", "imagetools", "inspect", "--raw", reference])
    )
    platforms: list[str] = []
    for entry in document.get("manifests", []):
        platform = entry.get("platform")
        if not platform or platform.get("os") == "unknown":
            continue
        platform_id = f"{platform['os']}/{platform['architecture']}"
        if platform.get("variant"):
            platform_id += f"/{platform['variant']}"
        platforms.append(platform_id)
    if not platforms:
        # A single-platform image manifest declares its own platform.
        config = document.get("config", {})
        architecture = config.get("architecture")
        os_name = config.get("os")
        if architecture and os_name:
            platforms.append(f"{os_name}/{architecture}")
    return platforms


def local_platform(reference: str) -> list[str]:
    architecture = run(
        ["docker", "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", reference]
    ).strip()
    return [architecture] if architecture else []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", help="image reference (tag or digest)")
    parser.add_argument(
        "--require",
        default="",
        help="comma-separated architectures that must all be present as linux platforms",
    )
    args = parser.parse_args()

    try:
        platforms = registry_platforms(args.reference)
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        try:
            platforms = local_platform(args.reference)
        except subprocess.CalledProcessError as error:
            print(f"inspect-image: cannot inspect {args.reference}: {error}", file=sys.stderr)
            return 2

    for platform in platforms:
        print(platform)

    if args.require:
        required = {item.strip() for item in args.require.split(",") if item.strip()}
        linux_archs = {
            platform.split("/")[1] for platform in platforms if platform.startswith("linux/")
        }
        missing = sorted(required - linux_archs)
        if missing:
            print(
                f"inspect-image: {args.reference} is missing required linux "
                f"architectures: {', '.join(missing)}",
                file=sys.stderr,
            )
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
