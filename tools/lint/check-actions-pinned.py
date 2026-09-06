#!/usr/bin/env python3
"""GitHub Actions immutability lint (PRD SEC-ASSURE-004).

Every `uses:` reference in the workflows must name a full 40-character
commit SHA — mutable tags (`@v4`, `@stable`) mean a compromised or
retagged upstream action silently changes what release jobs run. The lint
also refuses short SHAs (still ambiguous) and local paths are left alone
(they are reviewed code, not remote trust).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.yml"))
USES = re.compile(r"^\s*(?:-\s+)?uses:\s*(\S+)\s*$")
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")


def main() -> int:
    problems: list[str] = []
    for workflow in WORKFLOWS:
        for number, line in enumerate(
                workflow.read_text(encoding="utf-8").splitlines(), 1):
            match = USES.match(line)
            if not match:
                continue
            reference = match.group(1)
            if "./" in reference:
                continue  # local composite action: reviewed code
            action, _, version = reference.partition("@")
            if not version:
                problems.append(f"{workflow.name}:{number}: {action} pinned to nothing (branch default)")
            elif not FULL_SHA.fullmatch(version):
                problems.append(
                    f"{workflow.name}:{number}: {reference} is not a full commit SHA "
                    "(mutable ref — retagging upstream changes the release job)")
    if problems:
        for problem in problems:
            print(f"ERROR: {problem}")
        return 1
    print("actions pinned: PASS (every remote `uses` is a full commit SHA)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
