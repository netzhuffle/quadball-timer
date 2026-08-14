# Scoped Control Grant lifecycle

The Control Grant authority creates a QR-bound capability for one validated
event, game day, pitch, and pitch slot. The public lifecycle is:

1. `createControlGrant` validates the scope and a structured fixture authority,
   then returns the QR credential once. The durable Grant stores only its
   encrypted credential envelope and keyed lookup material.
2. `revealControlGrant` decrypts the credential for an authorized authority and
   returns it without exposing stored plaintext.
3. `rotateControlGrantCredentialKeys` decrypts a retained credential with its
   recorded old encryption key, verifies its complete binding and lookup
   digest, then re-encrypts and re-indexes it with the current keys. The Grant
   update and permanent `credential-rotated` audit evidence commit atomically;
   any cryptographic, collision, audit, or storage failure leaves the old
   credential and versions usable.
4. `admitControlGrant` validates the QR credential, resolves the current event
   game, and creates a separately random session bearer. A second admission in
   the same browser context revokes that context's active session and records a
   replacement; other contexts remain active.
5. `authorizeControlGrant` accepts only the session bearer and rechecks the
   Grant version, lifecycle, scope resolution, and session state.
6. `disableControlGrant` and `revokeControlGrant` are administrative lifecycle
   transitions. A Grant reaching its expiry time transitions every non-expired
   Grant (including disabled and revoked Grants) and all sessions to `expired`,
   appends exactly one `grant-expired` audit entry, and never revives. This is
   one storage transaction: encrypted credential material, lookup digests, and
   session bearer verifiers are erased while only non-secret metadata and a
   domain-separated retained fingerprint remain.

## Privacy and authority boundary

Authority callers provide `{ kind: "fixture", id }`, not a free-form audit
actor string. The ID is validated for the narrow boundary and immediately
included only as input to a keyed HMAC derivation. Durable audit reads expose a
pseudonymous `actor-*` reference; QR credentials, session bearers, browser
contexts, human identities, and caller-selected actor text are not persisted in
Grant rows or audit evidence. Grant reveal material uses AES-256-GCM, while
credential lookup and session bearer verification use separately keyed HMAC
material. Injected randomness must provide at least 256 bits for credentials
and independently random session bearers.

Invalid external credentials, unavailable scope state, disabled/revoked/expired
Grants, and invalid sessions return generic failures. Every public authority
operation contains storage failures at the module boundary; list operations
return a typed unavailable result and mutations return redacted failure
details. Storage writes for a Grant and its mandatory audit evidence are
transactional in both adapters, including expiry erasure and audit evidence.
Expired Grants have no credential key versions, ciphertext, IV, authentication
tag, lookup digest, or session verifier material and cannot rotate. Migration
006 upgrades legacy active, disabled, revoked, due, and expired rows in one
transaction. It preserves all prior audit evidence, creates missing expiry
evidence exactly once, erases due or terminal capability material, and replaces
legacy digest-equal values with tagged opaque 256-bit migration references. These
references are not credential fingerprints and are therefore never copied into
Grant Audit Trail fingerprint fields. Runtime audit creation likewise omits them;
only newly derived keyed credential fingerprints may occupy those fields. A
non-expired migrated Grant replaces the compatibility reference with a keyed
fingerprint when its retained credential keys are rotated.

## Test routing

The reusable semantic contract runs against in-memory storage in the ordinary
Fast Test boundary and against disposable SQLite storage in the focused
integration boundary. The SQLite contract covers replacement, generic failure,
atomic credential key rotation, expiry erasure, migration upgrade and rollback,
redaction, restart, and real independent-worker admission contention. The
contention harness uses an allowlisted child environment, a private owner-only
credential file, capped streaming diagnostics, and one bounded deadline for
barrier, work, TERM/KILL escalation, reap, and artifact cleanup. The focused
command is intentionally outside
ordinary Fast Test discovery, while remaining deterministic and isolated.

Run the fast unit contract with:

```text
bun test src/lib/grant-authority.test.ts
```

Run the focused SQLite contract with:

```text
bun run test:focused:grant
```

The focused file is intentionally outside ordinary test discovery. This slice
does not implement QR URL or fragment handling, cookies, React UI, Technical
Admin authentication, Grant Codes, or the complete three-type lifecycle
matrix.
