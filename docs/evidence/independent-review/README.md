# Independent cryptography review records (PRD sequence 4)

Audience: the appointed independent reviewer and the release owner.

`tools/release/prepare-review-package.py` assembles the exact bytes under
review (ADRs 0004/0005, machine contracts, kernel sources, lifecycle
checkers, projection tests) with a SHA-256 manifest pinned to a commit.
Assembling the package is **not** review.

## Appointment

The owner appoints a qualified independent cryptography reviewer through
their authenticated channel and records the appointment in
`record.json` (identity, affiliation, independence statement, date, the
package commit and manifest hash). The reviewer must not be an author of
the reviewed code.

## Review record rules

1. The review is of the package bytes only: `record.json` quotes the
   package commit and the manifest SHA-256, and every finding names the
   file and line it concerns.
2. Findings carry severity and disposition (accepted change, rejected
   with rationale, or deferred with a tracked blocker).
3. ADRs move to `Accepted` only after findings are resolved and the
   signed record exists; `tools/lint/check-manual-evidence.py` treats a
   Pending record as incomplete.
4. Nothing in this directory may be produced by automated tooling, AI
   review, or documentation work — only by the named human reviewer.

## Current state

Pending. No reviewer has been appointed; ADR 0004/0005 remain Proposed.
Blocker owner: the repository owner (appointment requires their
authenticated channel). Unlock: appointment recorded + review performed +
findings resolved + signed record.
