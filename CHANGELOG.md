# Changelog

Notable changes to Veyora are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioned releases
will follow [Semantic Versioning](https://semver.org/) once a stable release
process is established.

## [Unreleased]

### Added

- Every browser suite now runs on GitHub runners on every push: the
  E2E-002..007 acceptance journeys (digest-invariant unlock rejection,
  clean-device Recovery Key recovery, cross-vault isolation, atomic
  import, destructive restore + hostile inputs, key regeneration) joined
  the Compose-integration job with their own pristine stack reset, and a
  dedicated fault-injection job exercises the genuine 429, dead-store
  503, and gateway-injected latency legs against a rate-limited,
  delay-injected disposable stack with teardown. First green run: all
  seven CI jobs success with `E2E journeys: 6 passed` and `Fault suite:
  4 passed` in the runner logs.

- The live Connect-gate verification runs in CI on every push: the
  Compose-integration job now restarts the stack in token-auth mode and
  executes the previously on-demand `verify-token-gate.mjs` (stable 401
  envelope, fresh-browser gate, wrong-token refusal, real-token entry
  into the Welcome routes). Wiring it caught a staleness defect — the
  authorized probe listed `/records` unscoped, which since the
  vault-scoping change answers 400 on the missing declared scope; the
  probe carries its scope and the full 4/4 verification passes against
  the real token stack.

- The backup/wipe/restore drill is now real, machine-run, and CI-wired
  — and executing it for the first time exposed a genuine data-loss
  defect: the restore binary's INSERT used the pre-scoping single-column
  conflict target (`ON CONFLICT (record_id)`), so restores have been
  failing against the composite `(vault_id, record_id)` schema. The
  conflict target is fixed, and the drill itself is rewritten honestly:
  a unique per-run record, declared-vault-scope create/verify, fail-fast
  curl, an actual TRUNCATE wipe (via psql or the postgres container),
  and correct binary defaults. Verified green through
  `make test-backup-restore` (create → backup → wipe → restore →
  byte-level ciphertext verification against the live stack's
  PostgreSQL) and added to the CI Compose-integration job so every push
  runs it on a runner.

- A full locale sweep in the browser: a new blocking journey cycles all
  nine non-English catalogs (zh-CN, zh-TW, ja, ko, de, fr, es, ru, and
  Arabic) through the live language switcher, asserting per locale the
  registry-declared direction, a rendered translated label, an unchanged
  item list, and zero horizontal overflow — restoring English at the
  end. Together with the machine-checked 504-key parity and the deep
  Arabic RTL assertions, every supported language is now exercised
  against the real page (comprehensive suite 71/71 twice consecutively).

- CI-side security scanning and scheduled fuzzing are live on runners
  (PRD SEC-ASSURE-003/005, CI halves): a new security-scan workflow
  (push, weekly, nightly, manual — every action SHA-pinned) runs the
  secret scan, `cargo audit` (vulnerabilities deny; the 18 current
  warnings are unmaintained notices for the GTK3 family Tauri's
  webkit2gtk bindings require plus other no-replacement transitives,
  each ignored with crate-mapped rationale in `.cargo/audit.toml`), a
  machine-readable third-party license inventory (new
  `generate-license-inventory.py`: 544 cargo+npm dependencies,
  forbidden-license policy, zero NOASSERTION) uploaded as an artifact,
  and the actions-pinning lint — plus a nightly kernel fuzz-boundary run
  with a date-derived rotating seed and the full kernel suite as a
  regression guard. First runner run green end-to-end; the `.cargo`
  tooling-config directory is declared in the layout manifest so the
  closed-root gate keeps enforcing.

- Sequences 1 and 6 closed with owner-authenticated live evidence: the
  pushed commit triggered the first real GitHub-runner CI run, and five
  genuine runner-only defects were fixed on the way to a fully green run
  (Repository integrity, Compose integration with all browser suites on a
  live stack, Desktop shell, Rust workspace, Security kernel, and the
  WebAssembly build) — a cargo-fmt `-p` crash, missing Linux WebView
  dependencies for the unified workspace, an ESM/CJS clash in the kernel
  runtime test, stack resets silently dropping the diagnostics build
  stamp, and a pre-restructure workspace map in the architecture test
  (plus hadolint's CMD-vs-ENTRYPOINT flag passing and a gitleaks
  allowlist for the inert E2E fixture passwords). The live release audit
  then found the retired v0.0.1 preview tag presented as a stable Latest
  release; it is now a prerelease with honest retired-tag notes and the
  re-run audit passes against the 1.0.0 version authority.

- Evidence-artifact hygiene is machine-enforced (PRD QA-010, repository
  half) and the mode matrix lands (PRD DOC-006): a new lint in
  `make check` validates every artifact under `release/evidence/` for
  UTC collection stamps, version/commit identity, retention-window
  freshness, and the absence of secret material (recovery-kit shapes,
  bearer tokens, private keys, password literals) — its first run caught
  both performance artifacts unstamped, now pinned to the product
  version and working-tree commit. `docs/modes.md` documents the three
  runtime modes (Desktop Local, Desktop Connected, Web Connected) as a
  per-mode capability matrix with practical differences and honest
  limits, explicitly a view over the feature registry and linked from
  the User Guide.

- Locale-independent browser selectors are now machine-enforced (PRD
  QA-013): a new lint in `make check` classifies every text-coupled
  locator in the browser suites — test-created data filters and
  copy-validation assertions are inventoried, copy-driven business-flow
  selectors are violations. Its first run found 16 real violations;
  closing them added locale-independent identity to the product itself
  (toasts now carry `data-toast-key` and every ceremony error host
  carries `data-error-key`, both holding the i18n key), and the suites
  now address rows by `data-id` and states by key. Zero violations
  remain and the full browser regression re-passed twice consecutively
  (70/70 comprehensive, all suites green). Fresh-clone bootstrap (PRD
  QA-014) was verified from a clean, cache-free copy of the current
  tree: every repository gate, locale parity, 108/108 web units, the
  full cargo workspace build, api/persistence/sqlite/desktop/kernel
  test suites, and post-clean git cleanliness all pass from scratch.

- A registry-driven release test plan (PRD QA-012): `generate-test-plan.py`
  joins the feature/evidence registry against the PRD requirement table
  and the ledger's recorded blockers, emitting `release/test-plan.md`
  with per-feature pass/blocked/fail verdicts — a blocker on any
  requirement dominates, so partial automation can never read as done
  (current honest output: 5 pass / 5 blocked / 0 fail). Generating it
  surfaced three stale registry entries (recovery and password change
  still marked Protocol-only/Unsupported, portable backup Planned) which
  are now corrected to Experimental with their real evidence paths.

- Documentation command executability is now machine-checked (PRD DOC-004,
  repository half): `make check` parses every fenced shell block across
  the shipped docs under `bash -n`, rejects prompt-polluted or
  non-copy-pasteable commands, requires explicit pseudocode labeling, and
  verifies referenced repository paths. The first run caught a real
  defect — the TLS deployment guide's `<generate-with: openssl …>`
  placeholders are shell syntax errors on copy-paste — now replaced with
  inline `"$(openssl rand -hex 32)"` generation; all 39 blocks parse. A
  companion progress-consistency validator enforces the goal's own
  records (PRD status markers must equal ledger statuses for sequences
  1–11, Complete never carries remaining scope, non-Complete states what
  is missing, evidence paths exist, timestamps are UTC, and CHANGELOG
  keeps an Unreleased section).

- Reproducible unblock tooling for the externally gated sequences:
  a review-package assembler for sequence 4 (`prepare-review-package.py`
  builds a 19-file independent-review scope with a commit-pinned SHA-256
  manifest, alongside a structured appointment/review-record kit that
  stays Pending until a named human reviewer signs against those hashes);
  a CI first-run preflight for sequence 6 (`ci-preflight.sh`, executed
  green end-to-end locally — every repository-side check the migrated
  workflows run, in CI order, which also caught and fixed a clippy
  `-D warnings` failure in the desktop test module); and a
  release-metadata auditor for sequence 1 (`audit-releases.py` — dry-run
  validates the repository's version/tag gates today; `--live` gives the
  owner a one-command audit of every published release the moment GitHub
  access is authorized).

- Permanent deletion from Trash (PRD ITEM-008/ITEM-009, web scope): the
  Trash tab offers a purge action whose two-step armed confirmation names
  the exact item count and states irreversibility, with an explicit note
  that encrypted copies leave the service immediately — ahead of the
  retention window. The action reuses the same scoped store purge the
  worker's retention policy runs. A blocking browser journey audits the
  service afterwards: zero tombstones remain for the vault while every
  live item is untouched (comprehensive suite 70/70 twice consecutively;
  all other suites green; 504-key locale parity).

- Community-readiness documents (PRD sequence 10, OSS-005 local scope):
  public governance (decision model by class, maintainer expectations,
  and the prerequisites for ever opening external intake), a roadmap that
  is explicitly a view over the PRD gates rather than a second source of
  truth, a support/discussion routing page (security reports first, and a
  standing "support will never ask for your master password or Recovery
  Key" promise), bug and documentation issue templates, and a PR template
  that requires PRD/registry IDs plus actually-executed green evidence.
  The OSI license adoption (OSS-001/OSS-003) is recorded as a precise
  owner/legal blocker — permissive vs network-copyleft is a strategy
  decision an engineer cannot make — so every public surface keeps
  truthful source-available wording until it lands.

- Native packaging slice (PRD sequence 9, local scope): `make
  desktop-build` produces a real macOS ARM64 package
  (`Veyora_1.0.0_aarch64.dmg`, Mach-O thin arm64, ad hoc linker-signed),
  pinned by SHA-256 in a new evidence record that states exactly what is
  and is not proven (no signing/notarization credentials locally, one of
  four targets, no updater corpus). INST-006's data-location conventions
  are now unit-asserted in the desktop shell — the suggested vault
  directory prefers the platform Documents folder, falls back to the
  app-data directory, and never resolves inside an application bundle,
  download folder, or source checkout (veyora-desktop 10/10).

- Creation now presents and verifies the Recovery Key (PRD UX-ONB-007):
  a new vault opens straight into the Recovery Key ceremony — the
  canonical 71-character key with a copy action and explicit guidance
  that Veyora cannot recover it — and onboarding only credits the step
  after the user re-enters the key and both the kernel codec and an
  exact-match check pass; a mistyped copy is refused inline. The
  start-here checklist's recovery and backup steps are now real steps
  (completed by the ceremony and by a successful encrypted-backup
  download respectively; the honest-unavailable notes are gone), and
  Settings → Security offers View/verify to repeat the ceremony anytime.
  Every browser suite's creation helper now walks the real ceremony;
  comprehensive 69/69 twice consecutively, all other suites green.

- Recovery Key regeneration (PRD REC-006) and terminology enforcement
  (REC-007): Settings → Security offers Regenerate Recovery Key — the
  ceremony re-authenticates through the password wrapper, writes the new
  kit's wrapper first, revokes the old kit's wrapper compare-and-set
  (recovery now treats a tombstoned wrapper as revoked — its lingering
  ciphertext can never open the vault again), creates an encrypted backup
  and verifies it by opening it back before reporting success, displays
  the new kit with storage guidance, and states the revocation
  consequence. A blocking browser journey proves the chain on wiped
  state: the old kit is dead and the new kit recovers the same vault.
  The terminology rule is machine-enforced by a new lint in `make check`
  that refuses 'recovery code', 'recovery password', 'backup password',
  and any 2FA-recovery conflation across all ten catalogs and the shipped
  docs (488-key parity).

- The Recovery Key architecture (PRD REC-001..005, web scope): vaults now
  use a wrapped Vault Key — random 32 bytes from which every record key
  derives — protected by two wrappers: the master password's (stored in
  the vault scope) and the Recovery Key's, stored at a scope derived from
  the kit itself so a fresh device can find it with nothing but the kit.
  Legacy vaults migrate transparently on their next unlock (the old
  password-derived key IS the Vault Key, so migration writes only the
  wrappers and rewrites no record), password changes on wrapped vaults
  replace only the password wrapper through compare-and-set, and recovery
  — offered on the Welcome and unlock screens — validates the kit through
  the kernel codec, fetches the wrapper at the kit-derived scope, proves
  the recovered key against the real vault's verifier before adopting
  anything, and then sets the new password. E2E-003 passes as a blocking
  journey on a fully wiped device: malformed kits refused inline, every
  item recovered, the old password dead, the new password and post-
  recovery CRUD working. 107/107 web units and the full browser
  regression are green; strings ship at 478-key parity across ten
  catalogs.

- Browser acceptance journeys for PRD E2E-002, E2E-004, E2E-005,
  E2E-006, and E2E-007 (new suite `tests/e2e/web/test-browser-e2e.mjs`,
  `make test-browser-e2e`, plus a fault-suite leg for E2E-004): wrong
  passwords against an empty vault leave every stored byte identical;
  two vaults with colliding item ids stay isolated end to end with a
  server-side scoped audit; malformed and duplicate-id imports commit
  nothing while valid files commit exactly their rows (the first real
  browser-driven CSV import coverage); encrypted backups restore into an
  emptied destination with full comparison and post-restore CRUD while
  truncated, wrong-version, and wrong-password inputs never mutate it; and
  a password change attempted against a dead store fails safely with the
  old password and all 100 imported records intact after recovery. The
  journeys exposed and fixed a real defect: `vault.reset()` left the
  destroyed vault's decrypted entries in memory, which then rendered into
  a vault created later on the same page — reset now zeroes the list.

- Encrypted portable backup and restore (PRD EXP-001, web scope):
  Settings → Data now offers `Create encrypted backup` (previously
  honestly unavailable) and `Restore backup`. The `veyora-backup` envelope
  is portable — sealed under the master password with a per-backup salt
  independent of the live vault — and every entry is sealed individually,
  respecting the security kernel's per-record plaintext limit (a first
  single-blob design tripped `PM-KERNEL-LIMIT-EXCEEDED` against a real
  vault and was replaced before shipping). Creation re-authenticates
  against the stored verifier, refuses a wrong password inline with
  nothing downloaded, and the completion stage names the entry count and
  that only the master password can open the file. Restore advertises the
  count before asking for the password, verifies the
  concatenated-plaintext digest, and merges through the atomic batch
  endpoint with id de-duplication so existing entries are never
  overwritten. Covered by five unit tests and a blocking browser journey
  that downloads, audits, restores, and re-audits against the live
  service (68/68 twice consecutively; 473-key locale parity).

