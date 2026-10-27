# Plan 003: Traverse dynamic imports using Bun source entry points

> Follow the ordered steps and their verification gates. STOP on a listed escape condition rather than expanding scope. Update only this plan's status row in `plans/README.md` when complete.
>
> Drift check: `git diff --stat 864754c0927ed041966eeed4ca64e71439d87996..HEAD -- scripts/bundle-analysis.ts scripts/bundle-analysis.test.ts`. Compare the excerpts below with the execution checkout before editing. Known prerequisite changes described below are expected; unexplained changes in the affected logic require revalidation.

## Status

- Priority: P2
- Effort: S (hours)
- Risk: LOW
- Category: tech-debt / readability
- Depends on: none
- Planned at: `864754c0927ed041966eeed4ca64e71439d87996`, 2026-10-28
- Mode: Implementation handoff only: this document does not itself authorize executing the work.

## Execution baseline and non-negotiable boundaries

Repository: `/Users/jannis/Documents/workspace/php js/quadball-timer`. The planning checkout is a dirty feature branch whose package.json still pins Bun 1.4.2. Do not reset, stash, switch, install into, or format that caller checkout. Preserve its pre-existing documentation/workflow edits and untracked GLOSSARY.md. Start execution in a separate clean checkout including merged security PR #368, main commit `0f6659b23ddd679a52e97b328849a647650584fa`, or a descendant. That prerequisite pins packageManager, direct dev Bun executable and @types/bun to 1.4.4 and adds an embedded/builder version guard. Do not redo or downgrade it. Check the actual executable selected inside scripts as well as the shell runtime.

The user's 2026-10-28 instructions supersede older preferences: prefer Bun check for TypeScript checking, Bun fmt for formatting, and Oxlint with type-aware linting. Existing scripts remain the verification baseline until a separate migration is accepted; preference alone does not prove output or diagnostic parity.

Read `docs/agents/testing.md` before work. Ordinary checks/tests remain on the Fast Test boundary. No Qualification Test, soak, load, crash, recovery or exact-production-artifact workload is authorized by this plan; do not inspect or run qualification harnesses. No real server, credentials, production data, deployment, service restart, GitHub write, commit, push or merge is in scope. ADR `docs/adr/0005-post-sqm-automatic-deployment.md` requires one immutable release bundle through Test then Production; preserve that policy. Never put secret values in diagnostics or reports.

## Why this matters

Use metadata that names the original source instead of reconstructing it from emitted filenames. This removes an obsolete dependency between the source graph and output naming while keeping external imports excluded.

## Current state and conventions

`scripts/bundle-analysis.ts:3-17` traverses source imports. Its Bun 1.4.2 compatibility workaround joins an emitted chunk path to outputs:

```ts
const chunkEntry =
  edge.kind === "dynamic-import" ? meta.outputs[edge.path]?.entryPoint : undefined;
const target =
  chunkEntry && meta.inputs[chunkEntry] ? chunkEntry : edge.external ? undefined : edge.path;
```

Bun 1.4.3 added optional `entryPoint` directly to a rewritten input import edge, and @types/bun 1.4.4 declares it. Rewritten bundled imports may still say external:true; genuine externals have no source entry point. `scripts/bundle-analysis.test.ts:84-134` models the old output-join behavior. The same file's first test asserts eager/deferred/shared asset separation and fail-closed behavior; preserve those outputs. TypeScript named exports and `bun:test` fixtures are the existing pattern.

Follow nearby TypeScript named exports, explicit types and `bun:test` tests. Keep domain terms such as Controller, Grant Session and Game Clock; do not change authority or replay semantics. New helper tests should exercise the callable integrated into the server rather than duplicate its implementation.

## Scope

In-scope future changes:
- `scripts/bundle-analysis.ts`
- `scripts/bundle-analysis.test.ts`
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

Use a separate `codex/metafile-entrypoint` branch/checkout. Keep this change independent from other plans and unrelated work. No commit, push, PR or deployment is authorized by the planning request. If execution is separately authorized, report the diff and verification evidence for review; follow any later explicit delivery instructions. A future main push can trigger both deployments automatically.

## Ordered steps

### 1. Validate the supported metadata contract
Confirm the execution checkout uses aligned Bun/types at least 1.4.4 and inspect the BuildMetafile input-edge type. Historical metadata compatibility is not a product requirement in the current source; this tool analyzes the current pinned build. If a real external consumer needs older files, STOP before retaining a silent fallback.

Verify: `bun run check:bun-version` and `bun test --isolate ./scripts/bundle-analysis.test.ts` → exit 0.

### 2. Write fixtures for direct source entry points
Replace the obsolete regression fixture's bundled dynamic edge with one containing `entryPoint: "src/pages/event-admin-page.tsx"`. Ensure that traversal succeeds even when outputs cannot be joined by edge.path. Keep genuine external dynamic/static imports and the cyclic source reference. Add an unknown-entryPoint case so malformed metadata cannot invent a source edge.

Verify: `bun test --isolate ./scripts/bundle-analysis.test.ts` → the new no-output-join case fails before implementation and existing expectations remain meaningful.

### 3. Simplify importChains
Prefer a known `edge.entryPoint` as the input target; otherwise follow ordinary nonexternal source paths. Do not blindly follow every external:true edge, output chunk filename or original alias specifier. Preserve cycle prevention and report ordering/byte calculations. Remove the output-join workaround and obsolete explanation only; do not rewrite asset classification.

Verify: the same targeted command → all pass; `rg -n 'meta.outputs\[edge.path\]' scripts/bundle-analysis.ts` → no matches (exit 1).

### 4. Run quality and ordinary verification
Run lint:fix → format → lint, `bun run check`, `bun run test`, and `git diff --check`.

Verify: all exit 0. No build is needed to make unit assertions pass; an optional ordinary `bun run build --analyze` belongs only in the isolated execution checkout and must leave output under ignored dist/out directories.

## Test and evidence plan

Use the existing `Bun.BuildMetafile` typed fixture style without type assertions that hide absent fields. Cover dynamic entryPoint independent of outputs, static source imports, genuine external imports, unknown entry points, cycles, and unchanged initial/deferred/shared classification. Do not add a snapshot of the whole generated bundle.

## Done criteria

- [ ] `bun test --isolate ./scripts/bundle-analysis.test.ts` passes, including no-output-join and true-external cases.
- [ ] No `meta.outputs[edge.path]` workaround remains in importChains.
- [ ] Standard quality/Fast Test gates and diff hygiene pass.
- [ ] The final changed-path list is within Scope, relative to the recorded execution baseline.
- [ ] This plan's row in `plans/README.md` records DONE, BLOCKED or REJECTED and a brief evidence reference; an investigation's DONE means the decision report is complete, not that migration shipped.

## STOP conditions

- The pinned metadata type lacks entryPoint, or supported real outputs contradict the release contract.
- An external consumer requires importing historical Bun 1.4.2 metadata; decide compatibility explicitly before changing behavior.
- The proposed change affects byte accounting, source splitting or application routes.
- A reasonable correction still leaves a verification gate failing a second time; retain the failure rather than weakening an assertion, policy or type setting.
- Required work escapes Scope or would affect real state, secrets or production. Explain the missing capability instead of improvising.

## Maintenance and review notes

Future metadata changes should be captured with a small typed fixture. `original` may be an alias, not a source key; do not substitute it for entryPoint.

## References

- https://bun.com/blog/bun-v1.4.3#metafile-names-the-input-file-behind-a-split-import
