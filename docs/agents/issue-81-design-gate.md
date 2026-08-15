# Issue #81 recovery design gate

## Delivery boundary

Issue #81 adds one deep `FoundationRecovery` module. Its interface has four operations:

- create one verified pre-deployment snapshot;
- independently verify a retained snapshot;
- stage and replace the live Event foundation database while preserving the failed image;
- import Controller-held Control Actions through the existing composed-acceptance interface.

The module does not schedule backups, deploy releases, cut over Production, enroll/reset a Technical
Admin Passkey, or provide periodic, Event-handoff, or off-host backup machinery. Published
migrations 001–021 remain byte-for-byte unchanged; recovery points, restore evidence, and Recovery
Gaps are durable 0600 sidecars rather than a new application relation.

## Backup policy and integrity

`foundation-backup-policy-v1` is a closed relation allowlist. It includes all Event Game Record,
Control Action, idempotency, replay, Event catalog, non-Technical-Admin Grant, Grant Session,
credential/verifier, audit, integrity-anchor, admission, and migration-ledger relations. It excludes
the exact Technical Admin credential, enrollment, challenge, browser-session, identity/state, log,
and alert relations. A new or otherwise unclassified table/view fails the backup before retention can
change.

The live writer queue drains and remains held while `VACUUM INTO` creates a consistent raw snapshot
outside the live database directory. Explicitly excluded relations are removed only from that raw
snapshot. A second `VACUUM INTO` creates the compact retained image, so deleted Technical Admin
payload is absent from free pages as well as logical rows.

The backup workspace is a physically separate, caller-owned, non-symlink `0700` directory. Raw,
staged, retained, manifest, evidence, and failed-image destinations fail closed on pre-existing or
symlink paths. The raw unsanitized image is tightened to `0600` before the SQLite writer queue yields;
all other files are `0600`. Verification and restore copy from no-follow file handles whose inode,
size, and modification identity remain stable, into exclusively created private files. Published
files are rechecked against the opened inode; failed/live image moves use exclusive same-filesystem
links before unlinking the source. Every owned Event, Technical Admin, WAL/SHM, and quarantine source
is tightened and verified as a non-symlink `0600` regular file before preservation; the linked
destination is verified at the same private mode. Rollback repeats that identity and mode check.
Cleanup unlinks only the inode recovery created. Existing,
wrong-owner, permissive, symlinked, or replaced paths are never repaired or overwritten.

Verification uses a separate database handle and disposable copy. It requires:

- exact retained-file SHA-256 and deterministic included-relation equality with the quiesced point;
- `integrity_check`, `foreign_key_check`, exact schema, ordered migration IDs/checksums, immutable
  provenance, action/idempotency parity, Grant/audit/session/reference integrity, and complete Event
  Game replay through the existing readiness verifier;
- every encryption, lookup, and audit key version represented in retained rows to exist in the
  separately supplied key ring;
- no Technical Admin relation after compaction.

Grant credential/session lookup versions are lookup-key requirements. The accepted Grant Code format
derives its stored lookup/fingerprint material from the audit ring, so its represented lookup-version
column is truthfully an audit-key requirement; integrity anchors and audit tags are audit requirements
as well. Recovery reports the persisted contract without changing it, and a neighboring lookup key
cannot satisfy a missing represented audit key.

Keys are never written to the SQLite image, manifest, or evidence. A verified backup uses unique
versioned filenames. Existing verified snapshots remain untouched until the new database and
manifest have both passed verification and their directory entry is synced.

## Restore and authority policy

Restore verifies the retained snapshot before touching the live database and copies it to an
exclusive staging path beside the live file. Technical Admin and Event authoritative writers then
stop, drain, and close before the one final current-authority evaluation immediately preceding
replacement. Expired Grants are cryptographically erased through the existing lifecycle
implementation; stale Event Admin sessions are expired. Every active Control Session is resolved
through `resolveSession(scope, session.eventGameId)`: exact current, pinned, and switchable sessions
remain usable; only the exact session reported terminal for Game Lock or past Game Day is terminated.
One reused Control Grant may therefore terminate exact active sessions for multiple historical Game
identities without conflict. Its present Grant Code is erased once only when the Grant's independently
resolved current scope is Game-locked, with that exact current Game recorded as evidence. Missing,
unavailable, conflicted, malformed, or identity-mismatched resolution aborts restore.

