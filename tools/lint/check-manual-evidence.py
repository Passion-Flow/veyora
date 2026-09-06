#!/usr/bin/env python3
"""Validate the manual-evidence record templates and filled records.

The templates under docs/evidence/manual-evidence/ are the capture surface
for PRD requirements whose completion signals require human evidence. This
checker enforces structure and honesty invariants; it cannot and must not
decide whether a human actually performed the recorded activity.

Rules enforced:

- every expected requirement ID (the pending manual scope below) is covered
  by exactly one record, and no record covers an unknown ID;
- a record's status is one of Pending, In progress, Pass, Fail;
- Pending records leave method/environment/operator/date/artifacts empty;
- non-pending records fill method, environment, operator, and an ISO date,
  and list at least one artifact path that exists in the repository
  (Pass/Fail also require notes, Fail requires a follow-up statement).
"""

from __future__ import annotations

import re
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE_DIR = ROOT / "docs" / "evidence" / "manual-evidence"

# The pending manual scope of sequence 7 (see release/prd-progress.json).
EXPECTED_REQUIREMENT_IDS = {
    "ACC-001",
    "ACC-004",
    "ACC-012",
    "ACC-013",
    "E2E-010",
    "UX-ONB-001",
    "UX-ONB-004",
    "UX-ONB-002",
    "UX-ONB-005",
    "UX-ONB-006",
    "UX-ONB-010",
    "EXP-002",
    "EXP-003",
    "HELP-002",
    "ITEM-002",
    "ITEM-003",
    "ITEM-004",
    "ITEM-005",
    "ITEM-006",
    "DIAG-001",
    "DIAG-002",
}

RECORD_FIELDS = (
    "requirement_ids",
    "title",
    "status",
    "method",
    "environment",
    "operator",
    "date",
    "artifacts",
    "notes",
)
COMPLETION_FIELDS = ("method", "environment", "operator", "date", "artifacts")
STATUSES = {"Pending", "In progress", "Pass", "Fail"}
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

RECORD_START = re.compile(r"<!--\s*evidence-record\s*$")
RECORD_END = re.compile(r"^\s*-->\s*$")
FIELD = re.compile(r"^([a-z_]+):\s*(.*)$")


def tracked_files() -> set[str]:
    listing = subprocess.run(
        ["git", "ls-files"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
        timeout=60,
    )
    return set(listing.stdout.splitlines())


def parse_records(errors: list[str]) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    template_files = sorted(EVIDENCE_DIR.glob("*.md"))
    if not template_files:
        errors.append("no template files found under docs/evidence/manual-evidence")
        return records
    for path in template_files:
        lines = path.read_text(encoding="utf-8").splitlines()
        current: dict[str, str] | None = None
        last_field: str | None = None
        for line_number, line in enumerate(lines, start=1):
            location = f"{path.relative_to(ROOT)}:{line_number}"
            if current is None:
                if RECORD_START.search(line):
                    current = {}
                continue
            if RECORD_END.search(line):
                if current is not None:
                    missing = [f for f in RECORD_FIELDS if f not in current]
                    if missing:
                        errors.append(
                            f"{location}: record is missing fields: {', '.join(missing)}"
                        )
                    else:
                        current["_file"] = str(path.relative_to(ROOT))
                        records.append(current)
                current = None
                last_field = None
                continue
            match = FIELD.match(line)
            if match and match.group(1) in RECORD_FIELDS:
                last_field = match.group(1)
                current[last_field] = match.group(2).strip()
            elif last_field and line.startswith(" " * 2):
                current[last_field] += " " + line.strip()
            elif line.strip():
                errors.append(
                    f"{location}: unrecognized line inside evidence record"
                )
        if current is not None:
            errors.append(f"{path.relative_to(ROOT)}: unterminated evidence record")
    return records


def validate_record(
    record: dict[str, str], tracked: set[str], errors: list[str]
) -> None:
    location = record["_file"]
    requirement_ids = [
        item.strip()
        for item in record["requirement_ids"].split(",")
        if item.strip()
    ]
    for requirement_id in requirement_ids:
        if requirement_id not in EXPECTED_REQUIREMENT_IDS:
            errors.append(
                f"{location}: record covers unknown requirement {requirement_id}"
            )
    if not requirement_ids:
        errors.append(f"{location}: record covers no requirement id")

    status = record["status"]
    if status not in STATUSES:
        errors.append(
            f"{location}: status must be one of {sorted(STATUSES)}, got {status!r}"
        )
        return

    if status == "Pending":
        for field in COMPLETION_FIELDS:
            if record[field]:
                errors.append(
                    f"{location}: Pending record must leave {field} empty"
                )
        return

    for field in ("method", "environment", "operator"):
        if not record[field]:
            errors.append(f"{location}: {status} record must fill {field}")
    if not ISO_DATE.match(record["date"]):
        errors.append(
            f"{location}: date must be an ISO YYYY-MM-DD value, got {record['date']!r}"
        )
    else:
        try:
            if date.fromisoformat(record["date"]) > date.today():
                errors.append(f"{location}: date is in the future")
        except ValueError:
            errors.append(f"{location}: date is not a real calendar date")

    artifacts = [
        item.strip() for item in record["artifacts"].split(",") if item.strip()
    ]
    if not artifacts:
        errors.append(f"{location}: {status} record must list at least one artifact")
    for artifact in artifacts:
        if artifact.startswith(("http://", "https://")):
            if not artifact.startswith("https://"):
                errors.append(
                    f"{location}: external artifact must use https ({artifact})"
                )
            continue
        if Path(artifact).is_absolute() or ".." in Path(artifact).parts:
            errors.append(
                f"{location}: artifact path must be repository-relative ({artifact})"
            )
            continue
        if artifact not in tracked and not (ROOT / artifact).exists():
            errors.append(f"{location}: artifact path does not exist ({artifact})")
    if status in ("Pass", "Fail") and not record["notes"]:
        errors.append(f"{location}: {status} record must fill notes")
    if status == "Fail" and record["notes"] and "follow" not in record["notes"].lower():
        errors.append(
            f"{location}: Fail record notes must state a follow-up"
        )


def main() -> int:
    errors: list[str] = []
    tracked = tracked_files()
    records = parse_records(errors)

    covered: dict[str, str] = {}
    for record in records:
        for requirement_id in record["requirement_ids"].split(","):
            requirement_id = requirement_id.strip()
            if not requirement_id:
                continue
            if requirement_id in covered:
                errors.append(
                    f"{record['_file']}: requirement {requirement_id} is covered "
                    f"twice (also {covered[requirement_id]})"
                )
            covered[requirement_id] = record["_file"]
        validate_record(record, tracked, errors)

    missing = sorted(EXPECTED_REQUIREMENT_IDS - set(covered))
    if missing:
        errors.append(
            "records are missing for requirement ids: " + ", ".join(missing)
        )

    if errors:
        print("manual-evidence check FAILED:")
        for error in errors:
            print(f"  - {error}")
        return 1
    pending = sum(1 for r in records if r["status"] == "Pending")
    filled = len(records) - pending
    print(
        f"manual-evidence check PASS: {len(records)} records "
        f"({pending} pending, {filled} filled)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
