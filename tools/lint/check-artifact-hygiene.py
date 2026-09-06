#!/usr/bin/env python3
"""Evidence-artifact hygiene lint (PRD QA-010, repository half).

Every machine-generated evidence artifact under `release/evidence/` must:

- carry a `collected_at` (or equivalent) ISO-8601 UTC timestamp;
- identify the product version it measured (`product_version`, or a
  commit it pins via `prepared_at_commit`/`host` context);
- never contain secret material: master-password-looking literals, kit
  strings, bearer tokens, or private keys are refused outright;
- declare expiry: perf/reference artifacts older than the retention
  window (default 180 days) are flagged stale so they are re-collected
  rather than silently cited.

The acceptance half of QA-010 (runner identity, architecture, and seed on
CI-produced artifacts) is enforced where those artifacts are produced; this
lint guarantees the repository-cited ones are hygienic and labeled.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "release" / "evidence"
RETENTION_DAYS = 180

# Secret classes that must never appear in an evidence artifact. Kits are
# the 71-char recovery form; tokens are bearer material; passwords are the
# literal literals used in live ceremonies.
SECRET_PATTERNS = [
    (re.compile(r"[a-z2-7]{5}(-[a-z2-7]{5}){11}"), "recovery-kit-shaped string"),
    (re.compile(r"(?i)bearer\s+[a-z0-9._-]{16,}"), "bearer token"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "private key"),
    (re.compile(r"(?i)master[- ]?password['\"]?\s*[:=]\s*['\"][^'\"]{4,}"), "literal master password"),
    (re.compile(r"(?i)e2e-comprehensive-pw|fault-suite-master-password"), "test-suite credential literal"),
]
STAMP_KEYS = ("collected_at", "prepared_at", "generated_at")
VERSION_KEYS = ("product_version", "prepared_at_commit")


def main() -> int:
    problems: list[str] = []
    artifacts = [path for path in EVIDENCE.rglob("*") if path.suffix in (".json", ".md")]
    if not artifacts:
        problems.append("no evidence artifacts found under release/evidence/")
    for path in artifacts:
        relative = path.relative_to(ROOT)
        text = path.read_text(encoding="utf-8", errors="replace")
        for pattern, what in SECRET_PATTERNS:
            if pattern.search(text):
                problems.append(f"{relative}: contains {what}")
        if path.suffix != ".json":
            continue
        try:
            data = json.loads(text)
        except json.JSONDecodeError as error:
            problems.append(f"{relative}: invalid JSON ({error})")
            continue
        flat = json.dumps(data)
        if not any(key in data for key in STAMP_KEYS):
            problems.append(f"{relative}: no collection timestamp key {STAMP_KEYS}")
        if not any(key in data for key in VERSION_KEYS):
            problems.append(f"{relative}: no product-version/commit identity key {VERSION_KEYS}")
        stamp = next((data[key] for key in STAMP_KEYS if key in data), None)
        if stamp:
            try:
                when = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
                age = (datetime.now(timezone.utc) - when).days
                if age > RETENTION_DAYS:
                    problems.append(
                        f"{relative}: artifact is {age} days old (retention {RETENTION_DAYS}) — re-collect")
                if when.tzinfo is None:
                    problems.append(f"{relative}: timestamp lacks timezone (must be UTC)")
            except ValueError:
                problems.append(f"{relative}: timestamp is not ISO-8601: {stamp!r}")
        del flat
    if problems:
        for problem in problems:
            print(f"ERROR: {problem}")
        return 1
    print(f"artifact hygiene: PASS ({len(artifacts)} artifact(s) stamped, versioned, secret-free, within retention)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
