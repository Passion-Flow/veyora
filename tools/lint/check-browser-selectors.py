#!/usr/bin/env python3
"""Browser business-flow selector lint (PRD QA-013).

Locale-independence rule: a locator that *drives* a business flow (clicks,
fills, waits-for-visibility used as a gate) must address the DOM by id,
attribute, or CSS — never by user-facing copy, which changes with the
locale. Text matching is legitimate in exactly two places:

- **flow inputs**: `hasText` filters that identify *test-created data*
  (names the test itself typed, e.g. `E2E ...` strings or dynamic stamps);
- **copy validation**: assertions whose purpose is verifying rendered
  English copy (`assert.match(... /.../)`, `textContent()` + match) —
  those belong in the default-locale suite and are inventoried, not
  failed.

Everything else — `getByText`, `:has-text()`, `hasText` with fixed UI copy
driving a click/wait — is a violation: the flow breaks the moment a
non-English locale renders.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SUITES = sorted((ROOT / "tests" / "e2e" / "web").glob("*.mjs"))

# Locators that address by structure (allowed everywhere).
STRUCTURAL = re.compile(r"locator\(\s*['\"][#.\[]")
# Copy-driven locators (getByText / :has-text) — allowed only in asserts.
TEXT_LOCATOR = re.compile(r"getByText\(|:has-text\(")
# hasText filters: allowed when the value is test-created data...
VARIABLE_HAS_TEXT = re.compile(r"hasText[:=]\s*[`'\"]?\s*(\w+|\$\{)")
# ...specifically markers the tests themselves generate.
TEST_DATA_MARKERS = ("E2E", "e2e", "stamp", "entryName", "Name", "kit",
                     "name", "tagged", "alpha", "beta", "row", "toast",
                     "pending", "text", "path")
# Assertion contexts (copy validation): assert.match / textContent reads.
ASSERT_CONTEXT = re.compile(r"assert\.(match|equal|ok|deepEqual)|textContent|innerText|inputValue")


def classify_line(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if TEXT_LOCATOR.search(stripped):
        if ASSERT_CONTEXT.search(stripped):
            return ("copy", stripped)
        return ("violation", stripped)
    match = re.search(r"hasText[:=]\s*[`'\"]([^\$`'\"]+)[`'\"]", stripped)
    if match:
        literal = match.group(1)
        is_test_data = any(marker in literal for marker in TEST_DATA_MARKERS) \
            or literal.startswith(("E2E", "e2e"))
        if is_test_data:
            return ("flow-data", stripped)
        if ASSERT_CONTEXT.search(stripped):
            return ("copy", stripped)
        # A fixed-UI-copy hasText that gates or drives a flow.
        return ("violation", stripped)
    return None


def main() -> int:
    violations: list[str] = []
    copy_checks = 0
    flow_data = 0
    for suite in SUITES:
        relative = suite.relative_to(ROOT)
        for number, line in enumerate(suite.read_text(encoding="utf-8").splitlines(), 1):
            verdict = classify_line(line)
            if verdict is None:
                continue
            kind, text = verdict
            if kind == "violation":
                violations.append(f"{relative}:{number}: {text.strip()[:100]}")
            elif kind == "copy":
                copy_checks += 1
            else:
                flow_data += 1
    if violations:
        print(f"ERROR: {len(violations)} locale-coupled business-flow selector(s):")
        for violation in violations:
            print(f"  {violation}")
        print("Fix: address the element by id/attribute/data-* and move copy checks "
              "into assert.match (copy-validation) form.")
        return 1
    print(f"browser selectors: PASS ({flow_data} test-data hasText filters, "
          f"{copy_checks} copy-validation assertions; 0 locale-coupled flow selectors)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
