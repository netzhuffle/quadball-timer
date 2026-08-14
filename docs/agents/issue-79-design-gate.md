# Issue #79 design gate

This is the internal design gate for the fresh composed acceptance seam. It is
deliberately kept at the module boundary: Grant owns authority, Event Game
Record owns sporting state and ordering, and the acceptance seam owns only the
composition, durable acceptance bookkeeping, and cross-module evidence links.

## Invariant and state-transition table

| State or invariant            | Allowed transition                    | Guard and observable evidence                                                                                                                                                     |
| ----------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structural batch is untrusted | `untrusted -> prepared`               | Count/bytes, envelope identity, unique operation IDs, and acyclic causal graph pass before a write transaction; one read-only authorized preflight then validates every codec and payload before any reservation, budget, action, or audit mutation. |
| Action has no durable outcome | `pending -> accepted`                 | Current Grant/session/version/scope/Event Game/lifecycle/lock/causality/payload/rate/replay checks pass; action, metadata, Control audit, and paired Grant audit commit together. |
| Action has no durable outcome | `pending -> duplicate-accepted`       | Same permanent operation ID and content fingerprint; current authority still passes; a new linked duplicate audit is committed without a second action.                           |
| Action has no durable outcome | `pending -> rejected`                 | Current authority and snapshot pass, then payload/dependency/conflict/correction validation fails; paired rejection audits commit atomically.                                     |
| Action has no durable outcome | `pending -> dependency-blocked`       | A causal predecessor has a definitive non-commit result; the dependent still gets current authorization and paired blocked evidence.                                              |
| Action has no durable outcome | `pending -> retry-later`              | Storage/scope/budget is temporarily unavailable; no sporting mutation or acknowledgement is produced.                                                                             |
| Action has no durable outcome | `pending -> authority-expired`        | Current authority, relationship, lifecycle, or lock check fails; no sporting mutation is produced.                                                                                |
| Replay reservation            | `reserved -> committing -> committed` | Reservation/attempts are durable; a receipt is returned only after every action has a definitive committed outcome.                                                               |
| Replay reservation            | `reserved/partial -> reserved`        | A retry-later or transaction failure leaves work resumable and does not acknowledge unprocessed content.                                                                          |
| Replay reservation after lock | `reserved/partial -> discarded`       | Trusted lock seam records exactly count/session/Event Game/rejection time; no rejected content, replay identifier, fingerprint, original timestamp, receipt, attempt, or extra authorization provenance. Committed/acknowledged work remains intact. |
| Replay receipt                | `committed -> acknowledged`           | Only a stored digest derived from server-held key material is accepted; acknowledgement is allowed without re-authorizing the already committed replay.                           |
| Durable evidence              | `valid -> frozen`                     | Monotonic keyed anchors authenticate every budget/reservation/attempt/receipt revision and exact cardinality; canonical result JSON is bound to its operation/status/audits, and corruption, mutation, deletion, or cascade loss freezes memory and SQLite writes. |
| Rejected candidate evidence   | `candidate -> authenticated outcome`  | Every rejected candidate, including collision evidence, retains canonical JSON plus its codec fingerprint; readiness recomputes the exact SHA-256 content fingerprint and requires equality across candidate, Control linkage, Grant evidence, and replay attempt. |
| Rejection contract            | `adapter reason -> finite reason`     | Adapter replay-ineligibility reasons are normalized before persistence. Durable Grant evidence authenticates exact status, finite reason, and redacted detail; impossible status/reason pairs or coordinated tampering freeze memory and SQLite. |
| Online outcome recovery       | `durable outcome -> exact replayed response` | Repeated identical duplicate, rejection, and operation-conflict submissions recover the existing paired Control/Grant outcome without deterministic-ID collision or extra evidence; the result remains exact after restart. |
| Codec preparation identity    | `claimed kind/version -> durable codec identity` | Failed or unknown preparation records the canonical registry-derived claimed kind/version identity, never a sentinel; readiness validates identity, canonical content, and recomputed SHA-256 equality. |
| Prepared budget retry         | `rate-budget -> accepted after refill` | Budget exhaustion occurs only after preparation and retains the same prepared input/canonical candidate; after refill an identical online retry commits with matching evidence. |
| Replay pre-reservation recovery | `durable definitive rejection -> exact replay response` | An identical authorized replay that previously ended in replay-ineligible or invalid-action before reservation creation reuses the paired outcome, including after restart, without creating a reservation or receipt. |
| Authorized root-missing preparation | `authorized -> generic-structural-outcome` | After trusted read-only Grant authorization, every codec envelope and payload is prepared before returning an authorized result even when the Event Game root is absent or mismatched; root-dependent semantics are not disclosed and no reservation, budget, action, or audit row is written. |
| Transaction-local preparation | `preflight -> current-commit decision` | Every action write transaction prepares the raw action again against its transaction-local current root and requires canonical content, fingerprint, interpretation, and lifecycle equality with preflight before any replay, budget, sporting, metadata, or audit write. |
| Trusted lock discard authority | `reserved/partial -> discarded` | A separate trusted Game Lock capability is checked before ordinary bearer lookup; only an already reserved/partial exact record/Event Game/originating-session tuple can be discarded, and an ordinary caller cannot reach this seam. |
| Discard retention boundary | `discarded -> retained tuple` | Locked discard retains only count, originatingSessionId, eventGameId, and rejectedAtMs in its durable evidence; reservation/replay identifiers, timestamps, content, receipts, attempts, and orphan anchors are removed, with no replay identifier returned and repeated trusted calls idempotent. |
| Historical integrity continuity | `revision 1..N` | Every live acceptance subject has exactly one authenticated canonical anchor for each contiguous revision from 1 through N; every anchor is re-authenticated from its stored canonical evidence, and any missing, mutated, extra, or orphan anchor freezes memory and SQLite writes. |
| Independent authority races | `preflight -> synchronized writer barrier` | Focused SQLite tests use independent connections synchronized at the transaction boundary for revocation, key rotation, expiry, scope change, and Game Lock; failed authority has exact typed results and no audit, while neighboring authorized writes succeed. |

