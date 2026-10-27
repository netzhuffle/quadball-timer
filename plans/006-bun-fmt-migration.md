# Plan 006: Assess replacing Oxfmt with Bun fmt

> Investigation only. Follow the gates below; do not implement the migration in the caller's source tree. Update this plan's row in `plans/README.md` with the final report path and decision.
>
> Drift check: `git diff --stat 864754c0927ed041966eeed4ca64e71439d87996..HEAD -- package.json bunfig.toml .oxlintrc.json tsconfig.json .github/workflows/deploy-production.yml`. Compare the current-state excerpts to the execution checkout. The known Bun 1.4.4 prerequisite pin/guard changes are expected; other mismatches require revalidation before using measurements.

## Status

- Priority: P2
- Effort: M (a day-ish, bounded investigation)
- Risk of eventual adoption: MED
- Category: investigation / migration
- Depends on: none; rebase and repeat affected comparisons after overlapping accepted changes
- Planned at: `864754c0927ed041966eeed4ca64e71439d87996`, 2026-10-28
- Report: `plans/006-bun-fmt-migration-findings.md` (create during investigation)

## Baseline, scope and authority

Planning date: 2026-10-28. Planning checkout: `/Users/jannis/Documents/workspace/php js/quadball-timer` at `864754c0927ed041966eeed4ca64e71439d87996`, with unrelated dirty documentation/workflow changes and untracked GLOSSARY.md. It still pins Bun 1.4.2. Preserve it untouched. Use a separate clean disposable checkout including the merged Bun 1.4.4 security prerequisite, PR #368/main commit `0f6659b23ddd679a52e97b328849a647650584fa`, or a descendant. The prerequisite aligns packageManager, direct script Bun executable, types and locked platform packages and adds a builder/embedded-runtime guard. Do not downgrade or repeat that work.

The user's replacement instructions prefer Bun check, Bun fmt and type-aware Oxlint. This authorizes investigating those directions, not assuming parity or applying an unreviewed migration. All lasting changes from this investigation are limited to the findings report listed below and this plan's status in `plans/README.md`. Candidate configs/fixtures may exist only in a disposable copy or task-owned temporary directory. No source changes may be transferred to the caller checkout. Record source status before/after, tool versions, command, exit status and evidence limits. Never reproduce secrets or read real .env files/data for a fixture.

Read `docs/agents/testing.md`. No Qualification Test, load/soak/crash/recovery or exact-production-artifact workload is authorized. Do not inspect or launch qualification harnesses. Use static inspection and tiny disposable tooling fixtures only; no production credentials, network services or databases. Preserve ADR0005's immutable Test-before-Production deployment policy. Do not install new tools to obtain a preferred result. If setup is needed in the isolated checkout, only its reviewed `bun install --frozen-lockfile` is allowed, with no changed resolutions.

Use a `codex/<investigation-slug>` branch if later dispatched as an executor. This planning request authorizes no execution, commit, push, PR or deployment. An investigation finishes with ADOPT, DEFER or REJECT plus evidence and a proposed implementation boundary; ADOPT is a recommendation, not a shipped change.

Commands are fish-compatible and run from the disposable repository root. Inspect `bun --version`, `bun --revision`, `git status --short` before measurements. Keep candidate and baseline runtime/fixture inputs identical. `git diff --check` must exit 0 for the report. No mutating formatter or lint-fix command belongs in the caller checkout. If a later implementation is approved, its gates remain lint:fix → format → lint, `bun run check`, and `bun run test`; all must pass under the accepted new scripts.

## Why investigate

A built-in formatter could remove a tooling package and align with the updated preference. The investigation must prove formatting scope, output acceptability and usable verification behavior without rewriting unrelated code or user changes.

## Current state and conventions

Current package.json scripts are:

```json
{
  "format": "bunx --bun oxfmt \"**/*.{js,jsx,ts,tsx,mjs,cjs}\" \"!docs/**\"",
  "format:check": "bunx --bun oxfmt \"**/*.{js,jsx,ts,tsx,mjs,cjs}\" \"!docs/**\" --check"
}
```

The actual command formats JS/TS/JSX variants with docs excluded. oxfmt is a devDependency; Oxlint and oxlint-tsgolint are separate tools that remain. `bunfig.toml` contains install policy and the Tailwind serve.static plugin, with no fmt section. No formatter config was found during recon; verify hidden/ancestor config discovery rather than assuming none will apply in the executor environment.

Bun 1.4.4 adds built-in formatting, check-only mode, config discovery and --no-script. Its default extension coverage is broader than the current scripts. `bun fmt --help` was inspected during planning. The package has a format script, not a fmt script; retain `bun run format` as the public project entry point if a future migration is adopted. Automatic staging from --staged is not wanted here. User preferences now favor Bun fmt; historical Oxfmt preference is superseded, not a reason to reject the investigation.

## Files and boundaries

