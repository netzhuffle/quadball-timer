# Plan 007: Assess replacing Oxlint type checking with Bun check

> Investigation only. Follow the gates below; do not implement the migration in the caller's source tree. Update this plan's row in `plans/README.md` with the final report path and decision.
>
> Drift check: `git diff --stat 864754c0927ed041966eeed4ca64e71439d87996..HEAD -- package.json .oxlintrc.json tsconfig.json .github/workflows/deploy-production.yml docs/research/oxlint-configuration.md`. Compare the current-state excerpts to the execution checkout. The known Bun 1.4.4 prerequisite pin/guard changes are expected; other mismatches require revalidation before using measurements.

## Status

- Priority: P2
- Effort: M (a day-ish, bounded investigation)
- Risk of eventual adoption: MED
- Category: investigation / migration
- Depends on: none; rebase and repeat affected comparisons after overlapping accepted changes
- Planned at: `864754c0927ed041966eeed4ca64e71439d87996`, 2026-10-28
- Report: `plans/007-bun-check-migration-findings.md` (create during investigation)

## Baseline, scope and authority

Planning date: 2026-10-28. Planning checkout: `/Users/jannis/Documents/workspace/php js/quadball-timer` at `864754c0927ed041966eeed4ca64e71439d87996`, with unrelated dirty documentation/workflow changes and untracked GLOSSARY.md. It still pins Bun 1.4.2. Preserve it untouched. Use a separate clean disposable checkout including the merged Bun 1.4.4 security prerequisite, PR #368/main commit `0f6659b23ddd679a52e97b328849a647650584fa`, or a descendant. The prerequisite aligns packageManager, direct script Bun executable, types and locked platform packages and adds a builder/embedded-runtime guard. Do not downgrade or repeat that work.

The user's replacement instructions prefer Bun check, Bun fmt and type-aware Oxlint. This authorizes investigating those directions, not assuming parity or applying an unreviewed migration. All lasting changes from this investigation are limited to the findings report listed below and this plan's status in `plans/README.md`. Candidate configs/fixtures may exist only in a disposable copy or task-owned temporary directory. No source changes may be transferred to the caller checkout. Record source status before/after, tool versions, command, exit status and evidence limits. Never reproduce secrets or read real .env files/data for a fixture.

Read `docs/agents/testing.md`. No Qualification Test, load/soak/crash/recovery or exact-production-artifact workload is authorized. Do not inspect or launch qualification harnesses. Use static inspection and tiny disposable tooling fixtures only; no production credentials, network services or databases. Preserve ADR0005's immutable Test-before-Production deployment policy. Do not install new tools to obtain a preferred result. If setup is needed in the isolated checkout, only its reviewed `bun install --frozen-lockfile` is allowed, with no changed resolutions.

Use a `codex/<investigation-slug>` branch if later dispatched as an executor. This planning request authorizes no execution, commit, push, PR or deployment. An investigation finishes with ADOPT, DEFER or REJECT plus evidence and a proposed implementation boundary; ADOPT is a recommendation, not a shipped change.

Commands are fish-compatible and run from the disposable repository root. Inspect `bun --version`, `bun --revision`, `git status --short` before measurements. Keep candidate and baseline runtime/fixture inputs identical. `git diff --check` must exit 0 for the report. No mutating formatter or lint-fix command belongs in the caller checkout. If a later implementation is approved, its gates remain lint:fix → format → lint, `bun run check`, and `bun run test`; all must pass under the accepted new scripts.

## Why investigate

Separate compiler diagnostics from type-aware linting while aligning with the updated preference for Bun check. Adoption should retain both coverage and readable diagnostics, and must not accidentally execute the existing check script or remove type-aware lint rules.

## Current state and conventions

`.oxlintrc.json:25-28` contains:

```json
"options": {
  "typeAware": true,
  "typeCheck": true,
  "denyWarnings": true
}
```

The current `--type-check` behavior is configured through typeCheck:true, not written literally in package.json. lint is `bunx --bun oxlint --format=agent`; `bun run check` composes runtime guard, policy check, format:check, lint and ShellCheck. oxlint-tsgolint remains necessary for type-aware linting and must not be removed just because compiler diagnostics move elsewhere. Keep TypeScript, React, accessibility/import correctness rules and warnings-as-errors intact.

