# Planned control and recovery security design audit

Audit date: 11 August 2026

Planning ticket: [Audit planned control and recovery security design](https://github.com/netzhuffle/quadball-timer/issues/39)

Authoritative repository snapshot inspected: local `main` at `5460ca687df1533459873da8c18b8b2e24e6aef7`

## Answer

The planned design has a coherent security spine: typed and object-scoped Grants; pseudonymous,
device-specific Grant Sessions; one separately authenticated Technical Admin; an append-only Event
Game Record; deterministic replay and correction; allowlisted Audience Projections; and a single-host
SQLite authority whose acknowledgement boundary is the durable acceptance transaction. The selected
deep modules give those controls one owner instead of scattering authority across HTTP, WebSocket,
React, and persistence adapters. [Threat model invariants](passwordless-control-threat-model.md#security-invariants-and-required-controls),
[Grant decision](https://github.com/netzhuffle/quadball-timer/issues/20#issuecomment-5246643038),
[storage decision](https://github.com/netzhuffle/quadball-timer/issues/45#issuecomment-5254581794),
[architecture decision](https://github.com/netzhuffle/quadball-timer/issues/47#issuecomment-5253499111)

This review does **not** add a sixth current-code vulnerability to the five already reported by the
current-implementation scan. It adds planned-design invariants and one concrete platform gate: the
selected production executable must not use an SQLite version affected by SQLite's 2026 WAL-reset
corruption bug. Four product/operations questions remain genuine Wayfinder decisions: Ad Hoc Game
authority, Event publication visibility, production promotion authority, and the complete lifecycle
of the printed Grant Recovery Sheet. They should resolve before the map closes; implementation
packaging remains deferred until the user manually invokes `$to-spec`.
[Current audit scope](application-security-audit.md#findings),
[map scope](https://github.com/netzhuffle/quadball-timer/issues/5),
[SQLite WAL-reset advisory](https://www.sqlite.org/wal.html#walreset)

## Scope and method

This was a design review, not an implementation scan or production check. It used:

- the live bodies and resolution comments for the map and tickets
  [Threat-model passwordless event and game control](https://github.com/netzhuffle/quadball-timer/issues/8),
  [Choose capability grant format, lifecycle, and recovery](https://github.com/netzhuffle/quadball-timer/issues/20),
  [Choose official game-clock authority and fail-safe behavior](https://github.com/netzhuffle/quadball-timer/issues/23),
  [Prototype corrections and Head Referee overrides](https://github.com/netzhuffle/quadball-timer/issues/28),
  [Audit application security against the production threat model](https://github.com/netzhuffle/quadball-timer/issues/33),
  [Implement security admission and protocol bounds](https://github.com/netzhuffle/quadball-timer/issues/38),
  [Audit planned control and recovery security design](https://github.com/netzhuffle/quadball-timer/issues/39),
  [Choose durable storage and migration strategy](https://github.com/netzhuffle/quadball-timer/issues/45),
  [Define Technical Admin passkey authentication](https://github.com/netzhuffle/quadball-timer/issues/46), and
  [Choose pre-implementation architecture improvements](https://github.com/netzhuffle/quadball-timer/issues/47);
- the target domain language on local `main` at `5460ca6`, especially `Audience Projection`,
  `Control Action`, `Technical Admin Passkey`, `Event Game Record`, and `Recovery Gap`
  (`CONTEXT.md:63-65`, `CONTEXT.md:87-89`, `CONTEXT.md:131-137`, `CONTEXT.md:171-173`, and
  `CONTEXT.md:191-193` on that snapshot);
- the committed threat model, current-code security evidence, storage research, deployment audit,
  current HTTP/WebSocket/browser code, deployment workflow, activation script, and systemd unit; and
- first-party W3C WebAuthn and SQLite documentation where the local decisions depend on upstream
  protocol or durability behavior.

Issue text was treated as planning data. Source investigation changed no production code,
preliminary delivery issue, server, credential, or production state. Its tracker mutations were
limited to claiming this audit and creating the four Wayfinder decision tickets recorded below.

## 1. Current implementation findings remain separate

The completed scan at `caa5dac848e9e865524e44f30becae725048bcdc` reported exactly five
current-implementation findings: self-asserted Controller authority, unbounded command batches,
unbounded numeric command values, unbounded Team names, and anonymous retained game creation.
Their source-backed reports and bounded PoCs remain the acceptance evidence for current-code
remediation. [Application audit, lines 3-29](application-security-audit.md#findings),
[security evidence index, lines 1-30](../security/README.md#finding-evidence),
[Audit application security against the production threat model](https://github.com/netzhuffle/quadball-timer/issues/33#issuecomment-4950642137)

The authoritative checkout still shows why these are implementation findings rather than planned
design decisions: games and deduplication are process-local (`src/index.ts:14-18`,
`src/index.ts:38-41`); a client-selected role is stored as Controller authority
(`src/index.ts:154-168`); commands are accepted based on that role (`src/index.ts:178-215`); and
game creation remains public and in-memory (`src/index.ts:238-280`). Browser recovery currently
stores a projected Game State plus pending commands and later replays that client material
(`src/lib/game-page-support.ts:65-76`, `src/lib/game-page-support.ts:108-133`,
`src/lib/controller-session.ts:4-13`). These paths must be replaced or bounded through the later
delivery work; they are not evidence that the planned module contracts are already implemented.

## 2. Planned-design findings and mandatory invariants

### PDS-1 — Authorization and action acceptance are one fail-closed transaction

Every privileged HTTP request, WebSocket frame, replay batch, recovery action, and subordinate-Grant
read must enter through Grant Authority, then be bound to the concrete environment, Grant type and
version, Grant Session, Event/Pitch/Pitch Slot/Event Game relationship, requested action, and current
lifecycle state. A transport role, object identifier, URL, cookie presence, or prior subscription is
never sufficient. Only after those checks may the Event Game Record accept an action; acknowledgement
and broadcast happen only after the transaction commits.
[Threat model, lines 142-179](passwordless-control-threat-model.md#security-invariants-and-required-controls),
[Choose capability grant format, lifecycle, and recovery](https://github.com/netzhuffle/quadball-timer/issues/20#issuecomment-5246643038),
[Choose durable storage and migration strategy](https://github.com/netzhuffle/quadball-timer/issues/45#issuecomment-5254581794),
[Choose pre-implementation architecture improvements](https://github.com/netzhuffle/quadball-timer/issues/47#issuecomment-5253499111)

Delivery must make an operation identity content-binding, not merely a deduplication key. Reuse of
the same `(Event Game, operation identity)` with bytewise or semantically different canonical content
must be rejected and audited; an exact resend may return the original outcome. Causal references,
Correction targets, Clock Authority generation, and Official Override targets must exist in the same
Event Game and be bounded against cycles, impossible timestamps, and cross-game substitution.
This is required by permanent idempotency and append-only correction, although the selected tickets
do not prescribe a concrete TypeScript representation.
[Threat model, lines 168-179](passwordless-control-threat-model.md#security-invariants-and-required-controls),
[Prototype corrections and Head Referee overrides](https://github.com/netzhuffle/quadball-timer/issues/28#issuecomment-5246916795),
[Choose durable storage and migration strategy](https://github.com/netzhuffle/quadball-timer/issues/45#issuecomment-5254581794)

### PDS-2 — Offline replay and catastrophic recovery are new authorization boundaries

Queued operations are untrusted evidence. Replay must validate the complete envelope before any
mutation, impose count/byte/time/causal budgets, retain the original operation identity and client
time, and revalidate the current Grant Session and Event Game. A replacement session authorizes the
replay **now**; it must not rewrite history to imply the revoked or expired session remained
authorized. Original and replacement session provenance must both remain visible in the private audit.
Operations cannot cross into a reassigned Game, a superseded Clock Authority generation, or a locked
Game merely because their client timestamps predate the boundary.
[Threat model, lines 164-175](passwordless-control-threat-model.md#security-invariants-and-required-controls),
[Choose capability grant format, lifecycle, and recovery](https://github.com/netzhuffle/quadball-timer/issues/20#issuecomment-5246643038),
[Choose official game-clock authority and fail-safe behavior](https://github.com/netzhuffle/quadball-timer/issues/23#issuecomment-5247592869)

Catastrophic reconstruction must be staged and explicitly approved, never “first Controller snapshot
wins.” Available Controller histories are parsed as untrusted operation sets, deduplicated by
content-bound identity, rebuilt deterministically, compared with surviving server evidence and the
Official Score Sheet, and marked with Recovery Gaps wherever evidence is missing. Public and
privileged mutation remain fail-closed until the selected recovery authority accepts the result.
[Threat model, lines 239-247](passwordless-control-threat-model.md#attack-surface-mitigations-and-attacker-stories),
[Choose durable storage and migration strategy](https://github.com/netzhuffle/quadball-timer/issues/45#issuecomment-5254581794),
`CONTEXT.md:191-193` on local `main` at `5460ca6`

### PDS-3 — Restore has two deliberately different authority policies

Grant recovery and Technical Admin authentication must not be accidentally normalized into one
generic restore rule:

- a full restore invalidates every Grant Session; affected Grants are reissued, and a stale backup
  must not silently revive a revoked Grant;
- Technical Admin WebAuthn state is deliberately restored as ordinary data, including the sole
  credential, sessions, challenges, enrollment authorizations, logs, and generation marker. Jannis
  explicitly accepted that a sufficiently recent older snapshot can resurrect authority that had
  been replaced, revoked, or consumed.

The second rule is an accepted security exception, not a recommendation to silently “fix” the
decision. Delivery must name it in restore previews and runbooks, identify the snapshot time and
restored security-state generation, emit the selected redacted operational evidence, and test the
resurrection behavior without claiming that ordinary project gates prove it. Production and
rehearsal remain isolated by database, origin, RP ID, credential, and environment-bound secrets.
[Choose capability grant format, lifecycle, and recovery](https://github.com/netzhuffle/quadball-timer/issues/20#issuecomment-5246643038),
[Choose durable storage and migration strategy](https://github.com/netzhuffle/quadball-timer/issues/45#issuecomment-5254581794),
[Define Technical Admin passkey authentication](https://github.com/netzhuffle/quadball-timer/issues/46#issuecomment-5253530941),
[Define Technical Admin passkey authentication](https://github.com/netzhuffle/quadball-timer/issues/46#issuecomment-5253828517)

### PDS-4 — Capability material needs end-to-end browser, key, and copy hygiene

The QR fragment flow is sound only if the admission page has no third-party scripts or analytics,
removes the fragment before navigation or further rendering, submits it once over HTTPS, and never
persists it in application logs, errors, history state, caches, previews, or browser storage. Grant
Sessions should use `__Host-`, `Secure`, `HttpOnly` cookies with a deliberate `SameSite` policy;
mutations need exact Host/Origin checks plus a session-bound CSRF token, and privileged WebSockets
need exact Origin plus a one-time session-bound connection token. Revocation, rotation, and expiry
must actively close or downgrade live privileged sockets and invalidate replay authorization.
[Choose capability grant format, lifecycle, and recovery](https://github.com/netzhuffle/quadball-timer/issues/20#issuecomment-5246643038),
[Define Technical Admin passkey authentication](https://github.com/netzhuffle/quadball-timer/issues/46#issuecomment-5253557216),
[threat model, lines 151-167](passwordless-control-threat-model.md#security-invariants-and-required-controls)

Encryption, lookup, and audit correlation require independent, versioned, environment-bound keys.
AES-GCM nonces must never repeat under one encryption key; associated data must bind Grant identity,
type, scope, version, environment, and credential kind; the low-entropy radio-code lookup digest must
not double as a long-lived audit fingerprint key. Otherwise cryptographic erasure of lookup material
would either destroy audit correlation or retention of the lookup key would preserve an avoidable
offline code-guessing capability. Raw credential reveal remains an explicit browser-only human action.
[Choose capability grant format, lifecycle, and recovery](https://github.com/netzhuffle/quadball-timer/issues/20#issuecomment-5246643038),
[threat model, lines 155-163 and 201-205](passwordless-control-threat-model.md#security-invariants-and-required-controls)

The tracked Caddy source currently imports a global
`Referrer-Policy: strict-origin-when-cross-origin` for `timer.quadball.app`
(`infra-caddy/Caddyfile:34-38`, `infra-caddy/Caddyfile:59-65`, and
`infra-caddy/sites/timer.quadball.app.caddy:1-11`). Sensitive admission, reveal, enrollment, and
recovery responses require `no-referrer` and `no-store`. Because the reverse-proxied application owns
application headers, delivery must verify the final response header after Caddy/app precedence on
every sensitive path rather than assuming either layer wins.
[Threat model, lines 155-159](passwordless-control-threat-model.md#security-invariants-and-required-controls),
[Choose capability grant format, lifecycle, and recovery](https://github.com/netzhuffle/quadball-timer/issues/20#issuecomment-5246643038),
tracked `infra-caddy` checkout at local `main` `f2775f7`, `README.md:158-176`

### PDS-5 — Audience Projections are confidentiality and integrity boundaries

Public, Controller, Pitch Manager, Event Admin, and Technical Admin responses need independent,
allowlisted DTOs. Database rows, internal Game State, Grant metadata, pending commands, recovery
material, audit provenance, operator metadata, and denial reasons cannot leak because a field exists
in a shared model. Public clock values may remain useful during loss of synchronization only with the
selected stale/estimated/unavailable label and last-sync evidence; clients must not turn an old
projection into authority.
[Threat model, lines 151-154 and 176-187](passwordless-control-threat-model.md#security-invariants-and-required-controls),
[Choose official game-clock authority and fail-safe behavior](https://github.com/netzhuffle/quadball-timer/issues/23#issuecomment-5247592869),
[Choose pre-implementation architecture improvements](https://github.com/netzhuffle/quadball-timer/issues/47#issuecomment-5253499111),
`CONTEXT.md:59-65` on local `main` at `5460ca6`

Projection delivery must test absence, not only expected presence: construct high-entropy sentinel
values in every denied internal field and prove they never appear in JSON, HTML, WebSocket frames,
caches, logs, errors, or analytics. Public subscriptions and reconnects also need per-connection and
per-object fan-out/queue limits so spectator load cannot delay Controller acknowledgement.
[Threat model, lines 188-205](passwordless-control-threat-model.md#security-invariants-and-required-controls),
[threat-model verification, lines 252-274](passwordless-control-threat-model.md#control-verification-required-before-production)

### PDS-6 — Availability budgets must compose across proxy, protocol, database, and audit

The design needs one documented budget table covering HTTP bodies, WebSocket frames, connections,
subscriptions, replay batches and total bytes, pending/ack queues, operation and causal depth, names
and numbers, public fan-out, Grant and WebAuthn attempts, per-source throttle state, active Event and
Ad Hoc Games, audit/log growth, SQLite write-queue latency, WAL size, disk reserve, and backup work.
Every rejection must occur before state mutation and must itself have bounded CPU, memory, database,
and log amplification. Global admission ceilings need fair capacity or a reserved path so an attacker
cannot consume the entire fallback-code budget and starve legitimate event operations.
[Threat model, lines 188-205](passwordless-control-threat-model.md#security-invariants-and-required-controls),
[Choose capability grant format, lifecycle, and recovery](https://github.com/netzhuffle/quadball-timer/issues/20#issuecomment-5246643038),
[Define Technical Admin passkey authentication](https://github.com/netzhuffle/quadball-timer/issues/46#issuecomment-5253656998),
[current audit open follow-up](application-security-audit.md#open-follow-up)

Permanent Event Game and audit retention does not permit unbounded live-path work. Queries and replay
must paginate or stream through explicit caps, old Event records must not load into every public or
Controller request, and disk/WAL thresholds must fail readiness and authoritative writes before the
volume is exhausted while leaving already-admitted Controllers locally operable.
[Choose durable storage and migration strategy](https://github.com/netzhuffle/quadball-timer/issues/45#issuecomment-5254581794),
[storage research, lines 227-290](durable-storage-and-migration-options.md#backup-restore-integrity-and-retention-baseline)

### PDS-7 — SQLite WAL is acceptable only behind a patched-runtime gate

The selected topology—one process, one writer, same-host storage, short serialized transactions,
`synchronous=FULL`, and passive checkpoints outside the write queue—matches SQLite's documented WAL
model: one writer at a time; commits live in the WAL; `FULL` syncs the WAL at each commit; and the WAL
file is persistent database state that cannot be separated from the main file during copying.
[Choose durable storage and migration strategy](https://github.com/netzhuffle/quadball-timer/issues/45#issuecomment-5254581794),
[SQLite WAL overview and concurrency](https://www.sqlite.org/wal.html#overview),
[SQLite WAL performance](https://www.sqlite.org/wal.html#performance),
[SQLite WAL file](https://www.sqlite.org/wal.html#walfile)

There is, however, a newly relevant upstream gate. The authoritative checkout pins Bun 1.3.14
(`package.json:6`, `package.json:34`), and a read-only local probe on that runtime returned SQLite
`3.51.0`:

```console
$ bun -e 'import { Database } from "bun:sqlite"; const db = new Database(":memory:"); console.log(db.query("select sqlite_version() as version").get()); db.close();'
{ version: "3.51.0" }
```

SQLite documents a rare WAL-reset corruption bug affecting 3.7.0 through 3.51.2 when separate
connections concurrently checkpoint/write, fixed in 3.51.3 and named backports. The planned
single-connection/write-queue discipline reduces exposure but is not a substitute for the runtime
gate because deployment validation, backup, migration, CLI, or future read connections could create
the second connection. Before WAL production use, the compiled `bun-linux-x64-modern` executable must
report an unaffected SQLite version and pass a concurrent write/checkpoint integrity probe; otherwise
SQLite/WAL delivery is blocked or the database decision must reopen as already specified.
[SQLite WAL-reset advisory](https://www.sqlite.org/wal.html#walreset),
[storage research runtime probe, lines 60-71](durable-storage-and-migration-options.md#current-baseline-and-authoritative-semantics),
[Choose durable storage and migration strategy](https://github.com/netzhuffle/quadball-timer/issues/45#issuecomment-5254581794)

### PDS-8 — WebAuthn verification must implement the complete RP algorithm

The Technical Admin decision correctly requires server-generated challenges, exact origin and RP ID,
credential ID, signature, and signed UV verification. Delivery must also validate `type`, user
presence, cross-origin/top-origin state, and the credential/user handle relationship required by the
chosen non-username flow. Signature counter decreases are a security signal, not proof of cloning and
not an automatic lockout—especially with a synchronized passkey—and backup eligibility/state remain
risk hints rather than identity.
[Define Technical Admin passkey authentication](https://github.com/netzhuffle/quadball-timer/issues/46#issuecomment-5253828517),
[W3C assertion verification](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion),
[W3C signature-counter considerations](https://www.w3.org/TR/webauthn-3/#sctn-sign-counter),
[W3C challenge guidance](https://www.w3.org/TR/webauthn-3/#sctn-cryptographic-challenges)

The accepted pre-SQM assurance boundary explicitly does not require the dedicated negative suite,
real 1Password UV evidence, restore-resurrection reproduction, or auth runbook. Delivery planning
must retain those as explicit unverified properties and eventual work; ordinary format, test, and
build gates must never be represented as evidence that WebAuthn, CSRF, replay, redaction, or recovery
behavior was exercised.
[Define Technical Admin passkey authentication](https://github.com/netzhuffle/quadball-timer/issues/46#issuecomment-5253740449),
[Define Technical Admin passkey authentication](https://github.com/netzhuffle/quadball-timer/issues/46#issuecomment-5253828517)

## 3. Unresolved design gaps requiring Wayfinder tickets

These are decisions, not delivery slices. They are now child tickets and must resolve before the
map claims there is no remaining fog.

### [Choose Ad Hoc Game authority](https://github.com/netzhuffle/quadball-timer/issues/52)

The public prototype keeps Ad Hoc Game creation prominent, the current-code audit requires game
creation authority and quotas, and storage retains at most 50 Ad Hoc Games but can prune only old,
stopped games. The missing decision is who may create and control an Ad Hoc Game without an Event
Grant, how that authority is handed off/recovered, what prevents one actor from exhausting all 50
slots, and how a legitimate user recovers when the quota is full without granting Event access.
[Prototype the public home and spectator experience](https://github.com/netzhuffle/quadball-timer/issues/18#issuecomment-5246097894),
[Implement security admission and protocol bounds](https://github.com/netzhuffle/quadball-timer/issues/38),
[Choose durable storage and migration strategy](https://github.com/netzhuffle/quadball-timer/issues/45#issuecomment-5254581794),
[threat model, lines 221-226](passwordless-control-threat-model.md#assumptions-and-explicit-limits)

### [Choose Event publication boundary](https://github.com/netzhuffle/quadball-timer/issues/49)

Audience Projections own allowlists and eligibility, but no decision says when a newly created Event,
future schedule, changed matchup, past Event, or rehearsal/test Event becomes publicly discoverable,
or whether “configured” means “public immediately.” The threat model explicitly treats unpublished
Event discovery as in scope. Decide the publication state machine and which metadata, if any, is
public before publication; otherwise implementation cannot write the public authorization matrix or
absence tests.
[Prototype the public home and spectator experience](https://github.com/netzhuffle/quadball-timer/issues/18),
[Choose pre-implementation architecture improvements](https://github.com/netzhuffle/quadball-timer/issues/47#issuecomment-5253499111),
[threat model, lines 221-223](passwordless-control-threat-model.md#assumptions-and-explicit-limits)

### [Resolve production deployment authority](https://github.com/netzhuffle/quadball-timer/issues/50)

The deployment audit requires explicit promotion of an accepted artifact instead of deploying every
`main` push, while the later storage decision says every `main` push autonomously runs production
deployment and migrations with no routine manual work. The current workflow still deploys runtime
changes from `main` (`.github/workflows/deploy-production.yml:3-13`,
`.github/workflows/deploy-production.yml:67-73`). Decide which authority is canonical, when migrations
may run, and how the immutable accepted artifact and two-authority go/no-go record constrain automated
activation.
[Audit production deployment and operational failure modes](https://github.com/netzhuffle/quadball-timer/issues/9#issuecomment-4949438242),
[Choose durable storage and migration strategy](https://github.com/netzhuffle/quadball-timer/issues/45#issuecomment-5254581794),
[deployment audit, lines 37-61](production-deployment-operational-audit.md#required-operational-changes-before-sqm)

### [Define Grant Recovery Sheet handling](https://github.com/netzhuffle/quadball-timer/issues/51)

The accepted operational backup is one printed sheet containing every Event Admin, Pitch Manager,
and Control Grant in both QR and verbal-code form. The later Grant decision separately makes codes
on-demand, versioned, replaceable/disableable, and independent from QR credentials; full Grant
rotation replaces both. The unresolved decision is who may generate and hold the sheet, how many
copies may exist, how production and rehearsal sheets are distinguished, when a sheet is replaced,
how stale copies are accounted for and destroyed, what exposure triggers code replacement versus
full Grant rotation, and what acceptance evidence proves custody without exposing secrets. Until
resolved, the sheet is an Event-wide single physical compromise point whose lifecycle cannot be
implemented or rehearsed consistently.
[Define the SQM production acceptance and rehearsal plan](https://github.com/netzhuffle/quadball-timer/issues/21),
[Choose capability grant format, lifecycle, and recovery](https://github.com/netzhuffle/quadball-timer/issues/20#issuecomment-5246643038),
[deployment audit, lines 84-89](production-deployment-operational-audit.md#document-secret-and-recovery-operations)

## 4. Post-map delivery-plan amendments

Do not edit the preliminary delivery issues while the map remains open. After the map is validated,
closed, and the user invokes `$to-spec`, the specification and resulting package graph should carry
these package-neutral requirements:

1. **Grant Authority and browser admission:** PDS-1 and PDS-4, a complete grant/action
   authorization matrix, cross-environment and cross-object denials, active socket revocation,
   secret/key separation, sensitive-response header verification, and the resolved Recovery Sheet
   policy.
2. **Event Game Record and Controller synchronization:** content-bound operation identity, atomic
   acknowledgement, bounded replay, original/replacement provenance, Clock Authority generations,
   corrupt browser-state rejection, local retention expiry, deterministic recovery, and Recovery
   Gaps (PDS-1 and PDS-2).
3. **Audience Projections and public availability:** per-audience allowlists, sentinel absence tests,
   freshness labels, the resolved publication policy, fan-out/queue backpressure, and Controller
   capacity reservation (PDS-5 and PDS-6).
4. **Durable storage, migration, and deployment:** the restore-policy split, schema/authority atomicity,
   patched SQLite runtime gate, WAL/disk/backup controls, exact systemd state and credential paths,
   immutable release identity, and the resolved promotion policy (PDS-3, PDS-6, and PDS-7).
5. **Technical Admin authentication:** the complete W3C verification algorithm, exact-origin/CSRF/WS
   protections, host-local reset authority isolation, accepted restore resurrection, redacted
   observability, and a clearly deferred—but retained—negative/recovery evidence package (PDS-3 and
   PDS-8).
6. **Regression, security, load, and rehearsal evidence:** keep all five existing PoCs as current-code
   regression evidence; add authorization-matrix, replay-permutation, projection-absence,
   migration/restore, secret-redaction, load/fan-out, WebAuthn, and Caddy/systemd integration checks.
   Record exactly which properties remain unverified under the accepted pre-SQM assurance boundary.

## 5. Evidence gaps and limits

- No planned Grant, passkey, Event Game Record, Audience Projection, SQLite persistence, migration,
  or recovery implementation exists to scan. This artifact specifies review obligations; it is not
  proof that the controls work.
- The Bun 1.3.14/SQLite 3.51.0 probe ran on the authoritative local development runtime, not the
  eventual compiled Linux production executable. That executable must report and test its own
  SQLite version.
- The tracked Caddy configuration was inspected, but no live sensitive-path response exists yet.
  `no-referrer`/`no-store`, Host/Origin behavior, proxy limits, log redaction, and header precedence
  remain deployment verification work.
- Production-like connection counts, realistic Controller replay bursts, spectator fan-out,
  database latency, WAL/checkpoint behavior, disk headroom, and rate-limit fairness have not been
  measured. The six-Pitch/96-Game/500-spectator envelope remains a required test target, not evidence.
- The selected real 1Password desktop Chrome and iOS Safari ceremonies, server-observed `UV=1`,
  synchronized credential behavior, restore resurrection, and auth log/alert behavior remain
  deliberately unverified under [Define Technical Admin passkey authentication](https://github.com/netzhuffle/quadball-timer/issues/46#issuecomment-5253828517).
- The four Wayfinder gaps above have no canonical answer yet. Delivery packaging cannot safely infer
  their outcomes from preliminary implementation issues.

## Primary references

- [Passwordless Event and Game Control Threat Model](passwordless-control-threat-model.md)
- [Application Security Audit](application-security-audit.md)
- [Security evidence](../security/README.md)
- [Durable storage and migration options](durable-storage-and-migration-options.md)
- [Production deployment and operational failure audit](production-deployment-operational-audit.md)
- [W3C Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/)
- [SQLite Write-Ahead Logging](https://www.sqlite.org/wal.html)
- [SQLite `VACUUM INTO`](https://www.sqlite.org/lang_vacuum.html#vacuuminto)
