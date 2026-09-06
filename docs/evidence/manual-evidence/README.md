# Manual evidence capture kit (sequence 7 and later)

Audience: the humans who produce manual acceptance evidence — UX reviewers,
accessibility evaluators, security/privacy reviewers, and the release owner.

This directory holds structured templates for every PRD requirement whose
completion signal explicitly requires human evidence (screen-reader sessions,
copy reviews, comprehension and task studies, privacy and threat-model
approvals, native-desktop checks). The templates are **not evidence**. A
template only becomes an evidence record when a qualified human performs the
described activity and fills in the record fields.

Rules:

1. One record per pending manual activity, identified by its PRD requirement
   IDs. `tools/lint/check-manual-evidence.py` validates the record structure,
   the covered requirement inventory, and — for filled records — that a date,
   a named human operator, a method, an environment, and existing artifact
   paths are present.
2. `status: Pending` records must leave the completion fields empty. Filling
   them without performing the activity is prohibited; automated tooling,
   AI review, or documentation work is never a substitute for the manual
   activity the PRD names.
3. `status: Pass` requires at least one artifact (a transcript, screenshot,
   recording, signed note, or study sheet) stored in the repository or
   referenced by an absolute external location that the release owner can
   audit. `status: Fail` requires notes describing the observed defect and a
   follow-up.
4. Records are grouped by evidence family:

| File | Family | Requirement IDs |
| --- | --- | --- |
| `accessibility-manual.md` | Manual keyboard, screen-reader, zoom, and native accessibility | ACC-001, ACC-004 (manual portion), ACC-012, ACC-013, E2E-010 (manual portion) |
| `ux-copy-review.md` | Copy reviews and comprehension study | UX-ONB-001 copy review, UX-ONB-004 content review, EXP-002/EXP-003 copy review, HELP-002 content inventory review |
| `form-task-studies.md` | Item-form comprehension and completion studies | ITEM-002, ITEM-003, ITEM-004 (manual portion), ITEM-005 |
| `onboarding-manual.md` | Onboarding platform evidence and reviews | UX-ONB-002 (desktop routing), UX-ONB-005 (autofill/platform), UX-ONB-006 (threat-model approval), UX-ONB-010 (privacy review) |
| `desktop-native.md` | Desktop/native parity evidence | DIAG-001 (desktop), DIAG-002 (desktop), ITEM-006 (desktop/native portion) |

The checker runs as part of `make check` and fails when the inventory drifts
from the pending manual scope recorded in `release/prd-progress.json` — when
new manual requirements open, add records here in the same change.