Cross-cutting invariants: no authorization failure discloses action enumeration,
receipt existence, or another session's receipt; bearer/capability plaintext is
never persisted; online and replay budgets use separate durable bucket kinds;
caller-order results are returned even when execution follows topological order;
and every definitive non-lock result has exactly one Control audit linked to one
Grant audit.

## Transaction ownership and trust boundaries

| Boundary                 | Owner                   | Untrusted input / trusted evidence                      | Atomic responsibility                                                                                                            |
| ------------------------ | ----------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Structural seam          | Acceptance              | Raw batch, codec registry, clock                        | No writes; creates prepared actions and a topological plan only.                                                                 |
| Grant authority          | Grant module            | Session bearer supplied to the seam                     | Revalidates bearer lookup, grant state, version, session lifecycle, expiry, and event binding inside the acceptance transaction. |
| External scope           | Event Game integration  | Resolver result                                         | Resolves and compares the scope snapshot inside the same storage transaction.                                                    |
| Event Game Record        | Event Game module       | Prepared action and current root                        | Revalidates lock/lifecycle/causality/payload and owns action, idempotency, and ordering metadata.                                |
| Durable acceptance state | Storage adapter         | Reservation IDs, fingerprints, budget subjects, digests | Serializes budgets and replay lifecycle across instances; never stores raw receipts or bearers.                                  |
| Lock discard seam        | Trusted internal caller | Independently verified lock evidence                    | May write only the exact redacted lock discard tuple; it is not a substitute for online authorization.                           |
| Acknowledgement          | Acceptance/storage      | Opaque receipt presented by caller                      | Matches only a keyed digest and committed receipt; does not enumerate or authorize a reservation.                                |

## Migration and upgrade matrix

| Database state                                                             | Expected result                                                                                                             | Verification                                                                  |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Current main schema 016                                                    | Candidate-only migrations 017 and 018 may be appended coherently; preserve all 001–016 checksums and behavior.             | Fresh migration and reopen readiness report schema 18.                        |
| Fresh disposable candidate                                                 | Candidate migrations validate before production migration and remain unpublished drafts.                                  | Candidate readiness plus no surviving candidate file.                         |
| Already-ledgered 001–016 database                                          | Apply 017 then 018 and remain readable/writable.                                                                            | Upgrade/reopen storage and acceptance tests.                                  |
| Missing, reordered, changed, incomplete, future, or tampered ledger/schema | Refuse authoritative writes.                                                                                                | Existing migration/readiness failure matrix plus new acceptance-state checks. |
| #78 later renumbering                                                      | Keep migration identity and SQL append-only so mechanical renumbering can update ordinal/version without rewriting 001–018. | Migration checksum/ledger tests and documented handoff boundary.              |

## #79 acceptance-test matrix

