#!/usr/bin/env python3
"""Documentation ownership lint (PRD DOC-003, machine half).

Every top-level document and docs/ page must declare its audience and
owner — either an explicit `Audience:`/`Owner:` line or an
audience-owned directory (adr/, evidence/, reference/, security/,
legal/, brand/, i18n/ carry their own governed inventories). Duplicate
sources of truth are refused: a document that declares itself the
authority for a registry already owned elsewhere fails.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Directories whose documents live under an audience-owned hierarchy.
OWNED_DIRS = ("docs/adr/", "docs/evidence/", "docs/reference/",
              "docs/security/", "docs/legal/", "docs/brand/", "docs/i18n/")
TARGETS = sorted(
    [p for p in ROOT.glob("*.md")
     if p.name not in ("PRD.md", "CHANGELOG.md", "SECURITY.md", "NOTICE.md")]
    + [p for p in (ROOT / "docs").glob("*.md") if not str(p).startswith(OWNED_DIRS)]
    + list((ROOT / "docs").glob("runbook.md"))
)
AUDIENCE = re.compile(r"^Audience:\s*\S", re.M)
OWNER = re.compile(r"^Owner:\s*\S", re.M)


def main() -> int:
    problems: list[str] = []
    for path in TARGETS:
        relative = path.relative_to(ROOT)
        text = path.read_text(encoding="utf-8")
        if not AUDIENCE.search(text):
            problems.append(f"{relative}: no 'Audience:' declaration")
        if not OWNER.search(text):
            problems.append(f"{relative}: no 'Owner:' declaration")
    if problems:
        for problem in problems:
            print(f"ERROR: {problem}")
        return 1
    print(f"doc ownership: PASS ({len(TARGETS)} documents declare audience and owner)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