The staging database passes readiness again, is sealed into a portable checkpointed image, and is
confirmed free of Technical Admin state. The injected Technical Admin auth adapter then stops new
auth writes and drains/closes its separate database before authoritative Event writes are drained.
The live Event image, Technical Admin auth image, and any sidecars/quarantine marker move exclusively
to unique failed-image paths; only the staged Event image moves exclusively into active use. On next startup the
auth repository therefore creates empty auth state rather than reviving the former passkey, sessions,
challenges, or enrollment authorization. A replacement failure removes only the installed inode and
moves both failed images back without overwriting a competing path. The caller must reopen storage
after either outcome.

Before cutover, recovery writes and syncs one immutable private pending record. After successful live
replacement it atomically adds a separate synced `0600` completion record. A completion-record I/O
failure cannot turn the already completed restore into a reported failure: the return value states
`completed: true` and `completionEvidenceStatus: write-failed`, while the immutable pending record
retains the cutover identity for reconciliation and prevents an unsafe blind retry.

Redacted restore evidence records snapshot time, snapshot/current action counts, whether potentially
newer work existed, the preserved failed-image path, and restored Grant type/version tuples with
Grant IDs hashed. This is the accepted older-snapshot resurrection-risk evidence for later Technical
Admin review. It never claims that restored authority was current at snapshot time; current lifecycle
reevaluation remains decisive.

## Recovery import and Recovery Gaps

Controller-held actions are treated as untrusted inputs. The recovery operation:

- rejects cross-Event-Game input before submission;
- preserves each original operation identity, causal/occurrence evidence, and payload; original
  server acceptance time is nullable and retained only when surviving evidence establishes it;
- replaces historical authority claims with a supplied current Grant Session/version and submits the
  batch through the `FoundationAcceptance` instance composed once from this recovery's storage,
  Grant environment, codecs, scope resolver, and interpreter using a fresh current session bearer;
- therefore receives normal codec validation, content-bound idempotency, current authorization,
  cross-Game checks, deterministic ordering/rebuild, and paired Control/Grant audit behavior;
- bounds action and supplied-gap counts before pending evidence, writes explicit bounded redacted
  Recovery Gaps before submission, and adds one gap for every supplied action not accepted, including
  whole-batch rejection or a result list shorter than the action list, without inventing
  acknowledgement or other server-only evidence.

## Corruption and fatal quarantine failure

The #80 fatal case remains intentionally narrow. If corruption is latched and the sibling quarantine
marker itself cannot be durably persisted, the running storage still reports `quarantine-failure` and
must remain frozen. Operators must not attempt a fresh snapshot or silent SQLite repair from that
instance. Preserve the database, WAL/SHM files, and any marker as the failed image; restore only an
already independently verified snapshot through the staged path; then reopen with the separately
supplied key ring and require readiness before authoritative traffic. If no verified snapshot exists,
keep authoritative writes stopped and use current-authority Controller recovery plus the Official
Score Sheet, recording Recovery Gaps. This is not an automatic failover or a second writer.

## Fast-test evidence

Ordinary hermetic tests cover SQLite snapshot/compaction, synthetic Technical Admin rows and physical
canaries, unclassified relations, independent verification, retained predecessor backups, staged
replacement, failed replacement rollback, failed-image preservation, restart, current lifecycle
reevaluation, redacted evidence, explicit gaps, and real composed-acceptance import with durable
SQLite mutation. They do not run Qualification, soak, load, crash, or exact-production-artifact
workloads.

The corrected suite additionally covers the synchronized final-evaluation/cutover race; a pinned old
Game beside multiple exact locked and past-Game-Day sessions on one reused Grant; one truthful current
Game Code erasure across memory, SQLite, and restart; rejected/malformed per-session
resolution; private/no-follow filesystem behavior including synchronized backup-final replacement,
valid-database substitution before reevaluation, and verified restore-stage pathname and in-place
mutation races; `0644` failed-image inputs and rollback; post-cutover completion-evidence I/O failure;
base-contract present/disabled Grant Codes and represented-key category neighbors; whole-batch
gap completeness and bounds; and real composed acceptance with restart-observed SQLite mutation.
