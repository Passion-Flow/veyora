# ADR 0005: Scoped pairing and session credential lifecycle

Status: Proposed; implementation and qualified independent security review are
required before this decision may be marked Accepted. Connected mode must not
claim this design as a supported capability before that gate.

Date: 2026-09-05

Audience: security, service, client-platform, storage, and operations owners.

Owners: Security Architecture and Service Platform.

Decision register entry: `DEC-002` (connected identity/session protocol).

Requirements: `UX-AUTH-007`, `UX-AUTH-008`, `API-001`, `API-002`, `API-003`,
`DEP-004`, `DEP-005`, and the principal/device/session entities of PRD
section 10.1.

## Context

The preview's connected mode authenticates every request with one
deployment-wide bearer token (`VEYORA_API_TOKEN`). That token is not scoped to
a principal, device, or Vault; it cannot be rotated or revoked per client; it
has no expiry; and the web client keeps it in `localStorage`. The PRD forbids
exactly this posture: a global browser bearer token is forbidden for stable
connected mode (API-002), credentials must be scoped, rotatable, revocable,
and expiring, desktop credentials must use the operating-system credential
store, and web sessions must use reviewed secure session storage that never
puts a long-lived bearer token in `localStorage` (UX-AUTH-007/008). Production
auth must be provisionable through a documented pairing/bootstrap flow
(DEP-004).

This ADR defines the target credential and session model. It does not claim
the target is implemented, reviewed, or approved. The existing
`VEYORA_API_TOKEN` deployment token remains a local-preview/operator transport
until the scoped model ships and passes its evidence; nothing in this ADR
weakens that containment.

## Decision

### Terminology and ownership

- **Principal** is the authenticated owner identity on the service
  (`principal_id`, PRD section 10.1). Every stored record and session is
  scoped by it. In this single-user-per-deployment release the principal is
  provisioned by the operator; multi-tenant provisioning is out of scope.
- **Deployment token** stays an operator-held bootstrap credential. It
  provisions and manages device pairings; it never authorizes record access
  once a pairing exists, and it never reaches a client device.
- **Connection credential** is a per-device secret presented on every record
  request. It is distinct from the Master Password, which never leaves the
  client (PRD 4.1, and `authentication-profile-v1`'s
  `master_password_transport: forbidden`).
- **Session** is the service-side state for one authenticated device:
  scope, created/last-seen times, expiry, and revocation state.
- Pairing, rotation, revocation, and record envelopes are client/service
  protocol objects over TLS only. The service sees identifiers, opaque
  ciphertext, and bounded operational metadata — never Vault keys, wrappers,
  or plaintext fields.

The machine-readable authority for entities, states, limits, and error codes
is [`pairing-session-v1.json`](../../contracts/protocol/pairing-session-v1.json).

### Credential shape

- The connection credential is 32 random bytes from the operating-system
  CSPRNG, presented as an `Authorization` bearer value in constant-time
  comparable server-side form (stored only as a salted hash, never plaintext).
- It binds: protocol version, `principal_id`, `device_id`, the credential
  generation, and the credential purpose (`record-access`). The binding is
  part of the authenticated request context so a credential from one
  principal/device can never read or write another scope (API-001, DATA-002,
  E2E-005).
- Credential identifiers (a public `credential_id`) are non-secret,
  non-sequential, and safe in logs.

### Storage on clients

- **Desktop:** the credential is stored through the operating-system
  credential store (Keychain on macOS, Credential Manager on Windows) behind
  the Tauri shell; never in a plaintext file next to the vault database
  (UX-AUTH-008).
- **Web:** the service sets a `HttpOnly`, `Secure`, `SameSite=Strict` session
  cookie scoped to the deployment origin with a bounded lifetime; a
  long-lived bearer token in `localStorage` is forbidden (UX-AUTH-008). The
  client may keep an in-memory mirror for the tab lifetime only.

### Lifecycle

1. **Provision (pairing).** The operator issues a single-use, short-lived
   (default 15-minute) pairing code from the deployment token. The client
   presents the code over TLS; the service creates the principal's device
   record and returns the connection credential exactly once. A consumed or
   expired code is refused; codes are rate-limited per source address.
