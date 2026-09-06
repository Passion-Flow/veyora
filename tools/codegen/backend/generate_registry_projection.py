#!/usr/bin/env python3
"""Generate the backend settings registry projection.

Reads the canonical owner-shared registry (``contracts/registry/settings.json``)
and writes the backend-owned read-only projection
``packages/config/registry.generated.json``:

- settings are the canonical entries whose ``owner`` is ``backend``,
  byte-identical, ordered by setting id;
- ``_generated`` records the source, a SHA-256 of the canonical file bytes
  (``source_integrity``), and a structured digest over the metadata plus the
  projected settings (``projection_integrity``).

The Rust projection generator
(``tools/codegen/backend/generate_backend_projection.py``) consumes this file;
run it after this one. Use ``--check`` to fail on drift and ``--write`` to
regenerate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "contracts" / "registry" / "settings.json"
OUTPUT = ROOT / "packages" / "config" / "registry.generated.json"
BANNER = "GENERATED: read-only owner projection; edit contracts/registry/settings.json"
SOURCE_RELATIVE = "contracts/registry/settings.json"
OWNER = "backend"
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
MAX_DIAGNOSTIC_LENGTH = 280


class ProjectionError(ValueError):
    pass


def structured_digest(value: Any) -> str:
    encoded = json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def build(source_raw: bytes) -> str:
    try:
        canonical = json.loads(source_raw)
    except json.JSONDecodeError as error:
        raise ProjectionError(
            f"invalid JSON in {SOURCE_RELATIVE}: line {error.lineno} column {error.colno}"
        ) from None
    if not isinstance(canonical, dict) or not isinstance(
        canonical.get("settings"), list
    ):
        raise ProjectionError(f"{SOURCE_RELATIVE} must contain a settings array")
    if canonical.get("catalog_version") != 1:
        raise ProjectionError(f"{SOURCE_RELATIVE} catalog_version must be 1")
    projected = [
        setting
        for setting in canonical["settings"]
        if isinstance(setting, dict) and setting.get("owner") == OWNER
    ]
    projected.sort(key=lambda setting: setting.get("id", ""))
    if not projected:
        raise ProjectionError("the canonical registry has no backend-owned settings")
    ids = [setting.get("id") for setting in projected]
    if len(ids) != len(set(ids)):
        raise ProjectionError("backend setting ids are not unique")
    source_integrity = "sha256:" + hashlib.sha256(source_raw).hexdigest()
    metadata = {
        "banner": BANNER,
        "catalog_version": canonical["catalog_version"],
        "owner": OWNER,
        "read_only": True,
        "source": SOURCE_RELATIVE,
        "source_integrity": source_integrity,
    }
    projection_integrity = structured_digest(
        {"generated": metadata, "settings": projected}
    )
    record = {
        "_generated": {**metadata, "projection_integrity": projection_integrity},
        "settings": projected,
    }
    if not SHA256.fullmatch(projection_integrity):
        raise ProjectionError("projection integrity digest is malformed")
    return json.dumps(record, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def write_output(contents: str) -> None:
    with open(OUTPUT, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(contents)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="regenerate the projection")
    mode.add_argument("--check", action="store_true", help="fail when output is stale")
    arguments = parser.parse_args()
    try:
        source_raw = SOURCE.read_bytes()
        expected = build(source_raw)
        if arguments.check:
            if not OUTPUT.exists():
                raise ProjectionError(f"{OUTPUT.relative_to(ROOT)} is missing")
            actual = OUTPUT.read_bytes()
            if actual != expected.encode("utf-8"):
                raise ProjectionError("generated output is stale")
            settings = json.loads(expected)["settings"]
            print(f"backend registry projection: PASS ({len(settings)} settings)")
            return 0
        write_output(expected)
        settings = json.loads(expected)["settings"]
        print(f"backend registry projection: WROTE ({len(settings)} settings)")
        return 0
    except ProjectionError as error:
        diagnostic = " ".join(str(error).split())[:MAX_DIAGNOSTIC_LENGTH]
        print(f"backend registry projection: FAIL: {diagnostic}", file=sys.stderr)
        return 1
    except OSError as error:
        print(
            f"backend registry projection: FAIL: cannot read {SOURCE_RELATIVE}: {error}",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
