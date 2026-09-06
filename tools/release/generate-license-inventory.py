#!/usr/bin/env python3
"""Machine-readable third-party license inventory (PRD OSS-006, SEC-ASSURE-003).

Walks every Cargo.toml and package.json dependency edge in the repository
and emits a JSON inventory of name/version/license/source per dependency.
The inventory is the input the release gate scans for forbidden licenses
and unlicensed dependencies — and the artifact operators audit.

Usage:
    python3 tools/release/generate-license-inventory.py [--output FILE]
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

FORBIDDEN = {
    "GPL-2.0", "GPL-2.0-only", "GPL-2.0-or-later",
    "AGPL-1.0", "AGPL-1.0-only",
    "SSPL-1.0",
    "BUSL-1.1",
    "CC-BY-NC-4.0",
    "PolyForm-Noncommercial-1.0.0",
}


def cargo_inventory() -> list[dict]:
    result = subprocess.run(
        ["cargo", "metadata", "--format-version", "1", "--locked"],
        cwd=ROOT, capture_output=True, text=True, check=True)
    metadata = json.loads(result.stdout)
    workspace = {p["id"] for p in metadata["packages"] if p["manifest_path"].startswith(str(ROOT))}
    entries = []
    for package in metadata["packages"]:
        if package["id"] in workspace:
            continue
        entries.append({
            "ecosystem": "cargo",
            "name": package["name"],
            "version": package["version"],
            "license": package.get("license") or "NOASSERTION",
            "source": package.get("repository") or package.get("manifest_url", "crates.io"),
        })
    return entries


def npm_inventory() -> list[dict]:
    entries: list[dict] = []
    for manifest in ROOT.rglob("package.json"):
        # Skip installed trees; only tracked manifests matter.
        if "node_modules" in manifest.parts:
            continue
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        deps = {}
        for key in ("dependencies", "devDependencies", "optionalDependencies"):
            deps.update(data.get(key) or {})
        # npm locks live at the workspace root; walk up to the nearest one.
        lock = manifest.parent / "package-lock.json"
        walker = manifest.parent
        while not lock.exists() and walker != walker.parent:
            walker = walker.parent
            lock = walker / "package-lock.json"
        licenses: dict[str, str] = {}
        if lock.exists():
            try:
                lock_data = json.loads(lock.read_text(encoding="utf-8"))
                for name, info in (lock_data.get("packages") or {}).items():
                    if not name:
                        continue
                    short = name.removeprefix("node_modules/")
                    field = info.get("license")
                    if isinstance(field, str):
                        licenses[short] = field
            except json.JSONDecodeError:
                pass
        for name, version in sorted(deps.items()):
            version_spec = re.sub(r"[\^~>=< *|]", "", version) or version
            entries.append({
                "ecosystem": "npm",
                "name": name,
                "version": version_spec,
                "license": licenses.get(name, "NOASSERTION"),
                "source": str(manifest.relative_to(ROOT)),
            })
    return entries


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="-")
    args = parser.parse_args()

    try:
        entries = cargo_inventory() + npm_inventory()
    except (subprocess.CalledProcessError, FileNotFoundError) as error:
        print(f"ERROR: inventory collection failed: {error}", file=sys.stderr)
        return 1

    violations = [
        entry for entry in entries
        if any(
            forbidden.lower() in (entry["license"] or "").lower()
            for forbidden in FORBIDDEN
        )
    ]
    unlicensed = [entry for entry in entries if entry["license"] == "NOASSERTION"]

    inventory = {
        "schema_version": 1,
        "generated_from": "cargo metadata --locked + tracked package.json/package-lock.json",
        "dependency_count": len(entries),
        "forbidden_license_policy": sorted(FORBIDDEN),
        "violations": violations,
        "unlicensed_count": len(unlicensed),
        "dependencies": sorted(
            entries, key=lambda entry: (entry["ecosystem"], entry["name"])),
    }
    rendered = json.dumps(inventory, indent=2) + "\n"
    if args.output == "-":
        sys.stdout.write(rendered)
    else:
        (ROOT / args.output).write_text(rendered, encoding="utf-8")
        print(f"license inventory: {len(entries)} dependencies -> {args.output}")
    if violations:
        print("ERROR: forbidden licenses present:", file=sys.stderr)
        for violation in violations:
            print(f"  {violation['name']} {violation['version']}: {violation['license']}", file=sys.stderr)
        return 1
    print(f"license scan: PASS (0 forbidden; {len(unlicensed)} NOASSERTION to review)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
