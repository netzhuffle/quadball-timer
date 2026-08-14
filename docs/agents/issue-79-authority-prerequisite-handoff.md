# Issue #79 authority prerequisite handoff

This prerequisite starts from `15efaf351918b9f3635fb2421ac5b3afbd9ef412` and
owns only the acceptance authority/preflight/action-transaction seam plus its
adversarial and focused SQLite authority tests. It is not a complete #79/#70
implementation.

## Completed boundary

- Authorized missing or mismatched roots prepare every codec/envelope through
  the read-only preflight and return `record-not-found` without changing Grant,
  Session, audit, budget, or metadata state.
- Transaction-local preparation drift is compared before replay, budget,
  sporting, metadata, audit, or session-activity writes and returns the exact
  `retry-later` / `stale-preflight` boundary.
- Focused SQLite coverage includes synchronized full `rotateControlGrant`
  rejection of the old session/version with no action or audit, while retained
  credential-key rotation remains accepted maintenance.

## Evidence

- `bun install --frozen-lockfile`: passed, no changes.
- `bun audit`: passed, no vulnerabilities.
- `bun run check`: passed.
- `bun test --isolate`: 291 passed, 0 failed.
- `bun test --isolate src/lib/foundation-acceptance-adversarial.test.ts`: 9 passed, 0 failed, 57 assertions.
- `bun run test:focused:grant`: 36 passed, 0 failed.
- `bun run test:focused:sqlite`: 21 passed, 0 failed.
- `bun run test:focused:acceptance`: 5 passed, 0 failed, 61 assertions.
- `bun run build`: passed.
- `bun run build:executable`: passed (`bun-linux-x64-modern`).
- `git diff --check`: passed.

Qualification tests and `bun run check:sqlite-runtime` were not run. No storage,
schema, integrity, migration, issue, PR, push, or integration changes were
made. The containing prerequisite commit is the handoff commit.

The locked-discard lookup was only renamed to carry the trusted preflight root
through the reordered authority check; its helper and retention semantics were
not redesigned.

## Correction attempt 1

The authority ordering was tightened after review: ordinary online and replay
paths authenticate read-only before any root lookup, while the trusted lock
path verifies only the claimed Event Game, origin, evidence, and action count
before loading and validating the locked root. Root-read spy/throw negatives
cover invalid ordinary bearers and invalid lock evidence. The containing
amended commit is the authoritative correction commit.