- The Master Password change is now reachable and verified in the UI:
  Settings → Security offers the ceremony with the same composition-free
  rules as vault creation, refuses inline when the current password is
  wrong (nothing changed) or offline writes are still pending, and the
  unlock path resolves an interrupted change by adopting the committed
  target scope or falling back to the old salt. A blocking browser journey
  changes the password through the real UI and unlocks with the new one
  against the live service. Two defects the journey exposed are fixed:
  a rekey resurrected Trash entries (tombstoned rows now travel with a
  purgeable deletion stamp, enforced in the shared adapter contract), and
  a `u64::MAX` purge cutoff wrapped negative through the SQL adapters'
  `as i64` casts, silently purging nothing (now clamped and regression
  tested). Strings ship at 456-key parity across all ten catalogs.

- Atomic Master Password change through a server-side vault rekey: the
  storage port gains `rekey_vault`, which inserts every re-sealed record
  under the fresh salt and deletes the old scope in one transaction in the
  in-memory, SQLite, and PostgreSQL adapters (any target collision or
  failure rolls the whole operation back), exposed as `POST /vault/rekey`
  with strict mixed-scope rejection. The web client's password change now
  refuses while offline writes are pending, verifies the current password,
  snapshots and re-seals every row (the verifier's identity moves to the
  new salt's derived id), and commits through the rekey with a crash-safe
  pending marker that the next unlock resolves — adopting a committed
  target scope or falling back cleanly. This fixes a silent-data-loss
  defect: the previous flow re-sealed rows under the old salt, flipped the
  device salt, and left the entire service copy unreachable. Covered by
  the shared adapter contract suite (including a live PostgreSQL run), an
  API move-and-collision test (42/42), and new client tests for the rekey,
  failure, and crash-window paths (96/96 web units; browser regression
  66/66 twice consecutively).

- The destructive Reset matrix (PRD DATA-009, web scope): Settings → Data
  now offers four separately labeled reset actions instead of one ambiguous
  button — clear device preferences (never vault data), forget the saved
  service connection, remove this vault from this device (the confirmation
  states plainly that the service copy survives but becomes unreachable
  from this device, and offline queued writes are dropped with it), and
  delete everywhere, which deletes the service scope first (every live row
  tombstoned including the reserved verifier record, then one scoped
  purge) and removes the device copy only after the service confirms — a
  failed service deletion leaves the device untouched, so an unreachable
  remote orphan can never be created by accident. Five scope-boundary unit
  tests and two real-service browser journeys (the second audits the vault
  scope after reset and proves it answers an empty listing) cover the
  matrix; strings ship at 448-key parity across all ten catalogs.

- Tombstone retention with a consistent purge (PRD DATA-008, experimental
  scope): every tombstone now carries its deletion time (epoch seconds,
  NULL for live rows) — set on soft-delete, cleared on restore — and
  migration 0003 backfills pre-migration tombstones at the migration epoch
  so their retention window starts then and never purges earlier than an
  operator expects. Purge is one cutoff-scoped store operation shared by
  every caller: the API's `POST /vault/purge` purges at the current epoch
  and the worker enforces the operator retention policy
  (`VEYORA_TRASH_RETENTION_DAYS`, default 30 days per PRD DEC-009; `0`
  disables purging; the cutoff saturates at zero so a skewed clock deletes
  nothing extra). Proven live: the worker's sweep reports purged counts,
  live PostgreSQL tests backdate a stamp through the database itself and
  prove only the expired tombstone is removed, and the full pristine
  browser regression is green after rebuilding the migrator image.

- A shared adapter contract suite (PRD DATA-010, experimental scope):
  `backend_persistence::contract` runs one identical behavioral suite —
  round trips, server-assigned revisions, compare-and-set conflicts,
  (vault_id, record_id) isolation, bounded paging, all-or-nothing batches,
  tombstone stamp/restore lifecycle, and cutoff-boundary purge semantics —
  against the in-memory reference, SQLite, and live PostgreSQL, so the two
  SQL adapters can never drift. Fixes that fell out: `PostgresStore::
  migrate()` now reaches the real current schema (the composite primary
  key was previously skipped on the development path, silently building a
  single-key database), the ignored live tests serialize through a shared
  guard because migration files take table locks, and each live test
  cleans only its own vault scope instead of wiping the shared database.

- Per-vault verifier identity (PRD DATA-003, experimental scope): the
  password verifier record is no longer stored under one global fixed id.
  New vaults write `veyora-verifier-v1-<vault-salt>`, so two vaults on one
  store never share a verifier record id and an empty vault still rejects a
  wrong master password against its own verifier. Vaults created before
  this change unlock against the legacy global id and migrate on sight —
  the scoped verifier is written first, the legacy row is tombstoned after,
  and the sequence is crash-safe and idempotent (a 409 on the write means
  another device already migrated). Covered by four new blocking unit
  tests (89/89 web units) and a green pristine browser regression.

- Real write latency in the fault drills and single-flight save coverage:
  the gateway's Envoy config gains an optional fault-injection route
  (`VEYORA_GATEWAY_DELAY_MS`, milliseconds) that delays record writes for
  the fault-test stack while leaving health and readiness probes instant;
  the entire fault block is deleted from the rendered config unless the
  knob is set, so production gateways never carry it. The fault suite's
  new leg proves through the real browser path that a deliberately slow
  save disables the submit control while the write is in flight, fires
  exactly one record write under repeated clicks, and commits exactly one
  entry (3/3 twice consecutively; the standard stack stays delay-free and
  the comprehensive suite remains 64/64).

- Reduced-motion and RTL browser coverage: the accessibility suite now
  emulates `prefers-reduced-motion` and proves every animation and
  transition duration collapses to effectively zero (19/19, twice
  consecutively), and the comprehensive suite's Arabic language leg now
  proves RTL is a rendered state — mirrored dashboard chrome, zero
  horizontal overflow, and Arabic tab copy (64/64, twice consecutively).

- A fault-injection browser suite (`make test-browser-faults`) that drives
  real service failures into the client instead of mocks: a burst of live
  requests trips the API's rate limiter and the resulting genuine
  `PM-API-RATE-LIMITED` 429 (with `Retry-After: 60`) surfaces in the save
  banner with the typed input preserved, recovering once the minute window
  resets; stopping the stack's PostgreSQL makes the API answer a genuine
  `PM-STORE-UNAVAILABLE` 503 into the same banner, and after the database
  restarts the suite proves `/readyz` flips back to ready and the retried
  save commits. The suite runs on its own disposable rate-limited stack
  and passed twice consecutively.

### Fixed

- The PostgreSQL connection pool never recovered after a database restart
  (PRD DB-002 hardening): idle connections were handed out without a
  liveness check, so sockets stranded by a restart kept failing every
  store call forever and readiness never returned to ready. Idle
  connections are now probed with a `SELECT 1` round trip before hand-out
  and dead ones are discarded and replaced. Verified live by the new fault
  suite (stop PostgreSQL → real 503 → restart → `/readyz` 200 → retried
  save commits) plus `backend-postgres` 6/6 and `api` 41/41 test suites.

- Browser coverage for every non-Login item type: blocking journeys in the
  comprehensive suite now create Secure Note, API Token, SSH Key, and
  Identity entries through the template picker, assert each row's localized
  type label, verify type tabs scope to one template's entries, and verify
  type-specific fields (API token service subtitle, SSH host) are searchable
  without any request to the service. The suite grew to 64 tests and passed
  twice consecutively from pristine stores.

- Tags as a real vault capability in the web client (PRD 7.1 / ITEM-002 /
  NAV-003 / NAV-006): Login and Secure Note entries carry a comma-separated
  Tags field under the `More fields` disclosure, values are parsed, trimmed,
  and lowercased onto the encrypted item, search matches assigned tags with
  no query ever leaving the device, and a new Tags tab counts distinct tags
  and lists only tagged entries with pressed-state, individually removable
  filter chips. Strings ship across all ten locale catalogs at full key
  parity. Blocking browser journeys now cover the favorite/unfavorite scope
  and the full tag create/assign/filter/search path; the comprehensive suite
  grew to 62 tests and passed twice consecutively from pristine stores
  (smoke, accessibility 18/18, and keyboard 20/20 suites green as well).

### Fixed

- The gateway's HTTP-to-HTTPS redirect pointed at the plaintext port (PRD
  DEP-002): the redirect built `https://<host>:8080` from a Location header
  string. It now uses Envoy's redirect action with `scheme_redirect` and a
  `port_redirect` rendered from the configured TLS port, so the destination
  can never be mis-constructed. Verified with self-signed certificates in
  the Compose TLS mode: the redirect now targets the TLS port, health and
  readiness answer over verified TLS, and a full record PUT/DELETE round
  trip runs over TLS.

