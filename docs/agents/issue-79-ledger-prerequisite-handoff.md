# Issue 79 ledger prerequisite handoff

Base: `15efaf351918b9f3635fb2421ac5b3afbd9ef412`

This prerequisite owns the FoundationStorage acceptance-state seam, memory/SQLite
integrity readiness, and the locked-discard capability/lookup path. It does not
implement ordinary preflight, missing-root authorization/activity, transaction-
local codec/lifecycle preparation, or authority race orchestration.

Implemented:

- trusted locked replay verification receives and binds the canonical batch digest;
  memory and SQLite reservation lookup require the same digest and fail closed on
  ambiguous same-digest replacement-session matches. Exact live reservations take
  precedence over the permanent four-field discard audit, and a different live
  replacement reservation cannot be erased by tuple-only idempotency;
- committed and acknowledged exact reservations recover their durable per-action
  results and receipt key version after a lost response, including after Game Lock
  and lookup-key rotation;
- locked discard retains only the redacted count/session/game/timestamp tuple in
  the Control audit and removes reservation, attempt, receipt, and integrity-anchor
  state without returning a replay identifier;
- paired Control/Grant acceptance evidence is checked bidirectionally for identity,
  action kind, outcome/detail, acceptance ID, content fingerprint, and replay
  attempt/result semantics. Stored replay responses now require an exact
  status-specific canonical shape, and accepted/duplicate or rejected collision
  fingerprints are cross-checked against durable action/idempotency evidence;
- every paired online or replay acceptance carries independent Control-side
  fingerprint and rejected-candidate evidence. Accepted/duplicate pairs resolve
  against retained action plus idempotency rows; rejected pairs resolve against
  canonical candidate/collision evidence. Nonaccepted stored results enforce the
  exact supported status/reason discriminants and audit detail;
- acceptance anchors authenticate their canonical live state, and readiness rejects
  missing, gapped, extra, orphaned, or semantically retargeted history while
  retaining key-rotation recovery.

Verification completed:

- `bun install --frozen-lockfile`
- `bun audit`
- `bun run check`
- Fast acceptance/adversarial/storage tests
- `bun run test:focused:acceptance`
- `bun run test:focused:grant`
- `bun run test:focused:sqlite`
- `bun run build`
- `bun run build:executable`
- `git diff --check`

The correction-specific suite includes 290 Fast tests, 7 focused SQLite
acceptance tests, and memory/SQLite coordinated online fingerprint mismatch
negative controls. The previously fixed exact-reservation, lock-recovery,
receipt-rotation, result-shape, redaction, and anchor tests remain green.

Qualification commands, including `bun run check:sqlite-runtime`, were not run.
