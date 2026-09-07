#!/usr/bin/env python3
"""Fixture policy lint (PRD QA-008).

Test data must be reproducible and must never use real credentials or
user Vaults:

- unseeded randomness in test sources is forbidden (`Math.random` in
  JavaScript, `thread_rng`/`rngs::ThreadRng` in Rust). Uniqueness that
  only needs to differ within one run (a cache-busting counter, a
  timestamp in a generated name) stays allowed — the requirement is
  that a failing run's random *data* can be reproduced, which seeded
  generators and deterministic inputs satisfy;
- every email-looking literal in test sources must use a reserved
  documentation domain (RFC 2606 `example.*`) or the project's fixture
  domain `veyora.dev`, so no real address can slip into fixtures;
- the kernel fuzz suite must keep its recorded default seed (the
  `VEYORA_FUZZ_SEED` override stays), because its reproducibility is
  the load-bearing instance of this policy.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
JS_TEST_ROOTS = [ROOT / "tests", ROOT / "apps" / "web" / "test"]
RUST_TEST_FILES = [
    ROOT / "packages" / "security-kernel" / "crates" / "kernel-core"
    / "tests" / "fuzz_boundaries.rs",
]
FUZZ_TEST = RUST_TEST_FILES[0]

MATH_RANDOM = re.compile(r"Math\.random\s*\(")
THREAD_RNG = re.compile(r"\bthread_rng\b|ThreadRng")
EMAIL = re.compile(r"\b[a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b")
ALLOWED_EMAIL_HOSTS = {
    "example.com", "example.org", "example.net",
    "veyora.dev", "e2e.veyora.dev",
}


def js_sources() -> list[Path]:
    found: list[Path] = []
    for root in JS_TEST_ROOTS:
        found.extend(sorted(root.rglob("*.mjs")))
        found.extend(sorted(root.rglob("*.js")))
    return [p for p in found if "node_modules" not in p.parts]


def main() -> int:
    problems: list[str] = []
    for path in js_sources():
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(ROOT)
        for number, line in enumerate(text.splitlines(), 1):
            if MATH_RANDOM.search(line):
                problems.append(
                    f"{rel}:{number}: Math.random in a test source — use a "
                    "seeded generator or a deterministic counter (QA-008)")
        for match in EMAIL.finditer(text):
            host = match.group(1).lower()
            if host not in ALLOWED_EMAIL_HOSTS:
                number = text[: match.start()].count("\n") + 1
                problems.append(
                    f"{rel}:{number}: non-fixture email host '{host}' — test "
                    "addresses must use example.* or veyora.dev (QA-008)")
    for path in RUST_TEST_FILES:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(ROOT)
        for number, line in enumerate(text.splitlines(), 1):
            if THREAD_RNG.search(line):
                problems.append(
                    f"{rel}:{number}: thread-local RNG in a test source — "
                    "use an explicitly seeded generator (QA-008)")
        for match in EMAIL.finditer(text):
            host = match.group(1).lower()
            if host not in ALLOWED_EMAIL_HOSTS:
                number = text[: match.start()].count("\n") + 1
                problems.append(
                    f"{rel}:{number}: non-fixture email host '{host}' (QA-008)")
    if FUZZ_TEST.exists():
        fuzz = FUZZ_TEST.read_text(encoding="utf-8")
        if "VEYORA_FUZZ_SEED" not in fuzz:
            problems.append(
                "kernel fuzz suite lost its recorded seed override hook "
                "(VEYORA_FUZZ_SEED) — random inputs must be reproducible")
    else:
        problems.append(
            "kernel fuzz suite is missing; its seeded inputs are the "
            "load-bearing QA-008 instance")
    if problems:
        for problem in problems:
            print(f"ERROR: {problem}")
        return 1
    print(f"fixture policy: PASS ({len(js_sources())} JS test sources, "
          f"{len(RUST_TEST_FILES)} Rust test files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
