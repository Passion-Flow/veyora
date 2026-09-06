# Veyora Product Requirements Document

## 1. Document control

| Field | Value |
| --- | --- |
| Document status | Proposed implementation baseline |
| PRD version | 1.0-draft |
| Research date | 2026-09-01 |
| Evidence commit | `c3fe0094e1a0916d33523c192bf65d11a7950266` |
| Product release status at baseline | Preview; not approved for real credentials or stable release |
| Canonical language | English |
| Intended readers | Product, design, web, desktop, backend, security, QA, release engineering, operations, documentation, and open-source maintainers |
| Normative terms | MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY have their RFC 2119 meanings |

This document is the implementation and acceptance baseline for the Veyora stabilization program. It intentionally includes product, architecture, repository, documentation, packaging, installation, and regression requirements because a credential vault is only usable when all of those layers work together.

If this PRD conflicts with an older README, guide, screenshot, release note, test comment, or implementation claim, this PRD defines the target behavior. Existing behavior remains evidence of the current state, not an accepted requirement.

### 1.1 Source-of-truth hierarchy

The project MUST use this order of authority:

1. Approved security model, cryptographic profile, and versioned contracts.
2. This PRD and approved Architecture Decision Records.
3. Executable acceptance tests and release evidence.
4. Implementation.
5. User, operator, and developer documentation generated or verified against the items above.
6. Marketing copy and screenshots.

No README or marketing statement may override a security or acceptance requirement.

### 1.2 Requirement format

Every normative requirement has an ID. Implementation work, pull requests, tests, and release evidence MUST reference the relevant IDs. A requirement is complete only when its implementation, automated evidence, required manual evidence, and documentation are all complete.

Priority meanings:

| Priority | Meaning |
| --- | --- |
| P0 | Release blocker; the product promise is unsafe, false, corrupting, or impossible without it |
| P1 | Required for a usable, supportable public beta or stable release |
| P2 | Important improvement that may follow the first stable release if it does not invalidate a promise |

## 2. Executive decision

Veyora will be a **desktop-first, local encrypted vault for one person**, with an optional advanced **self-hosted connected mode**. The default path is local and requires no account or server. The connected path is explicit, separately authenticated, and never sends the Master Password, Vault Key, Recovery Key, or plaintext item fields to the service.

The first stable release is blocked until all P0 requirements and the four-native-platform release matrix pass. Until then:

- Real credentials MUST NOT be recommended.
- Releases MUST be marked prerelease.
- Veyora MUST NOT claim working recovery, production readiness, complete offline support, native Windows ARM support, or stable installation unless the matching evidence exists.
- Veyora MUST be called source-available, not open source, until an OSI-approved license is adopted.
- The browser MUST fail closed if the real security kernel is unavailable. A pass-through demonstration kernel MUST NOT exist in any distributable build.

### 2.1 Definition of the product in one sentence

> Veyora helps you save, find, and back up passwords and other private information in an encrypted vault you control.

The first screen and public README SHOULD use that level of language. Terms such as WASM, Argon2id, HKDF, CBOR, Merkle tree, revision, cipher suite, protocol, and kernel belong in technical documentation, not in the primary user journey.

### 2.2 First stable outcome

A user who has never seen Veyora MUST be able to install it, understand it, create or open a vault, save and verify recovery material, add or import a Login, find and use it, lock and unlock, create an encrypted backup, and restore that backup into an empty environment without reading source code or an external README.

## 3. Current-state baseline and target comparison

This baseline is a point-in-time audit of the evidence commit. A green unit test does not overrule an end-to-end contradiction.

| Area | Current observed state | Why it is insufficient | Required target | Priority | Blocking evidence |
| --- | --- | --- | --- | --- | --- |
| Product definition | Root README presents self-hosted web and standalone desktop without a clear default user journey | A new user cannot tell whether they need a server, account, local file, or browser | Desktop Local is the default; Connected Vault is an explicit advanced mode; Web is connected-only | P0 | First-run comprehension test and mode-specific E2E |
| First-run experience | The first meaningful action is setting a Master Password | The product value, Vault concept, storage location, alternatives, and recovery consequences are unexplained | Welcome screen explains value and offers Create, Open, Import, and Advanced Connect | P0 | Moderated first-run task success and automated route tests |
| First success | Success is treated as Vault creation | An empty Vault does not prove the user can accomplish the core job | First success is a saved Login that the user can find and copy or reveal | P1 | Onboarding funnel task test |
| Browser cryptography | `DemoKernel` silently passes plaintext through when WASM fails | The primary confidentiality promise can be false without a visible failure | Release builds load only the reviewed WASM kernel and fail closed | P0 | Known-plaintext network test and missing-WASM rejection test |
| Recovery | Recovery-looking text is generated and syntax-checked but is not tied to the key that encrypted existing records | A user can believe data is recoverable when it is not | Recovery Key unwraps the same Vault Key and is proven on a non-empty Vault in a clean environment | P0 | Destructive clean-state recovery E2E |
| Empty Vault unlock | Missing records/verifier can cause any password to be accepted | Wrong passwords appear valid and can create divergent metadata | A required encrypted key-confirmation record makes wrong credentials fail even for an empty Vault | P0 | Empty-Vault wrong-password matrix |
| Master Password change | Re-encryption and salt metadata can diverge; rollback is best effort | Records can become unreadable or disappear | Password change atomically rewraps the stable Vault Key; it does not re-encrypt every item | P0 | Fault-injected rotation tests across every commit boundary |
| Vault Key rotation | Mixed with password change semantics | High-risk full re-encryption has no durable transaction model | Vault Key rotation is separate, staged, resumable, backed up, and generation-aware | P1 | Interrupted rotation and rollback suite |
| Multi-vault storage | Server primary key is effectively `record_id`; verifier ID is fixed; clients filter returned records | Cross-vault collision and disclosure boundaries are not enforced by storage | Every read/write is scoped by authenticated principal, Vault ID, and record ID | P0 | Cross-Vault isolation and collision tests |
| Batch import | API loops over individual writes despite atomic wording | Partial imports can remain after failure | Import validates into staging and commits all-or-nothing | P0 | Fault injection at every row and commit boundary |
| Backup | Backup tooling moves opaque records but the restore drill does not destroy, restore fresh, or verify application behavior | A printed PASS is not recovery evidence | Versioned encrypted backup with integrity metadata and a true clean-target restore drill | P0 | Destructive restore plus post-restore CRUD |
| Plaintext export | CSV export is near ordinary settings and warnings are easy to miss | Users can leave all secrets unencrypted on disk | Encrypted Backup is the default; Plaintext Export is separate, re-authenticated, and strongly warned | P0 | UX review and filesystem artifact tests |
| Offline claim | PWA and guides imply offline vault access without a precise durability or conflict contract | Users may assume unsynced changes and cached secrets are safe | Desktop Local is offline by design; connected Web documents only tested offline behavior | P1 | Offline, reconnect, conflict, and data-loss E2E |
| Dashboard | Empty state says only to create an item; navigation includes icon-only actions and technical metadata | Users do not know the next safe task or what controls do | Guided checklist, named controls, stable Vault identity, clear search scope, and Help entry | P1 | New-user usability and accessibility test |
| Item form | Template abbreviations and technical fields such as raw Base32 TOTP are exposed immediately | Users must understand internal terms before saving a Login | Login starts with Name, Username, Password, Website; advanced fields are progressive | P1 | Form comprehension and completion test |
| Settings | Preferences, recovery, export, crypto internals, and destructive actions share one drawer | Risk and ownership are unclear | General, Security, Data & Backup, Connected Vault, Diagnostics, and About sections | P1 | Information-architecture card sort and task tests |
| Error behavior | Toasts and internal errors do not consistently state impact or next action | Users cannot tell whether data was saved or how to recover safely | Errors state what happened, whether data changed, what the user can do, and a copyable error ID | P0 | Error-state catalog and screen-reader test |
| Mobile Web | At 390 px the search field clips and category navigation overflows | PWA/iOS claims are unsupported | Responsive Web passes reflow and core-task tests before any mobile support claim | P1 | Real Safari/Chromium narrow-viewport matrix |
| Accessibility | Some controls are icon-only; manual assistive-technology evidence is absent | Automated checks cannot establish WCAG conformance | WCAG 2.2 AA, with manual keyboard, VoiceOver, and Narrator/NVDA evidence | P1 | Automated plus manual accessibility report |
| Repository ownership | Product, experiments, evidence, deployment, tests, and tools cross existing folder boundaries | Contributors cannot infer ownership or release impact | `apps`, `services`, `packages`, `deploy`, `tests`, `tools`, `assets`, and audience-based `docs` | P1 | Layout manifest and CODEOWNERS checks |
| Experiments | CI validates `m0-desktop` while the shipping Tauri app is elsewhere | A green check does not test the released desktop product | Experiments are archived outside `apps`; shipping desktop is blocking CI | P0 | CI job inventory check |
| Build hygiene | Local ignored output is about 5.6 GB; `clean` omits the largest desktop target | The checkout looks disorganized and consumes uncontrolled disk | All transient output lives under ignored `.build`; `clean-all` returns to a bounded clean state | P1 | Fresh-clone and clean-all disk/status checks |
| Runtime data | An unowned root `password/` directory exists and `make backup` can write `snapshot.json` at the root | User and test data can contaminate the source tree | Development runtime data uses ignored `.local`; production/user data is outside the checkout | P0 | Root allowlist and doctor check |
| WASM generation | Three paths are claimed or used, including a nonexistent path | Generated security artifacts have no single owner | One generator, one input set, one output path, reproducible `--check` mode | P1 | Fresh-clone regeneration with zero diff |
| Contract generation | Duplicate Rust projections refer to a missing generator; TypeScript output is claimed but not present | Contracts are not reproducible or traceable to consumers | One generator manifest records input, output, consumer, version, and digest | P0 | Generation and consumer compatibility tests |
| Scripts | Lint, E2E, smoke, release, deployment, and restore drill share one directory | No single owner or dependency boundary exists | Move each task to `tools`, `tests`, or `deploy` by responsibility | P1 | Layout manifest |
| Engineering language | Non-English appears in backend Rust, generic E2E, source registries, and README badges | The requested English-only development boundary is not enforced | English everywhere except locale values and dedicated i18n fixtures | P0 | Script-aware language guard and AST string guard |
| API localization | Backend source embeds multiple translated messages | API behavior, source language, and user copy are coupled | API returns stable English ASCII codes and parameters; clients localize | P1 | Contract and catalog tests |
| Documentation truth | Readmes claim recovery, atomic import, offline access, MSI, and support states not proven end to end | Public guidance can cause unsafe decisions | Every public claim maps to a feature status and evidence ID | P0 | Claim-to-evidence checker and security approval |
| Documentation structure | Eight READMEs exist, but responsibilities overlap and code paths are stale | Passing link checks does not prove accuracy | Root landing page, docs home, audience guides, and component READMEs have explicit scopes | P1 | Documentation inventory, command, path, and version checks |
| Open-source status | License is PolyForm Noncommercial | Source-visible software that prohibits commercial use is not OSI open source | Adopt an OSI-approved license before using the term open source | P0 | License approval and automated identifier check |
| Versioning | Kernel/backend are `1.0.0`, desktop/release are `0.0.1`, and tags move backward | Users and updaters cannot reason about compatibility | One monotonic product version authority drives every artifact and manifest | P0 | Version consistency and monotonicity guard |
| macOS package | Universal DMG exists but is unsigned and not notarized | Gatekeeper warnings are not an acceptable stable install path | Signed, hardened, notarized, stapled universal DMG tested natively on Intel and ARM | P0 | Final-asset install on both native hosts |
| Windows AMD64 package | x64 EXE exists but is unsigned; MSI is claimed but absent | SmartScreen warnings and documentation mismatch | Signed native AMD64 MSI, with optional proven-native EXE | P0 | Final-asset clean install/upgrade/uninstall |
| Windows ARM64 package | No artifact exists | ARM Windows is unsupported | Signed ARM64 MSI/MSIX or native ARM64 bootstrapper; stock x86 NSIS is forbidden | P0 | PE/MSI architecture inspection and native launch |
| Native architecture validation | Current Apple Silicon Mac cannot natively run Intel macOS or AMD64 Windows guests | Local emulation would violate the explicit no-compatibility requirement | Use four explicit native CI hosts; use leased native hosts where manual validation is required | P0 | Recorded OS/CPU assertions and no-translation proof |
| Release integrity | No complete checksums, SBOM, provenance, signing, or updater evidence bundle | Users cannot verify origin or contents | Every release publishes and verifies all supply-chain evidence | P0 | Release-evidence manifest gate |
| Web production routing | TLS gateway routes `/` to API while Web is loopback-only | Public HTTPS does not deliver the claimed product | One reviewed origin serves UI and routes only `/api/` to API | P0 | Real-domain TLS browser E2E |
| Connected authentication | A deployment token lacks a complete secure provisioning path to the client | Public self-hosting is not usable or supportable | Scoped pairing/session model with rotation, revocation, and secure client storage | P0 | Provision, rotate, revoke, expire, and cross-Vault tests |
| Desktop CSP | Tauri CSP is effectively absent | A compromised frontend or injected content has excessive capability | Desktop-specific fail-closed CSP with narrow WASM permission if required | P0 | Runtime CSP violation and capability tests |
| Browser security headers | Contract and nginx behavior drift | A policy file is not enforcement | Header contract is generated/tested against real HTTPS responses | P0 | External response-header test |
| Database operations | Validation is weak; pool/TLS policy is incomplete; restore conflict semantics are unclear | Corruption and operational failure paths are not bounded | Strict validation, bounded pool, reviewed TLS modes, migrations, and exact restore results | P1 | PostgreSQL integration and fault tests |
| Browser E2E | Comprehensive suite is explicitly non-blocking | Regressions can ship with green CI | Critical browser and desktop journeys are blocking | P0 | No shell success bypass, skip, quarantine, or ignored critical case |
| Release channel | Preview release is marked Latest rather than prerelease | Users receive the wrong stability signal | Channel policy is enforced from quality-gate state | P0 | GitHub Release API assertion |

## 4. Product definition

### 4.1 Product promise

Veyora stores passwords, secure notes, API tokens, SSH credentials, and identity details in an encrypted Vault. Encryption and decryption occur on the user's device. A connected service stores encrypted records and limited operational metadata, not plaintext fields or Vault keys.

That promise is conditional on an uncompromised client, operating system, distribution channel, and security kernel. Documentation MUST state those trust boundaries plainly and MUST NOT use absolute phrases such as "cannot read under any circumstances."

### 4.2 Product modes

| Mode | Primary user | Data location | Network requirement | Authentication | Default status |
| --- | --- | --- | --- | --- | --- |
| Desktop Local Vault | Individual | User-selected local application data plus optional encrypted backups | None after installation | Master Password unlocks local Vault | Default and recommended |
| Desktop Connected Vault | Individual self-hoster | Encrypted local cache plus owner-operated service | Required for sync; documented offline behavior | Connection credential for service; Master Password for Vault | Advanced |
| Web Connected Vault | Individual self-hoster | Owner-operated service plus bounded browser cache | Required except explicitly tested read-only/offline states | Paired web session for service; Master Password for Vault | Advanced |

The Web client MUST NOT silently create an unexplained local-only Vault. If no server session exists, it shows a connection or sign-in state before Vault creation or unlock.

### 4.3 Personas

| Persona | Need | Primary success criterion | Product mode |
| --- | --- | --- | --- |
| Local Owner | Keep private information on one computer without running a server | Installs, creates, uses, backs up, restores, and updates a local Vault safely | Desktop Local |
| Self-hosting Owner | Control encrypted storage and use it from a browser or desktop | Deploys a reviewed HTTPS service, pairs a client, and verifies backup/restore | Connected |
| Evaluator | Understand whether Veyora is safe and suitable before trusting it | Finds honest status, limitations, audit state, license, and verified downloads | Public docs |
| Contributor | Change one area without breaking another | Understands ownership, setup, contracts, tests, language policy, and review gates | Repository |
| Operator | Run and recover the service | Has exact configuration, hardening, monitoring, upgrade, rollback, and restore procedures | Connected service |
| Security Reviewer | Verify claims and changes | Has threat model, crypto profile, vectors, evidence, and a private report channel | All modes |

### 4.4 Jobs to be done

1. When I receive or create a credential, I want to save it with a recognizable name so I can find it later.
2. When I need a credential, I want to search, reveal, or copy it quickly without exposing unrelated secrets.
3. When I leave the device, I want the Vault to lock and clipboard exposure to end predictably.
4. When I forget my Master Password, I want the product to tell me accurately whether and how I can recover existing data.
5. When a device fails, I want to restore a verified encrypted backup in an empty environment.
6. When I change my Master Password or update Veyora, I want all existing items to remain readable or the operation to roll back safely.
7. When I self-host, I want the server to be unable to read Vault contents and unable to cross one Vault boundary into another.
8. When I download an installer, I want to verify its publisher, integrity, architecture, and test status.

### 4.5 Product principles

1. **Fail closed.** Missing cryptography, invalid metadata, failed verification, or uncertain writes stop the operation.
2. **Explain before asking.** The UI gives purpose, consequence, and prerequisites before requesting a secret or destructive decision.
3. **One term, one meaning.** Create, Open, Connect, Sign in, Unlock, Lock, Close, Sign out, Reset, Recovery Key, Backup, and Export are never interchangeable.
4. **Local by default.** The simplest safe path does not require infrastructure knowledge.
5. **Progressive disclosure.** Common tasks use familiar language; technical detail remains available in diagnostics and documentation.
6. **Evidence before claims.** A capability is not Stable because code exists; it is Stable after end-to-end evidence on supported targets.
7. **Data survival before convenience.** Backup, recovery, migration, update, and rotation paths receive destructive tests before release.
8. **Native means native.** An emulated installer or translated process is never reported as native validation.
9. **English engineering, localized product.** Engineering artifacts stay English; users may choose supported application locales.
10. **No hidden trust.** Storage, network, build, browser, operating-system, and endpoint trust boundaries are documented.

## 5. Scope

### 5.1 In scope for the first stable release

- Desktop Local Vault on macOS Intel, macOS ARM64, Windows AMD64, and Windows ARM64.
- Connected Vault through desktop and Web against an owner-operated Veyora service.
- Login and Secure Note as fully polished primary item types.
- API Token, SSH Credential, and Identity as supported secondary item types after matching UX and export/import coverage.
- Search, favorites, tags, Trash, reveal, copy, password generation, TOTP, lock, auto-lock, and clear status feedback.
- Real Recovery Key architecture, encrypted portable backup, strongly gated plaintext export, and staged atomic import.
- PostgreSQL connected storage and SQLite local storage with the same Vault-scoping invariants.
- Signed, notarized, architecture-correct packages and signed updates.
- English canonical engineering and documentation language with application localization.
- Public open-source readiness after an OSI-approved license decision.

### 5.2 Explicitly out of scope for the first stable release

- Shared Vaults, teams, organizations, role-based sharing, or collaborative editing.
- Browser extension and automatic website filling.
- Native iOS or Android applications.
- Marketing the PWA as an iOS application replacement.
- Hardware-backed key guarantees.
- Server-assisted reset that can bypass user-held cryptographic material.
- Anonymous usage or traffic-analysis resistance.
- Protection against a fully compromised unlocked endpoint.
- Storing attachments unless a versioned attachment contract and complete backup/export coverage are separately approved.
- Import compatibility claims for a third-party password manager until its parser and loss report pass fixture-based tests.

### 5.3 Non-goals that MUST remain visible

Veyora is not an identity provider, cloud key escrow service, shared enterprise password manager, antivirus product, or defense against an attacker controlling the user's operating system. The service cannot guarantee availability or freshness against a malicious operator without additional mechanisms.

## 6. Terminology and state model

### 6.1 Canonical user terms

| Term | User-facing definition | Must not be confused with |
| --- | --- | --- |
| Vault | The encrypted container that holds a user's passwords and other private items | Account, database server, folder, or application |
| Item | One saved Login, Secure Note, API Token, SSH Credential, or Identity | Raw API record |
| Master Password | The user-chosen secret used to derive a key that unlocks the Vault Key | Service password, API token, Recovery Key |
| Vault Key | A random internal key that protects Vault data; it is not shown directly | Master Password or Recovery Key |
| Recovery Key | A high-entropy user-held secret that can recover the existing Vault Key without the old Master Password | 2FA recovery code, backup password, emergency information sheet |
| Encrypted Backup | A portable, versioned, integrity-protected copy that requires documented recovery material | Plaintext export or server snapshot |
| Plaintext Export | An unencrypted interoperability file whose contents are readable by any process with file access | Backup |
| Connection Credential | A revocable credential that authorizes one client to one service/Vault scope | Master Password |
| Open | Select or attach an existing local Vault container | Unlock, connect, sign in, import |
| Connect | Pair the application with an owner-operated Veyora service | Unlock |
| Sign in | Authenticate to a service when a real service identity/session exists | Unlock |
| Unlock | Use local cryptographic material to make a known Vault readable | Sign in |
| Lock | Remove active plaintext views and usable key material from the application session | Sign out, close, delete |
| Close Vault | Detach the current local Vault without deleting it | Lock or Reset |
| Sign out | End the connected service session while preserving the Vault according to the stated cache policy | Lock |
| Reset local app | Remove local settings, sessions, and caches after a destructive confirmation | Delete remote Vault |

### 6.2 Product state machine

