#!/usr/bin/env python3
"""Public-surface wording lint (PRD OSS-002).

While the PolyForm Noncommercial license remains, every public surface
must say `source-available` and must not call the project `open source`.
Honest *negations* are required reading — "not licensed under an
OSI-approved open-source license" and the roadmap's promise never to make
the claim — so this lint fails on any `open source` occurrence outside a
reviewed allowlist of sentence contexts, making new claims impossible to
introduce silently.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Public surfaces: repository root documents and the docs tree.
# PRD.md is the internal requirements specification (it defines OSS-001/002
# and quotes the OSD) — not a marketing surface.
SURFACES = sorted(
    [p for p in ROOT.glob("*.md") if p.name != "PRD.md"]
    + list((ROOT / "docs").rglob("*.md"))
)

# Reviewed occurrences: each entry is a distinctive fragment of a sentence
# that legitimately references the term without claiming it. A line
# containing "open source" passes only if it contains one of these.
APPROVED_FRAGMENTS = (
    "not licensed under an",          # README license section negation
    "before an OSI-approved license", # roadmap: never claim prematurely
    "before the project",             # roadmap variant
    "not call the project",           # lint's own documentation
    "must say `source-available`",    # this file's rule text
    "must not call the project",      # this file's rule text
    "OSI-approved",                   # references the license, not a claim
    "Open Source Definition",         # the OSD citation itself
)

PATTERN = re.compile(r"open[ -]source", re.I)


def main() -> int:
    problems: list[str] = []
    for path in SURFACES:
        relative = path.relative_to(ROOT)
        text = path.read_text(encoding="utf-8")
        if "source-available" not in text and "open source" in text.lower():
            problems.append(f"{relative}: mentions 'open source' but never 'source-available'")
        for number, line in enumerate(text.splitlines(), 1):
            if not PATTERN.search(line):
                continue
            if any(fragment in line for fragment in APPROVED_FRAGMENTS):
                continue
            problems.append(
                f"{relative}:{number}: 'open source' outside reviewed negations: "
                f"{line.strip()[:80]!r}")
    if problems:
        for problem in problems:
            print(f"ERROR: {problem}")
        return 1
    print(f"source-available wording: PASS ({len(SURFACES)} public surfaces)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
