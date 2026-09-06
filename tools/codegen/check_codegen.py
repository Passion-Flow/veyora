#!/usr/bin/env python3
"""Enforce the generated-artifact manifest (PRD REPO-006/007/008).

Reads ``tools/codegen/manifest.json`` and, for every tracked generated
artifact:

- verifies the generator, every canonical input, and every tracked output
  still exist with the recorded SHA-256 digest;
- runs the artifact's deterministic ``check`` command and requires success.

The backend Rust projection is formatted by rustfmt after generation, so its
check regenerates into a temporary file under ``.build``, formats it with the
pinned rustfmt edition, and compares bytes with the tracked output. Missing
generators, missing outputs, stale digests, or a failing check command fail
with a nonzero exit (REPO-008).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = Path(__file__).resolve().parent / "manifest.json"
RUSTFMT_EDITION = "2024"
CHECK_MODES = {"generator-check", "rustfmt-pipeline-check"}
REQUIRED_ARTIFACT_FIELDS = {
    "description",
    "owner",
    "consumers",
    "generator",
    "generator_sha256",
    "inputs",
    "outputs",
    "tracked",
    "determinism",
    "regenerate_command",
    "check_mode",
    "check_command",
}
HEXDIGEST = re.compile(r"^[0-9a-f]{64}$")


def fail(message: str) -> None:
    print(f"codegen manifest: FAIL: {message}", file=sys.stderr)


def file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_binding(relative: str, expected: str, kind: str, errors: list[str]) -> None:
    path = ROOT / relative
    if not path.is_file():
        errors.append(f"{kind} is missing: {relative}")
        return
    if not isinstance(expected, str) or not HEXDIGEST.fullmatch(expected):
        errors.append(f"{kind} digest is malformed: {relative}")
        return
    actual = file_digest(path)
    if actual != expected:
        errors.append(f"{kind} digest drift: {relative}")


def run_check_command(artifact_id: str, command: list[str], errors: list[str]) -> None:
    if not isinstance(command, list) or not all(isinstance(item, str) for item in command):
        errors.append(f"{artifact_id} check_command must be a string array")
        return
    completed = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        timeout=120,
    )
    if completed.returncode != 0:
        output = (completed.stderr.strip() or completed.stdout.strip()).splitlines()
        detail = output[-1] if output else "check command failed without diagnostics"
        errors.append(f"{artifact_id} check failed: {detail}")


def rustfmt_pipeline_check(artifact_id: str, command: list[str], errors: list[str]) -> None:
    """Regenerate into .build, format with rustfmt, compare with the output."""
    if not isinstance(command, list) or "--write" not in command or "--output" not in command:
        errors.append(f"{artifact_id} rustfmt pipeline command is malformed")
        return
    rustfmt = shutil.which("rustfmt")
    if rustfmt is None:
        errors.append("rustfmt is required for the rustfmt pipeline check")
        return
    scratch_dir = ROOT / ".build" / "codegen"
    scratch_dir.mkdir(parents=True, exist_ok=True)
    output_index = command.index("--output") + 1
    if output_index >= len(command):
        errors.append(f"{artifact_id} rustfmt pipeline command lacks an output path")
        return
    tracked_output = command[output_index]
    temporary = scratch_dir / "pipeline-output.rs"
    command = list(command)
    command[output_index] = temporary.relative_to(ROOT).as_posix()
    command[command.index("--write")] = "--write"
    completed = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        timeout=120,
    )
    if completed.returncode != 0:
        errors.append(f"{artifact_id} regeneration failed: {completed.stderr.strip()}")
        return
    formatted = subprocess.run(
        [rustfmt, f"--edition={RUSTFMT_EDITION}", str(temporary)],
        capture_output=True,
        check=False,
        text=True,
    )
    if formatted.returncode != 0:
        errors.append(f"{artifact_id} rustfmt failed: {formatted.stderr.strip()}")
        return
    expected = (ROOT / tracked_output).read_bytes()
    if temporary.read_bytes() != expected:
        errors.append(f"{artifact_id} tracked output is stale")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--refresh-digests",
        action="store_true",
        help="rewrite manifest digests from the current tree after regeneration",
    )
    arguments = parser.parse_args()

    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot read the manifest: {error}")
        return 1
    if manifest.get("schema_version") != 1:
        fail("manifest schema_version must be 1")
        return 1

    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        fail("manifest must contain artifacts")
        return 1

    if arguments.refresh_digests:
        for artifact in artifacts:
            artifact["generator_sha256"] = file_digest(ROOT / artifact["generator"])
            artifact["inputs"] = {
                relative: file_digest(ROOT / relative) for relative in artifact["inputs"]
            }
            artifact["outputs"] = {
                relative: file_digest(ROOT / relative) for relative in artifact["outputs"]
            }
        with open(MANIFEST_PATH, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        print(f"codegen manifest: REFRESHED ({len(artifacts)} artifacts)")
        return 0

    errors: list[str] = []
    seen_ids: set[str] = set()
    for artifact in artifacts:
        artifact_id = artifact.get("artifact_id")
        if not isinstance(artifact_id, str) or not artifact_id or artifact_id in seen_ids:
            fail(f"artifact id is invalid or duplicated: {artifact_id!r}")
            return 1
        seen_ids.add(artifact_id)
        missing = REQUIRED_ARTIFACT_FIELDS.difference(artifact)
        if missing:
            errors.append(f"{artifact_id} is missing fields: {', '.join(sorted(missing))}")
            continue
        verify_binding(artifact["generator"], artifact["generator_sha256"], "generator", errors)
        for relative, digest in artifact["inputs"].items():
            verify_binding(relative, digest, "input", errors)
        for relative, digest in artifact["outputs"].items():
            verify_binding(relative, digest, "output", errors)
        if artifact["tracked"] is not True:
            errors.append(f"{artifact_id} must record tracked outputs")
        check_mode = artifact["check_mode"]
        if check_mode not in CHECK_MODES:
            errors.append(f"{artifact_id} has an unknown check_mode")
        elif check_mode == "generator-check":
            run_check_command(artifact_id, artifact["check_command"], errors)
        else:
            rustfmt_pipeline_check(artifact_id, artifact["check_command"], errors)

    if errors:
        for error in errors:
            fail(error)
        return 1
    print(f"codegen manifest: PASS ({len(artifacts)} artifacts)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