- Readiness reported HTTP 200 while the database was unreachable (PRD
  API-006): `/readyz` now answers `503` with an honest `ready:false` body
  when the backing store cannot be listed, so orchestrators stop routing
  traffic to a not-ready instance; `/healthz` stays process-alive-only and
  keeps answering `200` during a database outage so an alive process is not
  restarted. Covered by a new unavailable-store test (`cargo test -p api`,
  fmt, clippy `-D warnings`).

- The Compose `backup` profile could never write a snapshot: its entrypoint
  invoked a nonexistent `./backup` binary; it now runs the real
  `veyora-backup` binary, and the `./backups` bind mount documents the
  one-time `install -d -o 10001` ownership step required now that the
  container runs unprivileged.

### Changed

- UTC timestamps on every operational log line (PRD DEP-014 completion):
  the std-only ISO-8601 UTC formatter (unit-tested against the epoch, a
  leap day, and known instants) now lives in the shared persistence crate
  and prefixes the API access log plus the worker, migrator, backup, and
  restore log lines. Log content stays counts and stable English events
  only — no record or Vault identifiers, paths, or ciphertext. Live-verified
  on the rebuilt stack.

- UTC access logs with restart-unique request IDs (PRD DEP-014): every API
  access-log line now starts with an ISO-8601 UTC timestamp (a std-only
  formatter pinned by unit tests to the epoch, a leap day, and known
  instants), and request IDs gained a per-boot Unix-epoch prefix so they
  stay unique across process restarts while remaining pure-hex,
  bounded-cardinality correlation values, echoed in both the log line and
  the `X-Request-Id` response header. Live-verified on the rebuilt stack.

- Deployment health and resource bounds (PRD DEP-007): the gateway and web
  containers now have Compose healthchecks (the gateway probes its
  data-path listener over TCP since the envoy image ships no HTTP tool;
  the web container uses busybox wget), every Compose service declares a
  bounded memory limit (postgres 1g, api 512m, worker/migrator/gateway/
  backup 256m, web 128m), and the API service documents a 15-second
  stop-grace window matching its in-flight request drain on SIGTERM.
  Verified live: all five long-running services report healthy on the
  hardened stack and both smoke suites pass.

- Containers now run least-privilege (PRD DEP-006): every application
  container in the Compose topology runs with all Linux capabilities
  dropped and a read-only root filesystem. The six Rust service images
  (api, worker, migrator, backup, restore, validator) run as an
  unprivileged fixed uid 10001 `veyora` user; the gateway renders its envoy
  configuration into the ephemeral `/tmp` mount and runs as the image's
  unprivileged `envoy` user; the web image stages its nginx configuration
  as a read-only template, renders it at start into a tmpfs-mounted
  `conf.d`, and serves the runtime `veyora-config.js` from `/tmp`, keeping
  only the minimal nginx startup capabilities (`CHOWN`, `NET_BIND_SERVICE`,
  `SETGID`, `SETUID`) as a documented exception. PostgreSQL's official
  entrypoint remains the sole documented exception for volume
  initialization. Verified on a fully rebuilt hardened stack: all services
  healthy (Rust containers at uid 10001, gateway at uid 101), the web UI,
  config, assets, and API proxy all served, and both the API smoke suite
  and the browser smoke suite pass end to end.

### Added

- Bounded, paginated listings and authoritative conflict payloads (PRD
  DATA-005/006): record listings take explicit `limit`/`offset` with a
  strict maximum (default 500, hard cap 5000 — oversized or zero limits are
  stable-code rejections, never silently honored), every response carries
  an `x-truncated` marker when another page may exist, and the
  `?embed=bodies` hydration path has its own 500-row maximum with the web
  client paging summaries for larger vaults. Compare-and-set conflicts now
  answer `409` with the server-authoritative current revision in the typed
  `parameters` map, so clients resolve conflicts without guessing. Proven
  by blocking tests plus live-stack evidence (marker observed; a stale PUT
  answered `PM-STORE-CONFLICT` with `current_revision`), followed by a
  full pristine browser regression.

- Browser test inventory (`docs/browser-test-inventory.md`): every page,
  route, state, and flow mapped to its blocking suite, with seven honest
  coverage gaps recorded (favorites/tags journeys, non-Login item types,
  live 429/5xx in the UI, slow/duplicate requests, reduced-motion, RTL,
  native desktop).

