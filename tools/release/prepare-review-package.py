#!/usr/bin/env python3
"""Assemble the independent cryptography review package (sequence 4).

The owner hands this package to the appointed independent reviewer. It
contains exactly what PRD sequence-4 review requires — the ADRs, the
machine contracts, the kernel sources and vectors they bind, and a
SHA-256 manifest — so the reviewer's signed record can name the exact
bytes they reviewed.

The package is NOT review evidence. It only makes the reviewer's scope
reproducible; the review record (docs/evidence/independent-review/)
remains Pending until a qualified human fills it.

Usage:
    python3 tools/release/prepare-review-package.py [--output DIR]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Everything the reviewer must see, in one flat list: (repo path, role).
MATERIALS: list[tuple[str, str]] = [
    ("docs/adr/0004-key-recovery-backup-lifecycle.md", "ADR under review (key/recovery/backup lifecycle)"),
    ("docs/adr/0005-scoped-pairing-session-lifecycle.md", "ADR under review (scoped pairing/session)"),
    ("contracts/vault/generic-record-v1.schema.json", "record contract"),
    ("contracts/vault/encrypted-template-v1.schema.json", "template contract"),
    ("contracts/vault/client-derived-feature-policy-v1.json", "feature policy contract"),
    ("contracts/authorization/service-capabilities-v1.json", "authorization contract"),
    ("packages/security-kernel/crates/kernel-core/src/lib.rs", "kernel core"),
    ("packages/security-kernel/crates/kernel-core/src/recovery.rs", "recovery-kit codec"),
    ("packages/security-kernel/crates/kernel-core/src/limits.rs", "kernel limits"),
    ("packages/security-kernel/crates/kernel-core/src/codec.rs", "canonical codec"),
    ("packages/security-kernel/crates/kernel-wasm/src/lib.rs", "wasm binding surface"),
    ("apps/web/src/core/recovery.js", "client Vault Key wrapping"),
    ("apps/web/src/core/records.js", "client record sync incl. wraps/recovery"),
    ("apps/web/src/core/backup.js", "client encrypted backup format"),
    ("apps/web/src/core/kernel.js", "client kernel adapter"),
    ("tools/lint/check-key-lifecycle.py", "lifecycle contract checker"),
    ("tools/lint/check-pairing-session.py", "pairing contract checker"),
    ("tools/codegen/backend/tests/test_generate_backend_projection.py", "backend projection tests"),
    ("tools/codegen/backend/tests/test_generate_registry_projection.py", "registry projection tests"),
]


def git_commit() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="dist/review-package")
    args = parser.parse_args()
    output = (ROOT / args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)

    manifest = {
        "schema_version": 1,
        "purpose": "independent cryptography review scope (PRD sequence 4)",
        "prepared_at_commit": git_commit(),
        "not_evidence": ("This package defines reviewer scope only. The review record under "
                         "docs/evidence/independent-review/ remains Pending until the appointed "
                         "reviewer signs it; assembling this package is not review."),
        "files": [],
    }
    missing: list[str] = []
    for relative, role in MATERIALS:
        source = ROOT / relative
        if not source.exists():
            missing.append(relative)
            continue
        destination = output / source.name
        # Same-name collisions (e.g. two lib.rs roles) are disambiguated by
        # the crate prefix kept in the flat copy name.
        destination.write_bytes(source.read_bytes())
        manifest["files"].append({
            "path": relative,
            "role": role,
            "sha256": sha256(source),
            "bytes": source.stat().st_size,
        })
    if missing:
        print("ERROR: review materials missing from the tree:", file=sys.stderr)
        for item in missing:
            print(f"  {item}", file=sys.stderr)
        return 1
    (output / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"review package: {len(manifest['files'])} files at {output}")
    print(f"prepared_at_commit: {manifest['prepared_at_commit']}")
    print("hand the directory plus the appointment record to the reviewer;")
    print("their signed record must quote this commit and these hashes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
