# Desktop/native parity evidence

Records for the desktop (Tauri) and native-platform evidence behind DIAG-001,
DIAG-002, and the desktop portion of ITEM-006.

## DIAG-001 — Desktop Diagnostics panel evidence

<!-- evidence-record
requirement_ids: DIAG-001
title: Desktop Diagnostics panel parity and redaction verification
status: Pending
method:
environment:
operator:
date:
artifacts:
notes:
-->

On a native desktop build, verify the Diagnostics surface reports product
version, build commit, mode, a safe storage summary (local vault path
summary without full sensitive paths), service health when connected, last
sync, and last verified backup status — with no secret material visible
anywhere in the panel.

## DIAG-002 — Desktop support bundle evidence

<!-- evidence-record
requirement_ids: DIAG-002
title: Desktop support bundle opt-in/preview/redaction verification
status: Pending
method:
environment:
operator:
date:
artifacts:
notes:
-->

On a native desktop build, verify the support bundle is built only on
explicit request, previewed in full before any copy/save, redacted (seed the
vault and connection state with canary values and confirm none reach the
bundle), and never uploaded automatically.

## ITEM-006 — Desktop/native save status evidence

<!-- evidence-record
requirement_ids: ITEM-006
title: Desktop save idempotency, status reporting, and conflict evidence
status: Pending
method:
environment:
operator:
date:
artifacts:
notes:
-->

On a native desktop build in connected mode, verify a failed save leaves
local state unchanged with a clear not-saved status and an idempotent retry
(same id/revision, no duplicate items), a concurrent edit surfaces the
conflict with a reload path, and successes report whether the item was
synchronized. The true offline pending queue with local persistence is
separate connected-mode work; record its scope decision here when taken.