- Atomic batch import (PRD DATA-007/API-010, server scope): the store port
  gained a transactional `put_batch` — PostgreSQL and SQLite execute every
  row in one transaction, so a single invalid or conflicting row rolls the
  whole batch back; the in-memory store plans atomically under one lock.
  `POST /records/batch` is all-or-nothing: all records must declare one
  vault scope, a conflict answers the `PM-STORE-CONFLICT` envelope with
  nothing applied, and the success response carries exact
  `requested`/`committed` counts plus per-row revisions (the requested row
  count is never a success count). Unit and live-PostgreSQL rollback
  proofs, an updated web import client, and `api.md` documentation ship
  with it.

- Vault-scoped record storage (PRD DATA-001/002/004, experimental scope
  under the sequence-4 gate): the storage identity of a record is now
  `(vault_id, record_id)` across the persistence port and all three
  adapters — PostgreSQL and SQLite each gained a `0002` migration that
  replaces the single-column primary key with the composite pair, and every
  SQL statement filters by vault. The API requires a declared `?vault=`
  scope on every read, listing, deletion, and purge (missing scope fails
  with `PM-API-BAD-QUERY`), validates the envelope's vault on writes
  alongside the route/body identity check, and the web client, Connect
  probes, and smoke script carry the scope. New blocking tests prove the
  collision contract: the same record ID written for two vaults stays two
  independent rows, each listing sees only its own vault, and a cross-scope
  read is `404` (unit and live-PostgreSQL evidence, including the migration
  on a real store). The declared-scope model is interim until the ADR 0005
  pairing principals ship; no supported-capability claim is made.

- Least-privilege database roles (PRD DB-004): first initialization of the
  Compose database provisions `veyora_migrator` (DDL on the public schema)
  and `veyora_app` (DML-only) login roles — psql-quoted passwords with
  role-specific `VEYORA_DB_APP_PASSWORD`/`VEYORA_DB_MIGRATOR_PASSWORD`
  overrides that fall back to the shared deployment password. The records
  migration, applied by the migrator role as table owner, grants the
  application role exactly SELECT/INSERT/UPDATE/DELETE (skipped on
  role-less local databases), every Compose service connects with its own
  role-scoped `DATABASE_URL`, and the API falls back from startup migration
  to schema verification when the DML role is correctly denied DDL.
  Live-verified on a fresh role-initialized stack: services healthy,
  smokes green, and an integration test proves the DML role cannot run DDL
  while data operations and schema verification succeed.

- Remote-database TLS modes (PRD DB-003): database connections to any
  non-loopback TCP host now require verified TLS by default (pure-Rust
  rustls with the ring provider — aws-lc and OpenSSL are excluded so
  container images need no new system packages). `VEYORA_DB_TLS_MODE`
  selects `verify-full`, `disabled-insecure` (the explicit private-network
  acknowledgment the Compose file now carries), or `auto`; unknown modes
  fail closed, and `VEYORA_DB_TLS_CA_FILE` adds the operator's private CA
  (a configured-but-missing CA fails closed). Verified by unit tests plus a
  live integration test against a real `ssl=on` PostgreSQL with a
  self-signed private CA. The Rust builder pin moved to
  `rust:1.93.1-slim-bookworm` so builder and runtime glibc stay aligned.

- Compose network-topology gate (PRD DEP-003):
  `tools/lint/check-compose-topology.py` (part of `make check` and CI)
  renders the canonical Compose file and enforces the exposure contract:
  only the gateway's TLS edge port may bind non-loopback, every other
  published host port must be loopback-only, and internal services
  (api, worker, migrator, backup, restore, validator) must publish no host
  ports. Verified against the real topology and against negative cases
  that publish an internal service or bind a non-edge port publicly.

- Image architecture inspection (PRD DEP-007 / section 14.4):
  `tools/release/inspect-image.py` reports every `linux/<arch>` platform
  entry of an image's OCI index and supports `--require amd64,arm64` as a
  release-matrix gate. Verified against a public multi-arch image
  (including a missing-architecture negative that fails), and against the
  published `veyora-api` image, proving it is a true
  `linux/amd64`+`linux/arm64` index.

- Foundation image pin drift gate (PRD DEP-007):
  `tools/lint/check-foundation-pins.py` (part of `make check` and CI) proves
  the release workflow and the local publish script mirror exactly the same
  five digest-pinned upstream foundation images, and that every Dockerfile
  default base tag is the tag side of one of those pins — a digest changed in
  one place but not the other now fails the build (verified by injecting a
  fake digest).

- Security-header contract enforcement (PRD DEP-009, SEC-WEB-001..003,
  web-origin scope): the versioned header contract now matches the reviewed
  served values, the web origin serves the previously missing
  deny-by-default `Permissions-Policy` plus
  `Cross-Origin-Opener-Policy`/`Cross-Origin-Resource-Policy` and uses
  `Referrer-Policy: no-referrer`, and a new smoke test
  (`tests/smoke/headers.sh`, part of the CI lint set) compares every live
  header against the contract and rejects forbidden `script-src
  'unsafe-eval'` or missing `object-src`/`base-uri`/`frame-ancestors`
  `'none'`. Verified live (7/7 headers) with the browser and API smoke
  suites still passing.

- Proposed scoped pairing/session credential design (PRD DEC-002,
  `UX-AUTH-007`/`008`, `API-002`, `DEP-004`): ADR 0005 defines the
  review-gated target — a CSPRNG connection credential scoped to
  principal/device/generation, single-use pairing codes provisioned by the
  operator deployment token, bounded-overlap rotation, immediate revocation,
  absolute and idle expiry, OS-credential-store (desktop) and
  `HttpOnly`/`Secure`/`SameSite=Strict` cookie (web) storage with
  `localStorage` bearer tokens forbidden, and server-side scope enforcement
  with a closed `PM-AUTH-*` error surface. The machine contract, a
  repository checker (now part of `make check` and CI), and eleven negative
  contract tests keep the status Proposed until a qualified independent
  review is recorded; nothing claims the design as a supported capability.

- Operator failure-mode runbook (PRD DEP-015): `docs/runbook.md` documents
  TLS, authentication, CORS, database, migration, backup, restore, storage
  exhaustion, clock drift, and client/server version-mismatch failures with
  concrete `docker compose`/`curl` diagnostics, anchored on the
  `/healthz` vs `/readyz` semantics.

- Bounded upgrade procedure (PRD DEP-012): the operator guide's upgrade
  section is now preflight → verified backup → switch → verify →
  rollback-decision, including a one-shot backup command that was verified
  live against a real PostgreSQL and migrator-gated switchover with
  data-format-limited rollback guidance.

- Bounded PostgreSQL connection pool (PRD DB-002): the pool now tracks
  checked-out plus idle connections and refuses to open more than its
  maximum (default 8, overridable with `VEYORA_DB_POOL_MAX`) — pool
  exhaustion waits up to a bounded acquisition timeout (default 3 s,
  `VEYORA_DB_ACQUIRE_TIMEOUT_MS`) and then fails closed with
  `PM-STORE-UNAVAILABLE`, every connection carries a session-level
  statement timeout (default 15 s, `VEYORA_DB_STATEMENT_TIMEOUT_MS`),
  idle-expired connections are discarded (default 300 s,
  `VEYORA_DB_IDLE_TIMEOUT_SECS`), and `PostgresStore::shutdown()` drains
  idle connections immediately while waiting bounded for checked-out ones.
  The reservation logic is unit-tested (cap, refill, release, policy
  flooring) and the live integration test proves round trips, CAS
  conflicts, the statement-timeout session setting, and post-shutdown
  fail-closed behavior against a real PostgreSQL.

- Explicit destructive-teardown gate (PRD DEP-013): `make purge-data`
  refuses to run unless `CONFIRM=destroy-veyora-data` is passed exactly,
  and the deployment/operator documentation now states precisely what
  `docker compose down --volumes` deletes (the named `veyora-pg` volume
  holding every encrypted record) and what it does not touch
  (`./backups`, anything outside Compose — with no undelete).

- Desktop-runtime honesty for save-pending copy (PRD ITEM-006 desktop
  alignment): when the desktop runtime flag is set, the saved panel reports
  that the local vault did not respond (with a `Try saving again` action
  instead of `Sync now`), the row badge reads `Pending save`, and the
  Diagnostics timestamp row is labelled `Last saved` / `Nothing saved yet`
  rather than implying a remote synchronization that a local-only vault never
  performs. Five new locale keys ship in all ten catalogs (421-key parity);
  the comprehensive browser suite gained desktop-mode assertions for the
  `Last saved` row (still 60/60).

- Offline pending-write queue for saves (PRD ITEM-006, connected web
  scope): when the service cannot be reached, a save keeps its
  already-sealed ciphertext record DTO in a per-vault local queue (a newer
  queued write replaces the earlier one for the same record; no plaintext
  or key material is ever persisted), the item stays in the session with a
  `Pending sync` row badge, and the saved panel reports `Saved on this
  device — not yet on the service` with a `Sync now` action. Queued writes
  replay before every listing and from `Sync now`: still-offline replays
  keep the queue, successful replays commit with their compare-and-set
  metadata, and entries the server definitively rejects (conflicts) are
  dropped with the server authoritative. Unit tests cover the queue store
  and replay semantics with a no-plaintext-in-storage canary; browser E2E
  aborts the record request, observes the pending report, badge, and
  ciphertext-only storage, reconnects, and proves the synchronized report
  and badge clearing (comprehensive suite now 60/60; locale coverage
  416-key parity across all ten catalogs).

