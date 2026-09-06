# Manual accessibility evidence

Records for the human accessibility evidence behind ACC-001, the manual
screen-reader portion of ACC-004 and E2E-010, and ACC-012/ACC-013. The
automated contrast/reflow/target/label/dialog audits live in
`tests/e2e/web/test-browser-accessibility.mjs` and
`tests/e2e/web/test-browser-keyboard.mjs`; these records cover only what
those suites cannot establish.

Record format (parsed by `tools/lint/check-manual-evidence.py`): each
activity has an `evidence-record` HTML-comment block with the fields
`requirement_ids`, `title`, `status` (`Pending` / `In progress` / `Pass` /
`Fail`), `method`, `environment`, `operator`, `date`, `artifacts`
(comma-separated repository-relative paths or https URLs), and `notes`.
Pending records must leave the completion fields empty.

## ACC-001 — WCAG 2.2 AA manual conformance claim

<!-- evidence-record
requirement_ids: ACC-001
title: WCAG 2.2 AA manual conformance review of the web client
status: Pending
method:
environment:
operator:
date:
artifacts:
notes:
-->

Perform a manual WCAG 2.2 AA review of the nine audited core screens beyond
the automated checks: focus order vs visual order, use of color, headings and
landmarks, target-offset, dragging movements, consistent help/navigation,
and error/suggestion quality. Record the level (A/AA), the sampled screens,
and every failure with its success criterion.

## ACC-004 — Screen-reader dialog announcement (manual portion)

<!-- evidence-record
requirement_ids: ACC-004
title: Screen-reader verification of dialog name, role, and focus behavior
status: Pending
method:
environment:
operator:
date:
artifacts:
notes:
-->

With VoiceOver (macOS, Safari and the Tauri WebView) and NVDA (Windows,
Chrome/Edge), open the entry modal, password generator, settings drawer,
Help overlay, and shortcuts dialog. Verify each announces its accessible
name and dialog role, that focus is spoken inside the dialog, that Tab/
Shift+Tab cycling stays within it, and that closing returns focus to the
opener and re-announces it. The layered generator-over-entry-modal case is
mandatory.

## E2E-010 — Manual screen-reader and zoom evidence

<!-- evidence-record
requirement_ids: E2E-010
title: Screen-reader journey and 200%/400% zoom manual pass on core journeys
status: Pending
method:
environment:
operator:
date:
artifacts:
notes:
-->

Complete the core journeys (connect, create vault, add and find a login,
copy/reveal, lock, export ceremony, settings/diagnostics) under at least one
desktop screen reader, and re-check the journeys at 200% and 400% browser
zoom on a 1280 px base viewport. Record per-journey results, the assistive
technology and browser versions, and any workaround the tester needed.

## ACC-012 — Reduced-motion / preference adaptation evidence

<!-- evidence-record
requirement_ids: ACC-012
title: Reduced-motion and display-preference adaptation review
status: Pending
method:
environment:
operator:
date:
artifacts:
notes:
-->

Verify the client respects the operating-system reduced-motion preference
(no essential-information conveyed solely by animation, no parallax or
auto-translating content), and check forced-colors/high-contrast modes for
loss of affordances. Record the platform matrix actually tested.

## ACC-013 — Assistive-technology interoperability beyond the primary pair

<!-- evidence-record
requirement_ids: ACC-013
title: Secondary assistive-technology interoperability spot check
status: Pending
method:
environment:
operator:
date:
artifacts:
notes:
-->

Spot-check the core journeys with at least one additional assistive
technology (for example Narrator on Windows, or VoiceOver on iOS Safari for
the responsive web layout), covering announcement quality of status
messages, toasts with actions, and the undo flow. Record versions and
observed defects.
