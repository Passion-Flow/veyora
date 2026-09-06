# Browser test inventory — pages, states, flows, and coverage

The mandatory browser-verification baseline (PRD section 17.3 / E2E-010 and
the stabilization goal): this inventory enumerates every page, route,
drawer, modal, application state, and user flow that exists in the Web
client, maps each to the blocking suite that exercises it, and names the
honest coverage gaps. Every claim below traces to a concrete test title in
`tests/e2e/web/`; gaps are listed as gaps, never as covered.

Suites (each blocking in CI, each run from a pristine store):

- `test-browser.mjs` — smoke: kernel derive → seal → store → decrypt →
  reveal → delete → lock against the real service.
- `test-browser-full.mjs` — the comprehensive journey suite (60 tests).
- `test-browser-accessibility.mjs` — names/labels/contrast/targets/reflow
  audits over the rendered surfaces (18 tests, light and dark themes).
- `test-browser-keyboard.mjs` — WAI-ARIA dialog pattern, focus exposure,
  and 200% zoom reflow (20 tests).

## 1. Screens and routes

| Surface | Covered by | Notes |
| --- | --- | --- |
| First boot / no vault (Welcome, four routes) | full: welcome routes, open/import/connect route copy | Includes honest no-vault-on-device copy |
| Connect / Sign-in gate (401 boot) | full: gate + refused/valid credentials | Mocked 401 plus live token-auth verification script |
| Create vault form | full: pre-commit explanations, password rules | |
| Locked / unlock + Recovery Key route | full: lock, wrong password, correct password; kit-validated recovery on a wiped device (E2E-003) | |
| Dashboard (All items) | full + a11y + keyboard | Topbar vault identity, checklist, badges |
| Favorites / item types / Tags tabs | full: favorite/unfavorite journey with Favorites scope isolation; tag create/assign, Tags scope, tag chips with pressed state, tag matches in search; search-scope placeholder follows the active view; filter chips | Non-Login item types see gaps |
| Trash tab | full: delete → trash row → restore | |
| Settings drawer (all sections) | full: data (encrypted backup create/restore ceremony with download and post-restore service audits), retention, change-password rekey ceremony, diagnostics, the four-scope destructive Reset matrix; a11y + keyboard audit the drawer | |
| Help overlay | full: reachable from Welcome, Locked, Unlocked; task routing; focus return | |
| Shortcuts dialog | full + keyboard: dialog pattern, never-in-a-field | |
| Entry modal (all item types) | full: Login core fields, TOTP, save/error paths; creation journeys for Secure Note, API Token, SSH Key, and Identity through the template picker with type-label rows | Edit/reveal for non-Login types follows the shared drawer paths |
| Password generator overlay | a11y + keyboard (over the entry form) | |
| Export ceremony (plaintext) | full: warning, acknowledgement, re-auth, completion view | |
| Support-bundle preview overlay | full: opt-in, preview, redaction | |
| Start-here checklist card | full: steps, persistence, hide/reopen | |
| Offline/pending surfaces | full: queued save, badge, reconnect sync |
| PRD acceptance journeys (E2E-002/003/005/006/007) | e2e suite: digest-invariant wrong-password rejection, clean-device Recovery Key recovery (verifier-proven, old password dead), cross-vault colliding-id isolation with server-side audit, all-or-nothing imports, destructive restore + hostile-input rejections | Own contexts per device (`make test-browser-e2e`) |
| Save-failure surfaces (429 / 5xx) and slow saves | faults: real rate-limited 429, store-down 503, and gateway-injected 2.5s write latency driven into the save banner and single-flight save control, with input preservation and retry recovery | Own disposable stack (`make test-browser-faults`) | |

## 2. Application states

| State | Covered by |
| --- | --- |
| No service session → Connect gate | full (UX-ONB-003) |
| Empty vault | full (empty state + CTA) |
| No search results | full (NAV-005) |
| Save failure / retry / conflict | full (ITEM-006: banner, idempotent retry, reload latest) |
| Offline → pending → synchronized | full (ITEM-006 queue) |
| Locked-during-action | smoke (lock at end); keyboard suite dialog closing |
| Desktop runtime (Tauri flag) | full (diagnostics local-vault copy) |

## 3. Verified behaviors (representative)

Keyboard navigation j/k/Enter, undo toast, restore, reused-password badge,
favorites scoping (favorite via row star, Favorites lists only it), tag
assignment behind the More-fields disclosure with chip filtering and tag
matches in search, creation journeys for all four non-Login templates with
type-tab scoping and type-field search that stays local, the four-scope
Reset matrix including delete-everywhere audited against the live service,
search field scope + no-query-to-service proof, live TOTP with countdown,
reveal/copy with announced auto-clear, checklist persistence across lock,
language switch without state loss, opt-in-only telemetry silence, per-view
console-error surveillance (every full-suite test runs under a console
watchdog), reduced-motion emulation proving every animation and transition
duration collapses to effectively zero, Arabic RTL rendering (mirrored
chrome, no horizontal overflow, Arabic tab copy),
CSP/security-header contract via `tests/smoke/headers.sh`, real
service 429 (PM-API-RATE-LIMITED with Retry-After) and store-down 503
(PM-STORE-UNAVAILABLE) surfacing in the save banner with preserved input
and genuine recovery via the fault suite's disposable rate-limited stack, real gateway-injected write latency proving the save control goes inert in flight, fires exactly one record write under hammering, and still commits exactly one entry.

## 4. Honest coverage gaps (not claimed as covered)

1. **Native desktop (Tauri) execution of any of the above**: the shared-UI
   code is browser-verified; native desktop evidence remains a manual
   activity (`docs/evidence/manual-evidence/desktop-native.md`).

## 5. Maintenance rule

Any new view, modal, drawer, state, or flow must land in this inventory in
the same change, either mapped to a blocking test or listed as a gap. The
inventory is itself evidence: `release/prd-progress.json` references it.
