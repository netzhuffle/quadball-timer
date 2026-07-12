# Application Security Audit

This records the resolution of
[Audit application security against the production threat model](https://github.com/netzhuffle/quadball-timer/issues/33).
It summarizes the Codex Security Standard scan of revision
`caa5dac848e9e865524e44f30becae725048bcdc` against the
[passwordless Event and game control threat model](passwordless-control-threat-model.md).

The scan reviewed the current public HTTP and WebSocket implementation and the
planned production design seams for Control Grants, object scope, offline
replay and recovery, public projections, durable state and audit, denial of
service, secret handling, and the Caddy/systemd deployment boundary. It did not
implement fixes.

## Findings

| Finding | Severity | Priority | Decision | Required production response |
| --- | --- | --- | --- | --- |
| Anonymous clients can self-assert Controller authority | High | P1 | Reported | Require server-validated, game-scoped Control Grants before storing Controller authority or accepting control commands. |
| Unbounded command batches block the shared game service | High | P1 | Reported | Put an explicit server budget on offline replay batches before parsing, mutation, acknowledgements, or broadcasts. |
| Unbounded numeric command values corrupt game state | Medium | P2 | Reported | Reject non-finite, out-of-range, or domain-invalid numeric command values before engine arithmetic and projection. |
| Unbounded Team names are retained and repeatedly amplified | Medium | P2 | Reported | Enforce shared name length and normalization limits on Event Game creation, Ad Hoc Game creation, and rename operations. |
| Anonymous game creation can retain unbounded server state | Low | P3 | Reported | Authorize and budget game creation, with active-game quotas and lifecycle cleanup. |

The deployment shell-injection candidates and mutable same-SHA release rerun
candidate were kept as operational hardening evidence rather than final
application-security findings. The scan treated them as trusted-repository or
protected-deployment-path risks that still matter for the production delivery
backlog.

## Severity decisions

The two High findings are production blockers because they allow anonymous
public clients to reach live game control or multi-second synchronous service
work in the scanned baseline. They are below Critical because the paper
Official Score Sheet remains authoritative, scanned state is currently
process-local, and the findings do not provide host compromise.

The two Medium findings are cross-user integrity or availability issues that
remain important even after Control Grants exist: a legitimate or compromised
Controller must still be unable to submit out-of-domain numbers or oversized
names. The Low finding is reportable because anonymous game creation consumes
shared resources, but the exact request rate needed for event-wide denial was
not measured and a restart clears the in-memory games.

## Structural hardening decision

The scan supports one structural hardening direction: centralize game-control
admission and budgets behind a server-owned boundary. The recommended design is
to keep HTTP and WebSocket handlers as transport adapters and move these checks
into one control boundary before state mutation:

- Control Grant validation and game/object scope;
- game creation authority, active-game quota, and lifecycle policy;
- command batch count, byte, rate, and acknowledgement budgets;
- field-specific numeric, string, color, and command-ID validation;
- reject-before-mutation semantics for malformed or over-budget operations;
- projection guarantees for public and Controller-visible DTOs.

Local tactical fixes are still required first. The central boundary reduces
recurrence risk, but it is not a substitute for immediately rejecting the five
validated vulnerable paths.

## Delivery handoff

The post-map delivery backlog must include a dedicated security remediation
issue with acceptance criteria for all five reported findings. It should stay
blocked by the Wayfinder map until the remaining planning tickets choose the
Control Grant format, architecture sequence, correctness/regression contracts,
and production acceptance details.

The security remediation work must coordinate with:

- [Choose capability grant format, lifecycle, and recovery](https://github.com/netzhuffle/quadball-timer/issues/20)
  for Control Grant format, revocation, storage, and audit behavior;
- [Decide which architecture findings to pursue](https://github.com/netzhuffle/quadball-timer/issues/22)
  for whether the central admission boundary lands before or with durable
  operation storage;
- [Specify the correctness and reliability regression work](https://github.com/netzhuffle/quadball-timer/issues/36)
  for bounded protocol inputs, atomic rejection, permanent idempotency, and
  browser/device acceptance coverage;
- [Harden production release activation and promotion](https://github.com/netzhuffle/quadball-timer/issues/34)
  for immutable release and deployment hardening raised by the scan.

Acceptance for the security delivery issue should require every scan PoC to
fail before state mutation, all new limits to be tested at the protocol
boundary, and production-facing limits to be documented for operators.

## Open follow-up

Production Caddy request and body limits, host resource headroom, event-scale
subscriber counts, and realistic offline replay burst sizes were not measured.
Those measurements should be part of security delivery or acceptance rehearsal,
not a reason to defer the P1 authorization and batch-budget fixes.
