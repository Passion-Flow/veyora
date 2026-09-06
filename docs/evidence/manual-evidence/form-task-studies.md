# Item-form task studies

Records for the form comprehension and completion studies behind ITEM-002
through ITEM-005. A form-task study observes participants (at least three who
have never used Veyora) completing the described task without assistance;
record participant count, task success, time, and every hesitation or
misunderstanding.

## ITEM-002 — Progressive-disclosure form study

<!-- evidence-record
requirement_ids: ITEM-002
title: Login-form comprehension and completion study (initial fields vs More fields)
status: Pending
method:
environment:
operator:
date:
artifacts:
notes:
-->

Observe first-time users creating a Login with only the initially visible
fields (Name, Username, Password, Website), then adding a TOTP seed and
notes through the `More fields` disclosure. Verify the initial four-field
form is understood without training and that advanced fields are discoverable
without being intrusive.

## ITEM-003 — Name guidance study

<!-- evidence-record
requirement_ids: ITEM-003
title: Name-field guidance and example review
status: Pending
method:
environment:
operator:
date:
artifacts:
notes:
-->

Check that the `GitHub - Work` example and the recognition hint lead users
to names they can later find, and that users do not confuse the item name
with the username.

## ITEM-004 — Password field actions, keyboard and screen reader

<!-- evidence-record
requirement_ids: ITEM-004
title: Generate/Show-Hide/Copy actions keyboard and screen-reader verification
status: Pending
method:
environment:
operator:
date:
artifacts:
notes:
-->

Verify the named Generate, Show/Hide, and Copy actions adjacent to password
fields are reachable and operable by keyboard alone and announce their names
and states (including Show/Hide as a pressed toggle) under at least one
screen reader.

## ITEM-005 — TOTP input study

<!-- evidence-record
requirement_ids: ITEM-005
title: TOTP URI/Base32 entry comprehension and rejection study
status: Pending
method:
environment:
operator:
date:
artifacts:
notes:
-->

Have users paste a valid `otpauth://` URI and a raw Base32 secret with
stray whitespace, then a malformed value. Verify the source hint is
understood, normalization preserves working codes, and the rejection path
explains the problem without discarding the form.
