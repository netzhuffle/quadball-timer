# Plan 002: Reject oversized WebSocket messages at the native boundary

> Follow the ordered steps and their verification gates. STOP on a listed escape condition rather than expanding scope. Update only this plan's status row in `plans/README.md` when complete.
>
> Drift check: `git diff --stat 864754c0927ed041966eeed4ca64e71439d87996..HEAD -- src/index.ts src/lib/ws-protocol.test.ts`. Compare the excerpts below with the execution checkout before editing. Known prerequisite changes described below are expected; unexplained changes in the affected logic require revalidation.

## Status

- Priority: P1
- Effort: S (hours)
- Risk: MED
- Category: security / performance
- Depends on: 001-websocket-failure-boundary.md (serialize overlapping src/index.ts edits)
- Planned at: `864754c0927ed041966eeed4ca64e71439d87996`, 2026-10-28
- Mode: Implementation handoff only: this document does not itself authorize executing the work.

## Execution baseline and non-negotiable boundaries

Repository: `/Users/jannis/Documents/workspace/php js/quadball-timer`. The planning checkout is a dirty feature branch whose package.json still pins Bun 1.4.2. Do not reset, stash, switch, install into, or format that caller checkout. Preserve its pre-existing documentation/workflow edits and untracked GLOSSARY.md. Start execution in a separate clean checkout including merged security PR #368, main commit `0f6659b23ddd679a52e97b328849a647650584fa`, or a descendant. That prerequisite pins packageManager, direct dev Bun executable and @types/bun to 1.4.4 and adds an embedded/builder version guard. Do not redo or downgrade it. Check the actual executable selected inside scripts as well as the shell runtime.

The user's 2026-10-28 instructions supersede older preferences: prefer Bun check for TypeScript checking, Bun fmt for formatting, and Oxlint with type-aware linting. Existing scripts remain the verification baseline until a separate migration is accepted; preference alone does not prove output or diagnostic parity.

Read `docs/agents/testing.md` before work. Ordinary checks/tests remain on the Fast Test boundary. No Qualification Test, soak, load, crash, recovery or exact-production-artifact workload is authorized by this plan; do not inspect or run qualification harnesses. No real server, credentials, production data, deployment, service restart, GitHub write, commit, push or merge is in scope. ADR `docs/adr/0005-post-sqm-automatic-deployment.md` requires one immutable release bundle through Test then Production; preserve that policy. Never put secret values in diagnostics or reports.

## Why this matters

The application accepts 256 KiB but leaves Bun free to buffer much larger incoming messages before validation. Wiring the same policy into Bun avoids avoidable decoding/allocation while retaining defense in depth.

## Current state and conventions

`src/lib/validation-policy.ts:1-5` is the single source of truth:

```ts
export const SHARED_LIMITS = {
  transport: {
    websocketTextFrameBytes: 256 * 1024,
    httpJsonBodyBytes: 64 * 1024,
  },
```

`parseClientWsMessage` in `src/lib/ws-protocol.ts:92-96` checks UTF-8 byte length after delivery and returns a protocol error if oversized. Keep it. `src/index.ts:2457-2459` currently configures output only:

```ts
websocket: {
  backpressureLimit: AD_HOC_MAX_QUEUED_OUTPUT_BYTES,
  closeOnBackpressureLimit: true,
```

Bun's default incoming limit is 16 MB. The maxPayloadLength API is older than 1.4.4; its corrected close/payload behavior motivates this adjacent hardening. Native rejection closes with 1009 instead of returning the application's JSON error. Preserve `AD_HOC_MAX_QUEUED_OUTPUT_BYTES`, an output budget; do not confuse it with input size. `src/lib/validation-policy.test.ts` and `src/lib/ws-protocol.test.ts` illustrate current byte-boundary tests.

Follow nearby TypeScript named exports, explicit types and `bun:test` tests. Keep domain terms such as Controller, Grant Session and Game Clock; do not change authority or replay semantics. New helper tests should exercise the callable integrated into the server rather than duplicate its implementation.

## Scope

In-scope future changes:
- `src/index.ts`
- `src/lib/ws-protocol.test.ts`
- `plans/README.md`: this plan's status only.

Everything else is out of scope unless this plan explicitly names it. In particular, preserve durable storage, database schemas, access control, application response payloads, deployment workflow and runtime versions unless the ordered steps explicitly identify a necessary change. Report additional opportunities separately.

## Commands

Run commands from the execution repository root. Commands shown are fish-compatible.

