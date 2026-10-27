# Plan 005: Assess compiled-only strict code-generation protection

> Investigation only. Follow the gates below; do not implement the migration in the caller's source tree. Update this plan's row in `plans/README.md` with the final report path and decision.
>
> Drift check: `git diff --stat 864754c0927ed041966eeed4ca64e71439d87996..HEAD -- build.ts src/index.ts src/lib/monitoring-server.ts scripts/create-release-bundle.ts`. Compare the current-state excerpts to the execution checkout. The known Bun 1.4.4 prerequisite pin/guard changes are expected; other mismatches require revalidation before using measurements.

## Status

- Priority: P2
- Effort: M (a day-ish, bounded investigation)
- Risk of eventual adoption: MED
- Category: investigation / migration
- Depends on: none; rebase and repeat affected comparisons after overlapping accepted changes
- Planned at: `864754c0927ed041966eeed4ca64e71439d87996`, 2026-10-28
- Report: `plans/005-strict-code-generation-findings.md` (create during investigation)

## Baseline, scope and authority

Planning date: 2026-10-28. Planning checkout: `/Users/jannis/Documents/workspace/php js/quadball-timer` at `864754c0927ed041966eeed4ca64e71439d87996`, with unrelated dirty documentation/workflow changes and untracked GLOSSARY.md. It still pins Bun 1.4.2. Preserve it untouched. Use a separate clean disposable checkout including the merged Bun 1.4.4 security prerequisite, PR #368/main commit `0f6659b23ddd679a52e97b328849a647650584fa`, or a descendant. The prerequisite aligns packageManager, direct script Bun executable, types and locked platform packages and adds a builder/embedded-runtime guard. Do not downgrade or repeat that work.

The user's replacement instructions prefer Bun check, Bun fmt and type-aware Oxlint. This authorizes investigating those directions, not assuming parity or applying an unreviewed migration. All lasting changes from this investigation are limited to the findings report listed below and this plan's status in `plans/README.md`. Candidate configs/fixtures may exist only in a disposable copy or task-owned temporary directory. No source changes may be transferred to the caller checkout. Record source status before/after, tool versions, command, exit status and evidence limits. Never reproduce secrets or read real .env files/data for a fixture.

Read `docs/agents/testing.md`. No Qualification Test, load/soak/crash/recovery or exact-production-artifact workload is authorized. Do not inspect or launch qualification harnesses. Use static inspection and tiny disposable tooling fixtures only; no production credentials, network services or databases. Preserve ADR0005's immutable Test-before-Production deployment policy. Do not install new tools to obtain a preferred result. If setup is needed in the isolated checkout, only its reviewed `bun install --frozen-lockfile` is allowed, with no changed resolutions.

Use a `codex/<investigation-slug>` branch if later dispatched as an executor. This planning request authorizes no execution, commit, push, PR or deployment. An investigation finishes with ADOPT, DEFER or REJECT plus evidence and a proposed implementation boundary; ADOPT is a recommendation, not a shipped change.

Commands are fish-compatible and run from the disposable repository root. Inspect `bun --version`, `bun --revision`, `git status --short` before measurements. Keep candidate and baseline runtime/fixture inputs identical. `git diff --check` must exit 0 for the report. No mutating formatter or lint-fix command belongs in the caller checkout. If a later implementation is approved, its gates remain lint:fix → format → lint, `bun run check`, and `bun run test`; all must pass under the accepted new scripts.

## Why investigate

The existing immutable bundle and disabled autoloading could be strengthened with an embedded code-generation restriction. The benefit is conditional on compatibility with bundled dependencies and every maintenance mode; the investigation must separate source evidence from runtime proof.

## Current state and conventions

`build.ts:186-207` already builds with splitting, ESM and bytecode, and compiles with dotenv/bunfig autoload disabled:

```ts
format: "esm",
bytecode: shouldCompile,
// inside compile:
autoloadDotenv: false,
autoloadBunfig: false,
```

It does not embed execArgv restrictions. Bun 1.4.4 exposes `compile.execArgv`; the proposed value is `["--disallow-code-generation-from-strings=strict"]`. This limits runtime string-code generation and, for compiled programs, external JavaScript loading. It is not a security sandbox. Direct source inspection found no server eval/new Function/node:vm requirement, but that does not establish dependency compatibility. Browser lazy imports in `src/App.tsx:23-38` are build-time-known browser routes; do not confuse browser code with server execution.

`src/index.ts` also contains maintenance/identity modes before starting the server, including --release-runtime-identity and --production-activation. The bundle builder queries runtime identity. Developer tooling deliberately executes/transpiles disk source; keep it outside the proposed restriction. Existing named-export TypeScript helpers and injected Fast Test style in `src/lib/server-drain.test.ts` are exemplars.

## Files and boundaries

Read/compare: `build.ts src/index.ts src/lib/monitoring-server.ts scripts/create-release-bundle.ts`. Lasting writes: `plans/005-strict-code-generation-findings.md`, and this status row in `plans/README.md` only. Candidate patches must be shown in the report as proposed changes, not applied to tracked product/tooling files. Preserve domain semantics, existing lint rules, test taxonomy, developer data, deployment identities and artifact lifecycle. Use TypeScript fixtures with `bun:test` only where necessary; no new test framework.