- Vault identity on locked and unlocked screens (PRD 6.3 / NAV-001, web
  scope consumed by the desktop shell): the dashboard top bar now shows a
  human-readable vault name plus a safe location summary, and the locked
  unlock screen's identity line carries the same name and location instead
  of the raw vault-id hex. The summary is `On this device` on the desktop
  runtime and `Connected vault at <origin host>` on the web — never a full
  URL, path, or token (unit tests pin the boundary, browser E2E asserts
  both runtimes plus canaries; the comprehensive suite is now 59/59 and
  locale coverage 413-key parity across all ten catalogs).

- Desktop first-run dialog accessibility (PRD ACC-004 alignment,
  desktop-shell scope): the setup overlay is now exposed to assistive
  technology as a named modal dialog (`role="dialog"`, `aria-modal`, labelled
  by the Welcome heading), its waiting/error line is a live `role="status"`
  region matching the PRD error model, focus lands on the first route action
  when the wizard opens, pressing Enter in the connect address field opens it
  in the browser, and every control shows a visible keyboard focus outline.
  Desktop shell only; `cargo test -p veyora-desktop` remains 9/9.
- Desktop first-run Welcome routes (PRD UX-ONB-002, desktop implementation):
  the Tauri setup screen now offers the four PRD routes instead of one
  ambiguous storage-location button whose create-or-open behavior depended
  on the picked folder. `Create a new vault` refuses a folder that already
  contains `vault.db` (pointing to the Open route), `Open an existing vault`
  requires an existing database, `Import from another password manager`
  creates a vault and states that the next screen offers the import, and
  `Advanced: connect to a self-hosted server` opens a shell-validated plain
  http/https address in the system browser with honest copy that desktop
  connected pairing arrives with connected mode. `pick_vault_dir` gained a
  `route` parameter with create/open guards so neither route can silently
  become the other; four new desktop unit tests pin the guards and the
  external-URL validation (`cargo test -p veyora-desktop` now 9/9).


- Desktop-runtime diagnostics honesty (PRD DIAG-001/DIAG-002, web scope used
  by the desktop shell): when the Tauri WebView injects
  `window.VEYORA_DESKTOP`, the Settings Diagnostics panel reports
  `Local vault on this device` and an `Encrypted vault stored on this
  device` storage summary instead of claiming a connected vault or showing
  the meaningless loopback host, and the support bundle prints
  `mode: desktop-local-vault` with a `storage: local vault on this device`
  line and no `service-host:` line. Connected-mode output is unchanged.
  Two new locale keys ship in all ten catalogs (409-key parity), unit tests
  pin the desktop branch and its no-loopback canaries, and the comprehensive
  browser E2E gained a desktop-mode assertion (now 58/58).
- Manual-evidence capture kit (PRD sequence 7 preparation, not evidence
  itself): `docs/evidence/manual-evidence/` now holds structured `Pending`
  record templates for all 21 remaining manual activities — screen-reader
  and native accessibility (ACC-001, ACC-004/012/013, the manual portion of
  E2E-010), copy reviews and the comprehension study (UX-ONB-001/004,
  EXP-002/003, HELP-002), item-form task studies (ITEM-002..005), onboarding
  platform/privacy/threat evidence (UX-ONB-002 desktop, UX-ONB-005 autofill
  matrix, UX-ONB-006 threat-model approval, UX-ONB-010 privacy review), and
  desktop/native parity (DIAG-001/002, the desktop portion of ITEM-006). A
  new `tools/lint/check-manual-evidence.py` (part of `make check` and CI)
  enforces the record structure: the covered requirement inventory must be
  exact, `Pending` records must leave the completion fields empty, and any
  filled record must carry a method, environment, named operator, ISO date,
  and at least one artifact path that exists in the repository or an https
  location, with `Fail` records stating a follow-up. Filling a template is
  only valid after a human performs the recorded activity.
- Automated keyboard and focus audit suite (PRD ACC-004 automated portion,
  ACC-005, and the 200% zoom reflow check): the new blocking browser suite
  `tests/e2e/web/test-browser-keyboard.mjs` proves the WAI-ARIA dialog
  pattern for the entry modal, password generator, settings drawer, Help
  overlay, and shortcuts dialog — focus moves into the dialog on open,
  Tab/Shift+Tab cycles never leave it, and Escape or the close/cancel
  control returns focus to the opener (including the generator layered over
  the entry form). It also scans for ACC-005 by focusing every reachable
  control (scoped to the topmost open dialog, since the dialog pattern makes
  the page behind it inert) and asserting the interaction point is not
  covered, and checks 200% zoom reflow at 640 CSS px with no
  document-level horizontal scrolling. Manual screen-reader and native
  evidence is still required for E2E-010.
- Generic dialog focus return (PRD ACC-004): `captureFocusReturn` /
  `restoreFocusReturn` in `apps/web/src/core/ui.js` remember the control
  that opened a dialog and hand focus back on close for every surface —
  entry modal, generator, settings/entry drawer, plaintext-export ceremony
  (including its completion view), support-bundle preview, and shortcuts
  dialog. The password generator now also moves focus to its length control
  on open so the focus trap holds from the first Tab press.
- Fixed the focus trap targeting the wrong dialog: the Tab trap previously
  selected the first open overlay in DOM order, which let the password
  generator (opened over the entry form) escape into the modal behind it,
  and preferred the drawer over an overlay stacked above it. It now traps
  the topmost open overlay.
- Fixed the dashboard theme-toggle button rendering empty: the theme icon
  was applied by `applyDocumentTheme` before the dashboard existed, leaving
  an icon-only button with no content on the dashboard until a locale
  change re-rendered it.
- Fixed topbar button overlap: the shortcuts and Help buttons use the
  `.tb-lock` style that was hard-pinned to a 34 px width, so their text
  labels painted over adjacent buttons (the automated obscuring check
  caught the Settings icon covering the theme toggle). These buttons now
  auto-size with a 34 px floor, and the wrapped actions row is
  width-bounded at ≤640 px so the 320 px reflow audit still passes.
- Automated accessibility audit suite (PRD ACC-002/003/006/007/008 and the
  automated portion of E2E-010): the new blocking browser suite
  `tests/e2e/web/test-browser-accessibility.mjs` audits every core screen
  (Welcome routes, Connect gate, create form, item dashboard, entry modal,
  password generator, item drawer, Settings drawer, and Help overlay) for
  accessible names on all controls, persistent visible labels on data-entry
  fields, WCAG text contrast in both light and dark themes (computed from
  rendered styles, including element opacity), 24×24 CSS px pointer targets,
  and 320 px reflow with no document-level horizontal scrolling and primary
  actions on-screen; CI runs it after a pristine-store reset like the other
  browser suites. Manual keyboard, screen-reader, zoom, and native-target
  evidence is still required for E2E-010.
- Atomic desktop export finalization (PRD EXP-004, desktop path): every
  user-save-dialog file the desktop shell writes (Vault → Export Backup, and
  startup snapshot copies) now goes through a temporary file that is flushed
  to disk and atomically renamed over the target; a failure at any point
  deletes the temporary file and leaves a previously valid target untouched.
  Five fault-injection unit tests in `apps/desktop/src-tauri/src/atomic_file.rs`
  prove the guarantees (an interrupted export never destroys an older file or
  leaves a truncated result under the final name).
- Live Connect / Sign-in gate verification script (PRD UX-ONB-003):
  `tests/e2e/web/verify-token-gate.mjs` runs on demand against a real
  `VEYORA_API_AUTH=token` stack (set `VEYORA_CONNECT_TOKEN`) and proves the
  stable 401 envelope for missing and wrong tokens, that a fresh browser
  gates on Connect / Sign in with no vault create/unlock surface, that the
  live service refuses a wrong connection token, and that the real
  deployment token enters the Welcome routes.

- Closed error catalog with machine-enforced completeness (PRD DIAG-003):
  blocking API tests now require every `PM-*` literal used in the API
  sources to be cataloged, every catalog code to be searchable in
  `docs/reference/api.md` (and the documentation to promise no uncataloged
  code), and codes to be unique uppercase ASCII. axum `Json`/`Query`
  extractor rejections — which previously escaped as plain-text framework
  errors — now return the stable-code JSON envelope, adding the
  `PM-API-BAD-QUERY` catalog code (with the matching client locale key in
  all ten catalogs), and the documentation table gained the previously
  missing `PM-API-RATE-LIMITED` row.
- Opt-in support bundle preview (PRD DIAG-002, web scope): Settings →
  Diagnostics offers `Prepare support bundle`. The bundle is built only on
  request from the DIAG-001 safe sources (version, build stamp, mode,
  origin host, health word, last-sync timestamp, backup status), shown in
  full with an explicit statement that Veyora never uploads it, and copied
  only through an explicit Copy button; no automatic submission path
  exists, and the copy does not advance the Start-here checklist or emit
  first-success events. Unit canary tests prove connection tokens, full
  URLs, and paths cannot reach the bundle; browser E2E covers the flow
  (7 new locale keys, 407-key parity).

