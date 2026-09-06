#!/usr/bin/env python3
"""Ledger / PRD / CHANGELOG consistency validator.

Guards the three progress records against silent drift (the goal's own
completion standard is expressed in these files):

- every ledger sequence 1-11 has a PRD status-table row, and the status
  marker in PRD.md equals the ledger status exactly;
- no sequence marked Complete carries any remaining_scope item — a
  Complete claim with open scope is a contradiction and fails;
- every non-Complete sequence carries at least one remaining_scope item
  that states what is missing (empty remaining_scope would read as done);
- every evidence path in the ledger exists in the working tree;
- `updated_at` is a valid UTC ISO-8601 timestamp;
- CHANGELOG contains an Unreleased section (progress must be visible
  somewhere before a release consolidates it).
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LEDGER = ROOT / "release" / "prd-progress.json"
PRD = ROOT / "PRD.md"
CHANGELOG = ROOT / "CHANGELOG.md"

STATUS_ICONS = {"Complete": "✅", "Partial": "🟡", "Not started": "⬜", "Blocked": "🚧"}


def main() -> int:
    problems: list[str] = []
    ledger = json.loads(LEDGER.read_text(encoding="utf-8"))
    sequences = {entry["sequence"]: entry for entry in ledger["backlog"]}

    prd_text = PRD.read_text(encoding="utf-8")
    rows = {}
    for match in re.finditer(r"^\|\s*(\d+)\s*\|\s*([🟡✅⬜🚧])\s*`([^`]+)`\s*\|", prd_text, re.M):
        rows[int(match.group(1))] = match.group(3)

    for number in range(1, 12):
        entry = sequences.get(number)
        if entry is None:
            problems.append(f"ledger is missing sequence {number}")
            continue
        status = entry["status"]
        if status not in STATUS_ICONS:
            problems.append(f"sequence {number}: unknown status {status!r}")
        if number not in rows:
            problems.append(f"PRD.md status table has no row for sequence {number}")
        elif rows[number] != status:
            problems.append(
                f"sequence {number}: PRD.md says {rows[number]!r} but ledger says {status!r}")
        remaining = entry.get("remaining_scope") or []
        if status == "Complete" and remaining:
            problems.append(
                f"sequence {number}: marked Complete with remaining_scope: "
                + "; ".join(item[:80] for item in remaining))
        if status != "Complete" and not remaining:
            problems.append(
                f"sequence {number}: status {status} but remaining_scope is empty — "
                "state what is missing")
        for path in entry.get("evidence", []):
            if not (ROOT / path).exists():
                problems.append(f"sequence {number}: evidence path missing: {path}")

    stamp = ledger.get("updated_at", "")
    try:
        when = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        if when.tzinfo is None or when.tzinfo.utcoffset(when) != timezone.utc.utcoffset(when):
            problems.append("updated_at is not UTC")
    except ValueError:
        problems.append(f"updated_at is not ISO-8601: {stamp!r}")

    if "## [Unreleased]" not in CHANGELOG.read_text(encoding="utf-8"):
        problems.append("CHANGELOG.md has no Unreleased section for current progress")

    if problems:
        for problem in problems:
            print(f"ERROR: {problem}")
        return 1
    print("progress consistency: PASS (ledger/PRD/CHANGELOG agree; evidence paths exist)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