`tsconfig.json` uses strict, noUncheckedIndexedAccess, noImplicitOverride, bundler resolution, allowJs, noEmit and @/* aliases; it excludes dist/docs/node_modules. Follow its existing whole-project scope rather than silently narrowing to src. `docs/research/oxlint-configuration.md:7-9` records the earlier combined checking decision; append a new decision only in a future approved implementation, not by rewriting historical evidence.

The inspected Bun 1.4.4 help says: because package.json has a check script, plain `bun check` invokes that script. **Use `bun check --no-script --no-pretty` for the native checker.** A proposed standalone script can be `"typecheck": "bun check --no-script"`; keep `bun run check` as the aggregate. This avoids accidental recursion or measuring the aggregate instead of the compiler.

## Files and boundaries

Read/compare: `package.json .oxlintrc.json tsconfig.json .github/workflows/deploy-production.yml docs/research/oxlint-configuration.md`. Lasting writes: `plans/007-bun-check-migration-findings.md`, and this status row in `plans/README.md` only. Candidate patches must be shown in the report as proposed changes, not applied to tracked product/tooling files. Preserve domain semantics, existing lint rules, test taxonomy, developer data, deployment identities and artifact lifecycle. Use TypeScript fixtures with `bun:test` only where necessary; no new test framework.

## Ordered investigation

### 1. Map the current checking contract
Record exact Bun, Oxlint and oxlint-tsgolint versions, effective typeAware/typeCheck settings, tsconfig scope and every check invocation in scripts/CI. Read the historical Oxlint decision as context, not a prohibition on the newly requested investigation.

Verify: `bun check --help` → documents --no-script and the check-script collision; `bunx --bun oxlint --help` → documents both --type-aware and --type-check. Record baseline `bun run lint` result.

### 2. Compare compiler diagnostics without changing accepted source
Run native `bun check --no-script --no-pretty` on the same clean snapshot. Compare diagnostics with the combined Oxlint baseline by file, code/category and location, not just raw line count. Inventory source/TSX/tests/scripts/type declarations and alias resolution. Distinguish code errors, third-party declaration issues, configuration gaps and diagnostic-rendering differences. Do not auto-fix errors or relax tsconfig to make the comparison pass.

Verify: both command identities/exit codes are recorded and the report accounts for each differing diagnostic; native Bun has no emitted JS/declarations or changed source files.

### 3. Prove the split retains compiler errors and type-aware linting
In a disposable candidate copy only, set typeCheck:false (or remove that option after confirming default behavior) while retaining typeAware:true, warning denial and the entire rule set. Use explicit `bunx --bun oxlint --type-aware --format=agent` for candidate lint and equivalent lint:fix. Retain oxlint-tsgolint. Propose a separate typecheck script calling `bun check --no-script`, inserted once into aggregate check. Do not also add --check to every test/build/dev invocation.

Create tiny disposable negative fixtures for: a strict assignment error; missing/incorrect property; unchecked indexed access; alias-resolved imported type; TSX prop type mismatch; a representative type-aware lint rule actually enabled in the effective config. First confirm the selected rule is enabled; do not invent coverage. Run lint-only, native typecheck-only and aggregate paths independently. Clean each fixture before the next case. Fixtures may be checked statically but must not execute application/focused/qualification code.

Verify: native checking fails for every compiler-error fixture; the retained type-aware lint gate fails for its rule fixture; the candidate aggregate fails when either gate fails and succeeds on the clean candidate baseline. No recursion occurs. Report exit codes per fixture.

### 4. Compare costs and document the candidate integration
Record up to three warm timings for baseline combined checking versus candidate lint-plus-typecheck on identical inputs. Include startup costs and CI command order, not just checker internals. Report any duplicate analysis still required for type-aware linting. Identify the future patch boundary: package.json, .oxlintrc.json, a reviewed tooling-decision note and any necessary focused command-contract tests. CI should retain its existing aggregate check entry point unless evidence requires a separate change.

Verify: the report's proposed diff shows typeCheck disabled, type-aware linting retained, one explicit native typecheck gate and unchanged strict tsconfig.

### 5. Produce an evidence-based recommendation
Write ADOPT/DEFER/REJECT with diagnostic parity/gaps, fixture matrix, performance results, dependency effects, proposed migration and rollback. Any new errors must be reported with proposed scope/effort, not suppressed within this investigation. Pair with plan 006 only in a later implementation decision; neither investigation depends on the other's candidate result.

Verify: `rg -n 'Decision|Diagnostics|Coverage|Fixture matrix|Timing|Proposed|Rollback|no-script' plans/007-bun-check-migration-findings.md` → all sections/critical dispatch detail present; only report/index changes persist.

## Evidence and test design

Meaningful tests are negative fixtures that prove each independent gate catches a real error, plus a clean baseline. Keep known false-positive/unsupported constructs as explicit parity gaps. Do not swap Bun tests for another framework or claim compiler checks cover runtime behavior. Static checking may include test/harness sources under tsconfig, but it must never execute their workloads. If a future migration lands, maintain one compiler gate plus existing type-aware linting; retain strict options and avoid duplicate test/build --check passes.

## Done criteria

- [ ] Current config-based typeCheck and typeAware behaviors are distinguished correctly.
- [ ] Native compiler command uses --no-script; the aggregate command remains nonrecursive.
- [ ] Fixture matrix proves retained compiler and type-aware lint failures separately and aggregate failure propagation.
- [ ] Full source-scope coverage, diagnostic differences and timings are reported.
- [ ] Proposed integration retains oxlint-tsgolint, lint rules, denyWarnings and strict tsconfig without duplicate compiler gates.
- [ ] The report has an explicit ADOPT/DEFER/REJECT decision, unresolved facts, risks, rollback and a precise implementation file list.
- [ ] Each reported observation identifies the runtime version, command, exit code and input inventory; unperformed checks say NOT RUN.
- [ ] Caller source state is unchanged, and this plan's index row points to the report.
- [ ] `git diff --check` exits 0 for the findings document.

## STOP conditions

- The native command dispatches to the aggregate, produces files, omits relevant source categories, or does not honor the existing aliases/strict settings.
- Candidate lint loses type-aware behavior or removing oxlint-tsgolint seems necessary; investigate the engine requirement rather than removing it.
- Adoption would require broad application fixes, declaration workarounds, changed tsconfig exclusions or diagnostic suppression; report a separate prerequisite instead.
- A command needs an unapproved workload, real production state, secrets, new access or an unreviewed dependency change.
- A gate still fails after two reasonable diagnostic attempts; preserve evidence and mark the report BLOCKED rather than weakening assertions or safety settings.

## Maintenance notes

Keep compiler and linter responsibilities explicit. Re-run the negative fixture matrix after Bun/Oxlint upgrades. The report should recommend a follow-up implementation if accepted, not leave candidate script/config edits in the source checkout.

## References

- https://bun.com/blog/bun-v1.4.3#bun-check-a-typescript-type-checker-built-into-bun
- https://bun.com/docs/runtime/check
- .oxlintrc.json and docs/research/oxlint-configuration.md
