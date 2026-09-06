#!/usr/bin/env python3
"""Recovery terminology lint (PRD REC-007).

`Recovery Key` names exactly one mechanism: the 71-character kit that
unwraps the Vault Key. This lint refuses conflations in every user-facing
surface — locale catalogs and the shipped documentation — so no string can
call a 2FA code, a backup password, or an account-recovery flow a
"Recovery Key" (or call the kit a code/password).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Forbidden phrasings in user-facing text: they blur what the Recovery Key
# is. (Case-insensitive; "Recovery Key" itself is the sanctioned term.)
FORBIDDEN = [
    (re.compile(r"recovery\s+code", re.I), "'recovery code' blurs the Recovery Key (it is a 71-character key, not a code)"),
    (re.compile(r"recovery\s+password", re.I), "'recovery password' blurs the Recovery Key"),
    (re.compile(r"backup\s+password", re.I), "'backup password' is not a recovery mechanism; backups open with the master password"),
    (re.compile(r"2fa[^\n]{0,40}recover|recover[^\n]{0,40}2fa", re.I), "2FA and recovery must not share a sentence"),
    (re.compile(r"two[- ]factor[^\n]{0,40}recover|recover[^\n]{0,40}two[- ]factor", re.I), "two-factor and recovery must not share a sentence"),
]

LOCALES = ROOT / "apps" / "web" / "locales"
DOCS = [ROOT / "docs" / "USER-GUIDE.md", ROOT / "README.md"]


def lint_text(source: str, text: str, problems: list[str]) -> None:
    for pattern, why in FORBIDDEN:
        match = pattern.search(text)
        if match:
            excerpt = text[max(0, match.start() - 30):match.end() + 30].replace("\n", " ")
            problems.append(f"{source}: {why} — “…{excerpt}…”")


def main() -> int:
    problems: list[str] = []
    for catalog in sorted(LOCALES.glob("*.json")):
        data = json.loads(catalog.read_text(encoding="utf-8"))
        for key, entry in data.get("messages", {}).items():
            lint_text(f"{catalog.name}:{key}", str(entry.get("text", "")), problems)
    for doc in DOCS:
        if doc.exists():
            lint_text(str(doc.relative_to(ROOT)), doc.read_text(encoding="utf-8"), problems)
    if problems:
        for problem in problems:
            print(f"ERROR: {problem}")
        return 1
    print("recovery terminology: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
