# Passwordless Event and Game Control Threat Model

## Overview

Quadball Timer is a public, phone-first web application for live quadball operations. It is
being extended from its current in-memory game timer into an event system with passwordless,
shared capability grants. Event Admins will manage Event Games, Teams, Pitches, Pitch Manager
Grants, and Control Grants; Pitch Managers will retrieve the games and Control Grants for one
Pitch; Controllers will operate one game online or offline; spectators will have public,
read-only access. Technical Admin authority may remain a server-administration function.

This threat model covers the whole repository and the planned SQM 2026 production surface. It
sets security invariants and required control outcomes. It deliberately does not choose the
cryptographic token format, verbal encoding, lookup flow, rate-limit values, storage schema,
rotation schedule, or recovery mechanism; those choices belong to
[Choose capability grant format, lifecycle, and recovery](https://github.com/netzhuffle/quadball-timer/issues/20).

The current implementation is a security baseline, not the target capability design:

- `src/index.ts` exposes game creation, game reads, lobby reads, WebSocket subscriptions, and
  game commands without authentication. A WebSocket client declares its own `controller` or
  `spectator` role.
- `src/lib/game-page-support.ts` keeps a Controller's recovered state and pending commands in
  browser local storage and replays them after reconnection.
- `src/lib/ws-origin.ts` restricts WebSocket browser origins to the production origin or a
  matching loopback origin. This reduces cross-site WebSocket abuse but is not authorization.
- `src/lib/ws-protocol.ts` validates the supported message shapes, and the server deduplicates a
  bounded set of command IDs. Numeric ranges, batch sizes, message sizes, authorization, and
  durable replay protection are not yet production controls.
- `deploy/systemd/quadball-timer.service` runs a compiled executable as a dedicated,
  unprivileged user with an empty capability set and multiple systemd sandboxing controls.
- The tracked Caddy configuration terminates HTTPS, denies public `/internal/*`, adds HSTS,
  CSP, frame denial, MIME-sniffing protection, and a Permissions Policy, and proxies only to
  `127.0.0.1:3000`. The live production endpoint returned those headers and a public 404 for
  `/internal/healthz` on 12 July 2026.

The signed paper Official Score Sheet remains authoritative. That limits the app's legal or
final-record authority, but it does not make live integrity unimportant: unauthorized clock,
score, card, result, schedule, or grant changes can disrupt a match, mislead officials and
spectators, and destroy the operational evidence needed to reconcile the paper record.

## Threat Model, Trust Boundaries, and Assumptions

### Assets and security objectives

| Asset or privilege | Required property |
| --- | --- |
| Event Admin Grant | Secret, event-scoped authority; compromise must not grant Technical Admin or unrelated Event access. |
| Pitch Manager Grant | Secret, Pitch-scoped read/access authority; it may expose only that Pitch's schedule and Control Grants. |
| Control Grant | Secret, game-scoped control authority; it must never authorize another game or event-management action. |
| Technical Admin authority | Strongly separated from public and shared-grant surfaces; capable of controlled Event metadata and Event Admin Grant recovery. |
| Event configuration | Integrity and durability of Events, Game Days, Teams, Pitches, Event Games, and grant state. |
| Live game state | Availability and correct convergence of clocks, scores, penalties, stoppages, results, corrections, and Official Overrides. |
| Controller operation log | Durable, idempotent, causally ordered operations sufficient to converge and recover an Event Game. |
| Control Audit Trail | Append-only operational evidence of accepted actions, corrections, synchronization, conflict outcomes, and grant/session provenance without falsely claiming individual identity. |
| Game Timeline and public discovery | Accurate, bounded, read-only public projection that does not disclose grants, private audit details, pending operations, or infrastructure data. |
| Offline Controller state | Availability and integrity on the device; pending operations and any locally retained authority must be protected from unrelated origins and handled safely after grant changes. |
| Deployment and backups | Confidentiality of stored grant verifiers, integrity of releases and configuration, durable recovery, and continued operation during expected failures. |

### Actors

- **Spectator:** anonymous internet user allowed to discover public Events and games and receive
  public live projections.
- **Controller:** bearer of a Control Grant, with equal authority to other Controllers over one
  game, including offline operation and later synchronization.
- **Pitch Manager:** bearer of a Pitch Manager Grant for one Pitch; can see that Pitch's games
  and their Control Grants but cannot alter Event Games.
- **Event Admin:** bearer of the shared Event Admin Grant for one Event; can manage Event
  operational data and subordinate grants but not Event-level metadata or Technical Admin
  authority.
- **Technical Admin:** trusted production operator with server-side Event/bootstrap and recovery
  authority.
- **Infrastructure operator and deployer:** trusted to control Caddy, systemd, releases, storage,
  backups, DNS, and TLS. A compromise here can bypass application controls.
- **Opportunistic attacker:** anonymous remote user who enumerates identifiers, submits malformed
  traffic, attempts denial of service, or obtains a leaked grant.
- **Malicious or mistaken grant holder:** authorized within one scope but attempts escalation,
  destructive actions, replay, or access outside that scope.
- **Local-device attacker:** person, extension, malware, or shared-browser user who can read
  history, clipboard, screenshots, browser storage, or an unlocked Controller device.
- **Supply-chain attacker:** compromises a dependency, build input, CI credential, release
  artifact, or deployment path.

Because grants are intentionally shared and passwordless, possession authenticates a capability,
not a person. The system may record a pseudonymous Controller session/device and the grant version
used, but it must not describe that as verified human identity.

### Trust boundaries

1. **Public internet to Caddy:** untrusted HTTP, WebSocket, paths, headers, bodies, connection
   counts, and timing cross the TLS/reverse-proxy edge.
2. **Caddy to the Bun service:** Caddy supplies the effective public origin/host and routes to a
   loopback-only process. Host and forwarded-header trust must be explicit; direct non-loopback
   backend access is assumed unavailable.
3. **Anonymous presentation to privileged capability use:** public discovery and spectator reads
   cross into Event Admin, Pitch Manager, or Controller authority only after server-side
   capability validation. UI mode, route, game identifier, and WebSocket subscription role are
   attacker-controlled hints, never authorization evidence.
4. **One capability scope to another:** Event, Pitch, and Game are separate authorization
   objects. Every read and mutation must bind the validated capability to the requested object,
   its parent Event, and the permitted action.
5. **Online server to offline Controller:** browser state and queued operations leave the durable
   server trust domain. The device can be stale, cloned, modified, or operated after rotation or
   revocation. Reconnection is an authorization and validation boundary, not merely a merge.
6. **Browser runtime to local storage, URLs, clipboard, and QR handoff:** any same-origin script
   can read JavaScript-accessible secrets and state; URLs can enter history, logs, referrers,
   screenshots, messaging previews, and analytics; QR codes and verbal codes can be copied.
7. **Accepted operations to projections:** the Control Audit Trail and operation store are the
   durable operational facts. Game state, Game Timeline, lobby, and spectator views are derived
   projections and must not gain authority by being easier to edit or cache.
8. **Application to durable storage and backups:** database/storage contents include valuable
   grant verifiers, operations, audit history, and event configuration. Backups and restores must
   preserve confidentiality, referential integrity, revocation state, and replay/idempotency
   history.
9. **Build/deployment to production:** source, dependencies, compiled executable, release
   directory, symlink activation, systemd unit, Caddy configuration, and restart authority cross
   from developer/operator control into the production trust domain.
10. **Application operator to Technical Admin:** Technical Admin actions and grant recovery must
    use a separate, non-public authority path. Event Admin possession must not be enough to
    exercise it.

### Attacker-controlled inputs

- All HTTP paths, methods, query strings, JSON bodies, names, colors, identifiers, pagination,
  headers, and request timing.
- All WebSocket upgrade headers and frames, including message type, role, object identifiers,
  command IDs, client timestamps, causal metadata, batches, order, duplicates, and reconnects.
- Presented grants and grant-like values, including malformed, guessed, expired, revoked,
  rotated, wrong-scope, and high-volume attempts.
- Imported or recovered Controller operations and browser-persisted state. Client-side runtime
  guards are not a trust boundary.
- Event/Game display text that later reaches HTML, logs, exports, audit views, or notifications.
- Connection churn, slow clients, subscription fan-out, oversized inputs, future uploads, and
  resource-exhaustion patterns.

Operator-controlled inputs include Event bootstrap and recovery actions, deployment parameters,
environment variables, Caddy/systemd configuration, backups, and restore data. Developer-controlled
inputs include source, dependencies, lockfiles, build arguments, and release automation. These are
trusted for ordinary authorization but still require integrity controls because compromise has a
large blast radius.

### Security invariants and required controls

1. **Server-side authorization is mandatory for every privileged request and frame.** A client
   cannot become a Controller by choosing a route or role. Authorization must be checked again
   against the concrete Event, Pitch, or Game and action, including reads that reveal subordinate
   grants.
2. **Capabilities are least-privilege bearer secrets.** Event Admin, Pitch Manager, and Control
   Grants are distinct types and scopes. A grant for one object cannot be substituted for another
   type, parent, sibling, or environment. Ad Hoc Game authority cannot reach Event data.
3. **Public data is a separate allowlisted projection.** Spectators receive only intended Event,
   schedule, team, score, clock, status, and Game Timeline fields. Grant material, grant metadata,
   Controller local state, Control Audit Trail internals, recovery data, and operator details are
   denied by default.
4. **Raw grants do not persist accidentally.** They must not appear in routine application,
   reverse-proxy, analytics, error, or audit logs; public URLs sent to servers; referrers; cacheable
   responses; stack traces; or database fields intended only for lookup. Sensitive pages and grant
   responses require `Cache-Control: no-store` and a referrer policy that prevents leakage. The
   exact safe handoff and verifier scheme remains a downstream decision.
5. **Grant guessing and enumeration are bounded.** Grant validation and recovery endpoints need
   input limits, rate limits at appropriate capability/network/object scopes, uniform failure
   behavior, and monitoring. Object existence must not be disclosed through authorization error
   differences unless that existence is already public.
6. **Rotation, revocation, expiry, and recovery have explicit semantics.** Online authorization
   state changes must take effect without redeployment. The design must define what happens to
   active WebSockets, browser copies, QR links, cached subordinate grants, queued offline
   operations, and restored backups. Recovery must not silently resurrect revoked authority.
7. **Offline acceptance is authorization-aware.** Every uploaded operation is schema-checked,
   size-bounded, game-bound, uniquely identified, causally validated, and evaluated under the
   chosen pre-/post-revocation policy. Server loss recovery accepts only an authorized union of
   operations and cannot overwrite a different game or erase accepted audit history.
8. **Client time is evidence, not authority by itself.** Synchronized occurrence time can order
   operations under the convergence decision, but absurd, non-finite, or strategically forged
   timestamps and causal relationships must be rejected or bounded. Official clock authority is
   resolved separately.
9. **Event Game history is append-only at the fact layer.** Corrections and Official Overrides
   are new accepted operations targeting stable prior actions. Authorization, original action,
   correction, conflict outcome, grant version/session provenance, and acceptance time remain
   auditable. Destructive CRUD must not rewrite that history.
10. **Shared grants do not create false non-repudiation.** Audit records may show which grant
    scope/version and pseudonymous Controller session submitted an action, not which natural
    person did so. Operational procedures and the paper Official Score Sheet close the human
    accountability gap.
11. **Untrusted content stays data.** Render React text normally, validate and length-limit names
    and identifiers, encode exports and logs for their destination, keep a restrictive CSP, and
    avoid dangerous HTML or script-capable uploads. An XSS on a privileged page is a capability
    theft and game-control vulnerability.
12. **Availability controls protect live play.** Bound request bodies, WebSocket frame and batch
    sizes, subscriptions, per-connection queues, fan-out, stored operations, command-ID retention,
    name lengths, and numeric ranges. Apply connection/request limits and backpressure at Caddy and
    the app. A spectator must not be able to starve Controllers.
13. **Durability is part of authorization and integrity.** Persist Event configuration, grant
    state, accepted operations, audit records, deduplication history, and recovery checkpoints
    atomically enough that restart, rollback, or restore cannot duplicate commands, lose
    revocations, or mix scopes. Backups are access-controlled, encrypted where appropriate,
    restore-tested, and retained deliberately.
14. **Production administration remains separated and hardened.** The service stays loopback-only,
    unprivileged, and sandboxed; `/internal/*` stays unreachable publicly; releases are built from
    locked dependencies, integrity-checked, minimally writable, and rollback-safe; deploy and
    Technical Admin credentials are not available to the web process.
15. **Security-relevant actions are observable without leaking secrets.** Monitor rejected grant
    attempts, rate limiting, unusual rotations/recovery, cross-scope denials, malformed or
    oversized traffic, reconnect/replay anomalies, operation conflicts, persistence failures,
    resource saturation, process restarts, and backup/restore outcomes. Alerts and logs use grant
    fingerprints or versions, never raw grants.

### Assumptions and explicit limits

- HTTPS, DNS, Caddy, the production host, deployment credentials, and Technical Admin access are
  trusted. Their compromise is in scope for severity and hardening, but application capability
  checks cannot contain a fully privileged host attacker.
- A legitimate grant holder may perform every action in that grant's documented scope. Preventing
  intentional misuse inside that scope is primarily an operational/correction/audit concern;
  escalation, destructive history rewriting, and action outside the scope remain security issues.
- Sharing a QR code or verbal code intentionally shares its full capability. The design can make
  leakage less likely, revocable, bounded, and observable, but cannot infer the intended human
  recipient without introducing identity.
- Physical theft of an unlocked phone is not preventable by this repository. Minimizing retained
  secrets, exposing clear leave/revoke controls, and defining event-day device handling reduce the
  impact.
- Public Event/game discovery and spectator viewing are intended, so scraping public scores is not
  a confidentiality breach. Bulk resource exhaustion, unpublished Event discovery, or exposure of
  non-public audit/grant fields remains in scope.
- Ad Hoc Games intentionally lack an Event Game's durable Control Audit Trail and Game Lock. They
  still require isolation, input validation, availability controls, and an authorization model
  that cannot be confused with an Event Game.

## Attack Surface, Mitigations, and Attacker Stories

| Surface / attacker story | Consequence | Required control or existing mitigation |
| --- | --- | --- |
| Anonymous client declares `role: controller` and submits commands, as the current protocol permits. | Full unauthorized control of any known game. | Replace role assertion with server-validated Control Grant authority on subscription and every command/batch; bind it to the Game. Current origin checking is defense in depth only. |
| Attacker posts to the current public game-creation endpoint repeatedly. | Memory exhaustion, polluted lobby, misleading games. | Restrict Event Game creation to Event Admin authority; define bounded Ad Hoc Game creation, quotas/rate limits, lifecycle, and cleanup. |
| User follows, screenshots, pastes, or previews a grant-bearing URL; logs/history/referrers retain it. | Capability theft lasting until rotation/revocation. | Keep raw grants out of server-visible URLs and routine logs; use no-store/no-referrer on privileged handoff surfaces; redact errors and telemetry; make revocation practical. Exact exchange flow is deferred. |
| Pitch Manager changes an object identifier while presenting a valid Pitch Grant. | Reads another Pitch's Control Grants or mutates Event data. | Central authorization policy binds grant type, Event, Pitch, Game, action, and object relationship; deny-by-default data shaping; test horizontal and vertical escalation. |
| Event Admin Grant is accepted by a Technical Admin endpoint or for another Event. | Cross-Event takeover or production administration. | Separate Technical Admin channel and credentials; typed/scoped capabilities with audience/environment binding; no shared middleware fallback that treats all grants alike. |
| Spectator endpoint or WebSocket serializes the internal Game object. | Leaks audit provenance, pending commands, grant state, or recovery data. | Dedicated public DTO/projection and allowlist tests; never infer public visibility from field presence in domain state. |
| Attacker guesses verbal grants or probes response differences. | Unauthorized capability acquisition or private-object enumeration. | Sufficient entropy, bounded verification attempts, uniform errors/timing where practical, rate limits, monitoring, and no existence oracle. Exact alphabet/length is deferred. |
| Revoked grant keeps an open WebSocket or uploads operations created offline. | Continued control after an organizer believes access ended. | Define revocation epoch and offline acceptance semantics; reauthorize active channels and each batch; disconnect or downgrade invalid sessions; visibly report rejected/quarantined operations. |
| Modified local storage injects operations, duplicates IDs, forges causal context, or uses extreme timestamps/numbers. | State corruption, order manipulation, denial of service, or audit poisoning. | Treat recovery payload as untrusted; fully validate envelopes and commands, enforce bounds and referential rules, authorize the Game, preserve idempotency durably, and reject impossible causal/timing claims. |
| Server loses a Game and accepts the first Controller's local snapshot as truth. | Malicious or stale overwrite, loss of other Controllers' operations, wrong game recovery. | Recover from authorized immutable operations/checkpoints, not a client-projected snapshot; merge the authorized union deterministically; require explicit recovery authority and audit the recovery. |
| Two Controllers share a grant, and audit UI names one as the actor. | False attribution and unsafe operational decisions. | Record grant version/fingerprint and pseudonymous session/device correlation; label it accurately; use paper/operational assignment for human accountability. |
| Stored or reflected display text executes script on an Event Admin, Pitch Manager, or Controller page. | Theft and exercise of all grants accessible to that browser, plus game manipulation. | React-safe rendering, contextual encoding, validation/length limits, no dangerous HTML, restrictive CSP, dependency hygiene, and no raw grant in JavaScript-accessible state longer than necessary. |
| Anonymous clients open many sockets, subscribe repeatedly, send huge frames/batches, or trigger broadcast fan-out. | Controllers cannot operate a live match. | Proxy/app limits, frame/body/batch bounds, backpressure, idle/connection limits, per-scope quotas, bounded queues/retention, and controller-prioritized capacity/monitoring. |
| Crafted numeric commands use `NaN`, infinity, enormous deltas, or invalid domain combinations. | Corrupt derived state, crash serialization, or make a game unrecoverable. | Require finite, range-bounded values and domain-state preconditions at the server; validate every operation before persistence or projection. |
| Database or backup leaks. | Offline attack on every grant plus disclosure/modification of operational history. | Store non-reversible grant verifiers where possible, encrypt and access-control backups, isolate DB/service credentials, redact exports, rotate affected grants, and restore-test revocation/audit integrity. |
| Rollback restores application data or code incompatible with grant/audit state. | Revoked grants revive, accepted operations disappear, or authorization fails open. | Forward/backward migration plan, atomic release and schema compatibility checks, immutable release artifacts, data-aware rollback criteria, and tested restore/replay procedures. |
| Compromised dependency/build/deploy path ships malicious code. | All browser capabilities and server data are exposed. | Bun lockfile discipline, dependency review/update workflow, protected CI/deploy credentials, artifact provenance/integrity checks, least-privilege deploy sudo, and production monitoring. |
| Forged `Host`, `Origin`, or proxy headers bypass assumptions. | Cross-site WebSocket abuse, wrong absolute URLs, or routing confusion. | Maintain exact production-origin checks, configure trusted proxy behavior explicitly, reject unexpected Host values, keep backend loopback-only, and test Caddy-to-app headers. |
| Health or administrative endpoint becomes publicly routed. | Information disclosure or privileged production action. | Preserve Caddy's early `/internal/*` denial and app-side loopback host check; use a separate authenticated operator surface for any future mutating administration. |

### Control verification required before production

- Authorization matrix tests cover every grant type against every Event/Pitch/Game read and
  mutation, wrong-parent and wrong-environment objects, missing/revoked/expired/rotated grants,
  active WebSockets, and offline replay.
- Protocol tests reject unsupported types, oversized frames/batches, non-finite and out-of-range
  numbers, malformed causal data, cross-game command IDs, duplicate/replayed operations, and
  unauthorized recovery.
- Projection tests prove spectator and Pitch Manager responses cannot serialize denied fields or
  grants beyond their scope.
- Browser tests cover grant handoff, history/referrer/cache behavior, leave/clear behavior,
  rotation/revocation while connected, offline rejection/recovery, and shared-device residue.
- Persistence tests crash/restart around authorization-state and operation commits, restore a
  backup, replay Controller queues, and prove revocations, deduplication, scope bindings, and the
  Control Audit Trail survive.
- Load tests exercise public discovery, spectators, Controller command latency, reconnect storms,
  broadcast fan-out, invalid grant attempts, and bounded storage/queue growth.
- Deployment checks verify TLS/security headers, unexpected Host/Origin rejection, public
  `/internal/*` denial, loopback-only backend binding, systemd sandboxing, log redaction, backup
  access, artifact integrity, and rollback behavior.
- Event-day drills include a leaked Control Grant, lost Controller phone, Pitch Manager handoff,
  Event Admin Grant rotation, server restart/loss, offline convergence, malicious/stale recovery
  payload, and reconciliation against the Official Score Sheet.

## Severity Calibration (Critical, High, Medium, Low)

### Critical

Use Critical when exploitation can compromise the production host/deployment authority or all
Events with little additional access, or can irrecoverably destroy the only durable operational
records during live use. Examples include remote code execution in the public service, extraction
of all raw grants plus durable state from production, a public Technical Admin path that permits
cross-Event takeover, or unauthenticated destructive loss of all Event operations and backups.

### High

Use High for reliable unauthorized control or grant disclosure with an Event-wide or active-game
blast radius, especially when it can disrupt SQM operations or conceal the action. Examples include
self-asserted Controller authority over Event Games, a Pitch Manager Grant exposing another
Pitch/Event's Control Grants, XSS on a privileged page that steals grants, revocation that leaves
attackers able to control live games, or unauthorized rewriting/deletion of the Control Audit
Trail. Availability attacks that reliably make all Controllers unable to operate the active Pitch
or Event can also be High.

### Medium

Use Medium for bounded unauthorized influence, meaningful sensitive metadata disclosure, or
recoverable availability/integrity loss requiring favorable conditions. Examples include enumerating
unpublished games, leaking pseudonymous Controller/audit metadata without grants, a resource attack
that temporarily degrades one game, acceptance of an invalid but readily correctable operation from
an already authorized Controller, or stale privileged browser data remaining after an imperfect
leave flow. Severity rises when the issue crosses capability scopes, defeats revocation, or affects
the live event broadly.

### Low

Use Low for defense-in-depth gaps with little realistic impact, minor public-data issues, or
operator-only footguns that require already privileged host access and do not increase that access.
Examples include missing nonessential hardening headers on a public spectator response, verbose
errors that reveal no private object or grant, low-volume scraping of intentionally public scores,
or incomplete audit display labels when the underlying immutable provenance remains correct.

Repository: git-remote:sha256:af992719eee11636ad5a197ed6c4da6766a42d9bde13458a555e2aa579f8e6c7
Version: 92f49ace0a3f1b1084dd9ba4f325664bfe5e1580