2. **Use.** Every record request carries the credential; the service derives
   principal/device/session scope from the authenticated context only — never
   from query parameters (API-001).
3. **Rotate.** A client-initiated rotation with the current credential
   creates a new generation, returns the new credential once, and marks the
   old generation valid for a bounded overlap (default 5 minutes) so an
   interrupted exchange cannot lock the device out. After the overlap the old
   generation is dead.
4. **Revoke.** The operator (deployment token) or the client (its own
   credential) can revoke a device/session immediately. Revocation is
   idempotent and ends access on the next request.
5. **Expire.** Sessions expire after an absolute lifetime (default 30 days)
   and an idle lifetime (default 7 days); the client detects expiry through
   the dedicated `PM-AUTH-SESSION-EXPIRED` error and re-pairs through the
   documented ceremony.

All lifecycle transitions are idempotent and safe to retry; none can modify
or reveal Vault records.

### Error and CORS surface

- Stable ASCII error codes with safe parameters: `PM-AUTH-PAIRING-INVALID`,
  `PM-AUTH-PAIRING-EXPIRED`, `PM-AUTH-CREDENTIAL-REVOKED`,
  `PM-AUTH-SESSION-EXPIRED`, `PM-AUTH-RATE-LIMITED` — joining the closed,
  machine-enforced error catalog (DIAG-003).
- Authentication failures are non-enumerating: the same
  `PM-API-UNAUTHORIZED` family is used for wrong, unknown, and revoked
  credentials except where the client must distinguish expiry for its
  re-pairing ceremony.
- CORS continues to allow only reviewed origins; with credentials-mode
  cookies enabled, wildcard origins remain forbidden (API-003).

### Limits and abuse

Pairing attempts and authenticated requests are rate-limited per source
address and per credential; bodies, counts, and timeouts stay bounded by the
existing API contract source (API-005). The deployment token remains
refusable — an operator may disable pairing entirely (`disabled`) while
existing pairings keep working.

## Rejected alternatives

- One deployment-wide bearer token (status quo): unscoped, unrotatable,
  unrevocable, and stored in `localStorage`; exactly what API-002 forbids.
- Master-Password-based service login: the Master Password must never be
  transported to the service (PRD 4.1; authentication-profile-v1).
- Long-lived opaque tokens without server-side session state: revocation and
  expiry cannot be enforced, only pretended.
- Client-side Vault filtering as the isolation boundary: PRD DATA-002
  requires server-side scope enforcement.
- Unbounded overlap on rotation: a stolen old credential would stay valid
  indefinitely; the bounded overlap is the smallest window that keeps
  rotation crash-safe.

## Evidence and approval gate

The lifecycle checker (`tools/lint/check-pairing-session.py`) validates the
contract invariants: CSPRNG entropy, forbidden storage locations, non-derivable
credential hashing, bounded pairing/rotation/expiry parameters, server-side
scope enforcement, the closed error-code set, and the proposed-only status.

Before this ADR may become Accepted and connected authentication may be
claimed as supported:

1. the owner must appoint a qualified independent security reviewer through
   the registered reviewer process (shared with ADR 0004's registry);
2. the reviewer must sign a review record binding this ADR, the contract, and
   the pairing/session test corpus;
3. the implementation must pass the provision/pair, rotate, revoke, expire,
   cross-scope, and storage-inspection suites (UX-AUTH-007/008, API-002,
   DEP-004) including browser and desktop evidence;
4. `E2E-008` must pass against a real HTTPS hostname; and
5. the contract status may change only after the checker verifies the
   recorded approval, and Security and QA must record their sign-off.

Until then: the deployment-token preview mode stays honestly labeled, the
feature registry must not mark connected pairing supported, and experimental
implementation may proceed only with inert test data and no
production-readiness claim.

## Primary references

- [RFC 9106: Argon2](https://www.rfc-editor.org/rfc/rfc9106.html) (credential
  hashing profile follows the kernel's reviewed parameters)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [RFC 6265bis: Cookies](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis)
- [Veyora PRD](../../PRD.md), sections 8.2, 10.4, 14.3, and 22 (DEC-002)
