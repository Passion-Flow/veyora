# Onboarding platform evidence and reviews

Records for the platform-specific onboarding evidence behind UX-ONB-002,
UX-ONB-005, UX-ONB-006, and UX-ONB-010.

## UX-ONB-002 — Desktop-native Welcome routing evidence

<!-- evidence-record
requirement_ids: UX-ONB-002
title: Desktop (Tauri) Welcome routes verification for the four first-run actions
status: Pending
method:
environment:
operator:
date:
artifacts:
notes:
-->

On a native desktop build, verify the first screen offers and routes all
four actions — Create a new vault, Open an existing vault, Import from
another password manager, and Advanced: connect to a self-hosted server —
before any password is requested, matching the web/shared-UI behavior.

## UX-ONB-005 — Paste, autofill, and platform input matrix

<!-- evidence-record
requirement_ids: UX-ONB-005
title: Master-password paste/autofill/Unicode/length platform matrix
status: Pending
method:
environment:
operator:
date:
artifacts:
notes:
-->

On each supported platform/browser (including the Tauri WebView), verify the
Master Password field accepts paste, password-manager autofill where the
platform supports it, embedded spaces, non-ASCII input, and 64+ character
values, and that the Show/Hide control is keyboard operable. Record the
platform matrix and any platform-specific limitation.

## UX-ONB-006 — Threat-model approval of the local blocklist screen

<!-- evidence-record
requirement_ids: UX-ONB-006
title: Security approval of the local common-password screening threat model
status: Pending
method:
environment:
operator:
date:
artifacts:
notes:
-->

The security owner reviews `apps/web/src/data/blocklist.js` against the PRD
requirement: the screen runs locally, sends nothing, leaks no hash of the
password, cannot be used as an oracle, and the 15-character composition-free
floor matches the documented NIST-informed rationale. Approval must be
recorded by a named human approver; automated review is not sufficient.

## UX-ONB-010 — First-success telemetry privacy review

<!-- evidence-record
requirement_ids: UX-ONB-010
title: Privacy review and test-event inspection of first-success telemetry
status: Pending
method:
environment:
operator:
date:
artifacts:
notes:
-->

Inspect the events actually written by an opted-in test build across a full
session (create, save, search, copy/reveal, lock) and confirm they contain
only event names and timestamps — no vault content, field values, search
terms, or identifiers — and that the disabled default writes nothing. Record
the reviewer and the inspected localStorage payload.
