# Issue #81 implementation handoff

## Result

`FoundationRecovery` implements the minimum Event recovery operation required by #81/#70:
verified Foundation-only `VACUUM INTO` snapshots, independent replay/key/schema verification, conservative
retention, staged reversible restore, current Grant lifecycle reevaluation, semantic Technical Admin
restore preparation, redacted resurrection-risk evidence, and current-authority Controller recovery
with explicit Recovery Gaps. The correction from
candidate `1be460d6749aa98d96189fce88356a83d854ee37` closes the cutover-authority race, resolves every
active Control Session by its own Event Game identity, binds real composed acceptance at construction,
hardens the local filesystem boundary, completes rejected-batch gaps, and corrects Grant Code lookup
key reporting without changing the accepted persisted Grant Code format. The localized final-review
correction additionally supports multiple exact terminal Games on one reused Control Grant, enforces
private failed-image modes, and separates immutable pending from atomic completion evidence.

## Review seams

- `src/lib/foundation-recovery.ts` — the single public recovery interface and orchestration.
- `src/lib/foundation-recovery-sqlite.ts` — closed Foundation-only policy, deterministic snapshot
  facts, key-version discovery, and SQLite quoting.
- `src/lib/foundation-storage-sqlite.ts` — only two recovery primitives: queued `VACUUM INTO` and
  drained/checkpointed close before replacement.
- `src/lib/foundation-recovery.test.ts` — SQLite, restart, sanitization, retention, lifecycle,
  composed-acceptance, filesystem, and failure-injection Fast coverage.
- `src/lib/grant-code.ts` and `src/lib/foundation-storage-sqlite.ts` — the accepted Grant Code format
  remains audit-ring-backed while readiness/recovery report that represented category truthfully.
- `docs/agents/issue-81-design-gate.md` — invariants and proportional operator handling for #80's
  fatal quarantine-marker failure.

The deterministic cutover test moves lock, Game Day, and Event Admin idle-expiry facts at the
post-quiescence barrier, then synchronously attempts a second lock, Game Day transition, expiry, and
Grant Session revocation after final evaluation and before live replacement. Final evaluation observes
the drained facts; all four late writers are rejected because Event storage is already closed. The
restored result preserves the pinned old-Game session while terminating exact sessions for multiple
locked historical Games and a past Game Day. The Grant Code is erased once using only the separately
resolved current Game Lock as truthful evidence.

## Explicit boundaries

- Migrations 001–021 are unchanged; no migration 022 was necessary.
- Technical Admin authentication state is never restored from the Foundation backup set. A normal
  restore calls the #193 semantic adapter against the live auth store after quiescence, preserving
  a validated compatible credential while invalidating all transient authority and requiring fresh
  sign-in. Missing, invalid, incompatible, or explicit-reset state remains a separate
  re-enrollment-required outcome; sanitation-failed aborts before Foundation replacement.
- Foundation backup uses a closed Foundation-only relation allowlist. Any `technical_admin_*` or
  other authentication relation inside Foundation fails before publication; backup never opens,
  reads, copies, filters, or sanitizes the separate auth database.
- The sanitized live auth database remains at its live path throughout Foundation cutover. A later
  Foundation rollback changes only Foundation files and leaves that sanitized auth store untouched,
  never reviving pre-sanitation transient authority.
- Encryption/lookup/audit keys stay outside database, manifests, and evidence.
- There is no backup schedule, Event-handoff/off-host backup, production cutover, deployment change,
  Technical Admin enrollment/reset, distributed failover, or automatic corruption repair.
- Recovery evidence is private 0600 operator material and contains hashes/versions/counts rather than
  raw Grant IDs, credentials, session bearers, action payloads, or sporting evidence.
- The owned backup workspace is physically outside the live database directory, non-symlink `0700`;
  all file material is `0600`, exclusive/no-follow sources and destinations reject unsafe paths, and
  verification/copy/publication/cleanup bind to stable file identity without overwriting competing
  replacements. Failed Event database, sidecars, and quarantine images are tightened
  and verified before preservation and again on rollback.
- Restore evidence uses one immutable synced pending record plus an atomic separate completion record.
  Completion-record I/O failure is returned as a completed cutover with explicit evidence status, not
  as a failed restore that could invite an unsafe retry.
- Restore evidence exposes only the finite Technical Admin auth outcome and allowlisted reason. It
  contains no credential, RP/origin, session/challenge, auth path/schema, or raw adapter error.
- Recovery import has no per-call acceptance adapter. Construction composes acceptance from this
  storage and Grant environment, and tests prove current bearer authorization plus SQLite mutation
  visible after reopen.

## Historical #81 gate record

The following gate record is historical evidence for the original #81 integration. It does not
prove the later #192 composition or correction claims below.

Base: `066365aa070018f858e4a067191bedd5726a0124` (accepted #80 integration). Candidate:
`1be460d6749aa98d96189fce88356a83d854ee37`. The correction commit is the commit containing this
handoff.

- `bun install --frozen-lockfile` — passed without lockfile changes.
- `bun audit` — passed; no vulnerabilities found.
- `bun run check` — passed; only the seven pre-existing `await-thenable` warnings in Grant files.
- `bun run test` — passed: 404 tests, 0 failures, 16,470 expectations in 12.61 seconds.
- Timing investigation: Darwin 25.5.0 arm64, Bun 1.3.14; `/usr/bin/time -l` measured 12.64 seconds
  real, 12.37 user, 1.56 system, and 843,857,920 bytes maximum RSS. The recovery file measured 1.64
  seconds, below its two-second file target. The principal ordinary-suite files remained the required
  1,000-sequence generated convergence coverage (~3.08 seconds) and 10,000-action retention coverage
  (~1.67 seconds). Decision: retain all required deterministic Fast coverage and record the aggregate
  overrun; no test was weakened, removed, reclassified, or moved merely for timing.
- `bun test --isolate ./src/lib/foundation-recovery.test.ts` — passed: 10 tests, 0 failures.
- `bun run test:focused:sqlite` — passed: 21 tests, 0 failures.
- `bun run test:focused:acceptance` — passed: 10 tests, 0 failures.
- `bun run test:focused:grant` — passed: 36 tests, 0 failures.
- `bun run test:focused:grant-code` — passed: 15 tests, 0 failures.
- `bun run build` and `bun run build:executable` — passed.
- migration diff check — passed; migrations 001–021 remain byte-for-byte unchanged from base.
- `git diff --check` — passed.

No Qualification Test and no `bun run check:sqlite-runtime` were run or added for this issue.

## #192 correction gate/evidence

- Base: `051829ed4dbd0c02660031f98fc7380e42b380f1`; final amended correction commit is the
  current single `HEAD`; branch:
  `codex/192-compose-technical-admin-restore`.
- Correction scope: Foundation backup uses a closed Foundation-only relation allowlist and never
  opens or reads the separate Technical Admin database; restore keeps the sanitized auth store at
  its live path, with the accepted restart/fresh-sign-in composition preserved.
- Prior correction evidence: `bun run check` passed; Foundation recovery 14 tests, Technical Admin
  13 tests, SQLite 21 tests, and acceptance 10 tests passed; both builds and `git diff --check`
  passed. The focused Grant 35/36 mismatch remains a base-pre-existing fixture/migration issue.
- This attempt changes only agent/research documentation and the compatibility JSDoc for
  `failedTechnicalAdminDatabasePath`; no Qualification Test or `bun run check:sqlite-runtime` was
  run. The amended commit and final check results are recorded in the coordinator handoff.