The application MUST render state explicitly rather than infer it from the presence of arbitrary records.

```text
Launch
├── No product setup
│   └── Welcome
│       ├── Create a new local Vault
│       ├── Open an existing local Vault
│       ├── Import into a new local Vault
│       └── Advanced: connect to a self-hosted service
├── Known local Vault
│   ├── Locked
│   └── Unlocked
├── Connected client without session
│   └── Connect or Sign in
├── Connected session without selected Vault
│   └── Select, create, or pair a Vault
└── Known connected Vault
    ├── Locked and online
    ├── Locked and offline
    ├── Unlocked and synchronized
    ├── Unlocked with pending local changes
    └── Conflict requiring resolution
```

Unknown, corrupt, incompatible, or partially migrated metadata MUST produce a dedicated repair-safe error state. It MUST NOT be treated as a new empty Vault.

### 6.3 Vault identity

Every locked and unlocked screen MUST show the human-readable Vault name and a safe location summary. A location summary may show `On this Mac`, `On this Windows PC`, or the hostname of a connected service; it MUST NOT reveal a secret token, full database URL, or sensitive filesystem path by default.

## 7. Experience architecture

### 7.1 Primary navigation

After unlock, the desktop layout MUST expose:

1. Current Vault identity and synchronization/offline state.
2. Persistent search with an explicit scope.
3. `All items`, `Favorites`, item types, `Tags`, and `Trash`.
4. A named `New item` action.
5. A named or unambiguously labeled `Lock` action.
6. `Help` and `Settings` that remain discoverable without interpreting icons.

On narrow screens, functions may move into a menu, but no core action may disappear. Horizontal category overflow MUST use an accessible pattern with visible affordance; clipped text is a failure.

### 7.2 Settings information architecture

| Section | Contents |
| --- | --- |
| General | Theme, language, startup, default view, non-security preferences |
| Security | Auto-lock, clipboard timeout, change Master Password, Recovery Key status, session/device management |
| Data & Backup | Create encrypted backup, restore backup, import, plaintext export, Trash retention |
| Connected Vault | Service URL, connection state, device credential, sync state, revoke/sign out |
| Diagnostics | Health, version, storage location summary, safe logs, copyable error IDs, support bundle controls |
| About | Product version, license, acknowledgements, audit status, documentation links |

Cryptographic primitive names MAY appear in a technical details panel under About or Diagnostics. They MUST NOT replace plain-language security explanations.

### 7.3 Error model

Every error MUST belong to one category:

| Category | User presentation | Required fields |
| --- | --- | --- |
| Field error | Inline beside the field; summary when multiple errors exist | What is wrong, how to fix it |
| Credential error | Safe, non-enumerating message at unlock/sign-in | What can be checked, remaining safe actions |
| Conflict | Persistent conflict panel | Which item/state is affected, preserved versions, resolve/retry options |
| Storage/network failure | Banner or dedicated state, not disguised as field input failure | Whether data was saved, retry behavior, offline state |
| Corrupt/incompatible data | Blocking repair-safe state | Data not modified, supported recovery/export path, error ID |
| Internal failure | Plain summary plus collapsed diagnostics | Stable error ID, timestamp, copy action; no secrets or raw stack in primary UI |

Errors MUST preserve user input unless retaining it would itself reveal a secret after lock. Dynamic messages such as `Saved`, `Copied`, result counts, progress, and backup completion MUST be exposed to assistive technology as status messages.

## 8. Functional requirements

### 8.1 Welcome and onboarding

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `UX-ONB-001` | P0 | The first screen MUST state what Veyora does, what a Vault is, and whether the current mode is local or connected before requesting a password. | Copy review and 30-second comprehension study |
| `UX-ONB-002` | P0 | Desktop MUST offer `Create a new vault`, `Open an existing vault`, `Import from another password manager`, and `Advanced: connect to a self-hosted server`. | Route-level E2E for all actions |
| `UX-ONB-003` | P0 | Web without a service session MUST present Connect/Sign in before Vault create/unlock. | Fresh-browser E2E |
| `UX-ONB-004` | P0 | Create MUST explain storage location, password requirements, recovery consequences, and backup responsibility before commit. | Content and keyboard-flow test |
| `UX-ONB-005` | P0 | The Master Password field MUST allow paste, autofill where supported, spaces, Unicode, at least 64 characters, and a keyboard-accessible Show/Hide control. | Automated input matrix and manual accessibility test |
| `UX-ONB-006` | P0 | A single-factor Master Password MUST require at least 15 characters, MUST NOT impose composition rules, and SHOULD check a local compromised/common-password blocklist without sending the password. | Unit tests and threat-model approval |
| `UX-ONB-007` | P0 | Vault creation MUST generate a real Recovery Key, require a save action, and verify the saved material before onboarding can be marked complete. | Recovery ceremony E2E |
| `UX-ONB-008` | P1 | A dismissible `Start here` checklist MUST guide recovery verification, first Login/import, copy/reveal, lock, and backup. | State persistence and completion test |
| `UX-ONB-009` | P1 | The checklist MUST hide after completion and remain reopenable from Help. | UI state test |
| `UX-ONB-010` | P1 | First-success analytics in test builds MUST measure a saved Login followed by find and copy/reveal, not Vault creation. No Vault content may be collected. | Privacy review and test event inspection |

The password length baseline is a conservative offline-Vault requirement informed by [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html), which also supports paste, password managers, long inputs, and no composition rules. Its network-authentication scope MUST be acknowledged in the security model.

### 8.2 Unlock, lock, open, connect, and sign out

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `UX-AUTH-001` | P0 | Unlock MUST operate only on a known Vault identity with valid key-confirmation metadata. | Empty, non-empty, missing, and corrupt metadata matrix |
| `UX-AUTH-002` | P0 | A wrong Master Password MUST fail for empty and non-empty Vaults without modifying metadata or records. | Byte/digest comparison after failed attempts |
| `UX-AUTH-003` | P0 | Repeated failures MUST apply a local delay without deleting data or revealing whether a remote identity exists. | Timing and error-copy test |
| `UX-AUTH-004` | P0 | Lock MUST clear visible plaintext, close item views, cancel sensitive operations, and invalidate the active key handle. | UI, memory-boundary, and API tests |
| `UX-AUTH-005` | P1 | Auto-lock MUST cover inactivity, sleep, session lock, and configurable app background events with documented platform differences. | Four-platform event matrix |
| `UX-AUTH-006` | P1 | Close Vault, Sign out, Reset local app, Delete remote Vault, and Purge local data MUST be separate actions with separate consequences. | Information architecture and destructive action tests |
| `UX-AUTH-007` | P0 | Connected authentication MUST use a revocable scoped connection credential that is separate from the Master Password. | Provision/rotate/revoke/expire suite |
| `UX-AUTH-008` | P0 | Desktop connection credentials MUST use the operating-system credential store. Web sessions MUST use reviewed secure session storage and MUST NOT put a long-lived bearer token in local storage. | Platform storage inspection and browser security test |

### 8.3 Item management

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `ITEM-001` | P0 | `Login` and `Secure Note` MUST be complete primary item types. API Token, SSH Credential, and Identity MUST NOT be marked Stable until each passes backup, import/export, search, edit, and accessibility coverage. | Feature-status registry |
| `ITEM-002` | P1 | The Login form MUST initially show Name, Username, Password, and Website. Notes, TOTP, tags, and custom fields belong under `More fields`. | Form task study |
| `ITEM-003` | P1 | Name guidance MUST use an example such as `GitHub - Work` and explain that the name is for recognition. | Copy review |
| `ITEM-004` | P0 | Password fields MUST expose named Generate, Show/Hide, and Copy actions adjacent to the field. | Keyboard and screen-reader test |
| `ITEM-005` | P1 | TOTP MUST accept a valid `otpauth://` URI and Base32 secret, explain the source, normalize safe whitespace, and reject malformed input without discarding the form. | RFC fixtures and UX test |
| `ITEM-006` | P0 | Save MUST be idempotent at the client boundary and report whether the item was persisted locally, synchronized remotely, pending, or conflicted. | Retry and network-fault E2E |
| `ITEM-007` | P1 | Successful save MUST present clear next actions: return to Vault, copy a field, or add another item. | UI test |
| `ITEM-008` | P0 | Delete MUST move an item to Trash and provide Undo. Permanent deletion requires a concrete confirmation that names the item count and irreversibility. | Trash and purge tests |
| `ITEM-009` | P1 | Trash retention MUST be an explicit product setting/policy; the default for local Vaults is 30 days unless the user purges earlier. | Time-control tests |
| `ITEM-010` | P0 | Reveal and Copy MUST require an unlocked Vault and MUST close or invalidate immediately on lock. | Lock-during-action test |

### 8.4 Search, navigation, and organization

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `NAV-001` | P1 | Unlock MUST open `All items` and always show the current Vault name. | Desktop/web E2E |
| `NAV-002` | P1 | Search MUST show scope in its label or placeholder, such as `Search all items`. | UI and accessibility test |
| `NAV-003` | P1 | Active type, tag, favorite, Trash, and text filters MUST be visible and individually removable. | Filter-state tests |
| `NAV-004` | P1 | The empty Vault state MUST say `Your vault is empty` and offer `Add your first login` plus `Import items`. | Fresh-Vault screenshot and task test |
| `NAV-005` | P1 | No-results state MUST show the query and scope, with `Clear search` and `Search all items`. | Search E2E |
| `NAV-006` | P1 | Search MUST cover the documented fields only and MUST NOT send plaintext query terms to the service. | Network inspection and unit tests |
| `NAV-007` | P1 | Keyboard selection and shortcuts MUST never fire while focus is in an incompatible field and MUST be documented in an in-app shortcuts dialog. | Keyboard regression suite |

### 8.5 Recovery

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `REC-001` | P0 | Recovery MUST use an independent high-entropy Recovery Key to unwrap the existing Vault Key. Syntax-only tokens are forbidden. | Cryptographic vectors and clean-state E2E |
| `REC-002` | P0 | Recovery MUST work on a non-empty Vault after the old Master Password and all prior local application state are removed. | Destructive recovery test |
| `REC-003` | P0 | Successful recovery MUST preserve every item ID, revision, field value, tag, TOTP seed, Trash state, and supported metadata byte-for-byte after decryption/normalization rules. | Fixture manifest comparison |
| `REC-004` | P0 | Wrong, altered, truncated, other-Vault, and obsolete Recovery Keys MUST fail without changing the destination. | Negative recovery corpus |
| `REC-005` | P0 | Recovery MUST require setting a new Master Password and atomically replacing the password wrapper only after the existing Vault Key and verifier are proven. | Transaction fault tests |
| `REC-006` | P1 | Regenerating a Recovery Key MUST invalidate the old recovery wrapper, require re-authentication, create a verified backup, and present the revocation consequence. | Key regeneration suite |
| `REC-007` | P0 | Documentation MUST use `Recovery Key` only for this mechanism. 2FA recovery and backup passwords MUST use distinct names. | Terminology lint and docs review |

### 8.6 Backup, restore, import, and export

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `BAK-001` | P0 | Veyora MUST define a versioned portable encrypted backup envelope with format version, Vault identity, key-wrapper metadata, item/tombstone data, compatibility metadata, and authenticated integrity. | Schema, vectors, and parser tests |
| `BAK-002` | P0 | Backup creation MUST write to a temporary path, flush, verify, and atomically rename; an interrupted backup MUST NOT replace a valid older backup. | Power-loss/fault injection |
| `BAK-003` | P0 | Backup UI MUST state `Encrypted`, required recovery material, portability scope, creation time, item count, and verification status. | UX and file-inspection test |
| `BAK-004` | P0 | Restore MUST validate the entire backup before destination mutation and MUST support restore into a fresh isolated target. | Destructive restore drill |
| `BAK-005` | P0 | Restore results MUST report actual inserted, replaced, skipped, conflicted, and failed counts; input row count is not a success count. | Integration assertions |
| `BAK-006` | P0 | A restore drill MUST delete or detach the test primary, restore into empty storage, unlock through the documented ceremony, compare the fixture manifest, and perform create/edit/delete afterward. | Blocking CI/scheduled evidence |
| `IMP-001` | P0 | Import MUST parse and validate the entire source, display a loss/field mapping report, stage encrypted items, and commit atomically. | Malformed-row and injected-failure suite |
| `IMP-002` | P1 | Generic CSV import MUST document exact encoding, delimiter, header, multiline, escaping, duplicate, and unsupported-field behavior. | Fixture corpus |
| `IMP-003` | P1 | Third-party importers MUST be named by source/version and MUST emit a loss report before commit. | Source-specific fixtures |
| `EXP-001` | P0 | `Create encrypted backup` and `Export plaintext data` MUST be separate top-level Data & Backup actions. | Navigation test |
| `EXP-002` | P0 | Plaintext export MUST require Master Password re-authentication and an unskippable warning that any reader of the file can see all exported secrets. | Re-auth and warning test |
| `EXP-003` | P0 | The export completion view MUST say `Not encrypted`, list the path and omitted fields, offer `Show in folder`, and provide safe deletion guidance. | UI and filesystem test |
| `EXP-004` | P1 | Plaintext export MUST use a temporary file plus atomic finalization and MUST delete partial files on failure. | Fault injection |