- Diagnostics panel (PRD DIAG-001, web scope): Settings now carries a
  Diagnostics section showing the product version, the image build stamp
  (`VEYORA_BUILD_COMMIT`, rendered into `veyora-config.js` at container
  start by `deploy/web/Dockerfile` and `deploy/compose/compose.yaml`;
  unstamped builds display an honest not-stamped label), the connected
  vault mode, a safe storage summary (encrypted records at the origin
  host only — never the full URL, path, or connection token), a live
  service health probe against `/healthz`, the last successful
  synchronization (a bare ISO timestamp recorded by the records client on
  every successful fetch or save), and an honest not-available status for
  the last verified backup until the sequence-5 backup flow ships. Unit
  tests cover the redaction boundary and 18 new locale keys ship in all
  ten catalogs (399-key parity); browser E2E asserts the panel contents
  and that no master password, entry secret, or token material appears
  anywhere in the settings drawer.
- Save status reporting and idempotent retry (PRD ITEM-006, web scope): a
  failed save now renders a dedicated status banner in the form instead of
  a generic toast. Network/service failures state that the vault was not
  changed and offer `Retry save`, which re-runs the same idempotent write
  (create reuses the derived id; edits reuse the same compare-and-set
  revision, so a retry can never duplicate the item); a 409 conflict states
  that the item changed on another device, preserves the edits in the form,
  and offers `Reload latest version`, which refetches and re-opens the form
  on the server's version. Rejected saves for other reasons surface the
  API error text with the same retry path. Successful saves now report
  `Synchronized with the service — revision N` in the post-save panel.
  Seven new locale keys ship in all ten catalogs (381-key parity); browser
  E2E covers the not-saved banner, an idempotent retry with no duplicate,
  and the conflict reload path (55/55 plus the smoke suite).
- Field-level save errors with a multi-error summary (PRD ACC-010, web
  scope): every entry-form field now carries an inline `role="alert"` error
  slot wired through `aria-describedby`, a failed save reports all problems
  at once (missing name, missing required secret, malformed TOTP) inline
  beside each field with `aria-invalid` state, and two or more errors also
  render a focusable summary whose entries link to their fields. A single
  error focuses its field; typed input is never discarded and editing a
  field clears its own error. The two generic save toasts were replaced by
  messages that name the correction.
- Clipboard-clear announcement (PRD ACC-011/SEC-CLIP-001): after the
  configured clipboard window, Veyora announces that the clipboard was
  cleared — or that clearing failed because another app holds it — as a
  polite status message that does not move focus.
- Five new locale keys ship in all ten catalogs (374-key parity, two stale
  keys removed); the comprehensive browser E2E now covers the multi-error
  summary, the single-error focus behavior, and the clipboard-clear
  announcement (53/53 plus the smoke suite).

- Welcome routes (PRD UX-ONB-002, web/shared-UI scope): the first screen
  offers `Create a new vault`, `Open an existing vault` (which states
  honestly when no vault is known on this device), `Import from another
  password manager` (explains that the master password comes first, then
  lands in Settings → Data), and `Advanced: connect to a self-hosted
  server` before any password is requested. Desktop-native routing
  evidence remains open.
- Connect / Sign-in gate (PRD UX-ONB-003, web implementation): boot probes
  the records endpoint with the stored credential (or none) and an explicit
  401 renders a Connect / Sign-in screen — service URL plus the
  operator-issued deployment connection token — before any vault create or
  unlock surface. Credentials are verified against the service, persisted,
  and the app re-enters through boot; non-401 probe outcomes defer to the
  existing unlock error paths. The copy states that full device pairing
  arrives with connected mode. 25 new locale keys ship in all ten catalogs
  (371-key parity); browser E2E covers the gate against a mocked 401
  service and the four routes.

- Local common-password screening (PRD UX-ONB-006): vault creation rejects
  passwords built from an embedded list of widely breached material. The
  check is exact-match, case-insensitive, whitespace-folding, and runs
  entirely on the device — the password is never sent anywhere, which the
  pre-commit disclosure now states. The threat-model approval for the
  password policy remains open.
- First-success instrumentation for test builds (PRD UX-ONB-010): an
  opt-in-only recorder measures a saved Login followed by search and
  copy/reveal — never Vault creation — and stores only event names and
  timestamps (no item ids, names, queries, or secrets) in localStorage.
  It is disabled unless the build injects `VEYORA_FIRST_SUCCESS_TELEMETRY`
  or loads with `?veyora-first-success=1`; a browser assertion proves a
  full session writes nothing without the opt-in. The privacy review and
  test-event inspection remain open.

- Progressive Login form (PRD ITEM-002): the Login template now starts with
  Name, Username, Password, and Website; TOTP and Notes wait behind a
  keyboard-accessible `More fields` disclosure that auto-expands when an
  edited entry already uses those fields.
- Name recognition guidance (PRD ITEM-003): the Login name field uses the
  `GitHub - Work` example and a hint explaining the name is for recognition.
- Named password-field actions (PRD ITEM-004): secret inputs are masked by
  default and expose named `Generate`, `Show`/`Hide` (with `aria-pressed`),
  and `Copy` controls adjacent to the field.
- TOTP input parsing (PRD ITEM-005): the TOTP field accepts both raw Base32
  secrets and `otpauth://totp/` URIs, ignores safe whitespace and grouping
  dashes, normalizes to uppercase Base32 on save, explains the accepted
  sources in a hint, and rejects malformed input with an inline error while
  preserving everything the user typed. New locale strings ship in all ten
  catalogs (344-key parity), unit tests cover the normalizer, and browser
  E2E covers the disclosure, field actions, malformed-input rejection, and
  URI-based creation.

- Separated encrypted backup from plaintext export (PRD EXP-001): Settings →
  Data now offers `Create encrypted backup` (shown honestly as unavailable in
  this preview) as a distinct action from `Export plaintext data`.
- Plaintext export ceremony (PRD EXP-002): exporting requires an
  always-visible not-encrypted warning, an explicit acknowledgement, and
  master-password re-authentication against the stored verifier; a wrong
  password exports nothing. Re-authentication reuses a new
  `recordSync.verifyPassword` primitive that verifies without touching the
  session root key.
- Export completion view (PRD EXP-003): after a successful export the dialog
  repeats `Not encrypted`, names the file, lists the included columns and the
  omitted fields (TOTP seeds, favorites, custom metadata), and gives safe
  deletion guidance. Web downloads are all-or-nothing — the CSV is fully
  serialized before the download is created — while the desktop temp-file +
  atomic-rename path (EXP-004) remains open.
- Welcome screen orientation (PRD UX-ONB-001): the first screen now states
  what Veyora does, what a Vault is, and that the current mode is a connected
  vault before requesting a password.
- Create-form disclosure (PRD UX-ONB-004): vault creation explains the
  storage location, password requirements, recovery consequences, and the
  unavailable encrypted-backup boundary before the commit button, explicitly
  distinguishing plaintext CSV export from backup.
- Master Password input hardening (PRD UX-ONB-005/006): creation now enforces
  the 15-character floor without composition rules, preserves long Unicode
  and space-containing input, and gives Show/Hide a keyboard-accessible name.
- Post-save next actions (PRD ITEM-007): saving an item now shows a saved
  panel naming the item with `Back to vault`, `Copy secret`, and
  `Add another item`; returning closes both the modal and any underlying
  detail drawer.
- Trash retention preference (PRD ITEM-009 partial): Settings stores a
  validated 30-day default with 7/30/90/365-day options while stating that
  automatic deletion is not implemented yet.
- Task-routed Help (PRD HELP-001/002): a Help overlay reachable from the
  Welcome, Locked, and Unlocked states routes users by task — get started,
  understand recovery, encrypted backup, restore, connect, troubleshoot, and
  private security reporting — with truthful unavailable-capability copy,
  safe contextual actions, a reviewed private-report link, and focus return.
- Accessible authentication and save feedback (PRD ACC-003/010/011 partial):
  icon controls have accessible names, auth errors set alert/invalid state,
  and successful saves use an atomic polite status region.
- Scoped search (PRD NAV-002): the search field's placeholder and
  `aria-label` name the active view (`Search all items`, favorites, a type,
  or Trash) instead of a static label.
- Visible, individually removable filter chips (PRD NAV-003): the active
  scope and text query render as chips above the table, each removable with
  an accessible label.
- A true empty-vault state (PRD NAV-004): `Your vault is empty` with
  `Add your first login` and `Import items`, the latter wired to the same
  CSV import as Settings; a filtered-but-nonempty view gets its own copy.
- A no-results state (PRD NAV-005) that names the query and scope and
  offers `Clear search` and `Search all items`.
- Delete-to-trash Undo (PRD ITEM-008): the deletion toast now carries an
  Undo action — shared by the drawer and row-menu paths — that restores the
  tombstoned entry. New locale strings ship in all ten catalogs (289-key
  parity), and the comprehensive browser E2E gained assertions for each
  behavior.
- Start here checklist (PRD UX-ONB-008/009): a dismissible card above the
  table guides the first safe steps — add or import the first login, copy
  or reveal a secret, and lock the vault — while recovery verification and
  encrypted backup are listed honestly as unavailable in this preview.
  Progress persists in localStorage, the card hides itself once the
  available steps are done, and it reopens from
  `Help → Open the Start here checklist`.
- In-app keyboard shortcuts dialog (PRD NAV-007): a top-bar `Keyboard
  shortcuts` button and a Help task document every shortcut in one place
  and state that shortcuts never fire while focus is in a text field.
