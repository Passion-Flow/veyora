# Veyora mode matrix (DOC-006)

Audience: users and evaluators.
Owner: documentation.
capability status: `release/features.json` (this page is a view; where the
two disagree, the registry wins and this page is a defect).

Veyora ships one product in three runtime modes. A capability claim is
only as strong as its per-mode evidence — the same feature can be
experimental in one mode and unavailable in another, and this page never
blurs them.

## The three modes

| Mode | What it is | Default? | Status |
| --- | --- | --- | --- |
| **Desktop Local** | The Tauri desktop app with a vault stored in a local SQLite database on this device. No server, no account. | Yes — this is the product's intended path | Experimental preview |
| **Desktop Connected** | The desktop app pointed at a self-hosted Veyora service (advanced). | No — explicit advanced route | Design proposed (ADR 0005); not a supported capability |
| **Web Connected** | The browser client against a self-hosted service. | No — advanced connect route | Experimental preview, inert data only |

## Capability matrix

| Capability | Desktop Local | Desktop Connected | Web Connected |
| --- | --- | --- | --- |
| Vault create / unlock / lock | Experimental | Via web pairing model (design) | Experimental |
| Item CRUD, Trash + restore + permanent delete | Experimental | Experimental (shared client code) | Experimental |
| Search (device-local) | Experimental | Experimental | Experimental |
| Tags and favorites | Experimental | Experimental | Experimental |
| TOTP display | Experimental | Experimental | Experimental |
| Recovery Key (create/verify/recover/regenerate) | Experimental (kit-scoped wrappers) | Experimental (shared client code) | Experimental |
| Encrypted portable backup + restore | Experimental (web-shared code) | Experimental | Experimental |
| Master password change (atomic wrapper) | Experimental | Experimental | Experimental |
| Offline queue (pending sync) | n/a (no service) | Experimental | Experimental |
| Connected pairing / sessions | n/a | **Design proposed** (ADR 0005; gated on independent review) | Token gate today; scoped pairing gated on the same review |
| Server-side retention purge (Trash) | n/a | Experimental (worker) | Experimental (worker) |
| Signed native packages | **Unsigned preview only** | — | n/a |

## What differs in practice

- **Storage**: Desktop Local keeps ciphertext in `vault.db` in a folder
  you choose (Documents suggested); connected modes store opaque record
  envelopes on the service you point at. The service never holds keys or
  plaintext.
- **Offline**: Desktop Local is offline by design. Connected modes have
  an offline pending queue for writes; no general offline-access promise
  is made for this preview (see the User Guide's offline section).
- **Diagnostics**: the desktop runtime reports `Local vault on this
  device`; web reports the connected service's origin host only — never
  the full URL or a token.
- **Recovery**: the Recovery Key ceremony is identical across modes; on
  a fresh device the kit-derived scope finds the recovery wrapper on the
  service (connected modes) or the local database (Desktop Local, same
  device folder).

## Honest limits

- No mode is a supported production capability: cryptographic
  implementation awaits the independent review (sequence 4), native
  packages are unsigned, and no stable release channel exists.
- Desktop Connected's full pairing/session lifecycle is design-only
  until ADR 0005 passes that review; the desktop's advanced connect
  route opens the web client in a browser today and says so.
