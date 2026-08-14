# Issue #79 handoff

This is the final thin composition correction for #79: a headless acceptance
seam over the existing Grant and Event Game modules. It does not change public
routes, queues, WebSockets, Controller UI, or Grant Code admission. The
authoritative invariant, ownership, migration, and acceptance matrix is
[`issue-79-design-gate.md`](./issue-79-design-gate.md); this file is only the
compact coordinator handoff.

## Exact composition

- Starting candidate: `e66a99946a87de05c096d84c22b8555c7d2b5012`.
- Accepted authority prerequisite source: `be24d38c66a2f0315e619098ae460e54ef6dd166`; applied here as `400d85d`.
- Included cumulative #79 candidate ancestors: `1c3136cce87fe2c0fd551a4080c4bdb0a592bfe7`, `e7f95b2cb143b682fab4db8cb8a7c501c377aa30`, `c32feedde809faeae5cea045fb7fc267549db199`, `1b657472b077e64e0d03be63d337bd6b55acfc8e`, and `e66a99946a87de05c096d84c22b8555c7d2b5012`.
- Final composition commit: this commit; the coordinator should record its exact SHA from the handoff message.
- Correction scope: exact online outcome recovery for duplicate/rejection/conflict, canonical claimed codec identity for failed preparation, prepared budget retry after refill, and unconditional bounded replay-ineligibility normalization.

## Final gates closed

- Authority and capability checks precede root, scope, codec, payload, and
  reservation disclosure; missing-root and stale-preflight paths are
  mutation-free, and each write transaction reprepares against its local root.
- Replay reservations, receipts, attempts, budgets, anchors, and paired
  Control↔Grant evidence retain exact durable transitions, redaction, recovery,
  and rotation behavior. Locked discard retains only the required redacted
  tuple and is idempotent.
- Every rejected candidate, including collision evidence, retains canonical
  content and codec identity/fingerprint. Readiness recomputes the exact
  established SHA-256 fingerprint and requires equality across candidate,
  Control, Grant, and replay evidence. Unsupported kinds retain their claimed
  registered/versioned identity and never use `unprepared`.
- Repeated identical online duplicate, rejection, and operation-conflict
  submissions recover the exact existing paired outcome without appending
  deterministic-ID-colliding evidence; this remains true after SQLite restart.
- Rate-budget rejection is recorded only after preparation with its prepared
  input; after refill, the identical action resumes as accepted. Replay
  adapters cannot persist callback reason/detail, including on throw: all
  ineligible outcomes use the finite `replay-ineligible` reason and bounded
  redacted detail.
- Authorized replay retries of a prior definitive replay-ineligible or
  unsupported-codec rejection recover that exact paired outcome before
  reservation creation, including after SQLite restart; no receipt or
  reservation is created for the rejected branch.
- Rejection reasons use one finite durable contract. Adapter-supplied replay
  reasons are normalized before persistence; Grant HMAC evidence binds exact
  status, reason, and detail, and impossible combinations freeze both adapters.
- Migrations 001–016 are unchanged. Candidate migrations 017–018 remain
  unpublished drafts and are not production migration commands.

## Verification evidence

The coordinator’s completion message records the exact commands and final
results for frozen install, audit, check, Fast, focused acceptance/Grant/SQLite,
both builds, and diff checks. Qualification tests and
`bun run check:sqlite-runtime` are intentionally excluded. No push, pull
request, issue mutation, or integration onto
`codex/durable-control-foundations` was performed.
