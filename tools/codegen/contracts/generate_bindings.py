#!/usr/bin/env python3
"""Generate the Rust contract bindings from the canonical contracts tree.

One generator produces both tracked projections:

- ``packages/contracts-rust/src/lib.rs`` (root workspace consumers)
- ``packages/security-kernel/crates/kernel-core/src/contracts_generated/mod.rs``
  (kernel-internal copy; the kernel keeps an independent workspace, so the
  binding is duplicated verbatim rather than shared as a dependency)

The type shapes live in ``contracts_types_template.rs`` beside this script.
Scalar constants that mirror contract values and the two digest constants are
rendered by this generator:

- ``CONTRACT_SOURCE_DIGEST`` is the SHA-256 of the canonical contracts
  inventory: every tracked-style file under ``contracts/`` (``*.json``,
  ``*.cddl``, ``*.yaml``, ``*.md``), each encoded as the UTF-8 relative path,
  a NUL byte, the raw file bytes, and a NUL byte, in sorted path order.
- ``CONTRACT_PROJECTION_DIGEST`` is the SHA-256 of the rendered output text
  with the projection digest value replaced by 64 zeros, so each projection
  binds its own bytes.

Run with ``--check`` to fail on drift and with ``--write`` to regenerate.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CONTRACTS_DIR = ROOT / "contracts"
TEMPLATE_PATH = Path(__file__).resolve().parent / "contracts_types_template.rs"
ZERO_DIGEST = "0" * 64
MAX_DIAGNOSTIC_LENGTH = 280

OUTPUTS = {
    "packages/contracts-rust/src/lib.rs": None,
    "packages/security-kernel/crates/kernel-core/src/contracts_generated/mod.rs": (
        "// Kernel binding contains data types only and imports no transport/runtime crate."
    ),
}

CONTRACT_SUFFIXES = {".json", ".cddl", ".yaml", ".md"}


class BindingError(ValueError):
    pass


def contract_inventory() -> list[Path]:
    files = sorted(
        path
        for path in CONTRACTS_DIR.rglob("*")
        if path.is_file() and path.suffix in CONTRACT_SUFFIXES
    )
    if not files:
        raise BindingError("no canonical contract inputs were found")
    return files


def source_digest(files: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(ROOT).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def render(output_relative: str, note: str | None, source_hex: str, projection_hex: str) -> str:
    try:
        body = TEMPLATE_PATH.read_text(encoding="utf-8")
    except OSError as error:
        raise BindingError(f"cannot read the type template: {error}") from None
    if not body.endswith("\n"):
        raise BindingError("the type template must end with a newline")
    lines = [
        "// GENERATED: edit contracts/ (or the type template in tools/codegen/contracts/),"
        " then run tools/codegen/contracts/generate_bindings.py --write.",
    ]
    if note is not None:
        lines.append(note)
    lines.extend(
        [
            'pub const CONTRACT_SOURCE_DIGEST: &str =',
            f'    "sha256:{source_hex}";',
            "",
            "",
        ]
    )
    text = "\n".join(lines) + body
    text += (
        "pub const CONTRACT_PROJECTION_DIGEST: &str =\n"
        f'    "sha256:{projection_hex}";\n'
    )
    del output_relative
    return text


def projection_digest(text: str) -> str:
    unbound = re.sub(
        r'pub const CONTRACT_PROJECTION_DIGEST: &str =\n    "sha256:[0-9a-f]{64}";',
        f'pub const CONTRACT_PROJECTION_DIGEST: &str =\n    "sha256:{ZERO_DIGEST}";',
        text,
    )
    return hashlib.sha256(unbound.encode("utf-8")).hexdigest()


def build_all() -> dict[str, str]:
    files = contract_inventory()
    source_hex = source_digest(files)
    rendered: dict[str, str] = {}
    for relative, note in OUTPUTS.items():
        draft = render(relative, note, source_hex, ZERO_DIGEST)
        final = render(relative, note, source_hex, projection_digest(draft))
        rendered[relative] = final
    return rendered


def write_output(path: Path, contents: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(contents)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="regenerate the bindings")
    mode.add_argument("--check", action="store_true", help="fail when output is stale")
    arguments = parser.parse_args()
    try:
        rendered = build_all()
        stale: list[str] = []
        for relative, expected_text in rendered.items():
            path = ROOT / relative
            if not path.exists():
                stale.append(f"{relative}: missing")
                continue
            if path.read_text(encoding="utf-8") != expected_text:
                stale.append(f"{relative}: stale")
        if arguments.check:
            if stale:
                for item in stale:
                    print(f"contract bindings: FAIL: {item}", file=sys.stderr)
                return 1
            print(f"contract bindings: PASS ({len(rendered)} projections)")
            return 0
        for relative, expected_text in rendered.items():
            write_output(ROOT / relative, expected_text)
        print(f"contract bindings: WROTE ({len(rendered)} projections)")
        return 0
    except BindingError as error:
        diagnostic = " ".join(str(error).split())[:MAX_DIAGNOSTIC_LENGTH]
        print(f"contract bindings: FAIL: {diagnostic}", file=sys.stderr)
        return 1
    except Exception:
        print("contract bindings: FAIL: unexpected generator failure", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