## Ordered investigation

### 1. Verify the exact flag and embedding API
Inspect `bun --help`, the pinned CompileBuildOptions type and the official release/executable documentation. Record exact supported execArgv syntax, strict semantics and whether environment options can weaken an embedded restriction. List affected APIs and distinguish ordinary data/configuration loading from code loading.

Verify: `bun --version` → at least 1.4.4; a source/type search for `execArgv` in the installed bun-types declaration and the official documentation agree. If they do not, STOP.

### 2. Inventory all executable entry modes statically
Read build.ts and the early command dispatch in src/index.ts. List server startup, identity, admin/event/grant and activation-maintenance modes actually present, with callers. Search reachable server dependencies for dynamic code loading/code generation; distinguish unreachable/browser/build-only references. Record conditional Sentry/GlitchTip behavior without opening private DSN configuration. Do not inspect qualification harness code or run any mode on real data.

Verify: the report has a mode inventory where each item has a source path, compatibility risk, and verified/static/unknown status; `rg -n 'process.argv|execArgv|autoload' build.ts src/index.ts scripts/create-release-bundle.ts` → cited paths reconcile with that inventory.

### 3. Define a bounded compatibility matrix without executing the production artifact
A tiny non-production fixture may demonstrate allowed embedded code and rejected string compilation/disk modules in an owned temporary directory. Before creating it, classify the proposed command under testing.md; it must be a disposable Focused Integration fixture with no app or Production artifact, external network, secrets, database or durable state. Use a hard process deadline and owned-child cleanup. If that boundary cannot be established, retain static findings only and mark runtime evidence NOT RUN. This plan does not authorize running the app's exact compiled artifact, storage-recovery modes or a new qualification workload.

Verify: the report lists each permitted fixture's input, deadline, cleanup and expected result before execution. If executed, include exact command and exit status; the directory contains no retained executable/data after cleanup.

### 4. Produce the decision and proposed patch boundary
Recommend ADOPT only with evidence proportional to the boundary actually established; unresolved application dependency or maintenance compatibility means DEFER production adoption. Show a proposed compiled-only execArgv diff inside the existing compile object, preserving existing compile overrides intentionally and preventing accidental weakening by later spreads. Do not set this globally in BUN_OPTIONS or dev launchers. Name any separately authorized acceptance work needed before a future implementation; do not register or run it now.

Verify: `rg -n 'Decision|Mode inventory|Compatibility matrix|NOT RUN|Proposed|Rollback' plans/005-strict-code-generation-findings.md` → each section exists. `git diff --name-only` → no product/build/config changes from this investigation.

## Evidence and test design

Assess source reachability, bundled dependencies, embedded lazy modules, Workers and maintenance entry modes. A toy fixture cannot prove the production executable compatible. Do not claim the absence of direct eval calls proves safety, or that the flag prevents native memory corruption. If a future implementation is approved, meaningful Fast Tests should assert compile-option wiring and retained development behavior; further exact-artifact acceptance remains subject to the repository's explicit qualification boundary.

## Done criteria

- [ ] The report includes flag/type support, static mode inventory, dependency uncertainties and bounded fixture results or NOT RUN.
- [ ] Proposed restriction applies only to compiled releases and cannot silently disable an existing required mode.
- [ ] Any required production-artifact evidence is explicitly deferred, not fabricated or run without admission.
- [ ] The report has an explicit ADOPT/DEFER/REJECT decision, unresolved facts, risks, rollback and a precise implementation file list.
- [ ] Each reported observation identifies the runtime version, command, exit code and input inventory; unperformed checks say NOT RUN.
- [ ] Caller source state is unchanged, and this plan's index row points to the report.
- [ ] `git diff --check` exits 0 for the findings document.

## STOP conditions

- The flag breaks a supported dependency/entry mode, or a proposed fix requires enabling runtime disk plugins, suppressing errors or changing database/configuration loading.
- Testing compatibility would require executing a qualification or production-shaped artifact workload without explicit named authorization.
- Existing compile overrides can bypass the intended restriction and resolving precedence needs a wider build-interface redesign.
- A command needs an unapproved workload, real production state, secrets, new access or an unreviewed dependency change.
- A gate still fails after two reasonable diagnostic attempts; preserve evidence and mark the report BLOCKED rather than weakening assertions or safety settings.

## Maintenance notes

Reassess after dependency, dynamic-import or maintenance-command changes. If later adopted, rollback is a normal rebuild without the added restriction; it must not downgrade Bun or alter storage. Keep performance/JIT tuning out of this security investigation.

## References

- https://bun.com/blog/bun-v1.4.3#disallow-code-generation-from-strings-blocks-eval-and-new-function
- https://bun.com/blog/bun-v1.4.4#disallow-code-generation-from-stringsstrict-only-runs-code-that-ships-with-your-program
- https://bun.com/docs/bundler/executables#embedding-runtime-arguments