- Documented local search surface (PRD NAV-006): search now matches a
  single documented field set (name, username, website, service, host,
  notes, secret, item type) via `data/search.js`; the shortcuts dialog and
  user guide state that the query runs on-device and is never sent to the
  service. New locale strings ship in all ten catalogs (314-key parity),
  and the comprehensive browser E2E covers the checklist lifecycle, the
  shortcuts dialog, the field guard, and the no-network search assertion.

### Fixed

- Accessibility defects surfaced by the new audit (PRD ACC-002/003/006/007/008):
  the focused/hovered Welcome route tile and the selected item-type template
  rendered dark text on a dark fill (1:1 contrast); tertiary text (`--ink-3`)
  met only ~3:1 in both themes and template type codes were below 4.5:1; the
  `More fields` disclosure turned white-on-white on hover and was smaller
  than the 24 px pointer-target minimum; the settings selects, sort order
  control, and generator option checkboxes had no accessible name; the custom
  checkbox and the password-length slider were smaller than 24 px targets;
  and at 320 px the top bar forced 63 px of horizontal page scrolling (the
  search field now takes its own full-width row, actions wrap, and the
  two-column diagnostics grid collapses to one column).
- First-success instrumentation (PRD UX-ONB-010) now judges achievement by
  event-log position instead of millisecond timestamps, so a burst of
  events within one millisecond keeps its true order; the previous
  timestamp comparison could mis-order sub-millisecond activity.
- Clearing the search (Escape, the query chip, or the no-results actions)
  now cancels the pending search debounce; previously a stale 120 ms timer
  could silently re-apply the typed text and leave the table in a stale
  no-results state.
- Failed edits no longer mutate the unlocked in-memory item before the
  encrypted API write succeeds (PRD ITEM-006/QA-015); injected 503 coverage
  proves the last saved value is preserved and the form remains open.
- The Help and theme controls no longer overlap on Welcome/Locked screens;
  the new corner group now overrides the legacy fixed-position button style.
- Toasts are now pointer-interactive while overlays are open: `#toast`
  previously kept `pointer-events: none` even in its visible state, so an
  action inside a toast (such as Undo) could not be clicked while a drawer
  or modal was on screen.

- A generated-artifact manifest (`tools/codegen/manifest.json`) plus
  `tools/codegen/check_codegen.py` and the `make codegen` / `make
  check-codegen` targets: every tracked generated output now declares its
  generator, canonical inputs, consumers, digests, regeneration command, and a
  deterministic check that CI runs (PRD REPO-006/007/008).
- A real producer for `packages/config/registry.generated.json`
  (`tools/codegen/backend/generate_registry_projection.py`): the backend-owned
  settings projection is regenerated from `contracts/registry/settings.json`
  with reproducible source/projection digests.