| Criterion                                | Observable result / negative control                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Composed Grant + scope + Event Game seam | One transaction produces an action and both audit owners' linked evidence; a mismatched scope is retry-later with no row.                                                                  |
| Whole-batch structural validation        | Oversized, duplicate-ID, envelope-mismatch, and cyclic batches produce zero writes; invalid codec/payload outcomes are evaluated only after current authorization and are paired evidence. |
| Per-action outcomes                      | Focused suite asserts accepted, duplicate, rejected, dependency-blocked, retry-later, and authority-expired results.                                                                       |
| Only causal dependants block             | A rejected predecessor blocks its descendant while an unrelated later action commits.                                                                                                      |
| Revalidation at every action transaction | Revocation/rotation/expiry/lock/scope/version/causality/payload/rate/replay negative controls show no stale acceptance.                                                                    |
| Atomic action/evidence/metadata          | Read-back finds action, idempotency, metadata, Control audit, and paired Grant audit together; injected boundary failures leave none.                                                      |
| Failure after every boundary             | Failure injection after action, metadata, Control audit, Grant audit, and receipt boundaries rolls the transaction back and returns retry-later/no receipt.                                |
| Authority/lifecycle races                | Independent writers yield exactly one accepted-or-authority-expired result and no sporting effect after the losing transition.                                                             |
| Duplicate/conflict SQLite races          | Two independent SQLite connections and `Promise.all` produce one permanent content-bound action; same content duplicates, different content conflicts.                                     |
| Locked replay                            | Trusted lock seam returns discard and read-back exposes only count/session/Event Game/time; invalid trust evidence cannot discard.                                                         |
| Durable budgets                          | Restart and independent adapters retain online-session, online-event, and replay buckets separately and return retry guidance at sustained/burst limits.                                   |
| Replay reservation/receipt               | Partial work returns no receipt; retry resumes/returns exact outcomes; receipt acknowledgement remains possible after authority rotation/revocation/expiry.                                |
| No raw capability at rest                | Database inspection shows only keyed lookup verifiers/digests and no supplied bearer or receipt plaintext.                                                                                 |
| Corrupt-state freeze                     | Tampered/deleted reservation, receipt, attempt, or linked audit fails readiness and rejects both memory and SQLite writes.                                                                 |
| Rejected evidence integrity              | Non-canonical candidate JSON, recomputed-fingerprint mismatch, collision-candidate mismatch, raw adapter reason, or impossible status/reason fails readiness and rejects both memory and SQLite writes. |
| Final correction recovery                | Third same-content submission, repeated operation conflict/rejection, close/reopen recovery, unsupported codec/version, budget exhaustion/refill, and throwing/sensitive/oversized replay callbacks produce exact bounded durable outcomes in memory and SQLite. |

The clean-correction acceptance additions are explicit gates, not inferred from
the original rows:

| Clean-correction gate           | Required proof                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization-before-disclosure | Invalid bearer is checked before root, scope, lock, codec, payload, or reservation inspection; structurally invalid batches remain write-free.                                                                                  |
| Whole-batch envelope identity   | Record/Event Game, Grant session/version, lifecycle, recovery provenance, duplicate IDs, and causal graph consistency are checked before any acceptance mutation.                                                               |
| Resumable replay                | Reservations bind to the authenticated replacement session; exact completed attempts are skipped before budgets; retry-later predecessors remain retryable; receipts require all definitive attempts.                           |
| Trusted lock discard            | Only a verified lock seam can create/discard a replay reservation; digest, replacement provenance, attempts, receipts, and replay contents are erased, with idempotent repeat.                                                  |
| Control audit integrity         | Control-use/outcome Grant audit actions are paired in both directions and acceptance/link/action fingerprints and outcome fields are included in keyed integrity evidence.                                                      |
| Durable readiness               | Memory and SQLite reconstruct attempt/result/timestamp/status transitions and freeze writes for missing, extra, orphaned, deleted, or coordinated acceptance evidence.                                                          |
| Independent budgets and races   | Session and Event Game buckets consume independently; online/replay buckets remain separate; synchronized independent SQLite revocation, rotation, expiry, scope, lock, duplicate, and conflict controls produce exact reasons. |
| Receipt key rotation            | Receipt stores only a digest and lookup-key version; restart/retry reconstructs the same opaque receipt from retained key material after lookup-key rotation. |

## Gate decision

The design is acceptable only when every row above has a named ordinary test or
existing invariant check, and the final handoff records the exact commands and
commit. Any failed adversarial check is a redesign trigger, not a waived test.
