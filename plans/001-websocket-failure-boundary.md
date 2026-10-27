# Plan 001: Contain and report WebSocket handler failures

> Follow the ordered steps and their verification gates. STOP on a listed escape condition rather than expanding scope. Update only this plan's status row in `plans/README.md` when complete.
>
> Drift check: `git diff --stat 864754c0927ed041966eeed4ca64e71439d87996..HEAD -- src/index.ts src/lib/websocket-failure-boundary.ts src/lib/websocket-failure-boundary.test.ts`. Compare the excerpts below with the execution checkout before editing. Known prerequisite changes described below are expected; unexplained changes in the affected logic require revalidation.

## Status

- Priority: P1
- Effort: S (hours)
- Risk: MED
- Category: bug / reliability
- Depends on: none
- Planned at: `864754c0927ed041966eeed4ca64e71439d87996`, 2026-10-28
- Mode: Implementation handoff only: this document does not itself authorize executing the work.

## Execution baseline and non-negotiable boundaries

Repository: `/Users/jannis/Documents/workspace/php js/quadball-timer`. The planning checkout is a dirty feature branch whose package.json still pins Bun 1.4.2. Do not reset, stash, switch, install into, or format that caller checkout. Preserve its pre-existing documentation/workflow edits and untracked GLOSSARY.md. Start execution in a separate clean checkout including merged security PR #368, main commit `0f6659b23ddd679a52e97b328849a647650584fa`, or a descendant. That prerequisite pins packageManager, direct dev Bun executable and @types/bun to 1.4.4 and adds an embedded/builder version guard. Do not redo or downgrade it. Check the actual executable selected inside scripts as well as the shell runtime.

The user's 2026-10-28 instructions supersede older preferences: prefer Bun check for TypeScript checking, Bun fmt for formatting, and Oxlint with type-aware linting. Existing scripts remain the verification baseline until a separate migration is accepted; preference alone does not prove output or diagnostic parity.

Read `docs/agents/testing.md` before work. Ordinary checks/tests remain on the Fast Test boundary. No Qualification Test, soak, load, crash, recovery or exact-production-artifact workload is authorized by this plan; do not inspect or run qualification harnesses. No real server, credentials, production data, deployment, service restart, GitHub write, commit, push or merge is in scope. ADR `docs/adr/0005-post-sqm-automatic-deployment.md` requires one immutable release bundle through Test then Production; preserve that policy. Never put secret values in diagnostics or reports.

## Why this matters

Unexpected socket failures currently lack the explicit monitored per-connection boundary used by HTTP. A new callback alone would miss the existing async message path. Contain the failing connection while preserving durable acceptance, replay and shutdown tracking.

## Current state and conventions

`src/index.ts:707-724` owns idempotent disconnect cleanup: it checks `ws.data.closed`, releases reservation/accounting, removes the socket, and tracks durable session disconnect work. Reuse that owner; do not reproduce its bookkeeping.

`src/index.ts:730-732` explicitly monitors HTTP errors, but `websocket` at 2457 has open/close/message handlers and no socket-aware error callback. The final message wrapper is:

```ts
const receiveMessage = serverOptions.websocket.message.bind(serverOptions.websocket);
serverOptions.websocket.message = async (ws, message) => {
  if (!accepting || ws.data.closed) return;
  await work.track(receiveMessage(ws, message));
};
```

`src/lib/server-drain.ts:2-22` tracks pending promises and returns their original result/rejection. `src/lib/monitoring-server.ts` exposes captureException and deliberately disables default integrations. `src/lib/monitoring-redaction.ts:30-40` allows only category/component/operation/phase/status context tags. Use static tags, never socket data, credentials, messages or remote addresses. Follow dependency-injected test structure in `src/lib/server-drain.test.ts` and `src/lib/monitoring-server.test.ts`.

Bun 1.4.4 supplies `websocket.error(error, ws)` for synchronous throws. Rejected async handlers do not reach it. Both paths must enter the same application boundary.

Follow nearby TypeScript named exports, explicit types and `bun:test` tests. Keep domain terms such as Controller, Grant Session and Game Clock; do not change authority or replay semantics. New helper tests should exercise the callable integrated into the server rather than duplicate its implementation.

## Scope

In-scope future changes:
- `src/index.ts`
- `src/lib/websocket-failure-boundary.ts`
- `src/lib/websocket-failure-boundary.test.ts`
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

