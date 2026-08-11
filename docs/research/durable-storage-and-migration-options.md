# Durable storage and migration options

Research date: 11 August 2026

Planning ticket: [Research durable storage and migration options](https://github.com/netzhuffle/quadball-timer/issues/44)

## Executive answer

Two choices remain viable. They should be taken forward in this order for the later architecture
decision, without treating this research as that decision:

1. **SQLite in WAL mode, using Bun's built-in driver, is the preferred option to validate first for
   SQM.** It matches the current single-host, single-process compiled-executable deployment, adds no
   database service or driver dependency, supports atomic transactions, and permits concurrent
   readers while serializing writers. The decisive qualification is that `bun:sqlite` is synchronous
   and SQLite permits only one writer at a time. A production-shaped replay burst and six-pitch load
   test must therefore prove that short durable command transactions, WAL checkpoints, and backups
   do not stall WebSocket command handling. SQLite's own documentation recommends it for
   device-local storage with low writer concurrency and data that fits on one device; that describes
   the current deployment topology, but the load validation still matters
   ([Bun SQLite](https://bun.sh/docs/runtime/sqlite),
   [SQLite appropriate uses](https://www.sqlite.org/whentouse.html),
   [SQLite WAL concurrency](https://www.sqlite.org/wal.html#concurrency)).
2. **PostgreSQL, using Bun's built-in SQL client, is the stronger scale-out option and the fallback if
   SQLite misses the measured latency/recovery envelope.** PostgreSQL supplies asynchronous pooled
   client I/O, MVCC, concurrent writers, richer database-native monitoring, consistent online dumps,
   and a path to WAL-based point-in-time recovery. It also adds a separately operated service,
   authentication and credentials, routine maintenance, backup tooling, and a major-version upgrade
   lifecycle. Those costs are justified if the application will soon run multiple server processes,
   share a database across hosts, or require near-zero data loss after loss of the application host;
   they are not yet established SQM requirements
   ([Bun SQL](https://bun.sh/docs/runtime/sql),
   [PostgreSQL MVCC](https://www.postgresql.org/docs/current/mvcc-intro.html),
   [PostgreSQL server](https://www.postgresql.org/docs/current/app-postgres.html),
   [PostgreSQL backup and restore](https://www.postgresql.org/docs/current/backup.html)).

No third database is genuinely competitive for this decision. MySQL is technically available through
the same Bun API but introduces essentially the same separate-server boundary as PostgreSQL without a
repo-specific compatibility or operational advantage. DuckDB is an analytical database rather than
the transactional authority this system needs; Redis or raw JSON snapshots would require rebuilding
relational constraints, immutable history, backup semantics, and migration safety in the application.
The useful choice is the deliberately narrow embedded-versus-server comparison above.

The database product does not settle the harder correctness questions. Either option must persist an
accepted Control Action, its immutable provenance, its unique idempotency key, its deterministic
acceptance/order metadata, and any transactionally maintained projection/checkpoint as one atomic
unit. The server must acknowledge an operation only after that transaction commits. Neither arrival
order nor a mutable projection may become the authoritative history.

## Scope and current evidence

This report is planning only. It does not choose the final architecture, add a dependency, define a
physical schema, run a migration, provision a database, or change deployment.

The current implementation establishes the following baseline:

- [`src/index.ts`](../../src/index.ts) holds every game and its last 5,000 command ids in process-local
  `Map`/`Set` objects. A process restart loses them, and an older command becomes applicable again
  after its id is evicted.
- [`game-page-support.ts`](../../src/lib/game-page-support.ts) keeps a Controller snapshot and only
  pending command envelopes in browser local storage. After acknowledgement, the command envelope is
  removed; browser state is therefore useful outage continuity, not a durable server audit source.
- [`ws-protocol.ts`](../../src/lib/ws-protocol.ts) supplies a client command id and client timestamp,
  but the server currently applies batches in socket arrival order and broadcasts a mutable snapshot.
- [`package.json`](../../package.json) and [`bun.lock`](../../bun.lock) contain no database driver, ORM,
  or migration dependency. Production is a single compiled `bun-linux-x64-modern` executable.
- A local read-only smoke on the repository-pinned Bun 1.3.14 resolved `bun:sqlite` to SQLite 3.51.0
  and exposed the built-in `SQL` client. This establishes local API availability, not production
  executable or Linux storage behavior; those remain explicit validation gates below.
- The [deployment audit](production-deployment-operational-audit.md) identifies restart-safe state,
  schema-aware rollback, writable-state isolation, backup/restore, and rehearsal as production
  blockers. The [reliability baseline](correctness-reliability-baseline.md) requires lifecycle-long
  idempotency, deterministic concurrency, strict recovery parsing, and failure tests. The
  [threat model](passwordless-control-threat-model.md) requires atomic authorization/audit state,
  non-reversible grant verifiers, isolated public projections, and backup confidentiality.

## Required storage contract

The accepted language in [`CONTEXT.md`](../../CONTEXT.md) implies the contract below. “Permanent” is
a domain guarantee for the Event Game's operational record; it is not permission to retain raw
capabilities, routine logs, or unrelated personal data forever.

| Domain behavior | Required durable property | Consequence for either database |
| --- | --- | --- |
| An Event contains Game Days, Pitches, Pitch Slots, Event Teams, Event Games, and Grants. | Referential integrity and stable identifiers across schedule edits and Pitch Reassignment. | Use database constraints for object scope and parent relationships; reassignment updates references without replacing the Event Game or its history. |
| A Control Action is immutable; a Correction makes one stable Game Fact ineffective/effective again; an Official Override records the directed exception and reason. | Append-only facts and corrections, stable target ids, complete provenance, and deterministic replay. | Never update/delete accepted Event Game actions to express undo. Derived Game State and the Game Timeline are rebuildable projections. |
| Several Controllers can act concurrently and replay offline commands in order. | Atomic acceptance, uniqueness of command ids, a decided causal/ordering rule, and retry-safe conflict handling. | A uniqueness constraint provides durable deduplication. One transaction must bind the action, authorization provenance, order metadata, and maintained projection. |
| The server may disappear while Controllers remain operable. | Restart reconstruction from server facts/checkpoints plus explicitly authorized replay, without accepting a client snapshot as authority. | Readiness stays false until the store is readable, writable, compatible, and recovery is complete. Uncommitted/unacknowledged commands remain client pending work. |
| Control Grants, Grant Sessions, rotations, revocations, expiry, and recovery affect admission. | Authorization state and the Grant Audit Trail must commit atomically enough that restart/restore cannot revive revoked access or detach an action from its grant/session version. | Store verifier/fingerprint/version and pseudonymous session provenance, not a raw reusable grant or asserted human identity. |
| A finished Event Game locks after 15 minutes from its last accepted control action; unfinished games do not inactivity-lock. | Transactionally correct last-accepted time, lock state, and rejection of later admission/control. | The lock check and command acceptance must be in one serializable critical section; a stale in-memory check is insufficient. |
| The Control Audit Trail and Grant Audit Trail are permanent; the paper Official Score Sheet is authoritative for the event. | Long-lived integrity and restoreability while correctly presenting the app as operational evidence, not a signed sports record. | Retain accepted Event Game actions, corrections, overrides, deduplication keys, and audit provenance under an explicit archival policy. Paper authority reduces sporting harm but does not excuse silent data loss. |
| An Ad Hoc Game is editable and indefinitely visible by default, but has no Game Lock or durable Control Audit Trail and may be pruned if the list grows too long. | Restart-safe current state can be stored without promising permanent immutable history. | Give Ad Hoc data a separately explicit quota/pruning policy; do not weaken Event Game history or deduplication to match it. |
| Public spectators see only a Game Timeline and projections. | Deny-by-default data shaping, with no capability verifier, Grant Session, audit internals, pending command, or recovery data in public reads. | Query or construct explicit public DTOs; do not serialize internal database rows or projection checkpoints wholesale. |

### Transaction and command boundary

The minimum correct acceptance unit is conceptual rather than a schema prescription:

1. validate syntax, resource limits, object scope, Grant/Session validity, Game Lock, references, and
   the chosen causal/ordering preconditions;
2. attempt insertion under a game-scoped unique command id;
3. if already present, return the prior acceptance result without applying the sporting effect again;
4. otherwise append the immutable action and authorization provenance, assign its deterministic
   accepted order, and update any stored checkpoint/projection metadata in the same transaction;
5. commit, then acknowledge and broadcast the committed projection.

Both candidates support transactions and uniqueness constraints. SQLite permits one simultaneous
writer and provides snapshot isolation between separate connections; WAL lets reads overlap the
writer, but `SQLITE_BUSY` remains a normal condition that the application must bound and handle
([SQLite transactions](https://www.sqlite.org/lang_transaction.html),
[SQLite isolation](https://www.sqlite.org/isolation.html)). PostgreSQL uses MVCC so reads do not block
writes, offers row/table locking and stronger isolation levels, and supports atomic insert-or-ignore
through `INSERT ... ON CONFLICT`
([PostgreSQL concurrency control](https://www.postgresql.org/docs/current/mvcc.html),
[PostgreSQL INSERT](https://www.postgresql.org/docs/current/sql-insert.html)).

Application-level deterministic ordering is still required. A database commit sequence can serialize
acceptance, but it cannot decide whether two offline actions should be ordered by causal metadata,
client occurrence time, a server-assigned sequence, or a stable tie-breaker. The later ordering
decision must define that rule before persistence code is written.

## Candidate comparison

| Constraint | SQLite with `bun:sqlite` / Bun SQL | PostgreSQL with Bun SQL | Planning assessment |
| --- | --- | --- | --- |
| Bun and compiled Linux executable | Built into Bun; Linux uses Bun's statically linked SQLite. A live database must be an external file—an SQLite database embedded into a compiled executable loses writes when the process exits ([Bun SQLite](https://bun.sh/docs/runtime/sqlite), [single-file executable](https://bun.sh/docs/bundler/executables#embed-sqlite-databases)). | Built-in PostgreSQL client with prepared statements, transactions, pooling, connection timeouts, SCRAM support, and TLS; no JS driver package or server-side Bun runtime is required ([Bun SQL](https://bun.sh/docs/runtime/sql)). | Both avoid a native-addon packaging risk. Each still needs a production-executable integration test against the real store. |
| Driver maturity/risk | `bun:sqlite` has a direct synchronous API, explicit transactions/savepoints, prepared statements, WAL guidance, bigint handling, and SQLite error codes ([Bun SQLite](https://bun.sh/docs/runtime/sqlite)). | Bun SQL exposes the PostgreSQL wire protocol, pools, transactions, and typed PostgreSQL errors, but its docs list unsupported PostgreSQL features including `COPY`, `LISTEN`, and `NOTIFY` ([Bun SQL](https://bun.sh/docs/runtime/sql)). | Required CRUD/transaction behavior is covered in both. Do not design event propagation around Bun `LISTEN/NOTIFY`; WebSocket broadcasts remain application-owned. |
| Write concurrency | One writer at a time. WAL permits concurrent readers and writer, but checkpoints can be delayed by long readers and a busy store can return `SQLITE_BUSY` ([SQLite WAL](https://www.sqlite.org/wal.html), [SQLite transactions](https://www.sqlite.org/lang_transaction.html)). | MVCC supports concurrent readers/writers; unique and row constraints arbitrate conflicts, with deadlock/serialization handling still required ([PostgreSQL MVCC](https://www.postgresql.org/docs/current/mvcc-intro.html), [explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)). | SQLite plausibly fits one app process and short per-command writes; PostgreSQL has more headroom for multi-instance or heavy replay. Benchmark rather than infer. |
| WebSocket event-loop behavior | Bun's SQLite API is synchronous, so a slow lock, transaction, checkpoint, or query blocks that server thread ([Bun SQL SQLite notes](https://bun.sh/docs/runtime/sql#sqlite-specific-features)). | PostgreSQL queries are asynchronous and use a pool, so database waits need not synchronously block the Bun event loop; pool exhaustion and transaction latency remain explicit budgets ([Bun SQL pooling](https://bun.sh/docs/runtime/sql#connection-pooling)). | This is SQLite's largest application risk. Keep transactions short and broadcasts outside them; measure p95/p99 command-to-ack under replay plus spectators. |
| Transaction semantics | Atomic transaction functions; nested calls use savepoints; `BEGIN IMMEDIATE` can reserve the writer but may return busy ([Bun SQLite transactions](https://bun.sh/docs/runtime/sqlite#transactions), [SQLite transactions](https://www.sqlite.org/lang_transaction.html)). | A Bun transaction reserves one pooled connection and rolls back on callback error; PostgreSQL provides MVCC and configurable isolation ([Bun SQL transactions](https://bun.sh/docs/runtime/sql#transactions), [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)). | Either can atomically persist action + dedupe + audit + projection. Retries must be idempotent and bounded. |
| Constraint/type safety | Foreign-key enforcement must be explicitly enabled on every connection; `STRICT` tables add rigid type checks, and `integrity_check` also checks strict column types ([SQLite foreign keys](https://www.sqlite.org/foreignkeys.html), [STRICT tables](https://www.sqlite.org/stricttables.html)). | Rich typed columns and native primary, unique, check, exclusion, and foreign-key constraints ([PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)). | SQLite is acceptable only with explicit startup verification of foreign keys and intentional strict/check constraints. Validation remains mandatory before SQL for both. |
| Operational footprint | One database file plus WAL/shared-memory sidecars in one systemd-managed writable directory; no database daemon or connection credential. WAL requires same-host storage, not a network filesystem ([SQLite WAL](https://www.sqlite.org/wal.html)). | A running PostgreSQL server, data directory, configuration, authentication rules, database role, socket/port, backups, monitoring, vacuum, and version upgrades ([PostgreSQL server](https://www.postgresql.org/docs/current/app-postgres.html), [file locations](https://www.postgresql.org/docs/current/runtime-config-file-locations.html), [routine vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)). | SQLite is substantially simpler for the current host. PostgreSQL separates app crash from DB process and enables future multi-host app nodes at higher operator cost. |
| Resource use | No separate service; file size, WAL size/checkpoint latency, synchronous query time, and disk space must be app-monitored. Long readers can cause WAL growth ([SQLite WAL checkpointing](https://www.sqlite.org/wal.html#ckpt)). | Separate memory/process/connection-pool and vacuum/I/O budget; detailed cumulative activity, I/O, WAL, checkpointer, table, and lock statistics are built in ([PostgreSQL monitoring](https://www.postgresql.org/docs/current/monitoring.html), [viewing locks](https://www.postgresql.org/docs/current/monitoring-locks.html)). | SQLite should have lower fixed operational overhead; PostgreSQL has much stronger native observability. No numerical resource assumption is safe before rehearsal. |
| Backup/restore | Use Online Backup API, `VACUUM INTO`, or another SQLite-safe method for a live database; copying only the main file during writes can produce a corrupt backup ([safe backup methods](https://www.sqlite.org/howtocorrupt.html#_backup_or_restore_while_a_transaction_is_active), [Online Backup API](https://www.sqlite.org/backup.html), [VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuuminto)). | `pg_dump` creates an internally consistent snapshot without blocking ordinary readers/writers; custom archives restore through `pg_restore`. Base backups plus archived WAL support point-in-time recovery ([SQL dumps](https://www.postgresql.org/docs/current/backup-dump.html), [pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html), [PITR](https://www.postgresql.org/docs/current/continuous-archiving.html)). | SQLite is easy to copy only when done correctly; PostgreSQL has the richer recovery ladder. Both require off-host retention and restore rehearsal. |
| Integrity/corruption | `quick_check`, `integrity_check`, and `foreign_key_check` cover different invariants; `integrity_check` does not include foreign keys ([SQLite pragmas](https://www.sqlite.org/pragma.html#pragma_integrity_check)). | Data-page checksums detect changed pages when enabled; `amcheck` checks relation/index structure; backup manifests can be verified with `pg_verifybackup` ([data checksums](https://www.postgresql.org/docs/current/checksums.html), [amcheck](https://www.postgresql.org/docs/current/amcheck.html), [pg_basebackup](https://www.postgresql.org/docs/current/app-pgbasebackup.html)). | Schedule checks outside the live command latency path and verify restored data at the domain level in both cases. |
| Disk-full behavior | Writes can fail with `SQLITE_FULL`, including temporary-file writes; the app must leave commands unacknowledged and fail readiness ([SQLite result codes](https://www.sqlite.org/rescode.html#full)). | A full data disk prevents useful activity; a full WAL disk may panic and shut down the server, so free-space/WAL alerts are mandatory ([PostgreSQL disk-full failure](https://www.postgresql.org/docs/current/disk-full.html)). | Neither product makes disk exhaustion harmless. Preallocate headroom, alert before exhaustion, and test recovery. |
| Horizontal growth | WAL requires all users of the file on the same host and retains one writer ([SQLite WAL](https://www.sqlite.org/wal.html)). | Designed as a client/server database with multiple sessions and a path to replication/PITR ([PostgreSQL server](https://www.postgresql.org/docs/current/app-postgres.html), [high availability](https://www.postgresql.org/docs/current/high-availability.html)). | PostgreSQL should win if a second app host/process with independent writes becomes a near-term requirement. It is not required by the current systemd deployment. |

## Migration tooling and release practice

### Tooling choices to carry forward

The final database can use either of these migration approaches:

- **Reviewed, ordered SQL files plus a small application-owned migration ledger** are the lowest-risk
  SQM baseline. Bun SQL can execute a query file and supports multi-statement “simple” queries useful
  for setup/migrations; both Bun database APIs expose transactions
  ([Bun SQL query files](https://bun.sh/docs/runtime/sql#queries-in-files),
  [Bun SQL transactions](https://bun.sh/docs/runtime/sql#transactions),
  [Bun SQLite transactions](https://bun.sh/docs/runtime/sqlite#transactions)). The runner must record
  an immutable id/name, checksum, start/finish state or transaction outcome, release compatibility,
  and operator-visible failure. SQL remains reviewable and avoids hiding dialect behavior.
- **Drizzle schema/migration generation plus checked-in SQL** is a credible later evaluation, not a
  current recommendation. Official guides support `bun:sqlite` and its migration runner, and Drizzle
  documents Bun SQL/PostgreSQL integration
  ([Bun Drizzle guide](https://bun.sh/guides/ecosystem/drizzle),
  [Drizzle Bun SQLite](https://orm.drizzle.team/docs/sqlite/connect-bun-sqlite),
  [Drizzle Bun SQL/PostgreSQL](https://orm.drizzle.team/docs/get-started/bun-sql-new)). It adds runtime
  and development dependencies that are absent today, so compiled-executable resource inclusion,
  generated-SQL review, transaction behavior, and locked version quality would need separate proof.

Do not make “the app starts, therefore it silently migrates production” the normal deployment model.
Use an explicit, observable pre-activation step against a backup and a known release/schema pair.
Startup should instead check the schema version and refuse readiness if it is unsupported. This keeps
a migration failure from being obscured by systemd's automatic restart loop and lets activation stop
before WebSockets accept commands.

### Required migration protocol

1. **Declare compatibility.** Every release states the oldest/newest schema it can read and write.
   Readiness reports release identity, current schema, compatibility, and store writeability without
   exposing credentials or data.
2. **Quiesce deliberate migrations.** No Event Game command acceptance occurs while a schema/data
   migration runs. For the current single-host deployment, maintenance downtime outside active play
   is safer than attempting zero-downtime migration ceremony that has not been rehearsed.
3. **Take and verify a pre-migration backup.** Restore it into the isolated rehearsal store before the
   production change. Record the backup identity, database/schema version, release, timestamp, and
   integrity/domain counts; never record grant material.
4. **Acquire one migration owner.** Use the database's locking mechanism plus deployment
   serialization so two release attempts cannot migrate concurrently.
5. **Run one ordered migration at a time.** Prefer a transaction that includes its ledger record.
   SQLite's generalized ALTER procedure explicitly uses a transaction and may require table rebuilds
   ([SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes)).
   PostgreSQL supports transactional DDL broadly, but lock levels vary and operations such as
   `CREATE INDEX CONCURRENTLY` cannot run inside a transaction; failed concurrent builds can leave an
   invalid index
   ([PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html),
   [PostgreSQL CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY)).
6. **Make non-transactional steps resumable.** Split them into named phases with preconditions and
   postconditions. Never mark a phase applied until its invariant is verified; a retry must detect and
   safely resume or stop on the existing partial artifact.
7. **Run integrity and domain checks before activation.** At minimum: schema ledger/checksums,
   database-native integrity/constraints, Event/Game/Grant reference counts, uniqueness of command
   ids in their chosen scope, correction targets, last accepted order, projection rebuild comparison,
   and absence of raw grants in database/log exports.
8. **Activate only a compatible binary and run non-mutating smoke checks.** Broadcasts and public
   projections start only after readiness passes.

### Forward/backward compatibility and rollback

Prefer an **expand → backfill → switch reads/writes → contract** sequence whenever a release might
need executable rollback:

- add nullable/new structures first while the old executable still works;
- deploy code that can read the old and new representation and writes the new form;
- backfill explicitly, with progress and restartability;
- verify projections from both representations;
- remove the old form only after the rollback window is deliberately closed.

Large tables are unlikely at SQM scale, but migration safety is about locks and partial failure rather
than row count alone. PostgreSQL `ALTER TABLE` commonly takes restrictive locks unless documented
otherwise, while SQLite schema changes outside its limited native ALTER forms rebuild a table
([PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html),
[SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)). Rehearse with production-shaped
data and measure lock/elapsed time instead of assuming a small dataset makes every change safe.

Binary symlink rollback is safe only while the prior binary supports the current schema. After a
contracting or destructive migration, restoring an older database backup also discards later accepted
actions and revocations. During an Event that is usually worse than forward repair. Therefore:

- default to a compatible old binary or forward fix;
- permit database restore only through an explicit incident decision with a declared recovery point;
- reconcile any post-backup Controller operations through the authorized recovery protocol, never by
  replacing the database with the first available client snapshot;
- keep pre-migration backups until both rollback window and post-event acceptance are closed.

## Backup, restore, integrity, and retention baseline

The later decision should accept or replace these proposed service objectives explicitly:

| Failure | Proposed SQM objective | Required evidence |
| --- | --- | --- |
| App crash, deployment restart, or host reboot with healthy volume | **RPO 0 for acknowledged Event Game actions and revocations; RTO 2 minutes.** | Kill/restart/reboot during a time-compressed live game; compare action ids, audit order, grants, projection, and Controller convergence. |
| Failed or partially applied release migration, with commands quiesced | **RPO 0; RTO 15 minutes.** | Restore the verified pre-migration backup into isolation, then exercise the exact rollback/forward-fix path and schema compatibility check. |
| Database process/file temporarily unavailable | **No false acknowledgement; Controllers remain locally operable; server recovery within 5 minutes after storage returns.** | Force unavailable/read-only/busy states; prove readiness fails, writes remain pending, no partial action appears, and reconnect converges. |
| Primary volume/host lost during an Event | **Target RPO at most 5 minutes and RTO 30 minutes, subject to Production Acceptance Authority approval.** | Restore the newest off-host backup/PITR target into the isolated replacement, validate it, then merge authorized Controller operations and reconcile against the Official Score Sheet. |
| Corruption discovered | **Stop authoritative writes; preserve evidence; recover to the newest verified point rather than attempting silent repair.** | Inject a corrupt rehearsal copy or failed integrity result; verify alerts, isolation, restore, domain checks, and explicit recovery-point reporting. |

RPO 0 for acknowledged writes on an intact volume follows directly from acknowledgement-after-commit.
The five-minute catastrophic-volume target is deliberately not claimed as already achievable. SQLite
needs a safe frequent off-host snapshot/replication design; periodic local copies alone do not survive
host loss. PostgreSQL can use archived WAL for point-in-time recovery, but only after it is configured,
monitored, and restore-tested
([PostgreSQL continuous archiving](https://www.postgresql.org/docs/current/continuous-archiving.html)).
The Production Acceptance Authorities must decide whether the paper record plus Controller recovery
is an acceptable fallback for that rare failure or whether near-zero off-host RPO makes PostgreSQL (or
additional SQLite replication work) mandatory.

### Backup and rehearsal rules

- Keep at least one encrypted/access-controlled off-host backup, not merely another path on the same
  application volume. Protect backups as capability and audit stores; use separate operator access and
  never put them in release directories or CI artifacts.
- Back up before every migration and deployment that can affect durable state, on a scheduled cadence
  that meets the accepted RPO, and at an Event checkpoint appropriate to the chosen recovery design.
- For SQLite, capture a live database only through a documented safe method. A raw copy must include
  the right WAL state or occur with all transactions stopped; SQLite documents the Online Backup API,
  `VACUUM INTO`, and `sqlite3_rsync` as safe live-copy approaches
  ([SQLite corruption guidance](https://www.sqlite.org/howtocorrupt.html#_backup_or_restore_while_a_transaction_is_active)).
- For PostgreSQL, use a version-supported `pg_dump` custom archive for portable logical recovery at
  this scale; add base backup/WAL archive only if the accepted catastrophic RPO requires PITR.
  `pg_dump` is internally consistent during ordinary concurrent use and archive formats restore with
  `pg_restore`
  ([PostgreSQL SQL dumps](https://www.postgresql.org/docs/current/backup-dump.html),
  [pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html)).
- A backup is not accepted evidence until it restores into a different path/database with production
  credentials and outbound side effects disabled. Run native integrity checks, schema compatibility,
  referential/domain counts, immutable-action/dedupe checks, projection rebuild comparison, and a
  read-only API/WebSocket smoke against that restored copy.
- Rehearsal must never point a release candidate at production storage. SQLite needs a copied file and
  separate writable directory; PostgreSQL needs a separate database/cluster and distinct credentials.

### Retention model to decide before implementation

- **Event Games:** retain immutable accepted actions, Corrections, Official Overrides, grant/session
  provenance, conflict/recovery results, and deduplication keys for the full permanent audit lifetime.
  Retain enough checkpoints to verify replay, but projections may be regenerated.
- **Grants:** delete raw one-time presentation material as soon as the chosen exchange permits; retain
  non-reversible verifier/fingerprint/version, state transitions, expiry/revocation, and audit
  provenance. Restoring a backup must not silently make a revoked grant effective.
- **Ad Hoc Games:** retain current state across ordinary restart if the product decision requires its
  “indefinitely visible by default” behavior, but do not promise a permanent immutable audit. Decide a
  visible quota/pruning rule and dedupe horizon before implementation; never silently apply it to Event
  Games.
- **Backups:** retain all pre-migration/event backups through SQM acceptance and the rollback window.
  The post-SQM schedule, archival export, deletion authority, and proof of deletion may be deferred,
  but a temporary conservative retention must be documented before production data exists.
- **Logs/metrics:** retain only redacted operational metadata for a bounded period. Command payloads,
  raw grants, database URLs/passwords, query parameters, backup paths containing secrets, and private
  audit rows do not belong in routine logs.

## Security implications

The database is not an authorization boundary exposed to browsers. HTTP/WebSocket adapters validate a
capability through one server-owned admission boundary, and the runtime database identity receives
only the privileges needed by the application.

For either candidate:

- persist a slow/non-reversible verifier or equivalent chosen by the grant-format decision, plus a
  fingerprint/version suitable for audit; never persist or log the presented bearer value merely for
  convenience;
- bind every Grant, Grant Session, action, correction target, and public projection to its explicit
  Event/Pitch/Game scope using constraints and transaction checks;
- keep immutable action/audit tables append-only through the application interface; migration and
  recovery authority must be a separate operator path;
- make public DTO/projection queries explicit and allowlisted; database rows must not cross directly
  to a spectator or Controller response;
- encrypt/access-control off-host backups and rehearsal copies, isolate credentials, redact database
  errors, and record backup/restore success without recording private contents;
- fail closed when database state, schema, or authorization cannot be read or committed. Existing
  admitted Controllers may continue locally under the offline policy, but the server cannot admit new
  authority or acknowledge a mutation from stale memory.

SQLite additionally requires one systemd-managed writable state directory owned only by the runtime
user; the main file, `-wal`, `-shm`, temporary files, backup outputs, and restore staging all need the
same deliberate permission/space policy. Do not place the live file inside an immutable release or
embed it into the executable. Integrity tooling and backup operators need controlled read access.

PostgreSQL additionally requires a dedicated least-privilege application role, local Unix socket or
loopback-only listener unless remote access is deliberately accepted, restrictive `pg_hba.conf`, and
separate migration/backup authority. PostgreSQL authenticates every connection as a role and combines
`pg_hba.conf` with database privileges; Bun supports SCRAM authentication and verified TLS when a
remote connection is needed
([PostgreSQL roles](https://www.postgresql.org/docs/current/database-roles.html),
[PostgreSQL client authentication](https://www.postgresql.org/docs/current/auth-pg-hba-conf.html),
[Bun SQL TLS/authentication](https://bun.sh/docs/runtime/sql#tls-configuration)).

Database-at-rest and backup encryption remain host/operations responsibilities unless a separately
evaluated encryption layer is chosen. Database selection alone must not be recorded as satisfying
those controls.

## What must be decided when

### Before persistence implementation

1. Choose SQLite or PostgreSQL after the bounded validations below.
2. Fix the operation identity scope and lifecycle-long dedupe rule.
3. Fix deterministic causal/order semantics for concurrent and offline operations; storage must not
   invent the rule.
4. Fix the transaction boundary for action, grant/session provenance, audit, lock state, and any
   maintained projection/checkpoint.
5. Decide whether Event Game state is always replayed, checkpointed periodically, or both, including
   how a checkpoint proves which immutable actions it covers.
6. Decide the SQLite busy/checkpoint policy or PostgreSQL isolation/locking/pool policy, with explicit
   retry and timeout behavior.
7. Choose the migration artifact/ledger format, explicit deployment hook, schema compatibility
   declaration, and pre-activation failure behavior.
8. Accept RPO/RTO targets, backup cadence/location/encryption/access, restore verification, and
   production-versus-rehearsal isolation.
9. Decide Ad Hoc Game durability, quota/pruning, and dedupe retention separately from Event Games.
10. Fix storage limits and alerts for games, operations, names, batches, connections, WAL, file/disk,
    backup age, and migration/integrity failure.

### Required before SQM, but can follow the product choice

- physical schema/index design and migration implementation;
- the production executable's real driver integration test;
- restart, reboot, disk-full/read-only, corrupt-store, partial-migration, backup, restore, binary
  rollback/forward-fix, offline replay, and concurrent-order regression tests;
- production writable-state/service or PostgreSQL provisioning and hardening;
- readiness, latency, busy/lock/pool, disk/WAL, backup-age, restore, integrity, and rejection metrics;
- one isolated production-shaped rehearsal and a recorded Production Acceptance Authority decision.

### Safe to defer until after SQM

- multiple application instances, database replication/failover, read replicas, multi-region service,
  and automatic failover, unless the accepted catastrophic-host RPO forces them sooner;
- cross-database portability abstractions and a second active dialect;
- analytical warehouse/search/vector features;
- zero-downtime contracting migrations for large datasets (retain the compatibility discipline now,
  but a planned maintenance window is proportionate for SQM);
- finalized long-term archival/deletion automation after a conservative temporary retention policy is
  in force.

## Validation gates and unresolved unknowns

The later decision should not close until these bounded checks are answered:

1. **SQLite production-shaped load:** compiled Linux executable, WAL + full durability setting,
   foreign keys, strict tables, one live game per six pitches, spectator fan-out, two Controllers per
   game, and worst accepted offline replay burst. Measure p50/p95/p99 transaction and command-to-ack,
   event-loop stalls, `SQLITE_BUSY`, WAL size, checkpoint pauses, CPU, RSS, and disk writes.
2. **PostgreSQL comparison run:** same workload with the proposed local socket/loopback deployment,
   bounded pool, chosen isolation, and equivalent constraints. Measure latency, pool wait, locks,
   deadlocks/retries, CPU/RSS including the database service, WAL volume, and operational steps.
3. **Executable compatibility:** prove `bun-linux-x64-modern` opens the external SQLite file or connects
   to PostgreSQL, applies a transaction, restarts, and sees it. Verify the exact pinned Bun version;
   do not extrapolate from development mode.
4. **Backup during load:** produce a safe live backup without unacceptable command latency, restore it
   to isolation, validate native integrity plus domain invariants, and measure RPO/RTO.
5. **Failure injection:** process kill at each transaction boundary; forced busy/lock timeout;
   read-only state; nearly full and full disk; interrupted migration; incompatible old binary;
   corruption in a copied rehearsal store; and loss of the application host/volume.
6. **Scale input:** confirm expected maximum pitches, simultaneous Controllers/spectators, games per
   Event, operations per Game, offline batch size/age, retention years, and event overlap. The current
   prototypes show six pitches and 96 games, but those UI fixtures are not an accepted capacity
   contract.
7. **Operations input:** establish current host disk/filesystem and backup target, whether PostgreSQL
   is already operated on that host, monitoring/alert transport, available rehearsal host/container,
   and the operator who owns restore and database upgrades. This research did not inspect production
   over SSH.
8. **Catastrophic-loss policy:** the two Production Acceptance Authorities must approve whether a
   five-minute off-host RPO plus Controller/paper reconciliation is sufficient, or whether near-zero
   off-host RPO is mandatory. That answer can change the SQLite/PostgreSQL ranking.

## Rejected approaches

- **Current in-memory registry plus browser recovery:** rejected because it loses the shared authority,
  accepted dedupe history, revocation state, spectators, and other Controllers on restart. A client
  snapshot is untrusted recovery evidence, not the server record.
- **Periodic JSON or whole-state snapshots as the authoritative store:** rejected because the system
  needs uniqueness, atomic cross-object updates, immutable targeted Corrections, referential
  constraints, migrations, and verified live backup. Rebuilding those semantics around file replaces
  a database with bespoke database work.
- **An embedded SQLite database compiled into the executable:** rejected because Bun documents that
  writes to an embedded database are in memory and lost when the executable exits
  ([Bun single-file executable](https://bun.sh/docs/bundler/executables#embed-sqlite-databases)).
- **Blindly copying a live SQLite main file:** rejected because a copy taken during a transaction may
  combine old and new pages and be corrupt; use an official safe backup method
  ([SQLite corruption guidance](https://www.sqlite.org/howtocorrupt.html#_backup_or_restore_while_a_transaction_is_active)).
- **Automatic, unconditional startup migration:** rejected because a partial/incompatible migration
  can enter a systemd restart loop and erase the clean boundary between migrate, verify, activate, and
  serve. Startup should verify compatibility, not silently mutate production.
- **Dual SQLite/PostgreSQL production support for SQM:** rejected as unnecessary scope. Select one
  dialect after validation; shared conceptual boundaries and tests are valuable, but dialect
  portability must not dilute correctness or rehearsal.
- **A third primary database for this decision:** rejected because no current integration, scale, or
  operator constraint makes one superior to both the embedded SQLite and server PostgreSQL choices.

## Decision handoff

The evidence supports a bounded decision rather than more broad research: validate SQLite first
against the exact six-pitch/replay/failure envelope, run PostgreSQL as the comparison baseline, then
choose based on measured command latency, event-loop blocking, recovery proof, catastrophic-host RPO,
and operator burden. If SQLite meets those gates and the accepted host-loss RPO does not require
server-grade continuous archiving, it is the proportionate SQM choice. If it misses the latency
envelope, multiple writers/hosts become near-term, or near-zero off-host RPO is mandatory, choose
PostgreSQL. Either choice still requires the same immutable operation, atomic authorization/audit,
explicit migration, schema-compatibility, and restore-rehearsal contract.
