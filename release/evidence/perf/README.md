# Local-reference client performance measurements (PERF-002/004/005)

Audience: release engineering. Instrument: `tools/release/bench-client.mjs`
(Playwright against the live local stack; `VEYORA_BENCH_OUTPUT=...` writes
the JSON artifact next to this note).

These are **local reference measurements on this host** — the PRD's p95
targets are judged on the specified reference hardware in CI, where the
same harness is the instrument. They are honest signals, not acceptance
evidence, and one of them records a real defect-class finding below.

## 2026-09-06 run (`local-reference-2026-09-06.json`)

| Requirement | Measurement | p95 | Target | Verdict on this host |
| --- | --- | --- | --- | --- |
| PERF-002 | navigation → kernel self-test → interactive Welcome | 169 ms | ≤ 1000 ms | comfortable headroom |
| PERF-004 | search pipeline (filter+render), synchronous in-page, over 10,000 items | 25 ms | ≤ 100 ms | comfortable headroom; user path incl. the 120 ms debounce settles at ~387 ms with **no keystroke backlog** |
| PERF-005 | save click → encrypted & acknowledged panel, user-perceived path with the 10,000-item fixture seeded | 2811 ms | ≤ 250 ms (after encryption) | **over target — see finding** |

## Finding PERF-F-001 (filed against PERF-005/PERF-006)

The save path itself (seal + service PUT + revision acknowledgment) is
fast; the measured 2.8 s is dominated by the full table re-render after
save, which currently renders every in-session row without windowing.
With large vaults (the 10,000-item fixture) the acknowledgment panel
appears only after that render. This is exactly the long-work class
PERF-006 names. Follow-up: windowed/virtualized table rendering (or
deferring the full re-render until after the acknowledgment), then
re-run this harness — the instrument is in place and the artifact format
records pipeline and user-path numbers separately for exactly this
comparison.

## Reproduce

```
# stack on :3311 (see docs/DEPLOYMENT.md), then:
VEYORA_WEB_URL=http://127.0.0.1:3311 \
VEYORA_BENCH_OUTPUT=release/evidence/perf/<date>.json \
node tools/release/bench-client.mjs
```

## 2026-09-07 follow-up run (`local-reference-2026-09-07-windowed.json`) — PERF-F-001 RESOLVED

The finding was fixed with two changes:

1. **Windowed table rendering** — the table renders at most 500 rows per
   pass with a `Show more` control (and a shown/total line) expanding in
   500-row steps; searches and scope changes reset to the base window.
2. **Deferred acknowledgment re-render** — the save acknowledgment panel
   no longer waits for a table re-render on large vaults: above 500
   in-session items the refresh lands when the panel closes, while small
   vaults keep the immediate refresh (identical UX for normal sizes).

A follow-up defect the regression exposed in the first windowing cut was
also fixed: the window state could shrink to a filtered list's length and
then cap subsequent full renders (rows silently missing) — the window is
now expansion state only, clamped by the list at render.

| Requirement | Measurement | Before | After | Target |
| --- | --- | --- | --- | --- |
| PERF-002 | kernel load + self-test → Welcome | 169 ms | 187 ms p95 | ≤ 1000 ms |
| PERF-004 | search pipeline (10,000 items) | 25 ms | 8 ms p95 (user path 158 ms incl. debounce, no backlog) | ≤ 100 ms |
| PERF-005 | save acknowledgment (save-click → panel) | 2811 ms user-path | **32 ms p95** (compose incl. modal+typing: 54 ms) | ≤ 250 ms |

PERF-005 now meets its target on this host with an order of magnitude of
headroom. The instrument was also corrected in the same pass: the original
ack measurement rode Playwright's click-actionability loop (~300 ms of
driver overhead); the harness now dispatches the save click in-page for
the acknowledgment figure and reports the driver-click compose path
separately. Reference-hardware acceptance runs remain the CI-side half.