- `tools/codegen/contracts/generate_bindings.py` with
  `contracts_types_template.rs`: the two Rust contract bindings
  (`packages/contracts-rust` and the kernel's `contracts_generated`) are now
  generated from one template with a reproducible `CONTRACT_SOURCE_DIGEST`
  over the whole contracts inventory and per-output projection digests; the
  previously referenced-but-missing `generate-bindings.py` no longer exists
  only as a claim.
- A LANG-002 path-style check in the repository checker: path components must
  be lowercase or match an explicit approved naming convention (governance
  documents, cargo/make/docker files, font families, archived Java sources,
  BCP-47 locale names).
- Unit tests for the registry projection generator alongside the existing
  generator suite.

- A machine-readable product version authority and feature/evidence registry in
  `release/`, including explicit platform, release-channel, audit, recovery,
  backup, and installer limitations.
- A machine-readable PRD progress handoff that distinguishes completed work,
  partial risk containment, remaining scope, and the next recommended sequence.
- Browser regression coverage for missing/corrupt WASM, missing exports,
  initialization policy failures, kernel self-test failures, and a known
  plaintext network canary.
- A proposed, versioned key/recovery/portable-backup lifecycle ADR, binary
  grammar, review contract, and dependency-free validation that binds existing
  independent-oracle vectors without misrepresenting them as qualified human
  security approval.
- `repository-layout.toml`, the repository layout authority. The repository
  check now rejects unapproved tracked root entries and file types, non-ASCII,
  spaced, or case-colliding paths, tracked runtime state, unapproved
  working-tree root artifacts (including an empty `password/` directory), and
  experiment paths referenced by shipping CI or the Makefile.
- `CODEOWNERS` with specialist-review areas for the security kernel,
  contracts, release authorities, release workflows, and security docs.


### Changed
- The fresh-clone repository-integrity gate (PRD G1/M1) passes on the local
  Mac: a clean clone of the migrated tree, `npm ci`, the repository check,
  `git diff --check` (staged and unstaged), `make check-codegen` from a cold
  `.build`, the web/locale/codegen/contract suites, the root Rust workspace
  and security-kernel test suites, and `make clean-all` now end with zero
  untracked git entries and a bounded ~53 MB checkout.
- The layout authority allows `*.rs` template sources under `tools/`: the
  Rust contract-binding template that `tools/codegen/contracts/` owns is a
  generator input, and the fresh-clone gate caught that tracking it would
  have violated the previous `tools` file-type allowlist.
- The contract bindings and the codegen manifest digests were regenerated
  after whitespace-only contract edits; `make check-codegen` passes from a
  cold `.build`.
- API errors are no longer localized server-side (PRD LANG-003): the API
  returns stable ASCII codes with fixed English messages only, the
  `Accept-Language` negotiation middleware and its `Content-Language`/
  `Vary` rewriting were removed, and `services/api/src/error_catalog.rs`
  is English-only. The web client now renders localized API errors from
  new `apiError.*` keys in all ten locale catalogs through
  `apiErrorMessage()`, and the repository checker's final source CJK
  allowlist entry is gone.
- Locale parity is now release-blocking (PRD LANG-005): a shipped locale with
  missing keys fails `check-locales` instead of warning about fallback to
  English.
- The generic browser E2E suite and the root README are no longer CJK
  allowlist exceptions; only locale catalogs, i18n docs/registries, and the
  API error catalog may contain non-English text.
- The WASM generation story is single-sourced (PRD REPO-007): the web and
  kernel READMEs now document `make build-wasm` as the only generation
  command and `apps/web/src/wasm/` as the only destination; the stale
  `deployment/web/wasm/` path claim was removed.
- CI's Rust job now runs `make check-codegen`, so generated drift fails the
  build before tests run.
- CI's browser suites no longer build an ad-hoc `/tmp` npm package: the
  compose job runs `npm ci` from the root Node workspace and executes the
  checked-in `tests/e2e/web` scripts from the repository root. The suites
  fall back from bundled Chromium to the runner's preinstalled Chrome/Edge
  channels, matching their existing launch fallback order.


- The repository now follows the PRD target ownership layout. `frontend/web`
  and `frontend/desktop` moved to `apps/web` and `apps/desktop`; the backend
  services moved to `services/`; the shared crates moved to `packages/`
  (`config`, `contracts-rust`, and the `storage/` adapters); the backend
  architecture harness moved to `tests/architecture`; and the Dockerfiles,
  Compose topology, gateway, and web delivery configuration moved to
  `deploy/containers`, `deploy/compose`, `deploy/gateway`, and `deploy/web`.
  All Makefile, CI, Dockerfile, Compose, checker, registry, and documentation
  references were updated; the legacy `backend/`, `docker/`, and `frontend/`
  roots no longer exist.
- A single root non-kernel Rust workspace (`Cargo.toml`, `Cargo.lock`,
  `rust-toolchain.toml`) now builds the services, packages, the architecture
  harness, and the shipping desktop crate; the desktop shell no longer crosses
  the product boundary with `../../../backend` path dependencies. The security
  kernel intentionally keeps its own workspace and lockfile.
- A single root Node workspace with one lockfile covers `apps/desktop` and the
  browser E2E package; `npm ci` at the root installs everything and the stale
  per-package lockfiles were removed.
- Product release workflows now accept only the tag declared by the version
  authority and create preview versions as GitHub prereleases rather than
  Latest releases.
- Public documentation now identifies Veyora as a source-available experimental
  preview and separates implemented code from verified product capability.
- Recovery and Master Password change controls are hidden until the required
  Vault-Key-based, atomic designs are implemented and verified.
- Quality tooling moved by responsibility with history-preserving renames:
  lint checks to `tools/lint/`, browser E2E to `tests/e2e/web/`, the API smoke
  test to `tests/smoke/api.sh`, the backup/restore drill to
  `tests/integration/backup-restore.sh`, deployment tooling to `deploy/tools/`,
  and container publishing to `tools/release/publish-containers.sh`.
- The `m0-desktop` and `m0-android` capability spikes are archived under
  `experiments/`; the Makefile and CI now check the shipping desktop
  application instead of the obsolete spike.
- CI's desktop job runs format, lint, and test checks on the shipping desktop
  crate (`apps/desktop/src-tauri`).
- The comprehensive browser E2E suite is now blocking in CI. The shell success
  bypass is removed, and the two browser suites run against isolated pristine
  stores (a data-volume reset between suites) because a second vault on one
  store still collides with the reserved global verifier record id.
- The security kernel moved from the repository root to
  `packages/security-kernel/` with history-preserving renames while keeping
  its independent Cargo workspace, lockfile, and review boundary. All Makefile,
  CI, Dependabot, CODEOWNERS, gitleaks, doctor, layout-manifest, repository
  checker, contract, provenance, feature-registry, experiment-evidence, and
  documentation references were updated; kernel vector generator references
  and `fixture_sha256` digests were recomputed; the layout authority now
  supports nested entries such as `packages/security-kernel` via longest-prefix
  matching; and a pre-existing YAML indentation bug that folded the clippy and
  test steps into the CI rust job's fmt command was fixed.
- The `sandbox` service is renamed `validator` (`services/validator`, crate
  `validator`, image `veyora-validator`) across contracts, generated
  projections, capabilities, settings ids, CI, publishing, and documentation,
  removing the ambiguous sandbox naming. The backend generated projection was
  regenerated through `tools/codegen/backend/generate_backend_projection.py`.
- Transient build output now lives under the ignored `.build/` tree: Makefile
  targets use `.build/cargo` for the root workspace and `.build/kernel` for the
  security kernel. `make clean` removes `.build`, the new `make clean-all`
  additionally removes dependency trees and legacy `target/` directories, and
  the new `make doctor` (`tools/lint/doctor.sh`) reports required and optional
  toolchain readiness and flags unignored output directories.

### Fixed

- Removed trailing whitespace in `.github/workflows/ci.yml` and blank lines
  at end of file in `contracts/cddl/key-lifecycle-v1.cddl` and
  `docs/adr/0004-key-recovery-backup-lifecycle.md` found by the fresh-clone
  `git diff --check` gate.
- The backend architecture suite no longer scans `packages/security-kernel`
  as backend source; it keeps its own review boundary and workspace. This
  fixes false failures introduced by the kernel relocation.

- The Web client no longer contains a demonstration pass-through crypto
  fallback. Missing, invalid, or self-test-failing WASM blocks startup before
  Vault operations are available; the Service Worker cache moved to v5 and
  security-sensitive unversioned assets now bypass stale HTTP-cache entries.
  The generated binding and WASM module are digest-pinned and verified before
  initialization, including raw module/instance export checks and randomized
  startup tests.
- Trash is reachable from the dashboard, tombstoned records can be restored,
  and focused-grid `j`/`k`/arrow/Enter navigation is covered by browser E2E.

## [0.0.1] - 2026-09-01

Historical desktop preview tag. A later evidence audit found that the tag was
published after `v1.0.0`, was marked Latest, and did not provide the complete,
signed four-native installer matrix or Stable evidence required by the PRD.
The release must therefore be treated as an unverified preview rather than a
product baseline.

### Added

- Desktop app (`frontend/desktop`): a Tauri 2 experimental shell configured
  for Windows x64 and macOS universal source builds. The encrypted-records API
  and a SQLite store (`backend/crates/sqlite`) run in-process behind a
  loopback port. Packages were not signed, notarized, or validated across the
  four required native targets. First-run
  screen makes choosing the storage location the first action; Vault
  menu exposes change-location (with migration), storage info, open
  folder, and JSON export/import compatible with the server
  `backup`/`restore` tools; rolling startup snapshots in the chosen
  folder. Release workflow builds both platforms on `v*` tags
- Optional bearer-token support in the web client (`veyora-api-token`
  localStorage override) so browser and desktop clients work against
  token-auth deployments
- English-only source guard: the repository checker rejects Han, Kana,
  and Hangul text outside the i18n allowlist (locale catalogs, i18n
  docs, the localized error catalog, its assertions, README badges)
- `desktop-dev`, `desktop-build`, and `desktop-check` Makefile targets;
  desktop client guide (`docs/DESKTOP.md`)


- API CORS allow-methods now includes `POST`, so browser-side clients on
  other origins (the desktop WebView) can reach `POST /records/batch`;
  request IDs are generated from a per-process counter instead of reading
  `/dev/urandom`, which silently failed on Windows
- Backend architecture test recognizes `backend-sqlite` (store-adapter
  crate location, migrations directory, dependency edge)
- Single Docker deployment entry: the four root Compose files and the
  `deployment/` directory are consolidated into `docker/` with one
  canonical `docker-compose.yaml` (image pulls by default, inline
  source builds, `backup` profile, TLS, loopback database port),
  an annotated `.env.example`, and a deployment README
- Governance documents moved under `docs/` (brand guidelines, code of
  conduct, copyright and trademark policies); the unreferenced
  `TRADEMARKS.md` alias is removed
- `scripts/build-and-push.sh` defaults to the public GHCR namespace;
  the browser-test dependency (playwright-core) moved from the root
  `package.json` to `scripts/`
- Repository checker iterates tracked files only, so local `target/`
  and `node_modules/` trees no longer trip it

### Fixed

- `publish-images.yml` built the web image with the wrong context
  (`deployment/web` instead of the repository root)
- The Compose file now passes `VEYORA_API_CORS_ORIGINS` and
  `VEYORA_API_RATE_LIMIT` through to the API service

- Row action menu: every record row has a kebab (⋯) overflow menu with
  edit and delete; delete uses the same armed two-step confirmation as the
  drawer and tombstones into the trash. Dismisses on outside press,
  Escape, scroll, and re-render; the trigger toggles and reports
  `aria-expanded`/`role="menu"` semantics. New `action.more` catalog key
  in all 10 locales; browser smoke test covers open/dismiss, prefilled
  edit, and armed delete
- Brand identity: the shield mark now drives favicons (light/dark scheme),
  the Apple touch icon, PWA `any`/`maskable` icons, and the login and
  topbar wordmarks (CSS-mask tinted, theme-adaptive); Service Worker
  cache later rotated to v4
- Initial public source preview with a clean repository history
- English-first project documentation and multilingual translation gateway
- Public repository integrity checks and simplified continuous integration
- Localhost-only default port publishing for the Compose preview
- Monochrome web client (`frontend/web`): framework-free ES modules, design
  tokens, full i18n (10 locales with RTL and ICU plurals), dashboard with
  drawer detail, error boundaries, and accessibility semantics
- Real security-kernel integration in the browser: Argon2id derivation,
  XChaCha20-Poly1305 seal/open, checksummed recovery kits, CAS record sync
- Password verifier record: even an empty vault rejects a wrong master
  password
- Generic login CSV import/export per the interchange contract, with the
  entry type riding in `tags_json` for lossless round trips
- An early Master Password re-encryption prototype remains in source for
  migration work, but is unsupported and not exposed because it does not
  atomically rewrap an unchanged Vault Key
- Localized JSON error envelopes negotiated from `Accept-Language`
  (Content-Language/Vary headers) across the API surface
- Content-Security-Policy on the web container, live request metrics,
  constant-time bearer-token comparison
- Web client unit tests (Node `--test`, including real-WASM kernel
  and CSV contract suites) wired into CI alongside the locale checker


- Web container packages `frontend/web`; the legacy single-file client has
  been removed and `make run-web` / `make build-wasm` target the new client

### Added

- PWA manifest for install-to-homescreen
- Search result highlighting (`<mark>` tags)
- Sort and tab selection persist across sessions
- Focus trap in modals and drawer (WAI-ARIA dialog pattern)
- `prefers-reduced-motion` respected for all animations
- Comprehensive E2E browser test (`scripts/test-browser-full.mjs`)
  covering TOTP, trash restore, unavailable unsafe lifecycle controls,
  keyboard navigation, health badges, search highlighting, and language
  switching
- TLS deployment guide (`docs/DEPLOYMENT-TLS.md`)
- User guide (`docs/USER-GUIDE.md`)
- Operator guide (`docs/OPERATOR-GUIDE.md`)
- Threat model updated with TOTP, trash, health analysis, CSV
  interchange, and password rotation analysis
- Backup service in production Compose (daily, 7-day retention)
- `.env.example` documents `VEYORA_API_CORS_ORIGINS` and
  `VEYORA_API_RATE_LIMIT`

### Fixed

- Vault scoping on shared stores: `fetchAll`/`fetchTrash` now filter
  server listings by the device's `vault_id` before verifier lookup, so
  records left over from another vault (e.g. a reset that did not purge
  the server) can no longer fail unlock with a spurious wrong-password
  error or leak into listings
- Unlock distinguishes connectivity failures from wrong-password failures
- Editing or favoriting an entry refreshes its updated timestamp
- Render failures keep the last good DOM instead of a blank screen


- Completed the explicit environment wiring required by the API, gateway, web,
  worker, and migrator containers
- Made container-registry publishing provider-neutral
- Clarified preview status, security boundaries, and noncommercial licensing

## Preview feature set

The current source tree includes:

- a portable Rust security kernel with WebAssembly and native FFI surfaces;
- Argon2id, HKDF-SHA-256, XChaCha20-Poly1305, Ed25519, canonical CBOR,
  synchronization manifests, password generation, and recovery-kit primitives;
- Rust API, worker, migrator, backup, restore, and sandbox binaries;
- PostgreSQL and in-memory persistence adapters;
- a static browser client using the checked-in WebAssembly kernel;
- Envoy, nginx, Docker, and Docker Compose deployment sources; and
- protocol schemas, inert examples, provenance records, and known-answer
  vectors.

No production-ready or independently audited release has been published.