Official password-manager guidance consistently distinguishes encrypted backup from plaintext export and warns that plaintext files are directly readable. See [Bitwarden export guidance](https://bitwarden.com/help/export-your-data/), [Bitwarden encrypted exports](https://bitwarden.com/help/encrypted-export/), and [1Password export guidance](https://support.1password.com/export/).

### 8.7 Help and diagnostics

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `HELP-001` | P1 | Help MUST be reachable from Welcome, Locked, and Unlocked states. | Route test |
| `HELP-002` | P1 | Help MUST route users by task: get started, understand recovery, create backup, restore, connect, troubleshoot, and report a security issue. | Content inventory |
| `DIAG-001` | P1 | Diagnostics MUST show product version, build commit, mode, safe storage summary, service health, last sync, and last verified backup without exposing secrets. | Snapshot/redaction test |
| `DIAG-002` | P1 | Support bundles MUST be opt-in, previewable, redacted, and excluded from automatic upload. | Secret canary tests |
| `DIAG-003` | P1 | Every operational error MUST have a stable English ASCII error code that is searchable in English documentation. | Error catalog completeness |

## 9. Security and key architecture

### 9.1 Security objectives

Veyora MUST:

1. Keep plaintext item fields, Master Password material, Vault Keys, and item keys inside an authorized client process.
2. Detect modification of encrypted item content and security-critical metadata.
3. Enforce Vault and principal isolation in storage and authorization, not through client filtering.
4. Make wrong credentials, corrupt metadata, missing cryptography, replayed writes, and incompatible formats fail closed.
5. Preserve recoverability through tested key wrapping, backup, restore, change-password, migration, and update lifecycles.
6. Minimize and document metadata visible to a connected service.
7. Protect the build and delivery path with signing, provenance, review, and native release tests.

Veyora does not protect an unlocked Vault from a fully compromised endpoint, malicious accessibility tool, keylogger, screen capture, injected build, or process with equivalent privilege. Public copy MUST state this limitation without implying the server can therefore read data.

### 9.2 Target key hierarchy

The exact binary format requires a security ADR and independent review, but the functional relationship is mandatory:

```text
Master Password
    └── Argon2id(password, password-wrapper salt and version)
        └── Password KEK
            └── authenticated unwrap ──┐
                                      ├── Vault Key (random 256-bit)
Recovery Key                          │
    └── recovery KDF/version          │
        └── Recovery KEK              │
            └── authenticated unwrap ─┘

Vault Key + domain-separated context
    ├── item encryption keys
    ├── metadata/manifest authentication keys
    ├── backup wrapping or derivation context
    └── key-confirmation material
```

The Master Password and Recovery Key wrap the same Vault Key independently. Changing the Master Password replaces only the password-derived wrapper. Recovery proves the existing Vault Key before replacing that wrapper. Full Vault Key rotation is a separate operation.

### 9.3 Cryptographic requirements

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `SEC-CRYPTO-001` | P0 | The release client MUST use only the reviewed Rust security kernel for cryptographic operations. | Build dependency and runtime identity check |
| `SEC-CRYPTO-002` | P0 | Any failure to fetch, instantiate, validate, or self-test the kernel MUST block create, unlock, recover, import, export, and item writes. | Missing/corrupt/WASM-policy matrix |
| `SEC-CRYPTO-003` | P0 | Demonstration kernels MUST live only in non-release test fixtures and MUST be impossible to enable by runtime fallback or public configuration. | Release artifact scan |
| `SEC-CRYPTO-004` | P0 | Vault Keys MUST be generated with the operating-system cryptographic random source and MUST never be derived directly from a human password. | Code review and deterministic interface tests |
| `SEC-CRYPTO-005` | P0 | Password and Recovery wrappers MUST bind Vault ID, format version, algorithm suite, and wrapper purpose as authenticated context. | Known-answer and substitution tests |
| `SEC-CRYPTO-006` | P0 | Item encryption MUST bind principal/Vault ID, item ID, item type, schema version, and key generation as authenticated context where applicable. | Cross-context replay vectors |
| `SEC-CRYPTO-007` | P0 | Nonce generation and reuse prevention MUST be defined per algorithm and covered by property/fuzz tests. | Nonce corpus and invariant tests |
| `SEC-CRYPTO-008` | P0 | Kernel inputs MUST be bounded, versioned, and reject unknown mandatory fields or unsupported suites. | Parser fuzzing and version tests |
| `SEC-CRYPTO-009` | P0 | The client MUST validate a signed/digested kernel asset against the release manifest before allowing Vault operations where the platform permits. | Tamper test |
| `SEC-CRYPTO-010` | P1 | Cryptographic vectors MUST execute against native, WASM, and every supported FFI target and prove target parity. | Blocking target-parity suite |
| `SEC-CRYPTO-011` | P1 | Security-sensitive dependency updates, primitive changes, format changes, KDF changes, and unsafe-code additions MUST require a security owner review. | CODEOWNERS and policy check |
| `SEC-CRYPTO-012` | P1 | Cryptographic claims MUST distinguish design, implementation, automated verification, independent review, and external audit status. | Claim registry |

### 9.4 Password change and Vault Key rotation

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `SEC-KEY-001` | P0 | Change Master Password MUST verify the current wrapper, derive a new KEK with fresh parameters/salt, wrap the unchanged Vault Key, validate the new wrapper, and commit metadata atomically. | Unit/integration fault matrix |
| `SEC-KEY-002` | P0 | A failed password change MUST leave the old Master Password and every item usable; no mixed wrapper state is allowed. | Crash at every write boundary |
| `SEC-KEY-003` | P0 | After success, the new Master Password MUST unlock every item, the old Master Password MUST fail, and the Recovery Key MUST still recover unless explicitly regenerated. | Full-Vault regression |
| `SEC-KEY-004` | P1 | Vault Key rotation MUST create and verify a portable encrypted backup before mutation. | Precondition test |
| `SEC-KEY-005` | P1 | Rotation MUST use explicit old/new key generations, durable progress, idempotent resume, and a final atomic generation switch. | Crash/restart matrix |
| `SEC-KEY-006` | P1 | Rotation MUST never depend on best-effort reverse writes to reconstruct the old state. | Design review and injected failure tests |

### 9.5 Key material, memory, and clipboard honesty

Rust zeroization cannot prove that browser JavaScript strings, DOM nodes, WebView internals, screenshots, swap, or clipboard history are erased. Veyora MUST document the boundary accurately.

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `SEC-MEM-001` | P0 | UI and docs MUST NOT claim complete memory zeroization or that secrets never linger in the clipboard. | Claim lint |
| `SEC-MEM-002` | P1 | Native kernel buffers that support zeroization MUST be zeroized on drop/lock, with tests that verify the intended code path. | Kernel tests and review |
| `SEC-MEM-003` | P1 | Lock MUST remove plaintext from DOM state, close dialogs, revoke object URLs, clear internal caches, and reload the sensitive renderer if that is the only reliable boundary. | Runtime inspection |
| `SEC-CLIP-001` | P0 | Copy MUST show the configured clearing time and attempt to clear only if the clipboard still contains the value Veyora wrote. | Clipboard race tests |
| `SEC-CLIP-002` | P1 | Clipboard behavior and limitations MUST be tested and documented separately for the four native targets and supported browsers. | Platform matrix |
| `SEC-CLIP-003` | P1 | Clipboard timeout MUST use a safe default of 30 seconds and allow a bounded user choice. | Settings tests |

### 9.6 Application and Web security

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `SEC-WEB-001` | P0 | Web responses MUST use a tested CSP with explicit sources, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors`, and constrained connection/form destinations. | Real HTTPS header test |
| `SEC-WEB-002` | P0 | JavaScript `unsafe-eval` MUST be forbidden. Narrow `wasm-unsafe-eval` MAY be used only if required, documented, and tested on every supported browser/WebView. | CSP violation tests |
| `SEC-WEB-003` | P0 | HSTS MUST be enabled only on the reviewed HTTPS origin, with `nosniff`, strict Referrer Policy, and deny-by-default Permissions Policy. | External response scan |
| `SEC-WEB-004` | P0 | Desktop Tauri MUST use its own explicit CSP and capability allowlist; it MUST NOT copy a Web header profile blindly or use `csp: null`. | Desktop runtime security test |
| `SEC-WEB-005` | P0 | Web and desktop frontend code MUST avoid remote scripts, remote fonts, inline dynamic script construction, and unreviewed navigation. | Artifact and runtime scan |
| `SEC-WEB-006` | P0 | Sensitive responses and static app assets MUST use reviewed cache policies; service workers MUST not cache plaintext API responses. | Cache inspection |
| `SEC-WEB-007` | P1 | Production Web security controls SHOULD be mapped to versioned [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) requirements and tested with a balanced manual/automated method. | ASVS verification record |

The CSP distinction between JavaScript evaluation and WebAssembly compilation follows [W3C CSP Level 3](https://www.w3.org/TR/CSP/) and [Tauri CSP guidance](https://v2.tauri.app/security/csp/).

### 9.7 Security assurance

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `SEC-ASSURE-001` | P0 | Threat model, plaintext/metadata inventory, cryptographic profile, recovery design, update trust, and deployment trust MUST match the shipped release. | Security review sign-off |
| `SEC-ASSURE-002` | P0 | A private vulnerability-report channel with response targets and supported versions MUST exist before public beta. | End-to-end report test |
| `SEC-ASSURE-003` | P1 | Dependencies, containers, actions, licenses, and secrets MUST be scanned in CI; findings above the approved threshold block release. | CI evidence |
| `SEC-ASSURE-004` | P1 | GitHub Actions MUST be pinned to full immutable commit SHAs in release workflows. | Workflow policy check |
| `SEC-ASSURE-005` | P1 | The security kernel and parsing boundaries MUST have fuzz targets with retained regression inputs. | Scheduled fuzz evidence |
| `SEC-ASSURE-006` | P0 | A stable release MUST NOT claim independent audit until the published audit scope, version/commit, date, and unresolved findings are available. | Claim registry |

## 10. Data model, storage, and API

### 10.1 Logical entities

| Entity | Required identity | Sensitive content | Server visibility |
| --- | --- | --- | --- |
| Principal | `principal_id` | Connection identity/credential material | Identifier and auth metadata only |
| Vault | `(principal_id, vault_id)` | Wrapped Vault Key metadata, settings, verifier | Versioned opaque wrappers plus bounded metadata |
| Device/Session | `(principal_id, device_id/session_id)` | Revocable connection secret | Scope, expiry, revocation state |
| Item | `(principal_id, vault_id, item_id)` | Encrypted item envelope | Ciphertext, revision, tombstone, bounded sync metadata |
| Backup | Backup ID and source Vault ID | Encrypted portable envelope | File/object metadata unless user stores it remotely |
| Audit event | Stable event ID | Never item content, secrets, or search terms | Security/operation metadata only |

### 10.2 Storage invariants

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `DATA-001` | P0 | Database primary and unique keys MUST include principal and Vault scope wherever records can collide or cross a boundary. | Schema inspection and collision tests |
| `DATA-002` | P0 | The server MUST query by authenticated Vault scope; returning all records and filtering client-side is forbidden. | Query instrumentation and authorization tests |
| `DATA-003` | P0 | Verifier/key-confirmation identity MUST be scoped per Vault and MUST NOT use one global fixed record ID. | Two-Vault empty/non-empty tests |
| `DATA-004` | P0 | Every write MUST validate identity consistency among route, authenticated scope, envelope context, and body. | Mismatch corpus |
| `DATA-005` | P0 | Compare-and-set revision semantics MUST be server authoritative, transactionally enforced, and return the preserved competing revision on conflict without plaintext. | Concurrency tests |
| `DATA-006` | P1 | List APIs MUST be paginated and bounded; `embed all bodies` behavior MUST have a strict maximum or be removed. | Load and limit tests |
| `DATA-007` | P0 | Batch endpoints MUST use one database transaction or an explicit staged commit protocol with documented rollback. | Fault injection |
| `DATA-008` | P1 | Tombstones MUST retain only the data required by the documented Trash/restore/retention contract and be purged consistently. | Time and purge tests |
| `DATA-009` | P0 | Destructive Reset MUST distinguish local metadata, local Vault, connected cache, and remote Vault; no action may silently leave an inaccessible orphan or delete another scope. | Reset matrix |
| `DATA-010` | P1 | SQLite and PostgreSQL adapters MUST pass the same behavioral contract suite. | Adapter parity tests |

### 10.3 Migration and compatibility

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `MIG-001` | P0 | Every persisted and wire format MUST have an explicit version and compatibility policy. | Contract inventory |
| `MIG-002` | P0 | Database migrations MUST be ordered, transactional where supported, idempotent, and tested from every supported release. | N-2/N-1 to N matrix |
| `MIG-003` | P0 | Client Vault/backup migration MUST preserve a verified pre-migration backup and refuse unsupported future versions without mutation. | Compatibility corpus |
| `MIG-004` | P0 | Failed migration MUST leave an unlockable old state or complete rollback; mixed schemas are forbidden. | Crash injection |
| `MIG-005` | P1 | Breaking contract changes require a major contract version, explicit consumer migration, deprecation window, and release note. | Contract policy check |
| `MIG-006` | P1 | The supported rollback policy MUST state when binaries may roll back without rolling back data. | Upgrade/rollback tests |

### 10.4 API requirements

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `API-001` | P0 | All Vault endpoints MUST derive principal and Vault scope from reviewed authentication/session context, not untrusted query parameters alone. | Authorization test matrix |
| `API-002` | P0 | A global browser bearer token is forbidden for stable connected mode. Credentials MUST be scoped, rotatable, revocable, expiring where appropriate, and rate-limited. | Lifecycle E2E |
| `API-003` | P0 | CORS MUST allow only reviewed origins, methods, and headers, and credentials behavior MUST match the session design. Wildcards are forbidden with credentials. | Browser preflight suite |
| `API-004` | P0 | API errors MUST return stable English ASCII code, safe parameter map, request ID, and appropriate HTTP status. Localized prose is a client concern. | OpenAPI/error contract tests |
| `API-005` | P0 | Request bodies, item counts, field lengths, decompression, nesting, pagination, and timeouts MUST be bounded from one contract source. | Boundary and abuse tests |
| `API-006` | P1 | Health MUST mean process alive; readiness MUST include required storage/migration dependencies; neither may expose secrets. | Dependency-failure tests |
| `API-007` | P1 | Metrics MUST not include Vault IDs, item IDs, filenames, search terms, item types per user, ciphertext, credentials, or unbounded high-cardinality labels. | Canary/redaction tests |
| `API-008` | P1 | OpenAPI and runtime routes MUST be generated or checked bidirectionally so undocumented or missing operations fail CI. | Route/schema diff |
| `API-009` | P1 | Retries for mutation MUST use idempotency or revision semantics and MUST NOT create duplicate items. | Timeout/retry tests |
| `API-010` | P1 | The service MUST return precise batch/restore counts and MUST NOT report requested count as committed count. | Integration assertions |

### 10.5 Database and persistence operations

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `DB-001` | P0 | PostgreSQL integration tests MUST run in blocking CI; ignored database tests do not count as support evidence. | CI job |
| `DB-002` | P1 | Connection pool minimum, maximum, acquisition timeout, statement timeout, idle timeout, and shutdown behavior MUST be explicit and bounded. | Configuration tests |
| `DB-003` | P1 | Remote database TLS mode and certificate validation MUST be configurable and MUST default safely for non-local deployments. | TLS integration matrix |
| `DB-004` | P1 | Migrator, API, worker, backup, and restore MUST use least-privilege roles appropriate to their operations. | Role-denial tests |
| `DB-005` | P0 | Restore into a non-empty destination MUST use an explicit reject, merge, or replace policy; silent conflict ignore is forbidden. | Policy matrix |
| `DB-006` | P1 | Backup/restore serialization MUST use a versioned parser/serializer, not manually concatenated JSON. | Parser round-trip and fuzz tests |
| `DB-007` | P1 | Validation MUST reject malformed IDs, revisions, timestamps, tombstones, envelopes, and incompatible versions before persistence. | Negative corpus |

## 11. Engineering language policy

### 11.1 Hard rule

English is the only canonical engineering language. This applies to all repository-controlled material, including:

- Directory names and filenames.
- Source code, identifiers, comments, doc comments, and inline examples.
- Test names, test descriptions, ordinary fixtures, selectors, snapshots, and failure messages.
- Logs, metrics, trace names, error codes, command output, and diagnostics.
- Configuration descriptions, schemas, contracts, API descriptions, migration comments, and generated-code headers.
- Root and component READMEs, user/developer/operator/security/legal documents, ADRs, changelogs, and release notes.
- Pull-request templates, issue templates, commit messages produced by maintainers, branch naming guidance, and workflow labels.
- Brand source text and screenshots used in engineering documentation.

The application may be localized for users, but localization does not change the engineering language.

### 11.2 Only allowed non-English locations

Non-English natural-language text MAY exist only as:

1. Translation **values** under `apps/*/locales/**` or the approved shared locale package.
2. Dedicated localization samples under `tests/fixtures/i18n/**`.

Locale keys, field names, variable names, comments, schema descriptions, fixture filenames, and test names MUST remain English. A locale's native display name MAY be stored as a translation value or localization manifest value because it is user-facing localization metadata.

Protocol tests that need arbitrary Unicode SHOULD use escaped code points or generated bytes unless the purpose is specifically localization rendering. Public README language links MUST use English language names in the canonical README.

### 11.3 Language requirements

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `LANG-001` | P0 | Repository-controlled natural language outside the two allowlisted localization areas MUST be English. | Script-aware repository scan |
| `LANG-002` | P0 | Paths and engineering identifiers MUST be ASCII English. Top-level and ordinary file paths MUST use lowercase kebab-case except language/tool conventions. | Path lint |
| `LANG-003` | P0 | API source MUST NOT embed translated prose. It returns stable error codes and parameters; the client locale catalog renders prose. | AST/source scan and API contract tests |
| `LANG-004` | P0 | Business E2E selectors MUST use stable roles, accessible names in the active locale through a helper, or `data-testid`; generic flows MUST NOT contain multilingual text alternations. | Source lint |
| `LANG-005` | P1 | Canonical `en.json` is the source locale. Every shipped locale MUST have 100% key, placeholder, and plural parity; missing translations fail release. | Locale checker |
| `LANG-006` | P1 | User-visible strings in product source MUST use localization keys unless explicitly classified as non-localizable identifiers. | AST string extraction check |
| `LANG-007` | P1 | Documentation prose SHOULD pass an English technical style rule set and spelling check with an explicit term dictionary. | Vale/typos or equivalent |
| `LANG-008` | P1 | The i18n suite MUST separately test locale fallback, plural rules, long text, RTL, Unicode input, and layout without weakening the English engineering rule. | Locale matrix |
| `LANG-009` | P1 | Generated artifacts MUST inherit English comments/headers even when they include localized data values. | Generation check |

The current exceptions in backend Rust, generic browser E2E, source locale registry, and root README MUST be removed or moved into the approved localization paths.

## 12. Target repository information architecture

### 12.1 Design rule

Every tracked file MUST answer four questions from its path alone:

1. Is it a shippable application, deployable service, reusable package, deployment asset, test, tool, source asset, document, experiment, or governance file?
2. Who owns and reviews it?
3. Is it hand-maintained, generated, build output, or runtime data?
4. Which release or quality gate consumes it?

### 12.2 Target tree

```text
veyora/
├── apps/
│   ├── web/
│   │   ├── src/
│   │   │   ├── app/
│   │   │   ├── features/
│   │   │   ├── domain/
│   │   │   ├── infrastructure/
│   │   │   ├── ui/
│   │   │   └── i18n/
│   │   ├── public/
│   │   │   └── generated/wasm/
│   │   ├── locales/
│   │   └── tests/
│   └── desktop/
│       ├── src/
│       ├── src-tauri/
│       ├── assets/
│       └── tests/
├── services/
│   ├── api/
│   ├── worker/
│   ├── migrator/
│   ├── backup/
│   ├── restore/
│   └── validator/
├── packages/
│   ├── security-kernel/
│   │   ├── kernel-core/
│   │   ├── kernel-wasm/
│   │   └── kernel-ffi/
│   ├── config/
│   ├── contracts-rust/
│   └── storage/
│       ├── persistence/
│       ├── postgres/
│       └── sqlite/
├── contracts/
├── deploy/
│   ├── compose/
│   ├── containers/
│   ├── gateway/
│   ├── web/
│   └── tools/
├── tests/
│   ├── e2e/
│   ├── smoke/
│   ├── integration/
│   ├── compatibility/
│   ├── accessibility/
│   ├── performance/
│   ├── release/
│   └── fixtures/i18n/
├── tools/
│   ├── lint/
│   ├── codegen/
│   ├── release/
│   ├── security/
│   └── dev/
├── experiments/
│   ├── archive/
│   └── android-jni/
├── assets/
│   ├── brand/source/
│   └── third-party/fonts/
├── docs/
│   ├── user/
│   ├── install/
│   ├── admin/
│   ├── development/
│   ├── architecture/
│   ├── operations/
│   ├── security/
│   ├── reference/
│   ├── legal/
│   ├── brand/
│   └── i18n/
├── .github/
├── .build/        # ignored build output only
├── .local/        # ignored development runtime state only
├── Cargo.toml     # root non-kernel Rust workspace
├── Cargo.lock
├── package.json   # root Node workspace
├── package-lock.json
├── repository-layout.toml
├── release/version.json
├── README.md
└── PRD.md
```

The security kernel MAY retain an independent Cargo workspace and lockfile inside `packages/security-kernel` as an explicit security boundary. Backend services, shared storage, and desktop native code SHOULD use one root Rust workspace so desktop dependencies no longer cross a `../../../backend` product boundary.

### 12.3 Current-to-target migration map

| Current path | Target path | Owner and rationale |
| --- | --- | --- |
| `frontend/web` | `apps/web` | Shipping Web application |
| `frontend/desktop` | `apps/desktop` | Shipping desktop application |
| `frontend/spikes/m0-desktop` | `experiments/archive/m0-desktop`, then delete after evidence extraction | Replaced capability spike |
| `frontend/spikes/m0-android` | `experiments/android-jni` | JNI experiment, not a shipping frontend |
| `backend/services/api` | `services/api` | Deployable API process |
| `backend/services/worker` | `services/worker` | Deployable worker process; current capability described honestly |
| `backend/services/migrator` | `services/migrator` | Database migration process |
| `backend/services/backup` | `services/backup` | Backup process |
| `backend/services/restore` | `services/restore` | Restore process |
| `backend/services/sandbox` | `services/validator` | Bounded validation service; avoid ambiguous sandbox naming |
| `backend/crates/persistence` | `packages/storage/persistence` | Shared persistence contract |
| `backend/crates/postgres` | `packages/storage/postgres` | PostgreSQL adapter |
| `backend/crates/sqlite` | `packages/storage/sqlite` | Desktop and local adapter, not backend-only |
| `backend/crates/config` | `packages/config` | Shared typed configuration |
| Duplicate contracts projections | `packages/contracts-rust` and explicitly generated consumer outputs | One canonical generator and manifest |
| `security-kernel/crates/*` | `packages/security-kernel/*` | Reusable security package with independent review boundary |
| `backend/Dockerfile.*` | `deploy/containers/<service>/Dockerfile` | Container packaging belongs to deployment |
| `docker/docker-compose.yaml` | `deploy/compose/compose.yaml` | Canonical Compose implementation |
| `docker/gateway` | `deploy/gateway` | Edge configuration |
| `docker/web` | `deploy/web` | Static Web delivery configuration |
| `scripts/check-repository.py` and `check-web.mjs` | `tools/lint/` | Repository and Web quality tooling |
| `backend/tooling/*` | `tools/codegen/backend/` | Generation tooling, not runtime backend |
| `scripts/test-browser*.mjs` | `tests/e2e/web/` | Product E2E |
| `scripts/smoke-test.sh` | `tests/smoke/api.sh` | API smoke test |
| `scripts/backup-restore-drill.sh` | `tests/integration/backup-restore.sh` | Recovery evidence |
| `scripts/deploy.sh` | `deploy/tools/deploy.sh` | Deployment operation |
| `scripts/build-and-push.sh` | `tools/release/publish-containers.sh` | Release engineering |
| `frontend/web/src/wasm` | `apps/web/public/generated/wasm` | Explicit generated asset, not hand-written source |
| `docs/USER-GUIDE.md` | Audience-specific files under `docs/user/` | User tasks rather than one monolith |
| `docs/DESKTOP.md` | `docs/install/desktop.md` plus user/storage topics | Separate installation from behavior |
| `docs/DEPLOYMENT*.md` | `docs/admin/` and `docs/operations/` | Operator ownership |
| `docs/ARCHITECTURE.md` | `docs/architecture/overview.md` | Architecture ownership |
| `docs/OPERATOR-GUIDE.md` | `docs/admin/` and `docs/operations/` | Split setup and ongoing operations |
| `docs/brand/logo-original.png` | `assets/brand/source/` | One approved brand source |
| Generated Web/Desktop icons | App-local generated asset paths | Generated from one approved source |
| `frontend/web/assets/fonts` | `assets/third-party/fonts/<family>/<version>/` | Versioned licensed source; build copies only used weights |
| Root `snapshot.json` | `.local/backups/` or explicit user path | Runtime data never belongs at root |
| Root `password/` | Outside checkout; `.local/test-vaults/` only for inert development fixtures | No unowned user data in source tree |

### 12.4 Repository requirements

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `REPO-001` | P0 | `repository-layout.toml` MUST define approved root entries, path category, owner, allowed file types, generated status, and runtime/build restrictions. | Layout checker |
| `REPO-002` | P0 | The root MUST reject unapproved directories/files, databases, Vaults, backups, certificates, signing keys, `target`, and `node_modules`. | `make doctor` and CI |
| `REPO-003` | P1 | Shipping applications MUST live only in `apps`; experiments MUST never satisfy shipping CI or release gates. | Dependency/workflow inspection |
| `REPO-004` | P1 | Deployable processes MUST live in `services`; container packaging MUST live in `deploy/containers`. | Layout checker |
| `REPO-005` | P1 | Shared runtime code MUST live in `packages` and expose explicit dependency direction; apps/services MUST NOT reach across sibling product domains by fragile relative paths. | Dependency graph check |
| `REPO-006` | P0 | Every tracked generated artifact MUST declare canonical input, generator path/version, consumer, source digest, output digest, and a deterministic `--check` command. | Fresh-clone generation |
| `REPO-007` | P0 | One command and one destination MUST generate the Web WASM package. No stale alternative path may be documented or consumed. | Path and generation test |
| `REPO-008` | P0 | Missing generators, nonexistent documented paths, orphan contracts, and claimed outputs that do not exist MUST fail CI. | Documentation/codegen checker |
| `REPO-009` | P1 | All Node packages MUST use one root workspace and lockfile; CI MUST use `npm ci` or the selected deterministic equivalent. | Lockfile/path check |
| `REPO-010` | P0 | `release/version.json` or an equivalent single authority MUST drive desktop, Web, services, kernel compatibility, contracts, images, updater, and release filenames. | Version guard |
| `REPO-011` | P0 | Product versions MUST be monotonic. Tool and experiment packages MUST use a private/non-product version and MUST NOT present as product `1.0.0`. | Tag/manifest policy test |
| `REPO-012` | P1 | `CARGO_TARGET_DIR` and other transient outputs MUST resolve under ignored `.build/<tool>/<workspace>`. | Environment and path test |
| `REPO-013` | P1 | `make clean-all` MUST remove all transient desktop/backend/kernel/Node/generated temporary output and leave a clean Git state. | Disk and `git status` assertion |
| `REPO-014` | P1 | `.local` MAY contain inert development runtime state only; production and real user data MUST live outside the checkout. | Doctor check and docs |
| `REPO-015` | P1 | Top-level areas MUST have CODEOWNERS. Kernel, contracts, release workflow, security model, and migration changes require specialist review. | Branch protection configuration evidence |
| `REPO-016` | P1 | Case-insensitive path collisions, non-ASCII paths, spaces, and unapproved case conventions MUST fail to preserve Windows/macOS checkout compatibility. | Cross-platform path check |
| `REPO-017` | P1 | The empty root `password/` directory and obsolete local artifacts MUST be removed during migration without deleting any user-owned non-empty path automatically. | Migration checklist |

### 12.5 Asset ownership

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `ASSET-001` | P1 | One approved, editable brand source MUST generate Web, desktop, DMG, Windows, README, and store assets. | Asset generation and visual review |
| `ASSET-002` | P1 | Generated brand assets MUST record source digest, generator version, dimensions, and platform consumer. | Manifest check |
| `ASSET-003` | P1 | Third-party fonts/assets MUST record exact source, version, license, digest, allowed weights, and redistribution evidence. | License inventory |
| `ASSET-004` | P1 | Duplicate font binaries MUST NOT be declared as different weights; real font faces or intentional synthetic behavior must be documented and tested. | Digest/CSS check |
| `ASSET-005` | P1 | UI screenshots MUST use inert fixtures, contain no personal data, state the tested version, and be refreshed when the represented flow changes. | Screenshot metadata gate |

## 13. Documentation and public open-source readiness

### 13.1 Documentation hierarchy

```text
README.md                         Public product landing page

docs/
├── README.md                     Documentation home and audience routing
├── user/
│   ├── getting-started.md
│   ├── concepts.md
│   ├── items-and-search.md
│   ├── backup-and-restore.md
│   ├── recovery.md
│   ├── accessibility.md
│   └── troubleshooting.md
├── install/
│   ├── desktop.md
│   ├── macos.md
│   ├── windows.md
│   ├── verify-downloads.md
│   ├── upgrade-and-rollback.md
│   └── uninstall.md
├── admin/
│   ├── quickstart.md
│   ├── topology.md
│   ├── configuration.md
│   ├── authentication.md
│   ├── tls.md
│   ├── backup-and-restore.md
│   ├── upgrade-and-rollback.md
│   ├── monitoring.md
│   ├── hardening.md
│   └── troubleshooting.md
├── development/
│   ├── setup.md
│   ├── architecture.md
│   ├── directory-layout.md
│   ├── testing.md
│   ├── release.md
│   └── language-policy.md
├── security/
│   ├── security-model.md
│   ├── threat-model.md
│   ├── crypto-profile.md
│   ├── audit-status.md
│   └── plaintext-metadata-inventory.md
├── reference/
│   ├── api.md
│   ├── configuration.md
│   ├── contracts.md
│   └── backup-format.md
├── legal/
├── brand/
└── i18n/
    ├── README.md
    ├── contributing.md
    └── supported-locales.md
```

Root README owns product truth and routing. `docs/README.md` owns the documentation map. Component READMEs own only their component boundary, development setup, and verification commands.

### 13.2 Root README requirements

The root README MUST contain, in this order:

1. Product name, one-sentence value, status, and a prominent safety warning matching the release channel.
2. One real, current screenshot using inert data.
3. `Download Veyora` and `Self-host Veyora` paths that are visibly distinct.
4. A verified platform matrix with minimum OS, CPU, artifact, signing/notarization, and native test status.
5. A three-to-five-minute first-use path in user language.
6. A capability table whose states are only `Stable`, `Beta`, `Experimental`, `Protocol-only`, `Planned`, or `Unsupported`.
7. Clear non-goals and known limitations.
8. Plain-language security boundary and audit status.
9. Links for user docs, self-hosting/admin docs, development, security reporting, contribution, support/discussion, changelog, and license.
10. A license label that says `open source` only after `OSS-001` is complete.

The root README SHOULD NOT lead with algorithms, protocol primitives, service inventory, or long source-build instructions.

### 13.3 Component README contracts

| README | Mandatory content | Blocking verification |
| --- | --- | --- |
| Root | Product truth, screenshot, downloads, status, platform matrix, quick use, capabilities/limits, security/audit, docs, community, license | Release API/asset comparison, feature registry, link/command checks, English policy, security approval |
| Backend/services | Trust boundary, service map, toolchain, runtime modes, generated configuration table, API/OpenAPI, migrations, PostgreSQL tests, backup/restore semantics, health/readiness/metrics, non-goals, troubleshooting | Workspace inventory, clean-run commands, blocking PostgreSQL E2E, backup round trip, config generation |
| Security kernel | Crate map, runtime-used vs protocol-only status, targets, crypto profile, WASM/FFI ABI, generation, vector provenance, key lifecycle limitations, audit/fuzz status, change policy | Zero-diff build, KAT/oracle/target parity, ABI review, security-owner approval |
| Web | Requirements, run/build, runtime config, service auth, trust boundary, WASM fail-closed behavior, browser matrix, blocking/non-blocking tests, i18n, accessibility, CSP, cache/offline limitations | Missing-WASM hard failure, known-plaintext network check, browser E2E, truthful recovery status |
| Desktop | OS/CPU matrix, prerequisites, dev/build, local server boundary, storage, backup/import/export, install/uninstall, upgrade, CSP/capabilities, signing, troubleshooting | Four-native clean install through uninstall, signature check, universal slices, data preservation |
| Deploy | Local-only vs production scope, topology, ports/routes, image tags/digests, secrets, TLS, auth/CORS, volumes, backup/restore, upgrade/rollback, monitoring, hardening, destructive teardown | Public HTTPS UI/API E2E, auth lifecycle, multi-arch images, fresh/upgrade/rollback/restore drills |
| Contracts | Canonical source, real directory inventory, owner/consumer/status, compatibility, generator inputs/outputs, validation, deprecation, security triggers | Filesystem inventory, zero-diff generation, consumer tests, breaking-change policy |
| i18n | English policy, shipped locales, translation/review flow, fallback, plural/RTL, machine-translation status | Language boundary, parity, placeholders/plurals, RTL and screenshot QA |

### 13.4 Documentation requirements

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `DOC-001` | P0 | Public claims MUST come from a versioned feature/evidence registry with status, owner, test ID, supported modes, supported platforms, and last verification. | Claim-to-evidence CI |
| `DOC-002` | P0 | Security, recovery, backup, offline, native, signing, audit, and production-readiness claims require Security and QA approval. | CODEOWNERS evidence |
| `DOC-003` | P1 | Every document MUST declare audience/owner or live under an audience-owned hierarchy; duplicate sources of truth are forbidden. | Documentation manifest |
| `DOC-004` | P1 | Shell/PowerShell commands MUST execute on a clean matching runner, except explicitly marked pseudocode. | Executable-doc jobs |
| `DOC-005` | P1 | Links, heading anchors, referenced repository paths in links and code spans, configuration keys, versions, asset names, and directory inventories MUST be checked. | Documentation checker |
| `DOC-006` | P0 | Documentation MUST distinguish local Desktop, connected Desktop, and connected Web behavior. | Mode matrix review |
| `DOC-007` | P0 | Installation docs MUST never present bypassing Gatekeeper, SmartScreen, or Smart App Control as the normal stable path. | Forbidden-copy lint |
| `DOC-008` | P1 | Release notes MUST list data/contract migrations, security changes, breaking changes, known issues, supported upgrade origins, rollback limits, and recovery actions. | Release manifest check |
| `DOC-009` | P1 | Machine-translated documentation MUST be labeled unverified and MUST NOT count as a supported application locale. | i18n/docs review |
| `DOC-010` | P1 | Screenshots and steps MUST be tied to a product version and critical UI state so stale evidence is detectable. | Screenshot manifest |

### 13.5 Open-source and community requirements

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `OSS-001` | P0 | Before the project is called open source, the copyright owner MUST adopt an OSI-approved software license and update all manifests, badges, notices, headers, docs, and package metadata. | Legal approval and license scan |
| `OSS-002` | P0 | If PolyForm Noncommercial remains, every public surface MUST use `source-available` and MUST NOT use `open source`. | Public-surface scan |
| `OSS-003` | P1 | The license decision MUST explicitly choose the project strategy: permissive (for example Apache-2.0) or network copyleft (for example AGPL-3.0), including dependency and contribution implications. | Recorded legal/product decision |
| `OSS-004` | P1 | CONTRIBUTING MUST define setup, English policy, issue/PR workflow, tests, DCO/CLA decision, security handling, review ownership, and release contribution boundaries. | Contributor dry run |
| `OSS-005` | P1 | CODE_OF_CONDUCT, SECURITY, support/discussion routing, issue templates, PR template, governance, roadmap, and maintainer expectations MUST be public and coherent. | Community-readiness checklist |
| `OSS-006` | P1 | Every third-party dependency and distributed asset MUST have machine-readable license inventory and notice handling. | License/SBOM scan |

The [Open Source Definition](https://opensource.org/osd) requires free redistribution and no discrimination against fields of endeavor. Noncommercial restrictions do not meet that definition. Both [Apache-2.0 and other approved licenses](https://opensource.org/licenses) and [AGPL-3.0](https://opensource.org/license/agpl-3-0) are possible strategies, but the project owner must make the legal/product choice.

## 14. Connected-service deployment and operations

### 14.1 Supported deployment posture

The supported connected deployment is one owner-controlled HTTPS origin that serves the Web application and routes `/api/` to the API service. PostgreSQL, worker, migrator, backup, restore, validator, metrics, and proxy administration endpoints remain private.

Local preview and production MUST be separate profiles with separate security claims. A localhost preview with disabled auth is never evidence of production readiness.

### 14.2 Required topology

```text
User browser or connected desktop
          |
          | HTTPS
          v
Reviewed owner-controlled origin
    ├── /              -> static Web client
    ├── /assets/*      -> immutable versioned assets
    └── /api/*         -> authenticated API
                              |
                              v
                     private PostgreSQL

Private-only: worker, migrator, backup, restore, validator,
metrics collector, proxy admin, database administration.
```

### 14.3 Deployment requirements

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `DEP-001` | P0 | Production HTTPS `/` MUST return the Web UI and only `/api/` MUST route to the API; route precedence and refresh behavior MUST be tested. | Real-domain browser E2E |
| `DEP-002` | P0 | HTTP MUST redirect safely to HTTPS without constructing an attacker-controlled invalid destination. HSTS starts only after HTTPS is verified. | External redirect tests |
| `DEP-003` | P0 | Web, gateway, API, and database network exposure MUST be explicit. Only the reviewed edge port is public by default. | Port scan and Compose inspection |
| `DEP-004` | P0 | Production auth MUST be enabled and provisionable through a documented pairing/bootstrap flow. `disabled` auth is local-preview only. | Fresh production-shaped E2E |
| `DEP-005` | P0 | Secrets MUST come from a reviewed secret mechanism and MUST NOT appear in Git, image layers, Compose rendering output, process arguments, logs, diagnostics, backups, or support bundles. | Secret canary suite |
| `DEP-006` | P1 | Containers MUST run as non-root with read-only filesystems and dropped capabilities except documented necessities. | Container-policy test |
| `DEP-007` | P1 | Images MUST use pinned base digests, minimal runtime contents, health checks, resource limits, graceful shutdown, and architecture declarations. | Image inspection |
| `DEP-008` | P1 | Configuration MUST be generated from one typed registry with name, type, default, mode, secret classification, validation, owner, and documentation. | Config drift test |
| `DEP-009` | P1 | The gateway and Web header configuration MUST be generated from or tested against the versioned header contract. | Real-response contract test |
| `DEP-010` | P1 | Production database access MUST use private networking, least-privilege roles, reviewed TLS, bounded connections, and tested credential rotation. | Integration/rotation tests |
| `DEP-011` | P0 | Backup scheduling MUST define first-run timing, atomic output, encryption/integrity, permissions, retention, verification, failure alerting, and restore ownership. | Scheduled drill evidence |
| `DEP-012` | P1 | Upgrade procedure MUST include preflight, verified backup, image digests, migrations, health/readiness, smoke test, rollback decision, and data-format limitation. | N-1 to N rehearsal |
| `DEP-013` | P1 | Destructive teardown commands MUST say exactly which volumes/data are removed and require an explicit destructive option. | Command/documentation tests |
| `DEP-014` | P1 | Logs and metrics MUST use UTC timestamps, stable English events, request correlation, bounded cardinality, and no Vault content. | Observability review |
| `DEP-015` | P1 | Operator docs MUST include failure modes for TLS, auth, CORS, database, migration, backup, restore, storage exhaustion, clock drift, and incompatible client/server versions. | Runbook game day |

### 14.4 Container platform support

Container support is independent from desktop support. Every published image MUST expose an OCI multi-platform index for `linux/amd64` and `linux/arm64`, and the release manifest MUST pin the per-platform digest. Pulling and starting all images on both architectures is a release gate; a manifest-only inspection is insufficient.

## 15. Desktop packaging, installation, and updates

### 15.1 Architecture terminology

This PRD uses:

- **AMD64** and **x86_64** for 64-bit Intel/AMD architecture.
- **ARM64** and **aarch64** for 64-bit Arm architecture.

Literal 32-bit x86/i686 is not in scope. Calling AMD64 `x86` in a casual sentence is discouraged because it can be mistaken for a fifth 32-bit target.

### 15.2 Why four native hosts are required

Apple's virtualization framework creates a VM of the same architecture as the underlying Mac. The current Apple Silicon Mac can natively virtualize ARM guests, not Intel macOS or AMD64 Windows. Running those locally would require translation/emulation and would violate the stated native-only rule. See [Apple VZVirtualMachine](https://developer.apple.com/documentation/virtualization/vzvirtualmachine).

The solution is a native distributed test lab:

| Target | Automated native host | Manual/native option | Local Apple Silicon role |
| --- | --- | --- | --- |
| macOS ARM64 | GitHub `macos-15` | Current Mac | Full local manual and automated acceptance |
| Windows ARM64 | GitHub `windows-11-arm` | Parallels Windows 11 ARM VM on the ARM Mac | Full local manual acceptance after provisioning the ARM VM |
| Windows AMD64 | GitHub `windows-2025` | Native AMD64 Azure/other x64 VM over RDP | Automated evidence; manual pre-stable session on native cloud host |
| macOS Intel | GitHub `macos-15-intel` | Intel EC2 Mac `mac1.metal` or equivalent native Intel Mac host | Automated evidence; manual pre-stable session on leased native host |

GitHub documents these explicit architectures in its [hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). AWS documents `mac1.metal` as Intel Mac hardware that natively runs macOS in its [EC2 Mac guidance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html). Native remote hardware is not a compatibility workaround; it is the required execution architecture.

### 15.3 Required release matrix

| Release target | Required build/test runner | Final artifact | Architecture proof | Signature/trust proof |
| --- | --- | --- | --- | --- |
| macOS Intel | `macos-15-intel` | Signed/notarized universal DMG | Every Mach-O binary, framework, helper, and updater contains `x86_64`; process launches without translation | Developer ID, hardened runtime, secure timestamp, notarization, staple, `codesign`, `spctl` |
| macOS ARM64 | `macos-15` | Same signed/notarized universal DMG | Every Mach-O contains `arm64`; `sysctl.proc_translated = 0` | Same final DMG verification on ARM host |
| Windows AMD64 | `windows-2025` | Signed native AMD64 MSI; optional native AMD64 EXE | Every EXE, DLL, custom action, and uninstaller reports AMD64 PE machine type | Authenticode chain/timestamp, `SignTool verify /pa`, clean-image trust test |
| Windows ARM64 | `windows-11-arm` | Signed native ARM64 MSI/MSIX or independent native ARM64 bootstrapper | Every EXE, DLL, custom action, and uninstaller is ARM64; MSI Template Summary is `Arm64` | Authenticode chain/timestamp, native install/launch, clean-image trust test |

Tauri states that its stock NSIS installer remains x86 even when the installed application is ARM64. Therefore stock NSIS MUST NOT be shipped as the Windows ARM installer under this PRD's no-emulation requirement. See [Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/) and Microsoft's [64-bit Windows Installer package requirements](https://learn.microsoft.com/en-us/windows/win32/msi/64-bit-windows-installer-packages).

One universal DMG is preferable for users, but it counts as two supported architectures only after the exact final DMG passes independent native install and launch on both Mac architectures. Apple describes the required slice model in [Building a universal macOS binary](https://developer.apple.com/documentation/apple-silicon/building-a-universal-macos-binary).

### 15.4 Packaging requirements

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `REL-001` | P0 | Release workflows MUST use explicit runner labels and assert actual OS, OS version, and CPU architecture before build/test. `*-latest` is forbidden in the native support matrix. | Runner evidence record |
| `REL-002` | P0 | Release binaries MUST be built and packaging-tested on the matching native architecture, except the universal merge step whose slices are independently native-built. | Build provenance |
| `REL-003` | P0 | Windows ARM MUST use an ARM64 MSI/MSIX or proven native bootstrapper. Stock NSIS is forbidden because the installer executes under emulation. | PE/MSI inspection |
| `REL-004` | P0 | The universal macOS app MUST contain both slices in every embedded executable dependency; checking only the main executable is insufficient. | Recursive Mach-O report |
| `REL-005` | P0 | macOS stable artifacts MUST be Developer ID signed, use hardened runtime and secure timestamps, be notarized and stapled, pass Gatekeeper assessment, and open from the final downloaded DMG. | Apple evidence bundle |
| `REL-006` | P0 | Windows stable artifacts, uninstallers, and executable payloads MUST be Authenticode signed and timestamped; signature verification MUST use the final downloaded asset. | SignTool evidence |
| `REL-007` | P0 | Every artifact MUST publish SHA-256, size, target, minimum OS, signing identity, commit, workflow run, SBOM, and provenance attestation in a machine-readable release manifest. | Manifest validation |
| `REL-008` | P1 | SBOM MUST use a current standardized format such as SPDX and include bundled native, Rust, Node, container, font, and binary dependencies as applicable. | SBOM schema/license checks |
| `REL-009` | P1 | Artifact attestations MUST be generated and verified; documentation MUST state that provenance does not prove the software is vulnerability-free. | GitHub attestation verification |
| `REL-010` | P0 | Tag, GitHub Release, release manifest, updater manifest, containers, packages, and docs MUST use one monotonic product version. | Version guard |
| `REL-011` | P0 | A tag MUST NOT exist without a complete matching Release, and a Release MUST NOT be marked stable/Latest unless all required assets and gates exist. | GitHub API release policy |
| `REL-012` | P0 | Preview quality MUST publish as prerelease. Stable/Latest is an output of the quality gate, not a manual optimistic label. | Release channel assertion |
| `REL-013` | P1 | Final artifact filenames MUST encode product version and architecture where the artifact is not universal, without ambiguous `x86` terminology. | Naming policy |
| `REL-014` | P1 | Release signing and updater private keys MUST have documented custody, backup, access, rotation, revocation, and loss procedures. | Key-custody drill |

GitHub artifact attestations bind an artifact to repository/workflow/commit provenance and can include an SBOM, but do not establish that it is safe. See [GitHub artifact attestation guidance](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) and the [SPDX specification](https://spdx.dev/use/specifications/).

### 15.5 Installation requirements

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `INST-001` | P0 | Tests MUST download the exact immutable release candidate asset rather than install a build-directory binary. | Network/hash evidence |
| `INST-002` | P0 | Each target MUST complete clean install, first launch, Vault setup, lock/relaunch/unlock, backup/restore, upgrade, uninstall, and reinstall. | Four-native release suite |
| `INST-003` | P0 | Installation MUST NOT require disabling operating-system security or using `Run anyway`/`xattr -cr` as the supported path. | Clean-host manual evidence |
| `INST-004` | P1 | Windows MUST test normal and unattended MSI install/uninstall with verbose logs. | `msiexec` logs |
| `INST-005` | P1 | macOS MUST test DMG mount, drag/install, quarantine, first launch, relaunch, and removal from the final signed/notarized image. | macOS logs/screenshots |
| `INST-006` | P0 | App data location MUST follow platform conventions, be shown safely in Diagnostics, and never default inside the application bundle, download folder, or source checkout. | Path assertions |
| `INST-007` | P0 | Uninstall MUST remove app binaries, shortcuts, protocol handlers, startup entries, updater components, and processes. | Remnant inventory |
| `INST-008` | P0 | Uninstall MUST preserve the encrypted user Vault by default and explain that choice. A separate strongly confirmed purge removes user data. | Uninstall/reinstall/purge matrix |
| `INST-009` | P1 | Reinstall MUST rediscover or safely prompt for preserved Vault data without silently creating a new empty Vault over it. | Reinstall E2E |
| `INST-010` | P1 | Minimum supported OS versions and lifecycle policy MUST be explicit and tested; unsupported OS behavior MUST be clear. | Compatibility matrix |
| `INST-011` | P1 | Installer UI and all installation documentation MUST be accessible and English-canonical; installer localization is an i18n resource. | Manual platform accessibility review |

### 15.6 Update, downgrade, and rollback requirements

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `UPD-001` | P0 | Updates MUST use HTTPS plus mandatory updater signatures and platform-appropriate architecture entries. | Updater integration tests |
| `UPD-002` | P0 | Signed N-1 to N update MUST run on all four native hosts using the real update manifest and preserve every fixture item/settings value. | Four-native update suite |
| `UPD-003` | P0 | Wrong key, modified bytes, truncated asset, wrong architecture, incomplete manifest, expired/revoked channel, and downgrade attempts MUST be rejected while the existing app remains usable. | Negative update corpus |
| `UPD-004` | P0 | Data migration and binary update MUST have a defined safe ordering and recovery path. The updater MUST NOT strand a Vault between formats. | Crash/fault matrix |
| `UPD-005` | P1 | Automatic downgrade MUST be refused by default. Any supported rollback MUST check data compatibility and be operator/user explicit. | Downgrade tests |
| `UPD-006` | P1 | Update UI MUST state version, channel, size, signing status, backup recommendation/requirement, restart effect, and release-note link. | UX test |
| `UPD-007` | P1 | Loss of the updater signing key MUST have a rehearsed response because existing installations may be unable to trust a replacement key automatically. | Key-loss tabletop |

Tauri documents mandatory updater signatures and architecture-specific manifests in its [Updater guidance](https://v2.tauri.app/plugin/updater/). Apple documents signing/notarization requirements in [Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution). Microsoft documents signature verification in [Use SignTool to verify a file signature](https://learn.microsoft.com/en-us/windows/win32/seccrypto/using-signtool-to-verify-a-file-signature).

### 15.7 Release evidence bundle

Every candidate MUST produce one immutable evidence index containing:

- Product version, Git commit, source tag, workflow run IDs, timestamps, and approval identities.
- Final artifact filenames, sizes, SHA-256 digests, updater signatures, and download URLs.
- Runner OS/architecture assertions.
- Recursive Mach-O or PE/MSI architecture reports.
- macOS `codesign`, notarization log, staple validation, and `spctl` results.
- Windows Authenticode/SignTool results and clean-image SmartScreen/Smart App Control notes.
- SBOM and verified provenance attestations.
- Clean install, unattended install where applicable, first launch, upgrade, uninstall, reinstall, and purge logs.
- Critical feature, recovery, backup/restore, migration, accessibility, performance, and security results.
- Known issues, waivers, owners, expiry, and release decision.

No P0 waiver may be used to publish Stable.

## 16. Non-functional requirements

### 16.1 Accessibility

The product target is WCAG 2.2 Level AA for Web content and equivalent native application behavior. W3C states that automated tools do not establish conformance alone, so manual checks are required. See [WCAG 2.2](https://www.w3.org/TR/WCAG22/) and [W3C evaluation guidance](https://www.w3.org/WAI/test-evaluate/).

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `ACC-001` | P1 | All Level A and AA criteria applicable to the supported flows MUST pass. | Versioned conformance report |
| `ACC-002` | P1 | Every input MUST have a persistent visible label and programmatic association. Placeholder text alone is insufficient. | Automated/manual form audit |
| `ACC-003` | P1 | Icon buttons MUST have a stable accessible name; unfamiliar or high-risk actions SHOULD also have visible text. | Accessible-name inventory |
| `ACC-004` | P1 | All functionality MUST be operable by keyboard with logical order, visible focus, no trap, modal focus containment, and focus return. | Manual keyboard suite |
| `ACC-005` | P1 | Focus MUST not be obscured by drawers, sticky regions, toasts, or virtual keyboards. | Visual/manual tests |
| `ACC-006` | P1 | Normal text contrast MUST be at least 4.5:1 and meaningful non-text/UI contrast at least 3:1, subject to WCAG exceptions. | Contrast report |
| `ACC-007` | P1 | At 200% zoom and down to 320 CSS px width, no core function or content may be clipped, overlap, or require two-dimensional scrolling except allowed content. | Reflow screenshots/tests |
| `ACC-008` | P1 | Pointer targets MUST meet 24 by 24 CSS px minimum or a documented WCAG exception; primary actions SHOULD target 44 by 44. | Target-size audit |
| `ACC-009` | P0 | Authentication and recovery MUST allow paste and password-manager assistance; the UI MUST NOT require users to transcribe one character into many separate fields. | Accessible-auth test |
| `ACC-010` | P1 | Errors MUST identify the field and nature in text, offer a known correction, preserve input, and provide an error summary for multiple errors. | Form error suite |
| `ACC-011` | P1 | Save/copy/result/progress/backup states MUST be programmatically announced without stealing focus. Urgent alerts MUST be used sparingly. | Screen-reader event test |
| `ACC-012` | P1 | Core flows MUST receive manual VoiceOver testing on macOS and Narrator or NVDA testing on Windows before Stable. | Signed manual report |
| `ACC-013` | P1 | Locale expansion and RTL MUST preserve accessibility names, reading order, focus order, and task completion. | Locale accessibility matrix |

Form instructions, validation, and error behavior are also informed by [W3C form instructions](https://www.w3.org/WAI/tutorials/forms/instructions/) and [W3C form validation](https://www.w3.org/WAI/tutorials/forms/validation/).

### 16.2 Performance budgets

Performance MUST be measured on documented reference hardware with inert generated Vaults. Security parameters MUST NOT be weakened to meet UI budgets.

| ID | Priority | Budget | Measurement |
| --- | --- | --- | --- |
| `PERF-001` | P1 | Desktop cold launch to interactive Welcome/Locked state: p95 <= 2.5 seconds | Each native target, 20 cold runs |
| `PERF-002` | P1 | Kernel load/self-test: p95 <= 1.0 second on reference hardware | Web and desktop separately |
| `PERF-003` | P1 | Unlock 1,000-item Vault: p95 <= 2.5 seconds; 10,000-item Vault: p95 <= 5 seconds, including configured KDF | Each native target and supported browsers |
| `PERF-004` | P1 | Search over 10,000 unlocked items after index build: p95 <= 100 ms per query and no keystroke backlog | Desktop/Web benchmark |
| `PERF-005` | P1 | Local item save acknowledgment: p95 <= 250 ms after encryption; connected final acknowledgment: p95 <= 2 seconds on reference network | Instrumented E2E |
| `PERF-006` | P1 | UI interactions MUST remain responsive during backup, import, rotation, and synchronization; long work exposes progress and cancellation safety. | Long-task interaction test |
| `PERF-007` | P2 | Peak memory with 10,000 standard items SHOULD remain below 350 MB on desktop reference builds, with no monotonic growth across 100 lock/unlock cycles. | Memory soak |
| `PERF-008` | P1 | Release asset, Web transfer, and startup bundle size MUST have baselines; growth above 10% requires an approved explanation. | Size budget report |

The first implementation cycle MAY recalibrate numeric budgets once a reproducible baseline exists, but any change requires an ADR, reason, and before/after evidence. No budget may be silently removed.

### 16.3 Reliability and durability

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `RELIA-001` | P0 | A confirmed successful save MUST survive immediate process termination and relaunch according to the mode's durability contract. | Kill-after-ack test |
| `RELIA-002` | P0 | Partial writes MUST be detectable and must not replace the last verified item/Vault/backup state. | Fault injection |
| `RELIA-003` | P0 | Recovery, restore, migration, import, password change, key rotation, and update MUST be idempotent or explicitly detect prior partial execution. | Resume/retry matrix |
| `RELIA-004` | P1 | Connected clients MUST expose pending, synchronized, offline, and conflict states; `Saved` alone MUST not imply remote sync. | Network-state E2E |
| `RELIA-005` | P1 | Clock changes MUST not corrupt TOTP, retention, sessions, revisions, backup ordering, or update decisions. | Clock-skew tests |
| `RELIA-006` | P1 | Disk-full, read-only storage, permission denial, database unavailable, and network partition states MUST preserve the last good data and report impact. | Failure matrix |
| `RELIA-007` | P1 | A 24-hour soak with repeated CRUD, lock/unlock, search, sync, and backup MUST show no data mismatch or unbounded resource growth. | Scheduled soak evidence |

### 16.4 Privacy and observability

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `PRIV-001` | P0 | Telemetry MUST be disabled by default in stable self-hosted and local builds unless the user explicitly opts in. | Network inspection |
| `PRIV-002` | P0 | Telemetry/logging MUST never include Master Passwords, Recovery Keys, connection credentials, plaintext item fields, TOTP seeds/codes, clipboard content, search queries, filenames from plaintext exports, or raw backups. | Canary suite |
| `PRIV-003` | P1 | Product metrics MUST be content-free and documented, with purpose, retention, destination, fields, and deletion behavior. | Privacy inventory |
| `PRIV-004` | P1 | Crash reporting MUST be opt-in or explicitly operator-controlled, preview/redact sensitive payloads, and exclude memory dumps by default. | Crash fixture review |
| `PRIV-005` | P1 | The plaintext/metadata inventory MUST be updated for every schema, telemetry, log, sync, and backup change. | Security review gate |

### 16.5 Compatibility

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `COMP-001` | P1 | Supported OS/browser/WebView versions MUST be explicit and limited to versions with active security support. | Published support matrix |
| `COMP-002` | P1 | Desktop packages MUST bundle or validate required runtime dependencies without unsafe network downloads during installation. | Offline install test |
| `COMP-003` | P1 | Supported client/server protocol ranges MUST be machine-readable; incompatible clients receive a safe actionable error. | Version matrix |
| `COMP-004` | P1 | Backups created by every supported release MUST restore in the current release or have an explicit migration tool. | Backup compatibility corpus |
| `COMP-005` | P1 | Case-insensitive filesystems, long paths, Unicode user data, locale settings, and non-default OS scaling MUST be covered. | Platform matrix |

## 17. Regression and quality strategy

### 17.1 Test layers

| Layer | Purpose | Blocking scope |
| --- | --- | --- |
| Static policy | Language, paths, ownership, versions, contracts, generated outputs, docs, licenses, secrets | Every pull request |
| Unit | Pure domain, crypto wrappers, parsing, validation, state transitions, UI functions | Every pull request |
| Property/fuzz/vector | Crypto invariants, parsers, IDs, formats, migration edge cases | Pull request for changed area; scheduled extended runs |
| Contract | API/OpenAPI, config, errors, storage adapters, headers, backup schema, locale parity | Every pull request |
| Integration | PostgreSQL, SQLite, API, migrations, backup/restore, auth, Compose | Every pull request for relevant areas; nightly full |
| Web E2E | Real browser + real WASM + API + HTTPS where relevant | Critical journeys blocking |
| Desktop E2E | Packaged Tauri app, local storage/server, native OS integration | Pull request smoke; release full |
| Security | ASVS mapping, dependency/secret/image scans, CSP/CORS, auth abuse, threat-model tests | Blocking by policy |
| Accessibility | Automated scans plus keyboard/assistive-technology manual evidence | Pull request automation; release manual |
| Performance | Budgets and regressions | Main/nightly; release blocking |
| Native release | Final signed assets installed and exercised on four native targets | Every release candidate |
| Operations | Production-shaped TLS, upgrade, rollback, backup, destructive restore, monitoring | Every release candidate |

### 17.2 Quality requirements

| ID | Priority | Requirement | Acceptance evidence |
| --- | --- | --- | --- |
| `QA-001` | P0 | Critical suites MUST be blocking. Shell success bypasses, ignored critical cases, silent quarantine, and pass-on-missing-dependency behavior are forbidden. | Workflow policy lint |
| `QA-002` | P0 | CI MUST test the shipping desktop application, not an obsolete capability spike. | Job/path assertion |
| `QA-003` | P0 | Web E2E MUST use the real release-mode WASM kernel and fail if it is missing, corrupt, or replaced. | Runtime identity assertion |
| `QA-004` | P0 | Tests MUST include known plaintext canaries and assert they never appear in API requests, server logs, database rows, backups, support bundles, or release diagnostics. | Canary scan |
| `QA-005` | P0 | PostgreSQL tests MUST be blocking and include multi-Vault isolation, concurrency, transaction rollback, migration, restore, and TLS/pool behavior. | CI integration report |
| `QA-006` | P0 | Recovery and backup drills MUST destroy/detach the test primary and restore into a fresh target. A no-op round trip is insufficient. | Destructive evidence |
| `QA-007` | P0 | Every supported native package MUST run the same invariant core journey against the exact final candidate. | Four-native matrix |
| `QA-008` | P1 | Random test data MUST be reproducible by recorded seed and MUST never use real credentials or user Vaults. | Fixture policy check |
| `QA-009` | P1 | Flaky tests MUST remain blocking or be immediately owned with a short expiry; quarantined tests cannot satisfy feature evidence. | Flake registry |
| `QA-010` | P1 | Test artifacts MUST redact secrets, expire by policy, and include product/test version, runner, architecture, seed, and timestamps. | Artifact inspection |
| `QA-011` | P1 | Documentation commands and release verification commands MUST run in CI on their claimed platform. | Executable-doc jobs |
| `QA-012` | P1 | A release test plan MUST be generated from requirement IDs and produce pass/fail/blocked evidence, not a free-form checklist. | Traceability report |
| `QA-013` | P1 | Browser business-flow selectors MUST be locale-independent; locale rendering gets its own parameterized suite. | Selector lint |
| `QA-014` | P1 | Fresh clone setup, build, test, clean, and Git cleanliness MUST pass on macOS ARM and CI baseline hosts. | Bootstrap jobs |
| `QA-015` | P1 | All failure-path assertions MUST prove preserved data state, not merely an error status. | State digest assertions |

### 17.3 Critical end-to-end scenarios

#### `E2E-001`: New local user reaches first success

1. Install the final package on a clean native host.
2. Launch and explain Veyora/Vault in the UI before secret entry.
3. Choose Create, select a safe local location, create a compliant Master Password.
4. Save and verify a real Recovery Key.
5. Add a Login, find it by name/username, copy the password, observe clear feedback.
6. Lock, relaunch, and unlock with the correct password.
7. Confirm wrong password fails without mutation.

#### `E2E-002`: Empty Vault rejects wrong password

1. Create a Vault and add no ordinary items.
2. Lock and record metadata/data digests.
3. Attempt correct-length wrong passwords and a different Vault's password.
4. Verify unlock fails, no new identity/salt/verifier is committed, and digests remain unchanged.
5. Verify the correct password still unlocks.

#### `E2E-003`: Real clean-state recovery

1. Create a Vault with every supported item type, tags, TOTP, favorites, and Trash entries.
2. Record a decrypted canonical fixture manifest.
3. Remove the old Master Password from the test and delete all local app metadata/cache/session state.
4. On a fresh installation/target, use only the documented Vault source, Recovery Key, and a new Master Password.
5. Verify every canonical value and ID/revision rule.
6. Verify old password fails, new password works, and CRUD remains functional.

#### `E2E-004`: Atomic password change

1. Populate at least 100 items across all stable types.
2. Inject failure before, during, and after each wrapper write/commit boundary.
3. For every failed attempt, verify old password and all records remain usable.
4. On success, verify new password, Recovery Key, records, backup, and relaunch.

#### `E2E-005`: Cross-Vault isolation

1. Create two principals and at least two Vaults with intentionally colliding item IDs/verifier logical names.
2. Exercise list, read, put, batch, delete, restore, backup, and conflict calls using valid, missing, expired, and cross-scoped credentials.
3. Verify no cross-scope data or existence signal beyond the approved error model.

#### `E2E-006`: Atomic import

1. Import a valid multirow file and verify all committed items.
2. Repeat with malformed first, middle, and final rows; duplicate IDs; unsupported fields; oversized input; and injected database failure.
3. Verify preview/loss report, zero partial commit on failure, deterministic retry, and exact result counts.

#### `E2E-007`: Encrypted backup and destructive restore

1. Create a versioned encrypted backup and verify it.
2. Destroy/detach the isolated primary and all local metadata.
3. Restore into an empty destination through documented steps.
4. Compare item IDs, revisions, fields, TOTP, tags, Trash, and metadata.
5. Perform post-restore create/edit/delete/backup.
6. Verify wrong password/key, tamper, truncation, wrong Vault, and unsupported version fail without destination mutation.

#### `E2E-008`: Connected production-shaped path

1. Deploy the exact candidate images behind a real HTTPS hostname.
2. Verify HTTP redirect, `/` UI, `/api/` routing, headers, CORS, auth bootstrap, token/session rotation, and private service exposure.
3. Pair a client, create/sync/modify/conflict/delete/restore items, revoke the session, and verify access ends.
4. Upgrade N-1 to N, verify migration and rollback policy, then perform a destructive backup restore.

#### `E2E-009`: Four-native installation and update

Run on macOS Intel, macOS ARM64, Windows AMD64, and Windows ARM64:

1. Assert host architecture and clean state.
2. Download final asset; verify hash, provenance, SBOM, signature, publisher, and every embedded architecture.
3. Install normally and unattended where supported.
4. Launch and prove no translation/emulation.
5. Run `E2E-001` plus backup/restore.
6. Install signed N-1, create data, update to N, and verify preservation.
7. Reject tampered/wrong-architecture/downgrade updates.
8. Uninstall, inventory remnants, reinstall, rediscover preserved data, then test explicit purge.

#### `E2E-010`: Accessibility core journey

On supported Web and native targets, complete Welcome, create/open, recovery verification, add Login, search, item detail, copy, lock, unlock, backup, restore error, and settings using keyboard only and the platform screen reader. Verify focus, labels, status messages, errors, reflow, zoom, contrast, and target size.

### 17.4 Native candidate workflow

The release pipeline MUST stage artifacts before publishing:

```text
Build native slices/packages
        |
        v
Sign and notarize/timestamp
        |
        v
Create immutable candidate assets + manifest
        |
        v
Download candidate on four native hosts
        |
        v
Verify -> install -> exercise -> update -> uninstall
        |
        v
Assemble evidence and approvals
        |
        v
Promote the same bytes to prerelease or stable
```

Rebuilding after test invalidates the evidence. Promotion MUST reuse exactly the tested bytes.

## 18. Quality gates and release policy

### 18.1 Gate sequence

| Gate | Required outcome | Blocks |
| --- | --- | --- |
| G0: Product truth | Product modes, terminology, scope, license wording, feature status, version authority, and owner decisions approved | Implementation divergence and public claims |
| G1: Repository integrity | English policy, target ownership, real desktop CI, reproducible codegen, clean build paths, version/path/docs guards pass | Merge to stabilization branch |
| G2: Security/data correctness | Real kernel fail-closed, key hierarchy, recovery, password change, Vault isolation, atomic batch/import, migrations pass | Any credential use recommendation |
| G3: Core usability | Welcome through first success, errors, settings, help, backup/export separation, responsive layout, accessibility automation pass | Public beta |
| G4: Connected operations | Reviewed auth, same-origin TLS, CORS/headers, database integration, backup/restore, upgrade/rollback, monitoring pass | Self-hosted support claim |
| G5: Native delivery | Four-native final-asset build/install/update/uninstall, signatures, notarization, architectures, provenance/SBOM pass | Desktop release |
| G6: Documentation/community | Root and component READMEs truthful, install/admin/user/security docs executable, OSI license decision, community processes ready | Open-source stable announcement |
| G7: Stable approval | All P0/P1 stable-scope requirements, external security review criteria, performance, soak, manual accessibility, known-issue review pass | Stable/Latest promotion |

### 18.2 Release channel policy

| Channel | Allowed state | User-facing warning | Gate requirement |
| --- | --- | --- | --- |
| Local development | Incomplete/unsafe | Inert test data only | G0 minimum |
| Nightly | Unstable; may corrupt test data | Not for real credentials | G1 plus changed-area tests |
| Preview | Integrated but known blockers remain | Not for real credentials; no support promise | G2 for tested scope; marked prerelease |
| Beta | Feature complete for stable scope; broader validation ongoing | Backup required; known limitations listed | G0-G6; prerelease |
| Stable | Supported release | Normal security limitations and support window | G0-G7; no P0/P1 stable-scope failures |

`Latest` MUST point only to Stable. A Beta or Preview GitHub Release MUST have `prerelease=true`.

### 18.3 Stable release blockers

Stable is automatically blocked by any of the following:

- Any distributable demo/pass-through cryptography path.
- Recovery not proven on an existing non-empty Vault in a clean environment.
- Failed or non-destructive backup/restore drill.
- Cross-Vault access, collision, or client-side-only isolation.
- Non-atomic password change, migration, batch/import, or restore behavior that can strand data.
- Missing real desktop CI or non-blocking critical E2E.
- Missing one of the four native installation results.
- Emulated Windows ARM installer or translated native test process.
- Unsigned/unnotarized required package, failed signature, missing final-asset architecture proof.
- Missing checksum, SBOM, provenance, release manifest, or updater signature.
- Production HTTPS origin that does not serve UI and API correctly.
- Global/unprovisionable connected auth, wildcard credentialed CORS, or absent desktop CSP.
- Unsupported false claim in public documentation.
- Version inconsistency or backward version/tag sequence.
- Source-available license marketed as open source.
- Unresolved critical/high security finding within the approved release policy.
- Data-loss, recovery, accessibility, or installation P0 failure.

## 19. Delivery milestones

Dates are set by the owner after capacity planning. Milestone order and exit criteria are mandatory.

### M0: Release freeze and truth baseline

Scope:

- Freeze Stable/Latest publication and real-credential recommendations.
- Approve this PRD, product modes, terminology, owner map, feature status taxonomy, and release channel policy.
- Correct the current public release status to prerelease where appropriate.
- Record license decision deadline and select an OSI strategy or retain source-available wording.
- Create one requirement/evidence registry and one product version authority.

Exit criteria:

- G0 passes.
- All existing public claims are classified as proven, limited, experimental, protocol-only, planned, or removed.
- No current documentation implies working recovery, stable installation, or open-source status incorrectly.

### M1: Repository and build-system normalization

Scope:

- Create target directories and ownership without mixing behavior changes into blind moves.
- Move tests/tools/deploy/assets by responsibility.
- Archive then remove obsolete spikes after extracting relevant fixtures.
- Establish root Node workspace, root non-kernel Rust workspace, `.build`, `.local`, layout manifest, language guard, version guard, codegen manifest, and CODEOWNERS.
- Make real Web, desktop, backend, kernel, PostgreSQL, and generation jobs blocking.

Exit criteria:

- G1 passes from a fresh clone on CI and the local Mac.
- `make doctor`, full test, `make clean-all`, and `git status --porcelain` succeed.
- No documented path, generator, contract output, asset source, or configuration key is missing.

### M2: Key, recovery, and data correctness

Scope:

- Remove distributable DemoKernel and implement fail-closed kernel loading.
- Implement stable random Vault Key and independent password/recovery wrappers.
- Implement per-Vault verifier, atomic password change, recovery ceremony, encrypted backup, destructive restore, and explicit rotation generations.
- Migrate schemas to principal/Vault/item scope with safe migration/rollback.
- Make batch/import atomic and storage adapters behaviorally equivalent.

Exit criteria:

- G2 passes.
- `E2E-002` through `E2E-007` pass with crash/fault injection.
- Security review approves key hierarchy, formats, migration, and threat-model updates.

### M3: Comprehensible core product

Scope:

- Rebuild Welcome, onboarding, Vault identity, first-success checklist, item forms, dashboard, search, errors, settings, Help, Data & Backup, responsive layout, and localization boundary.
- Complete Login/Secure Note quality; classify remaining item types honestly.
- Meet WCAG automation, keyboard, reflow, contrast, and screen-reader design requirements.

Exit criteria:

- G3 passes.
- At least 5 representative new users complete the critical experience without external documentation; target metrics in Section 20 are met.
- `E2E-001` and `E2E-010` pass.

### M4: Connected service and operations

Scope:

- Implement scoped connection credential/session lifecycle.
- Fix same-origin UI/API TLS topology, CORS, headers, private networks, secrets, database roles/pool/TLS, monitoring, and bounded configuration.
- Implement real backup scheduling/verification, production-shaped restore, upgrade, and rollback.
- Produce complete operator runbooks.

Exit criteria:

- G4 passes.
- `E2E-005`, `E2E-007`, and `E2E-008` pass against a real HTTPS hostname.
- Operator game day restores an isolated environment and resolves at least one injected failure.

### M5: Four-native signed delivery

Scope:

- Build universal macOS package from native slices and native Windows AMD64/ARM64 packages.
- Implement native ARM64 MSI/MSIX or bootstrapper; do not use stock x86 NSIS for ARM.
- Implement signing, notarization, updater signing, checksums, SBOM, provenance, release manifest, and immutable candidate promotion.
- Provision Parallels Windows ARM for local manual testing and native hosted/cloud capacity for other architectures.

Exit criteria:

- G5 passes.
- `E2E-009` passes on all four native targets using final candidate bytes.
- Clean Windows security-control and macOS Gatekeeper paths show no bypass instructions.

### M6: Public beta and open-source readiness

Scope:

- Rewrite root/component READMEs and all user/install/admin/development/security/reference docs from verified behavior.
- Adopt OSI-approved license or explicitly retain source-available positioning.
- Complete contributor/community/security processes and executable docs.
- Conduct external security/cryptographic assessment appropriate to stable claim scope.

Exit criteria:

- G6 passes.
- Public Beta is a prerelease with complete assets/evidence and no misleading claims.
- New contributor performs clean setup, one change, full test, and PR workflow from documentation.

### M7: Stable 1.0

Scope:

- Resolve Beta findings, complete soak/performance/manual accessibility evidence, publish audit status, and rehearse incident/update key-loss paths.
- Approve supported OS/browser/client-server ranges and maintenance policy.

Exit criteria:

- G7 passes with no P0/P1 stable-scope failures.
- The same tested candidate bytes are promoted to Stable and Latest.
- Stable release notes and evidence index are public.

## 20. Success metrics

Metrics MUST be collected through test studies, CI, release evidence, or explicit opt-in telemetry. No Vault content is collected.

### 20.1 User comprehension and task success

| Metric | Target before Stable | Method |
| --- | --- | --- |
| Product/Vault comprehension in 30 seconds | At least 80% of 8+ representative new users correctly explain purpose and storage model | Moderated first-run study |
| Correct first action | At least 90% choose Create/Open/Import/Connect appropriate to a scripted scenario | Moderated study |
| First Login success | At least 90% save, find, and copy/reveal a Login without help | Moderated study |
| Recovery consequence comprehension | 100% correctly state what the Recovery Key can do and what happens if both password/key are lost | Moderated study |
| Backup vs plaintext export distinction | 100% identify which file is encrypted before execution | Moderated study |
| Core-flow accessibility completion | 100% of critical tasks complete by keyboard and target screen reader | Manual acceptance |

### 20.2 Correctness and release quality

| Metric | Target |
| --- | --- |
| Critical automated suite pass rate | 100%; no critical skips/quarantine |
| Four-native candidate pass rate | 100% for the exact promoted bytes |
| Recovery fixture match | 100% canonical match across every supported field |
| Backup/restore fixture match | 100% plus successful post-restore CRUD |
| Cross-Vault unauthorized access | Zero successful or existence-leaking cases beyond approved error policy |
| Known plaintext in service/storage/log evidence | Zero occurrences |
| Version/signature/provenance manifest inconsistencies | Zero |
| P0/P1 stable-scope failures | Zero at Stable |
| Documentation claim without evidence ID | Zero |
| Non-English engineering text outside allowlist | Zero |
| Build/runtime output outside `.build`/`.local` policy | Zero |

### 20.3 Operational targets

| Metric | Target |
| --- | --- |
| Scheduled backup verification | Every produced backup is verified; failures alert within the configured interval |
| Destructive restore drill | At least once per release candidate and monthly for maintained deployments |
| Dependency/security scan review | Every release candidate; critical/high disposition recorded |
| Supported security report acknowledgement | Within 3 business days; urgent credible reports triaged faster when possible |
| Stable security update policy | Defined before 1.0 with supported versions and target response windows |

## 21. Definition of Ready and Definition of Done

### 21.1 Definition of Ready for an implementation item

A work item is Ready only when:

- It references one or more PRD requirement IDs.
- User impact, affected modes, data/security impact, and supported platforms are stated.
- Acceptance examples include success, failure, interruption, and recovery behavior.
- Contract/schema/version/migration impact is identified.
- Localization, accessibility, documentation, observability, and privacy impact is identified.
- Required test layer and evidence owner are assigned.
- High-risk key, recovery, migration, authentication, signing, or destructive changes have an approved design/ADR before coding.
- Dependencies and rollout/rollback constraints are known.

### 21.2 Definition of Done for an implementation item

A work item is Done only when:

- Implementation meets the requirement without an undocumented fallback.
- Unit, contract, integration, E2E, negative, and fault tests appropriate to risk pass.
- Data preservation or rollback is proven for every failure path.
- Security/threat model/contracts/migrations are updated and reviewed where applicable.
- English policy and i18n catalog parity pass.
- Keyboard, labels, error/status behavior, and responsive layout are verified for UI changes.
- Documentation and feature/evidence status are updated from behavior.
- Version, generated output, SBOM/dependency, and release implications are handled.
- No new warning, secret exposure, flaky critical test, ignored case, or dirty generated diff remains.
- Evidence is linked to the work item and survives outside local developer state.

## 22. Risk and decision register

| ID | Decision/risk | Current direction | Owner deadline | Consequence if unresolved |
| --- | --- | --- | --- | --- |
| `DEC-001` | License strategy | Choose OSI-approved permissive or network-copyleft license; otherwise remain source-available | M0/M6 | Cannot call the project open source |
| `DEC-002` | Connected identity/session protocol | Scoped per-device/per-Vault credential; exact pairing/session ADR required | Before M4 implementation | Connected mode remains unsupported |
| `DEC-003` | Minimum OS/browser versions | Use actively supported versions and explicit native runner baselines | Before M5 | Cannot publish support matrix |
| `DEC-004` | Windows ARM package technology | Native ARM64 MSI/MSIX or custom native bootstrapper; no stock NSIS | Early M5 | Windows ARM release blocked |
| `DEC-005` | Recovery and backup wire format | Stable Vault Key with password/recovery wrappers; exact format security-reviewed | Before M2 implementation | Recovery/backup claims blocked |
| `DEC-006` | Vault Key rotation in 1.0 | Implement only if staged generation model meets gates; otherwise classify Planned | M2 scope lock | Do not expose unsafe rotation UI |
| `DEC-007` | Secondary item types | Stable only with full lifecycle/export/backup coverage | M3 scope lock | Mark Beta/Experimental or hide |
| `DEC-008` | Connected Web offline behavior | Promise only tested behavior; desktop local remains offline default | M3/M4 | Remove offline/PWA claims |
| `DEC-009` | Trash retention | Local default 30 days; connected policy must be explicit | M3/M4 | Unclear deletion expectations |
| `DEC-010` | Telemetry | Disabled by default; test studies and opt-in only | M3 | Privacy claim conflict |
| `DEC-011` | Approved brand source | Select one source and regenerate all derived assets | M1/M6 | Inconsistent public identity/assets |
| `DEC-012` | External audit scope | Define crypto, client, backend, deployment, and release scope before Stable | M6 | Stable security claims limited |

### 22.1 Principal risks

| Risk | Likelihood/impact | Mitigation |
| --- | --- | --- |
| Data model migration strands preview data | High/high | Versioned preflight, verified backup, fixture corpus, N-1/N migration, no silent overwrite |
| Recovery design is implemented without independent review | Medium/critical | Security ADR, vectors, external crypto review, clean-state destructive tests |
| Repository move creates a long unreviewable diff | High/medium | Mechanical moves first, preserve history, behavior changes in separate PRs, path guards |
| Four-native CI labels/services change | Medium/high | Assert actual architecture, pin explicit labels, maintain leased/self-hosted fallback |
| Windows ARM packaging tool emits x86 custom actions | Medium/high | Recursive PE/MSI inspection and no-emulation launch gate |
| Signing/updater key is lost or compromised | Medium/critical | Custody, offline backup, minimal access, rotation/revocation/key-loss drill |
| README is rewritten before implementation and repeats false claims | High/high | Feature/evidence registry first; documentation generated/checked last |
| Security terminology overwhelms users again | High/medium | Plain-language copy, progressive disclosure, usability studies |
| Automated accessibility gives false confidence | High/high | Required manual keyboard and screen-reader release evidence |
| Preview users store real credentials despite warning | Medium/critical | Prominent in-app warning, prerelease channel, fail closed, no stable badges |

## 23. Traceability from current findings to target evidence

| Current finding at evidence commit | Primary requirement IDs | Required regression/evidence |
| --- | --- | --- |
| Web silently selects pass-through DemoKernel | `SEC-CRYPTO-001` to `SEC-CRYPTO-003`, `QA-003`, `QA-004` | Missing/corrupt WASM hard failure; known plaintext absent from network/storage/logs |
| Recovery material does not unwrap existing data key | `REC-001` to `REC-007`, `SEC-KEY-003` | `E2E-003` on non-empty Vault with clean state |
| Empty Vault accepts arbitrary password | `UX-AUTH-001`, `UX-AUTH-002`, `DATA-003` | `E2E-002` with unchanged digests |
| Password change can seal with old salt/key state then commit new salt | `SEC-KEY-001` to `SEC-KEY-003` | `E2E-004` plus crash at every commit boundary |
| Vault Key rotation relies on best-effort rollback | `SEC-KEY-004` to `SEC-KEY-006` | Interrupted/resumed generation rotation |
| Database primary key is only record ID | `DATA-001` to `DATA-004`, `API-001` | `E2E-005` collision and authorization matrix |
| Server returns records and client filters by local salt | `DATA-002`, `API-001`, `PRIV-005` | Query-scope instrumentation and cross-Vault negative tests |
| Batch endpoint loops per record while docs claim atomic | `DATA-007`, `IMP-001`, `API-010` | `E2E-006` injected row/database failures |
| Desktop/server portability docs omit required local metadata | `BAK-001` to `BAK-006`, `MIG-001` | Portable backup restore on clean machine across modes |
| Restore ignores conflicts/defaults fields and reports input count | `BAK-004`, `BAK-005`, `DB-005` to `DB-007` | Explicit reject/merge/replace policy with exact counts |
| Backup drill does not destroy primary or validate restored behavior | `BAK-006`, `QA-006`, `DEP-011` | `E2E-007` and scheduled operations drill |
| Production TLS sends `/` to API while Web is loopback-only | `DEP-001`, `DEP-002`, `DEP-009` | `E2E-008` on real hostname |
| Browser token auth lacks secure provisioning; local storage used | `UX-AUTH-007`, `UX-AUTH-008`, `API-002`, `DEP-004` | Provision/rotate/revoke/expire/session storage tests |
| CORS/auth/header behavior does not match connected product | `API-003`, `SEC-WEB-001` to `SEC-WEB-003`, `DEP-009` | Browser preflight and real-response contract matrix |
| Desktop CSP is null and loopback service is permissive | `SEC-WEB-004`, `SEC-WEB-005` | Tauri CSP/capability tests and loopback threat review |
| Security header contract differs from nginx/gateway response | `DEP-009`, `SEC-WEB-001` to `SEC-WEB-003` | Generated/checked header contract against HTTPS |
| PostgreSQL integration is ignored; pool/TLS/validation weak | `DB-001` to `DB-007`, `QA-005` | Blocking PostgreSQL integration/failure suite |
| Comprehensive browser E2E uses a shell success bypass | `QA-001`, `QA-003`, `QA-015` | Critical suite blocks and proves state preservation |
| CI validates desktop spike, not shipping Tauri app | `REPO-003`, `QA-002` | Real packaged desktop smoke in pull requests/releases |
| WASM has multiple output paths and stale README path | `REPO-006` to `REPO-008` | One generator/destination and zero-diff clean build |
| Contracts projections are duplicated; claimed generator/output missing | `REPO-006`, `REPO-008`, `MIG-001`, `MIG-005` | Codegen manifest plus consumer compatibility suite |
| Deployment Dockerfiles are split across product/backend ownership | `REPO-004`, `DEP-007` | Layout manifest and image build matrix |
| Root scripts mix lint, E2E, smoke, release, deploy, and restore | `REPO-001`, `REPO-003`, `REPO-004` | Target directory migration and ownership checks |
| Local checkout contains multi-gigabyte scattered targets | `REPO-012`, `REPO-013`, `REPO-014` | Unified `.build`, bounded disk, clean-all |
| Root runtime data path and backup output can pollute checkout | `REPO-002`, `REPO-014`, `REPO-017`, `INST-006` | Root doctor and safe data-location tests |
| Backend Rust and generic tests contain translated messages | `LANG-001` to `LANG-004`, `API-004` | Script/AST scan and client localization contract |
| Locale checker permits missing keys as warnings | `LANG-005`, `LANG-008` | 100% parity/placeholder/plural release gate |
| Root README contains non-English badges despite English-canonical claim | `LANG-001`, `DOC-001` | Canonical README English scan |
| READMEs claim recovery, atomic import, offline, MSI, and platform support without evidence | `DOC-001`, `DOC-002`, `DOC-005` to `DOC-008` | Feature registry, executable docs, release API comparison |
| Contracts README lists missing/omitted directories | `DOC-005`, `REPO-008` | Filesystem-to-doc inventory check |
| Worker README overstates maintenance behavior | `DOC-001`, `DOC-002` | Capability status generated from evidence |
| Public release is Latest while product says Preview | `REL-011`, `REL-012` | GitHub Release API channel assertion |
| Product versions are inconsistent and move backward | `REPO-010`, `REPO-011`, `REL-010` | Single version authority and monotonic tag guard |
| PolyForm Noncommercial is marketed toward future open source | `OSS-001` to `OSS-003` | OSI-approved license or source-available wording everywhere |
| Universal DMG is unsigned/unnotarized | `REL-004`, `REL-005`, `INST-002`, `INST-005` | Native Intel/ARM final-DMG installation and Apple verification |
| Windows x64 EXE is unsigned and MSI claim is false | `REL-006`, `INST-002`, `INST-004`, `DOC-005` | Native AMD64 signed MSI install/update/uninstall |
| Windows ARM package does not exist | `REL-001` to `REL-003`, `INST-002` | Native ARM64 MSI/MSIX architecture and launch report |
| Apple Silicon cannot natively host Intel macOS/AMD64 Windows guests | `REL-001`, `REL-002`, `QA-007` | Explicit hosted native runners and leased manual host evidence |
| No complete release checksums/SBOM/provenance evidence | `REL-007` to `REL-009`, `SEC-ASSURE-004` | Verified release evidence bundle |
| Settings expose technical internals and weakly warn about plaintext export | `UX-ONB-001`, `EXP-001` to `EXP-004`, Section 7.2 | Comprehension and high-risk operation tests |
| Mobile search clips and navigation overflows | `ACC-007`, `NAV-002`, `NAV-003` | Reflow/narrow-viewport core journey |
| Icon-only critical controls and absent manual AT evidence | `ACC-003` to `ACC-005`, `ACC-012` | `E2E-010` manual/automated report |

### 23.1 Current evidence anchors

These anchors refer to the evidence commit and are not target paths. Line movement after implementation does not erase the finding; the mapped requirement and regression close it.

| Finding | Current repository evidence | Notes |
| --- | --- | --- |
| Pass-through DemoKernel and silent fallback | `frontend/web/src/core/kernel.js:82-123`, `:239-254` | Plaintext-like payload with a small tag may be selected after WASM failure |
| Root/Web WASM-only claims | `README.md:45-49`, `:61-62`; `frontend/web/README.md:3-5`, `:37-41` | Public claims and fallback disclosure contradict each other |
| Recovery token not used to unwrap existing data | `frontend/web/src/core/vault.js:37-55`; `frontend/web/src/views/entry-flow.js:393-417` | Recovery path validates syntax and derives a new password key |
| Recovery claims | `README.md:65`, `:76`; `docs/USER-GUIDE.md:24-35` | User-facing language promises more than implementation proves |
| Empty Vault permissive verification | `frontend/web/src/core/records.js:123-143` | Missing candidates can return success |
| Password change inconsistent encryption context | `frontend/web/src/core/records.js:193-256`, `:324-351` | New metadata can be committed after sealing under stale context |
| Test preserves the problematic identity behavior | `frontend/web/test/records.test.mjs:140-172` | Existing unit expectation is not target correctness |
| Global record primary key | `backend/crates/postgres/migrations/0001_records.sql:5-18` | Vault/principal scope is absent from the key |
| Client-side Vault filtering and local token | `frontend/web/src/core/records.js:27-59` | Scope/auth depend on local state rather than server authorization |
| Batch implemented as per-record loop | `backend/services/api/src/lib.rs:367-393` | No database-wide atomic transaction is demonstrated |
| Public TLS routes all paths to API | `docker/gateway/envoy.yaml:79-83` | Web UI is not served on the public TLS origin |
| Web service loopback-only | `docker/docker-compose.yaml:139-156` | Contradicts production public Web guidance |
| Backup scheduling/first-run semantics | `docker/docker-compose.yaml:158-172` | Sleeps before first backup and lacks atomic verified output contract |
| Desktop CSP absent | `frontend/desktop/src-tauri/tauri.conf.json:9-14` | Stable desktop policy is not enforced |
| Permissive embedded loopback API | `frontend/desktop/src-tauri/src/server.rs:1-100` | Auth, CORS, and body-limit posture needs a dedicated desktop threat model |
| Restore/backup drill is not destructive | `scripts/backup-restore-drill.sh:16-59` | Does not restore into an empty destination and prove application behavior |
| Persistence validation and PostgreSQL pool/TLS gaps | `backend/crates/persistence/src/lib.rs:109-119`; `backend/crates/postgres/src/lib.rs:23-58` | Boundaries and connection policy are insufficiently explicit |
| Header contract/implementation drift | `contracts/web/security-headers-v1.json:1-13`; `docker/web/nginx.conf:12-20` | Contract presence does not prove response behavior |
| Comprehensive Web E2E non-blocking | `.github/workflows/ci.yml:178-184` | Failure is converted into workflow success |
| CI tests obsolete desktop spike | `Makefile:20-21`; `.github/workflows/ci.yml:34-36` | Shipping Tauri app is not the checked desktop target |
| Spike evidence is explicitly unverified | `frontend/spikes/m0-desktop/evidence/windows.json:1-15`; `macos.json:1-14` | Cannot satisfy native platform support |
| Conflicting WASM output paths | `Makefile:29-33`; `security-kernel/scripts/build-wasm.sh:44-71`; `security-kernel/README.md:28-37` | Includes a nonexistent documented path |
| Duplicate/missing contracts generation chain | `backend/crates/contracts-generated/src/lib.rs:1`; `security-kernel/crates/kernel-core/src/contracts_generated/mod.rs:1`; `contracts/README.md:32-34` | Generator and claimed TypeScript projection are not present as described |
| Deployment ownership split | `docker/README.md:3-6`, `:36-50`; `.github/workflows/publish-images.yml:98-133` | Dockerfiles and canonical deployment ownership are separated |
| Empty backend integration host presented as backend package | `backend/Cargo.toml:1-25`; `backend/src/lib.rs:1-3` | Root crate has no runtime export |
| Clean target omits largest output | `Makefile:105-107` | Desktop Cargo target and Node/generated output remain |
| Root backup output | `Makefile:85-91` | Can write `snapshot.json` into source root |
| Embedded backend translations | `backend/services/api/src/error_catalog.rs:32-154`, `:259-272` | Violates English-only source boundary |
| Generic E2E translated selectors | `scripts/test-browser-full.mjs:105-112`, `:167-169` | Business flow is coupled to selected translations |
| Source locale names | `frontend/web/src/i18n/registry.js:9-20` | Native display names belong in localization metadata/catalogs |
| Root README non-English badges | `README.md:28-39` | Canonical engineering document is not English-only |
| Partial language checker exceptions | `scripts/check-repository.py:115-153` | Checks limited scripts and explicitly allows several violations |
| Desktop hard-coded first-run/menu copy | `frontend/desktop/src-tauri/src/setup.js:74-136`; `frontend/desktop/src-tauri/src/lib.rs:434-450` | Desktop copy is not consistently catalog-driven |
| Locale missing keys are warnings | `frontend/web/tools/check-locales.mjs:82-100` | Shipped locale parity is not release-blocking |
| Misplaced desktop setup JavaScript | `frontend/desktop/src-tauri/src/setup.js` | JavaScript sits alongside Rust source without a clear frontend ownership boundary |
| Fragile desktop dependencies into backend | `frontend/desktop/src-tauri/Cargo.toml:25-27` | Desktop crosses product domains with deep relative paths |
| Asset source inconsistency | `docs/brand/BRAND_GUIDELINES.md:8-14`; `frontend/web/assets/brand/`; `frontend/desktop/assets/`; `frontend/desktop/src-tauri/icons/` | No approved single source despite distributed derived assets |
| Duplicate font binaries declared as different weights | `frontend/web/assets/fonts/fonts.css:11-18` | Resource duplication and synthetic weight behavior are unclear |
| Version drift | `backend/Cargo.toml:25-28`; `security-kernel/Cargo.toml:17-20`; `frontend/desktop/package.json:1-4`; `frontend/desktop/src-tauri/tauri.conf.json:1-5` | Product components do not share one authority |
| Desktop release matrix incomplete | `.github/workflows/desktop-release.yml:22-30` | Windows x64 and macOS universal only |
| Windows MSI public claim but no target | `README.md:157-160`; `frontend/desktop/src-tauri/tauri.conf.json:16-18` | Config lists NSIS/app/DMG, not MSI |
| Every-tag installer claim is false | `README.md:162` | Public tags/releases/assets are not one atomic set |
| PWA covers iOS claim unsupported | `README.md:166-167` | No real iPhone support/installation/offline matrix |
| Non-OSI license | `LICENSE`; `README.md:251-257` | Correctly source-available, not open source |

## 24. Initial execution backlog

This order minimizes repeated work and prevents documentation from becoming a polished version of false behavior.

| Sequence | Work package | Dependencies | Primary IDs | Completion signal |
| ---: | --- | --- | --- | --- |
| 1 | Freeze stable claims and correct release channel/status | None | `DOC-001`, `DOC-002`, `REL-011`, `REL-012`, `OSS-002` | Public surfaces match evidence |
| 2 | Establish requirement/evidence registry and version authority | 1 | `DOC-001`, `REPO-010`, `REPO-011` | CI rejects drift |
| 3 | Make Web crypto fail closed and remove distributable DemoKernel | 2 | `SEC-CRYPTO-001` to `003`, `QA-003`, `QA-004` | Known-plaintext and missing-WASM tests pass |
| 4 | Approve key/recovery/backup ADR and format | 2 | `REC-*`, `BAK-*`, `SEC-KEY-*`, `MIG-001` | Security approval and vectors |
| 5 | Implement scoped schema, verifier, atomic password change, recovery, backup/restore, batch/import | 3-4 | `DATA-*`, `REC-*`, `BAK-*`, `IMP-*`, `SEC-KEY-*` | `E2E-002` to `E2E-007` |
| 6 | Normalize repository ownership, language, workspaces, codegen, build paths, real CI | 2; may run alongside 4-5 in mechanical PRs | `LANG-*`, `REPO-*`, `QA-001`, `QA-002` | G1 passes |
| 7 | Rebuild Welcome/core UX/errors/settings/help/accessibility | 3-6 | `UX-*`, `ITEM-*`, `NAV-*`, `EXP-*`, `ACC-*` | `E2E-001`, `E2E-010`, user study |
| 8 | Implement connected auth and production topology | 5-7 | `API-*`, `DEP-*`, `DB-*` | `E2E-008` |
| 9 | Implement four-native packages, signing, updater, evidence | 5-8 | `REL-*`, `INST-*`, `UPD-*` | `E2E-009` |
| 10 | Select OSI license and complete public/community docs | Evidence from all earlier work | `OSS-*`, `DOC-*` | G6 passes |
| 11 | External assessment, soak, Beta remediation, Stable decision | 1-10 | `SEC-ASSURE-*`, `PERF-*`, G7 | Same bytes promoted to Stable |

### 24.1 Execution progress marker

This table records implementation progress without changing or weakening any
requirement above. A work package is `Complete` only when its completion signal
in the initial execution backlog is satisfied; code changes or temporary risk
containment alone are `Partial`. The machine-readable handoff authority is
[`release/prd-progress.json`](release/prd-progress.json), which records evidence
paths and the exact remaining scope.

Last updated: `2026-09-06T14:30:00+08:00` (sequence-8 mechanical window: API-006
readiness semantics, complete DEP-006 non-root/read-only containers, DEP-007 partial
healthchecks/limits; `2026-09-05`).

| Sequence | Marker | Evidence summary / remaining boundary |
| ---: | --- | --- |
| 1 | 🟡 `Partial` | Repository claims and future release workflows are corrected; existing published GitHub release metadata/status still requires an external audit and correction. Reproducible unblock tooling: audit-releases.py dry-run passes (repository-side tag/version gates validated); --live gives the owner a one-command published-release audit once GitHub access is authorized. |
| 2 | ✅ `Complete` | Version, feature/evidence, and kernel-asset authorities exist and repository checks reject drift. |
| 3 | ✅ `Complete` | Web crypto fails closed; DemoKernel is absent; digest, WASM, randomized self-test, cache, impostor, and known-plaintext regressions pass. |
| 4 | 🟡 `Partial` | A proposed key/recovery/backup lifecycle ADR, machine contract, CDDL, review schema, and hash-bound vector checks exist. Qualified independent human security approval and qualified vector review remain; sequence 5 stays gated. |
| 5 | 🟡 `Partial` | Unsafe unsupported controls are contained. Experimental (non-supported) implementation has begun within the sequence-4 gate: DATA-001/002/004 landed — record identity is (vault_id, record_id) across the persistence port and all three adapters (PostgreSQL/SQLite each gained a composite-PK migration 0002), the API requires a declared `?vault=` scope on every read/delete/purge and validates envelope identity on writes, the web client carries the scope, and new unit + live tests prove the E2E-005 collision scope (identical record IDs in two vaults stay isolated; cross-scope reads are 404; missing scope is `PM-API-BAD-QUERY`). Full browser regression green on pristine stores (60/60, 18/18, 20/20). DATA-007/API-010 are complete in the server scope: `put_batch` is a true single transaction in both SQL adapters (any row failure rolls the whole batch back), `/records/batch` is all-or-nothing with exact requested/committed counts and mixed-vault-scope rejection, proven by unit + live rollback tests, and the web import client consumes the exact-count contract — followed by a second consecutive pristine full-browser regression (60/60, 18/18, 20/20 plus smokes). DATA-005/006 are complete in the server scope: listings are paginated with a strict limit cap (oversized limits are stable-code rejections, `x-truncated` marks pages, the embed path has its own 500-row maximum and the client pages large vaults), and compare-and-set conflicts answer 409 with the server-authoritative `parameters.current_revision` — proven by blocking tests plus live-stack evidence, with the full pristine browser regression green afterward. The mandated browser page/flow inventory exists at `docs/browser-test-inventory.md` with seven honestly recorded coverage gaps. The declared-scope model is interim until ADR 0005 principals; DATA-003 is complete in the experimental scope (the verifier record id is derived per vault — `veyora-verifier-v1-<salt>` — with legacy global-id vaults migrating on unlock: scoped verifier written first, legacy tombstoned after, crash-safe and idempotent; four blocking unit tests including two-vault empty/non-empty independence, 89/89 web units, and the pristine browser regression green). DATA-008 is complete in the experimental scope: tombstones carry a deletion stamp (set on soft-delete, cleared on restore, migration 0003 backfills pre-migration rows at the migration epoch so retention never fires early), purge is one cutoff-scoped operation shared by the API's `/vault/purge` and the worker's retention sweep (`VEYORA_TRASH_RETENTION_DAYS`, default 30, zero-disables, underflow-saturating cutoff), proven by live backdating tests and a green pristine browser regression. DATA-010 is complete in the experimental scope: `backend_persistence::contract` runs one identical behavioral suite (round trips, CAS, vault isolation, paging, atomic batches, tombstone lifecycle, cutoff-boundary purge) against SQLite, live PostgreSQL, and the in-memory reference — plus the dev-path fix that `PostgresStore::migrate()` now reaches the real scoped-PK schema. DATA-009 is complete in the web scope: destructive Reset is a labeled four-scope matrix in Settings → Data (device preferences, saved connection, this device's vault copy with its orphan consequence named, and delete-everywhere which deletes the service scope first — verifier row included — and removes nothing locally on failure), proven by five scope-boundary unit tests and two real-service browser journeys ending with an empty vault-scope audit (66/66 twice consecutively, 448-key locale parity). The Master Password change is now an atomic server-side vault rekey (experimental scope): a new single-transaction store operation moves every re-sealed row to the fresh salt and deletes the old scope in one step across all three adapters (contract-suite and live-PostgreSQL proven, with target-collision rollback), exposed as POST /vault/rekey and consumed by a rewritten client flow with a crash-safe pending-rekey marker and unlock-time resolution — the previous flow silently orphaned the whole service scope. The Settings → Security ceremony is implemented: creation-strength validation, inline failure classes (wrong current password, pending offline writes), unlock-time resolution of an interrupted change, and a blocking browser journey that changes the password through the UI and unlocks with the new one against the live service (67/67 twice consecutively) — the journey also fixed two real defects: Trash state was resurrected by a rekey (tombstones now travel with a purgeable deletion stamp, proven in the adapter contract), and a u64::MAX purge cutoff wrapped negative in the SQL adapters. Encrypted portable backup and restore are complete in the web scope (EXP-001): a portable password-sealed `veyora-backup` envelope (per-entry seals respecting the kernel's per-record plaintext limit, concatenated-plaintext digest), master-password re-auth on create, inline failure classes, and a restore ceremony that merges through the atomic batch with id de-duplication and a post-restore service audit — 68/68 twice consecutively plus the full suite set. E2E-002/004/005/006/007 are covered by blocking browser journeys (a new dedicated suite plus the fault suite's dead-store change leg): digest-invariant wrong-password rejection, cross-vault isolation with colliding ids audited server-side, all-or-nothing imports with exact counts, destructive restore into an emptied destination with hostile-input rejections, and a 100-item password change that fails against a dead store while the old password and every record stay usable — all twice consecutively, and the journeys fixed a real defect (vault.reset() left destroyed-vault entries in memory, which rendered into a later vault). The Recovery Key architecture is implemented (REC-001..005, web scope): a wrapped Vault Key with password and kit-scoped recovery wrappers (fresh-device discoverable), transparent legacy migration (zero record rewrites), wrapper-only password changes, and verifier-proven recovery that adopts the vault and sets a new password — E2E-003 passes as a blocking journey on a fully wiped device (malformed kit refused, every item recovered, old password dead, new password + CRUD working; journeys 5/5 twice consecutively, comprehensive 68/68 twice). REC-006 and REC-007 are complete: the regeneration ceremony re-authenticates, writes the new kit's wrapper first, revokes the old kit's wrapper (recovery treats a tombstoned wrapper as dead), creates and verifies a backup before reporting success, and states the revocation consequence — proven by a blocking journey on wiped state (old kit dead, new kit recovers; journeys 6/6 twice consecutively) — and the terminology rule is machine-enforced by a lint in `make check` across all ten catalogs and the shipped docs. UX-ONB-007 is complete: creation presents the real Recovery Key with copy and storage guidance and requires a verified re-entry before the onboarding step completes (wrong entries refused inline), the checklist's recovery and backup steps are real, and Settings offers View/verify — covered by blocking journeys with every suite's creation helper walking the real ceremony (comprehensive 69/69 twice consecutively). E2E-001/008 remain (native install and a real HTTPS hostname). |
| 6 | 🟡 `Partial` | Layout authority and enforcement, tooling responsibility moves, spike archival, shipping-desktop CI, blocking browser E2E, CODEOWNERS, the full `apps`/`services`/`packages`/`deploy` migration with one root non-kernel Rust workspace and one root Node workspace/lockfile, the `sandbox`→`validator` rename, `.build` transient-output routing with verified `clean`/`clean-all`/`doctor`, and the security-kernel move to `packages/security-kernel` all landed (REPO-004 complete). Codegen is now single-sourced and CI-gated: `tools/codegen/manifest.json` plus `make check-codegen` bind the registry projection, Rust config projection, both contract bindings, and the WASM assets to generators, digests, and deterministic checks, and the previously missing `generate-bindings.py` producer exists with a reproducible `CONTRACT_SOURCE_DIGEST` (REPO-006/007/008). Shipped-locale parity is release-blocking (LANG-005), the LANG-002 path-style lint is enforced, and the generic E2E and root README left the CJK allowlist. LANG-003 is implemented: the API returns only stable ASCII codes with fixed English messages (no translated prose, no `Accept-Language` negotiation), the client renders localized errors from `apiError.*` keys in all ten locale catalogs, and the last source CJK allowlist entry is removed. The fresh-clone G1 run passed on the local Mac (clean clone of the migrated tree, `npm ci`, repository check over 377 tracked files, `git diff --check` both staged and unstaged, `make check-codegen` from a cold `.build`, web/locale/codegen/contract/cargo test suites, then `make clean-all` leaving zero untracked entries and a bounded ~53 MB checkout); the run surfaced and fixed real drift (the layout manifest now allows the `*.rs` contract-binding template under `tools`, trailing-whitespace/EOF defects were removed, and the bindings were regenerated with refreshed manifest digests). Remaining: GitHub-runner verification of the migrated CI plus the new codegen gate, and the DATA-003 scoped-verifier fix once sequence 4 is approved. The CI browser harness now installs its dependencies from the root Node workspace with `npm ci` instead of an ad-hoc `/tmp` `npm install`, and runs both suites from the checked-in `tests/e2e/web` scripts (locally verified for module resolution and browser launch; first GitHub-runner run still pending the owner's push). |
| 7 | 🟡 `Partial` | Trash restore, keyboard navigation, truthful unsupported controls, scoped search/filter/empty states (NAV-002/003/004/005), and delete-to-trash Undo (ITEM-008 partial) are implemented. The Welcome and pre-create surfaces explain the product, Vault, connected mode, storage, password rules, unavailable recovery, and the fact that plaintext CSV export is not encrypted backup (UX-ONB-001/004 implementation). Master Password creation now enforces a 15-character composition-free floor, preserves long Unicode/space input with a keyboard-accessible Show/Hide control, and screens against an embedded local common-password list that never leaves the device (UX-ONB-005/006 partial; threat-model approval and autofill manual evidence remain). Successful saves present Back/Copy/Add actions (ITEM-007), rejected edits stage changes without replacing the last saved in-memory value (ITEM-006/QA-015 partial), and save/error surfaces have accessible status/alert semantics (ACC-003/010/011 partial). Task-routed Help is verified from Welcome, Locked, and Unlocked states, includes Connect and private security-report routing, restores focus, and describes unavailable recovery/backup/restore/pairing honestly (HELP-001/002 automated Web scope). A validated, persisted 30-day Trash-retention preference is visible without claiming automatic purge (ITEM-009 partial). A dismissible Start here checklist now guides first login/import, copy/reveal, lock, and (honestly marked unavailable) recovery verification and encrypted backup, with persisted progress, auto-hide on completion, and reopening from Help (UX-ONB-008/009 automated Web scope). Search matches a single documented field set via `data/search.js`, runs device-local, and is proven to send no query to the service (NAV-006); an in-app Keyboard shortcuts dialog documents every shortcut and the never-in-a-field guarantee (NAV-007). Encrypted backup and plaintext export are now separate Settings → Data actions (EXP-001): `Create encrypted backup` is shown honestly as unavailable in this preview, while `Export plaintext data` opens a ceremony with an always-visible not-encrypted warning, a mandatory acknowledgement, and real master-password re-authentication against the stored verifier via a new `recordSync.verifyPassword` primitive (EXP-002); the completion view repeats `Not encrypted`, names the file, lists included and omitted fields, and gives safe deletion guidance (EXP-003). Web downloads are all-or-nothing by construction (full serialization before the Blob), while the desktop temp-file/atomic-rename fault-injection path of EXP-004 remains open. The Login form now opens with Name, Username, Password, and Website and hides TOTP/Notes behind a `More fields` disclosure (ITEM-002), the name field uses the `GitHub - Work` recognition example with an explanatory hint (ITEM-003), secret inputs are masked with named Generate/Show-Hide/Copy actions (ITEM-004), and TOTP accepts both `otpauth://` URIs and Base32 with whitespace normalization, an inline malformed-input rejection that preserves the form, and save-time normalization (ITEM-005 web implementation; keyboard/screen-reader manual evidence and form-task study remain). First-success instrumentation exists for test builds (UX-ONB-010 implementation): an opt-in-only local recorder measures a saved Login followed by search and copy/reveal — never Vault creation — storing event names and timestamps with no Vault content; the privacy review and test-event inspection remain. The Welcome screen now offers the four PRD routes — Create, Open (with an honest no-vault-on-this-device note), Import (password-first explanation, landing in Settings → Data), and Advanced connect (UX-ONB-002 web/shared-UI scope) — and boot probes the records endpoint so an explicit 401 renders a Connect / Sign-in gate before any vault create or unlock surface, using the service URL plus operator-issued deployment token with honest copy that full pairing awaits connected mode (UX-ONB-003 web implementation; desktop-native routing, a live token-auth verification, and the sequence-8 scoped pairing model remain). ITEM-006 is implemented for the web client: failed saves render a dedicated status banner that names the failure class and states that the vault was not changed — network/service failures offer an idempotent `Retry save` (same id and compare-and-set revision, so retries cannot duplicate the item), 409 conflicts preserve the edits and offer `Reload latest version`, and other rejections surface the API error with retry; successful saves report `Synchronized with the service — revision N` (ITEM-006/QA-015). DIAG-001 is implemented for the web client: a Settings Diagnostics panel shows the product version, the image build stamp (VEYORA_BUILD_COMMIT rendered into veyora-config.js at container start; unstamped builds state so honestly), the connected-vault mode, a safe storage summary (encrypted records at the origin host only — never the full URL or token), a live /healthz probe, the last successful synchronization timestamp recorded by every successful fetch/save, and an honest not-available status for the last verified backup; unit tests pin the redaction boundary and browser E2E proves no master password, entry secret, or token material appears in the drawer. All ten locale catalogs have 409-key parity and the comprehensive browser suite passes 58/58 plus the smoke suite. DIAG-003 is complete: the API error catalog is closed and machine-enforced — every `PM-*` literal in the API sources must be cataloged, every catalog code must appear in `docs/reference/api.md` (and vice versa), and previously escaping axum `Json`/`Query` extractor rejections now fail through the stable-code envelope with the new `PM-API-BAD-QUERY` code (blocking cargo tests plus live-stack verification; the client ships the matching locale key in all ten catalogs). DIAG-002 is implemented for the web client: Settings → Diagnostics offers an opt-in `Prepare support bundle` action that builds the bundle only on request, previews the full redacted text in an overlay stating that Veyora never uploads it, and copies only through an explicit Copy button with no automatic submission path by construction; unit canary tests prove connection tokens, full URLs, and paths cannot reach the bundle, and browser E2E asserts the preview contents and secret absence (desktop/native support-bundle evidence remains). Field-level save validation is complete for the web entry form (ACC-010 web scope): every field carries an inline error slot and describedby chain, failed saves report all problems at once with `aria-invalid` state, a focusable error summary with per-field links appears for multiple errors, a single error focuses its field, input is preserved, and editing clears each field's own error; the automatic clipboard clear is now announced (with a failure variant) as a polite status message (ACC-011). EXP-004 is now complete across surfaces: the desktop native file-writing path (Vault → Export Backup, and startup snapshot copies) finalizes through a new temp-file + flush + atomic-rename helper with failure cleanup, proven by five fault-injection unit tests in `apps/desktop/src-tauri/src/atomic_file.rs` (an interrupted export keeps a valid older file byte-identical and deletes every partial temporary file), while web downloads remain all-or-nothing by construction. UX-ONB-003 gained its live token-auth verification: `tests/e2e/web/verify-token-gate.mjs` runs against a real `VEYORA_API_AUTH=token` stack and proves the stable 401 envelope for missing/wrong tokens, that a fresh browser gates on Connect / Sign in with no create/unlock surface, that the live service refuses a wrong connection token, and that the real deployment token enters the Welcome routes (the sequence-8 scoped pairing model remains). The automated portion of E2E-010 is now machine-checked: a new blocking browser suite (`tests/e2e/web/test-browser-accessibility.mjs`, also wired into CI after a pristine-store reset) audits the Welcome routes, Connect gate, create form, dashboard, entry modal, password generator, item drawer, Settings drawer, and Help overlay for accessible names (ACC-003), persistent visible labels on data-entry fields (ACC-002), rendered text contrast in both light and dark themes with element opacity blended in (ACC-006), 24×24 CSS px pointer targets (ACC-008), and 320 px reflow with no document-level horizontal scrolling (ACC-007), passing 18/18; the audit exposed and fixed real defects — 1:1 contrast on the focused Welcome route tile and the selected item-type template, ~3:1 tertiary text in both themes, a white-on-white `More fields` hover, sub-24 px targets (custom checkbox, length slider, back link), missing accessible names (settings selects now `aria-labelledby` to their visible labels, sort control, generator checkboxes), and 63 px of forced horizontal scrolling at 320 px (the top bar now wraps: full-width search row, wrapping actions, single-column diagnostics grid). The manual keyboard/screen-reader/zoom/native portions of E2E-010 and ACC-001/004/005/012/013 remain. The automatable keyboard and focus scope is now machine-checked: a second blocking browser suite (`tests/e2e/web/test-browser-keyboard.mjs`, wired into CI after a pristine-store reset) proves the WAI-ARIA dialog pattern for the entry modal, password generator, settings drawer, Help overlay, and shortcuts dialog (focus moves into the dialog, Tab/Shift+Tab cycles stay inside it, and closing with Escape or the close control returns focus to the opener — including the generator layered over the entry form), verifies ACC-005 by focusing every reachable control on the dashboard, entry modal, and settings drawer and asserting the element at its interaction point is the control or its own content, and checks 200% zoom reflow at 640 CSS px (half the 1280 base viewport) with no document-level horizontal scrolling and primary actions on-screen; it passed 20/20 across three consecutive local runs. That audit exposed and fixed three more real defects: the focus trap targeted the first open overlay in DOM order instead of the topmost (the generator opened over the entry form could escape the trap into the modal behind), the dashboard theme toggle rendered empty because the theme icon was applied before the dashboard existed, and the fixed 34 px `.tb-lock` width made the text-bearing shortcuts/help buttons paint their content over adjacent topbar buttons (now auto-sized with a 34 px floor, and the wrapped actions row is width-bounded so 320 px reflow still passes 18/18). Manual screen-reader, VoiceOver/NVDA, native-desktop, and remaining zoom evidence for ACC-001/004/012/013 and E2E-010 still remain. A machine-checked manual-evidence capture kit now exists (`docs/evidence/manual-evidence/` plus `tools/lint/check-manual-evidence.py`, run by `make check` and CI): every pending manual activity — 21 records covering ACC-001/004/012/013, E2E-010 manual, UX-ONB copy/platform/privacy/threat evidence, EXP-002/003 and HELP-002 copy reviews, ITEM-002..005 form studies, and the DIAG-001/002 and ITEM-006 desktop portions — has a structured record template that a human must fill with method, environment, named operator, date, and existing artifact paths before it may leave `Pending`; the checker refuses unknown or duplicate requirement coverage and any filled record without artifacts, so the templates prepare but never impersonate the human evidence. DIAG-001/DIAG-002 gained their desktop-runtime alignment (web-code scope consumed by the desktop shell): when the Tauri WebView injects `window.VEYORA_DESKTOP`, the Diagnostics panel reports `Local vault on this device` mode and an `Encrypted vault stored on this device` storage summary instead of claiming a connected vault or surfacing the meaningless loopback host, and the support bundle prints `mode: desktop-local-vault` with a `storage: local vault on this device` line and no `service-host:` line; unit tests pin the desktop branch and a browser assertion exercises the rendering with the flag set (connected-mode output is unchanged). UX-ONB-002 gained its desktop-native first-run implementation: the Tauri setup screen now offers all four Welcome routes — `Create a new vault` (a folder that already contains `vault.db` is refused with a pointer to Open), `Open an existing vault` (requires an existing database, honestly noting none is known on this device), `Import from another password manager` (creates a vault and states that the next screen offers the import), and `Advanced: connect to a self-hosted server` (an http/https address validated on the shell side and opened in the system browser, with honest copy that desktop connected pairing arrives with connected mode) — replacing the single ambiguous storage-location button whose create-or-open behavior depended on the picked folder; four new desktop unit tests pin the route guards and the external-URL validation (`cargo test -p veyora-desktop` now 9/9), and the desktop README and docs/DESKTOP.md describe the four routes. Native desktop execution evidence for the routes remains. The desktop first-run screen was aligned to the PRD dialog/status model (ACC-004 alignment, desktop-shell scope): it is now exposed to assistive technology as a named modal dialog (`role="dialog"` + `aria-modal` + heading label), its waiting/error line is a live status region per the section 7.3 error model, focus lands on the first route action when the wizard opens, Enter in the connect address field opens it in the browser, and keyboard focus is visibly outlined on every control (`apps/desktop/src-tauri/src/setup.js`; `cargo test -p veyora-desktop` still 9/9). Vault identity now appears on the locked and unlocked screens (PRD 6.3 / NAV-001, web scope consumed by the desktop shell): the dashboard top bar and the locked unlock screen show a human-readable vault name plus a safe location summary — `On this device` on the desktop runtime, the connected service's origin host alone on the web, never a full URL, path, or token — replacing the raw vault-id hex in the primary identity line (`diagnostics.vaultIdentity()` with unit tests, browser assertions for both runtimes, 413-key locale parity, comprehensive suite 59/59). Desktop/native validation, remaining onboarding/recovery work, UX-ONB-006 threat approval, Trash purge and permanent-delete confirmation are implemented (ITEM-008 web scope: count-naming armed confirmation, immediate scoped purge, server-audited journey 70/70 ×2), remaining error/settings/accessibility scope (ACC-002..012 manual and desktop evidence), E2E-001/E2E-010, and the user study remain. ITEM-006 gained its true offline pending queue (connected web scope): when the service is unreachable, a save keeps its already-sealed ciphertext DTO in a per-vault localStorage queue (`apps/web/src/core/pending-queue.js`, newest write per record wins), the session keeps the item with a `Pending sync` row badge and a saved panel that reports `Saved on this device — not yet on the service` with a `Sync now` action, every listing replays queued writes before reading (`recordSync.flushPending()` keeps the queue while offline, commits successful replays, and drops queue entries the server definitively rejects as conflicts), and unit tests pin the no-plaintext-in-storage boundary while browser E2E aborts the record PUT, observes the pending report and badge, reconnects, and proves the synchronized report and badge clearing (416-key locale parity; comprehensive suite 60/60). Two desktop-alignment/API-003 fixes followed: the API CORS preflight now allows the `Authorization` request header (a cross-origin token deployment's preflight was previously rejected; verified live against the rebuilt stack), and the desktop runtime no longer claims a remote service it does not have — the pending-save panel/badge use local-save wording (`Pending save`, `Try saving again`), and the Diagnostics row says `Last saved` instead of `Last sync` when `window.VEYORA_DESKTOP` is set (421-key locale parity; comprehensive suite 60/60 with a new desktop assertion). |
| 8 | 🟡 `Partial` | Mechanical dependency-safe scope landed: `/readyz` answers 503 with an honest `ready:false` body when the store is unavailable while `/healthz` stays process-alive-only (API-006; covered by a new unavailable-store test), and DEP-006 is complete for every application container — all six Rust service images run as unprivileged uid 10001, the gateway renders its envoy config into `/tmp` and runs as the unprivileged envoy user, the web image renders nginx config into a tmpfs-mounted `conf.d`, serves the runtime `veyora-config.js` from `/tmp`, and runs with a read-only root filesystem plus the documented minimal nginx capability set, while Compose drops ALL capabilities everywhere (postgres is the sole documented exception); the Compose backup entrypoint's nonexistent `./backup` binary was fixed to `veyora-backup`. Live-verified on a rebuilt hardened read-only stack: all services healthy, Rust containers at uid 10001, gateway at uid 101, `tests/smoke/api.sh` and the browser smoke suite pass. DEP-007 is partial: base digests are pinned through the digest-pinned GHCR foundation mirrors in the release path, the gateway and web containers gained healthchecks, Compose declares bounded per-service memory limits (verified applied), and the API documents its drain-grace window; DEP-013 is complete (`make purge-data` requires `CONFIRM=destroy-veyora-data`, and the docs name exactly which data `down --volumes` deletes); image architecture inspection tooling remains. DB-002 is complete: the PostgreSQL pool enforces a tested hard connection cap with fail-closed acquisition timeout, session-level statement timeout, idle-expiry discard, environment-tunable bounded policy, and `PostgresStore::shutdown()` draining — proven by unit tests and the live integration test against a real PostgreSQL. DEC-002 now has its review-gated design package (ADR 0005 Proposed: scoped CSPRNG connection credential with pairing/rotation/revocation/expiry, OS-keychain and cookie storage, server-side scope enforcement, closed `PM-AUTH-*` errors; machine contract + checker + negative tests enforce the invariants and keep the status Proposed until qualified review). DEP-015 is complete (`docs/runbook.md` covers all ten required failure modes with concrete diagnostics) and DEP-012's documented upgrade procedure (preflight, live-verified one-shot backup, migrator-gated switch, verify, data-format-limited rollback) is complete. DEP-009 is partial (web-origin scope): the security-header contract matches the reviewed served values, the web origin serves deny-by-default Permissions-Policy plus COOP/CORP with `no-referrer`, and `tests/smoke/headers.sh` enforces the contract against the live origin (verified 7/7); the TLS-origin/external scan story remains with E2E-008. DEP-007's architecture-inspection tool exists (`tools/release/inspect-image.py`, `--require amd64,arm64`; verified against a public multi-arch image, a missing-architecture negative, and the published `veyora-api` index); wiring it into the runner-side release gate remains. The DEP-007 digest drift is now machine-gated (`tools/lint/check-foundation-pins.py` in `make check` and CI). DEP-003 is machine-gated for the Compose topology (`tools/lint/check-compose-topology.py` in `make check` and CI: only the gateway TLS edge may bind non-loopback, internal services publish no host ports). DB-003 is complete (rustls/ring TLS: non-loopback hosts require verified TLS by default, `VEYORA_DB_TLS_MODE`/`VEYORA_DB_TLS_CA_FILE`, live-tested against an ssl=on PostgreSQL; Compose acknowledges its private network explicitly), and DEP-002's redirect defect is fixed with a live TLS-topology rehearsal (correct 301 to the TLS port; health/ready and a PUT/DELETE round trip over verified TLS). DB-004 is complete (init-provisioned `veyora_migrator` DDL and `veyora_app` DML-only roles, per-service role-scoped `DATABASE_URL`s, migration-owned table grants, and an API schema-verification fallback — live-verified with a DDL-denial test on a fresh role-initialized stack). DEP-014 is complete for every operational service (shared unit-tested UTC formatter; API/worker/migrator/backup/restore all log UTC-prefixed, counts-only stable-English lines; live-verified). API-007 is machine-checked for the current metrics surface (a blocking canary test proves record/vault identifiers cannot appear in `/metrics`). Remaining: implementing the approved lifecycle (`UX-AUTH-007`/`008`, `API-002`, `DEP-004`), production TLS topology, header/pool/role hardening, backup scheduling/restore drills, and `E2E-008`. |
| 9 | 🟡 `Partial` | Local slice: the desktop app builds as a real native package for the current host (`Veyora_1.0.0_aarch64.dmg`, Mach-O arm64, ad hoc linker-signed, SHA-256-pinned in release/evidence/native-preview/macos-arm64-preview.md with honest limits), and INST-006's path conventions are unit-asserted in the shell (Documents first, app-data fallback; veyora-desktop 10/10). Signing/notarization credentials, the other three native targets, the updater corpus (UPD-001..004), and E2E-009 on real hardware remain. |
| 10 | 🟡 `Partial` | OSS-005 community surface is public and coherent (governance, roadmap as a PRD view, support routing, issue/PR templates, SECURITY, conduct) in the honest intake-closed state. BLOCKER recorded precisely: OSS-001/OSS-003 license adoption is an owner/legal strategy decision (permissive vs network copyleft) that an engineer cannot make; until then all surfaces stay source-available (OSS-002 enforced) and the SBOM scan (OSS-006) plus contributor dry run (OSS-004) follow the decision. |
| 11 | 🟡 `Partial` | PERF local-reference instrument landed with first measurements (PERF-002 p95 169 ms, PERF-004 pipeline 25 ms no-backlog, PERF-F-001 FIXED: windowed 500-row rendering with Show-more plus deferred ack re-render above the window — acknowledgment p95 32 ms (was 2811; target 250), search pipeline 8 ms over 10,000 items; artifacts under release/evidence/perf/). SEC-ASSURE-004 complete: every workflow action is pinned to a full commit SHA resolved from its published tag (machine-enforced by a lint in `make check`). SEC-ASSURE-005 local half: seeded fuzz-boundary tests over the recovery-kit decoder and canonical CBOR codec with a retained regression corpus (found and pinned real behavior on first run); security-kernel workspace 15/15. Remaining: the sequence-4-gated assessment items, CI-side scanning and scheduled fuzzing, reference-hardware PERF benchmarks, and the soak/Beta/Stable decision. |

Continuation rule: sequence 6 is implementation-complete and blocked only on
owner push plus GitHub-runner CI verification (and the DATA-003 fix gated on
sequence 4), so continue with sequence 7 UX work while the owner arranges the
qualified independent review required to finish sequence 4. Prioritize the
remaining Welcome routes and connected-session gate, recovery and Start-here
work after approved designs, ITEM-006/008/009 completion, the desktop
EXP-004 atomic-export path, and accessibility/error coverage. Do not start
sequence 5 as a supported product implementation until sequence 4 is approved;
do not redo sequences 2 or 3 unless their evidence regresses, and treat every
`Partial` row as unfinished.

## 25. Evidence record schemas

### 25.1 Feature/evidence registry

Each public capability MUST have at least:

| Field | Description |
| --- | --- |
| `feature_id` | Stable English ASCII ID |
| `name` | Canonical English capability name |
| `status` | Stable, Beta, Experimental, Protocol-only, Planned, or Unsupported |
| `modes` | Desktop Local, Desktop Connected, Web Connected |
| `platforms` | Exact OS/architecture/browser set |
| `implementation_paths` | Owned source paths |
| `security_claims` | Bounded claims or none |
| `requirement_ids` | PRD IDs satisfied |
| `automated_evidence` | Blocking test IDs/run references |
| `manual_evidence` | Required study/accessibility/native evidence |
| `owner` | Product/engineering owner |
| `security_approver` | Required for sensitive features |
| `last_verified_version` | Product version |
| `last_verified_at` | UTC timestamp |
| `known_limitations` | User-visible limitations |

README capability tables and release support matrices SHOULD be generated from this registry.

### 25.2 Release manifest

The release manifest MUST include:

- Product name/version/channel and minimum compatible client/server/backup versions.
- Git tag and commit; build workflow/repository/event.
- Artifact name, target OS, target architecture, package type, size, SHA-256, URL.
- Native build runner and native validation runner OS/architecture.
- Signing identity/certificate metadata, timestamp, notarization/staple state.
- Updater target, signature, URL, and compatibility constraints.
- SBOM filename/digest/format and provenance attestation reference.
- Test plan/evidence index digest and quality-gate decision.
- Known issues, migration/backup requirements, rollback support, support window.

### 25.3 Generated artifact manifest

Every generated output MUST record:

- Generator path and exact version/digest.
- Canonical input paths and combined digest.
- Output paths and digests.
- Consumer and owner.
- Determinism expectations.
- Regeneration command and `--check` command.
- Whether output is tracked or build-only and why.

### 25.4 Error code convention

Stable error codes MUST be English ASCII uppercase with a bounded domain and condition, for example:

```text
VAULT_WRAPPER_INVALID
VAULT_VERSION_UNSUPPORTED
RECOVERY_KEY_INVALID
ITEM_REVISION_CONFLICT
IMPORT_VALIDATION_FAILED
STORAGE_UNAVAILABLE
SESSION_REVOKED
BACKUP_INTEGRITY_FAILED
```

An error response carries code, safe parameters, request ID, and retry classification. It does not carry translated prose from the API. Client catalogs map code + safe parameters to localized messages. Logs may add internal context but never secrets.

## 26. Research basis and primary sources

The requirements above combine repository evidence with first-party product documentation and standards-body guidance. Living documents were checked on 2026-09-01; the project MUST revalidate mutable runner/tool facts before implementation and release.

### 26.1 Native architecture and virtualization

- [Apple VZVirtualMachine](https://developer.apple.com/documentation/virtualization/vzvirtualmachine) — a virtual machine uses the same architecture as the underlying Mac; this establishes the local Apple Silicon limitation.
- [Apple: Building a universal macOS binary](https://developer.apple.com/documentation/apple-silicon/building-a-universal-macos-binary) — native Intel/ARM slices and translation detection.
- [GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) — explicit Windows AMD64, Windows ARM64, macOS Intel, and macOS ARM64 runner labels.
- [Amazon EC2 Mac instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html) — native Intel `mac1.metal` and Apple Silicon Mac hardware options for manual leased-host testing.
- [Microsoft: How emulation works on Arm](https://learn.microsoft.com/en-us/windows/arm/apps-on-arm-x86-emulation) — why PE inspection and native host assertions are needed to detect accidental Windows translation.

### 26.2 Packaging, signing, and updates

- [Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/) — Windows package types, ARM64 target, and the critical fact that stock NSIS remains x86.
- [Microsoft: 64-bit Windows Installer packages](https://learn.microsoft.com/en-us/windows/win32/msi/64-bit-windows-installer-packages) — ARM64 MSI metadata and component rules.
- [Apple: Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) — Developer ID, hardened runtime, timestamps, and notarization requirements.
- [Apple Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/) — outside-App-Store signing identity.
- [Microsoft: Use SignTool to verify a file signature](https://learn.microsoft.com/en-us/windows/win32/seccrypto/using-signtool-to-verify-a-file-signature) — Windows signature verification.
- [Microsoft: Test with Smart App Control](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control) — clean-image consumer trust testing.
- [Tauri Updater](https://v2.tauri.app/plugin/updater/) — mandatory updater signatures, HTTPS, architecture targets, and downgrade behavior.
- [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) — provenance and SBOM attestation, with limits.
- [SPDX specifications](https://spdx.dev/use/specifications/) — standardized SBOM format.

### 26.3 Accessibility and usable forms

- [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/) — Level AA baseline, keyboard, focus, reflow, target size, authentication, errors, and status behavior.
- [W3C: Evaluating Web Accessibility](https://www.w3.org/WAI/test-evaluate/) — manual and automated evaluation roles.
- [W3C: Form instructions](https://www.w3.org/WAI/tutorials/forms/instructions/) — persistent labels and instructions.
- [W3C: Form validation](https://www.w3.org/WAI/tutorials/forms/validation/) — accessible error identification, correction, and confirmation.
- [GOV.UK: Start using a service](https://design-system.service.gov.uk/patterns/start-using-a-service/) — context, eligibility, and prerequisites before a user begins.
- [GOV.UK: Error message](https://design-system.service.gov.uk/components/error-message/) and [Error summary](https://design-system.service.gov.uk/components/error-summary/) — actionable field and form error patterns.

### 26.4 Password, recovery, backup, and manager UX

- [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html) and [NIST password guidance](https://pages.nist.gov/800-63-4/sp800-63b/passwords/) — length, paste/autofill, long inputs, and no composition rules, applied here with an offline-Vault scope caveat.
- [Bitwarden desktop first steps](https://bitwarden.com/help/getting-started-desktop/) — guide users to a first saved Login.
- [Bitwarden: Understand Log in vs. Unlock](https://bitwarden.com/en-gb/help/understand-log-in-vs-unlock/) — state terminology distinction.
- [Bitwarden encrypted exports](https://bitwarden.com/help/encrypted-export/) — portable versus account-restricted encrypted export and key-rotation implications.
- [Bitwarden export guidance](https://bitwarden.com/help/export-your-data/) — encrypted versus plaintext export risk.
- [1Password: Get started](https://support.1password.com/explore/get-started/) — product-value and first-item orientation.
- [1Password: Emergency Kit](https://support.1password.com/emergency-kit/) and [Secret Key](https://support.1password.com/secret-key-security/) — why emergency information, Secret Key, backup code, and account recovery are distinct concepts.
- [KeePassXC Getting Started Guide](https://keepassxc.org/docs/KeePassXC_GettingStarted) — create/open database terminology and password-loss consequence.

### 26.5 Security, supply chain, and open source

- [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) — testable application security requirements and verification confidence.
- [OWASP Web Security Testing Guide](https://owasp.org/www-project-web-security-testing-guide/latest/) — balanced security testing across the lifecycle.
- [W3C CSP Level 3](https://www.w3.org/TR/CSP/) and [Tauri CSP guidance](https://v2.tauri.app/security/csp/) — separate Web/Tauri policies and narrow WebAssembly evaluation.
- [NIST Secure Software Development Framework SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final) — secure development and supply-chain practice.
- [OWASP Key Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html) and [Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html) — key lifecycle and recoverable protected backups.
- [OSI Open Source Definition](https://opensource.org/osd) and [OSI approved licenses](https://opensource.org/licenses) — the legal meaning of open source and approved license set.

### 26.6 Open-source documentation patterns

- [KeePassXC README](https://github.com/keepassxreboot/keepassxc/blob/develop/README.md) and [Build and Install](https://github.com/keepassxreboot/keepassxc/blob/develop/INSTALL.md) — user-value landing page separated from detailed platform build/install instructions.
- [KeePassXC Release Checklist](https://github.com/keepassxreboot/keepassxc/wiki/Release-Checklist) — multi-architecture build, signing, installation, and digest verification practice.
- [Bitwarden Client Applications README](https://github.com/bitwarden/clients/blob/main/README.md) and [Bitwarden contributing client setup](https://contributing.bitwarden.com/getting-started/clients/) — concise monorepo scope and layered client development docs.
- [Bitwarden Server README](https://github.com/bitwarden/server/blob/main/README.md) — server technology, platform development setup, production image evidence, contribution, and security routing.
- [Vaultwarden README](https://github.com/dani-garcia/vaultwarden/blob/main/README.md) — prominent HTTPS/persistence warnings before deployment commands.
- [GitHub: Managing releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository) — prerelease channel and complete release asset practices.

## 27. PRD change control

Changes to this PRD MUST:

1. Identify affected requirement IDs and public claims.
2. Explain user, security, data compatibility, architecture, platform, documentation, and release impact.
3. Include evidence for any changed external fact, such as runner labels or packaging behavior.
4. Update traceability, milestones, tests, and feature/evidence registry.
5. Receive Product and QA approval; Security approval is mandatory for security/data/recovery/auth/release-trust changes.
6. Preserve requirement history. IDs MUST NOT be silently reused for a different meaning.

An implementation shortcut does not change the requirement. A requirement change requires an explicit reviewed PRD revision.

## 28. Final acceptance statement

Veyora is ready for a Stable release only when a new user can understand and use it without external interpretation, existing encrypted data survives every documented lifecycle, connected infrastructure enforces the intended boundaries, all public claims are backed by evidence, and the exact final packages install and run natively on macOS Intel, macOS ARM64, Windows AMD64, and Windows ARM64 without compatibility or emulation being counted as native validation.