Use a separate `codex/websocket-failure-boundary` branch/checkout. Keep this change independent from other plans and unrelated work. No commit, push, PR or deployment is authorized by the planning request. If execution is separately authorized, report the diff and verification evidence for review; follow any later explicit delivery instructions. A future main push can trigger both deployments automatically.

## Ordered steps

### 1. Establish the existing boundary and a clean baseline
Read the named files and locate all rejections flowing from `receiveMessage`. Record existing closed-socket and work-tracker behavior; do not classify expected protocol/rate-limit outcomes as exceptions.

Verify: `bun test --isolate ./src/lib/server-drain.test.ts ./src/lib/monitoring-server.test.ts` → all existing tests pass.

### 2. Add one small injected failure/dispatch seam and regression tests
Create `src/lib/websocket-failure-boundary.ts` with a narrow typed interface accepting the existing work tracker, closed/accepting checks, monitor and disconnect owner. Its async dispatch must catch both a synchronous throw from the operation and a rejected promise. Its shared failure method reports sanitized static context, invokes existing idempotent cleanup and closes only the failed socket with code 1011 and a generic reason. Make failure handling non-throwing even if monitoring, cleanup or close throws; still attempt the remaining cleanup actions. Preserve ownership of any asynchronous disconnect work.

Write tests before wiring it into the server. Avoid `as any`, wall-clock sleeps and real sockets.

Verify: `bun test --isolate ./src/lib/websocket-failure-boundary.test.ts` → the named cases in Test plan pass.

### 3. Wire both Bun error delivery paths to that seam
Add `websocket.error(error, ws)` and replace the final async wrapper's uncaught await with the tested dispatch seam. Keep the original `receiveMessage` business logic unchanged. Reuse `disconnectSocket`; do not acknowledge failed or undelivered replay work. Handle an error callback after close safely.

Verify: `rg -n 'websocket-failure-boundary|error\(error, ws\)' src/index.ts` → import/use and callback are present. Rerun the targeted test command → pass.

### 4. Run the repository gates and review scope
Run the required lint:fix → format → lint order, then `bun run check` and `bun run test`. Review all automatic changes; revert only unrelated changes generated in this isolated checkout.

Verify: both ordinary gates exit 0; `git diff --check` exits 0; `git status --short` adds only Scope files.

## Test and evidence plan

New Fast Tests must cover synchronous throw, rejected promise, successful result, ignored closed/admission-stopped dispatch, reporting/cleanup/1011 close, repeat failure/close idempotency, and monitor/close failures. Ensure the exact helper wired into `src/index.ts` is exercised. Verify work-tracker count returns to zero after rejection and disconnect bookkeeping is not duplicated. Assert that dispatch does not retry an operation after rejection or manufacture acceptance/acknowledgment behavior; preserve receiveMessage business logic and existing replay tests. Use injected typed interfaces and spies, matching the existing drain tests. No real storage or network traffic is needed.

## Done criteria

- [ ] `bun test --isolate ./src/lib/websocket-failure-boundary.test.ts ./src/lib/server-drain.test.ts ./src/lib/monitoring-server.test.ts` exits 0.
- [ ] Both the synchronous error callback and async message wrapper invoke the tested shared boundary.
- [ ] Required lint/format sequence, `bun run check`, `bun run test`, and `git diff --check` all exit 0.
- [ ] The final changed-path list is within Scope, relative to the recorded execution baseline.
- [ ] This plan's row in `plans/README.md` records DONE, BLOCKED or REJECTED and a brief evidence reference; an investigation's DONE means the decision report is complete, not that migration shipped.

## STOP conditions

- The pinned Bun types do not expose the documented socket-aware callback, or actual delivery semantics differ from the official documentation.
- A safe implementation requires changing mutation, authorization, replay acceptance/acknowledgment or disconnect storage semantics. Those need a separate design decision.
- The helper needs a broad framework or server rewrite rather than one narrow seam.
- A reasonable correction still leaves a verification gate failing a second time; retain the failure rather than weakening an assertion, policy or type setting.
- Required work escapes Scope or would affect real state, secrets or production. Explain the missing capability instead of improvising.

## Maintenance and review notes

Future socket handlers must join this boundary. Review static telemetry tags and replay non-acknowledgment especially carefully. Coordinate plan 002 because both touch the server WebSocket configuration; this is error containment, not a replacement for validation or rate limits.

## References

- https://bun.com/blog/bun-v1.4.4#websocketerror-in-bunserve-receives-the-socket
- https://bun.com/docs/runtime/http/websockets#errors