Read/compare: `package.json bunfig.toml .oxlintrc.json tsconfig.json .github/workflows/deploy-production.yml`. Lasting writes: `plans/006-bun-fmt-migration-findings.md`, and this status row in `plans/README.md` only. Candidate patches must be shown in the report as proposed changes, not applied to tracked product/tooling files. Preserve domain semantics, existing lint rules, test taxonomy, developer data, deployment identities and artifact lifecycle. Use TypeScript fixtures with `bun:test` only where necessary; no new test framework.

## Ordered investigation

### 1. Capture configuration and the exact baseline file set
Record Bun/Oxfmt versions, all applicable formatter/ignore/config files and the source files selected by the current explicit scripts. Use a TypeScript inventory helper only in the disposable workspace if needed. Record ignored/generated directories and docs exclusion. Do not run a blanket root formatter or touch the caller's dirty docs.

Verify: `bun fmt --help` → native command documented; baseline `bun run format:check` → record exit status. A baseline that fails must be explained before comparing candidates.

### 2. Compare baseline and candidate on identical disposable inputs
Create two owned copies from the same clean execution revision, including exactly the same reviewed file inventory and configuration. Run existing Oxfmt in one and Bun fmt with explicit same extension patterns/docs exclusion in the other; use `--no-script` for native dispatch. Use the installed frozen tools, not latest bunx downloads. Capture byte-identical files, changed files/lines, idempotence and representative differences (TSX, comments, template literals, imports, long signatures). Classify semantic, scope and style differences separately. Do not turn on import/Tailwind/package sorting by default.

Verify: a second formatting pass on each copy has an empty diff; each tool's corresponding check-only pass exits 0. The before/after path inventory has no new docs/CSS/config/Markdown coverage unless separately listed as an optional follow-up, not part of migration.

### 3. Check behavior and small tooling costs
For the candidate copy only, show proposed format/format:check scripts using native Bun with the same scope. Confirm deliberately misformatted disposable input makes check mode exit nonzero without writing it; confirm write mode fixes it and check then exits 0. Assess fresh process startup plus up to three warm command timings on identical inputs; report measurements, not vendor speedup claims. Review whether removing only the direct oxfmt package would actually remove it from the dependency tree; don't change the caller lockfile.

Verify: check-only failure leaves fixture bytes unchanged, write/check/idempotence pass, and a path/hash comparison proves the candidate did not broaden formatting scope.

### 4. Produce a migration decision, not a source rewrite
Report ADOPT/DEFER/REJECT, exact candidate commands/config, output-difference categories, estimated mechanical diff, dependency impact, config compatibility and rollback to the old scripts. Separate a mechanical formatting commit from behavioral changes in any proposed future rollout. Mention any docs/test assertions that name Oxfmt and require updating, without silently editing AGENTS or project policy now.

Verify: `rg -n 'Decision|Inventory|Output differences|Idempotence|Timing|Proposed|Rollback' plans/006-bun-fmt-migration-findings.md` → sections exist. Only report/index files are lasting changes.

## Evidence and test design

Use a fixture corpus spanning TS, TSX, JSX-in-template content, comments/ignore directives and representative long expressions, based on existing source rather than private user documents. Prove check mode does not write and repeated formatting stabilizes. Run candidate ordinary lint/check/Fast Tests in the disposable copy only if proposing adoption; report pre-existing failures separately and preserve test taxonomy. Do not use snapshot updates or blanket formatter rewrites to hide semantic changes.

## Done criteria

- [ ] Baseline/candidate inventory and output-diff counts are recorded with exact versions and commands.
- [ ] Check-mode non-writing behavior, idempotence and same-scope selection are established.
- [ ] Recommendation includes proposed public scripts and an explicit oxfmt dependency/lockfile decision.
- [ ] Broader CSS/docs/config formatting is separate from this migration.
- [ ] The report has an explicit ADOPT/DEFER/REJECT decision, unresolved facts, risks, rollback and a precise implementation file list.
- [ ] Each reported observation identifies the runtime version, command, exit code and input inventory; unperformed checks say NOT RUN.
- [ ] Caller source state is unchanged, and this plan's index row points to the report.
- [ ] `git diff --check` exits 0 for the findings document.

## STOP conditions

- Candidate output changes code semantics, loses comments/ignore directives, touches ignored/generated/data files, or unexpectedly formats docs.
- Bun fmt requires an unavailable plugin or different dependency install to match the existing scope.
- A decision would require silently changing application code, TypeScript settings, test expectations or user-authored dirty files.
- A command needs an unapproved workload, real production state, secrets, new access or an unreviewed dependency change.
- A gate still fails after two reasonable diagnostic attempts; preserve evidence and mark the report BLOCKED rather than weakening assertions or safety settings.

## Maintenance notes

Bun upgrades can change formatting output. Pin/review it like any formatter update and keep mechanical changes separate. If eventually adopted, use the new scripts for mandated post-edit formatting; do not keep two competing formatter gates permanently.

## References

- https://bun.com/blog/bun-v1.4.4#bun-fmt-a-formatter-built-into-bun
- https://bun.com/docs/format
- package.json formatting scripts