| Purpose | Command | Expected result |
|---|---|---|
| Runtime identity | `bun --version` and `bun run check:bun-version` | Version matches the execution checkout, at least 1.4.4; guard exits 0 |
| Ordinary verification | `bun run check` | Exit 0; existing policy, formatting, lint and shell checks pass |
| Fast Tests | `bun run test` | Exit 0; no focused or qualification workload runs |
| Required post-edit order | `bun run lint:fix`, then `bun run format`, then `bun run lint` | Each exits 0; review the diff after both mutating commands |

For an executor authorized to implement, `bun install --frozen-lockfile` is the only setup install; it must exit 0 without resolution changes. Do not install or update dependencies merely to investigate a diagnostic. If setup fails, record the exact blocker.

## Git workflow

Use a separate `codex/native-websocket-payload-budget` branch/checkout. Keep this change independent from other plans and unrelated work. No commit, push, PR or deployment is authorized by the planning request. If execution is separately authorized, report the diff and verification evidence for review; follow any later explicit delivery instructions. A future main push can trigger both deployments automatically.

## Ordered steps

### 1. Reconfirm shared policy and existing tests
Locate all WebSocket server option construction and ensure the native option applies to both Ad Hoc and public Event connections without changing their role-specific resource accounting.

Verify: `bun test --isolate ./src/lib/validation-policy.test.ts ./src/lib/ws-protocol.test.ts` → pass.

### 2. Wire the existing policy directly into Bun
Add `maxPayloadLength: SHARED_LIMITS.transport.websocketTextFrameBytes` directly to the shipped WebSocket options in src/index.ts. Keep the existing `satisfies Bun.Serve.Options<SessionData>` type check, output backpressure settings and parser size check. Do not introduce a helper/configuration module solely to test one property.

Verify: `rg -n 'maxPayloadLength: SHARED_LIMITS.transport.websocketTextFrameBytes' src/index.ts` → exactly the integrated option line is present. `git diff -- src/index.ts` → input option addition only, apart from separately accepted plan 001 changes.

### 3. Retain meaningful byte-boundary coverage
Existing ws-protocol tests already reject an oversized emoji payload before JSON parsing and accept an exact 256 KiB ASCII envelope while rejecting one byte over. Keep those tests. Add only a missing multibyte exact-boundary regression if needed to establish UTF-8 byte semantics; do not add a test that merely rereads a constant or source string. Document the native 1009 close behavior in the review evidence rather than pretending the parser test exercises native framing.

Verify: `bun test --isolate ./src/lib/ws-protocol.test.ts ./src/lib/validation-policy.test.ts` → pass, including existing exact-boundary and multibyte rejection tests.

### 4. Run required gates
Run lint:fix → format → lint, `bun run check`, `bun run test`, and `git diff --check`.

Verify: all exit 0; changed paths stay within Scope.

## Test and evidence plan

Review the direct input-option wiring and unchanged output budget in the actual diff. Run the existing exact-boundary and oversized UTF-8 protocol tests; optionally add the uncovered exact multibyte case in ws-protocol.test.ts. No test-only exported options object, source-text assertion test, real huge-message load test or new harness is requested. Fast Tests establish application validation and compiler checking establishes the option type; they do not claim an exact-artifact native-framing qualification. If real component coverage is necessary, first propose a separately named disposable Focused Integration Test and its bounded scope.

## Done criteria

- [ ] Targeted Fast Tests pass.
- [ ] The integrated Bun options use the shared input constant; the application parser check and output budget remain.
- [ ] `bun run check`, `bun run test`, required lint/format order and `git diff --check` exit 0.
- [ ] Review notes explicitly identify native 1009 close semantics and the limits of Fast Test evidence.
- [ ] The final changed-path list is within Scope, relative to the recorded execution baseline.
- [ ] This plan's row in `plans/README.md` records DONE, BLOCKED or REJECTED and a brief evidence reference; an investigation's DONE means the decision report is complete, not that migration shipped.

## STOP conditions

- A legitimate current Controller/replay payload exceeds the documented shared budget; investigate the contract instead of raising it.
- A change would require altering replay batches, output limits, compression, authentication or connection capacities.
- Plan 001 has not settled the overlapping server integration, or there is unresolved source drift.
- A reasonable correction still leaves a verification gate failing a second time; retain the failure rather than weakening an assertion, policy or type setting.
- Required work escapes Scope or would affect real state, secrets or production. Explain the missing capability instead of improvising.

## Maintenance and review notes

Input and output budgets are different contracts. Keep the native value derived from the shared policy if that policy changes. Never replace protocol validation with the native setting.

## References

- https://bun.com/docs/runtime/http/websockets#timeouts-and-limits
- https://bun.com/blog/bun-v1.4.4 (Bun.serve WebSocket server fixes)
