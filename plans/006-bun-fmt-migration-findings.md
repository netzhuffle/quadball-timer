# Bun fmt migration findings (006)

## Decision

**ADOPT as a separate future migration**, subject to repeating affected checks after integration changes. This investigation ships no migration. On the pinned source inventory, native Bun 1.4.4 and installed Oxfmt 0.67.0 produce byte-identical output. The important migration detail is explicit `--flavor=oxfmt`: without configuration, Bun detects the existing `oxfmt` dependency to select Oxfmt defaults; removing that dependency otherwise changes the defaults. The candidate below preserves them without adding a second configuration file.

Bun's [official migration guide](https://bun.com/guides/format/migrate-from-oxfmt) documents that dependency-based detection, compatibility with Oxfmt 0.72 rather than every historical release, and the absence of an LSP. The [formatter reference](https://bun.com/docs/format) documents native dispatch, check-only behavior, discovery and broader default language coverage. These are reasons to pin/review Bun upgrades and retain explicit scope. No historical preference against Bun informs this recommendation.

## Inventory and environment

Execution date: 2026-10-28, Darwin arm64. Source: `fa3dba9df05a9f5b5f0ab36e6421b92955219908`, branch `codex/bun-worker-006`, isolated worktree `worktrees/worker006` under the run directory. Its Git common directory resolved to the primary repository's `.git`. Configured setup helper exited 0 and reported `status: prepared`; its frozen install installed the existing resolutions. Initial source status was clean. The caller checkout was neither formatted nor edited.

Exact versions: `bun --version` = `1.4.4`; `bun --revision` = `1.4.4+5d9cc0f4f`; installed `node_modules/.bin/oxfmt --version` = `0.67.0`. Bun resolved to `/opt/homebrew/bin/bun`. No latest-package downloads or additional tool installs occurred.

The drift command from plan 006 exited 0 and showed only the expected prerequisite `package.json` change (3 insertions, 2 deletions); Bun pin/type alignment is 1.4.4. The reviewed `bunfig.toml` has install and serve settings, no `[fmt]`. Tracked discovery found `.gitignore` and `bunfig.toml`, no Oxfmt, Prettier or EditorConfig files. A filename-only ancestor search to filesystem root found only this worktree's `bunfig.toml`. `bun fmt --no-script --find-config-path=src/index.ts` exited 1 with “Can not find configure file”; `--doctor --format=json` exited 0, reported Oxfmt defaults, no config/nested config/editorconfig, 327 native files, no plugins or unsupported options. No secret/configuration data outside the specified tooling files was read.

The source inventory is the 327 tracked paths with extensions `.js,.jsx,.ts,.tsx,.mjs,.cjs` outside `docs/`. It includes TS, declaration TS, TSX and the existing source/comment/template/import/long-signature corpus. `bun fmt --no-script --list-files "**/*.{js,jsx,ts,tsx,mjs,cjs}" "!docs/**"` exited 0 and its sorted output equals that inventory exactly. Baseline `bun run format:check` exited 0 and reported exactly 327 files. No `.mts`/`.cts`, CSS, JSON, TOML or Markdown expansion is proposed.

`.gitignore` excludes `node_modules`, `out`, `dist`, coverage, logs, cache, local development state and environment files. Disposable copies contained only the same 327 inventory paths and the same `package.json`, `bunfig.toml`, `.gitignore`; no developer data or environment files were copied. This establishes the selected committed source set, not a promise to format arbitrary future untracked files. Existing explicit patterns plus ignore rules remain the future selection contract.

## Output differences and commands

All formatter writes ran in owned disposable copies, except the candidate public check command, which is non-writing. Commands shown here are fish-compatible and run from the relevant copy. `OXFMT` below denotes the already installed absolute `node_modules/.bin/oxfmt` path, not a downloaded tool.

```text
OXFMT "**/*.{js,jsx,ts,tsx,mjs,cjs}" "!docs/**"
bun fmt --no-script "**/*.{js,jsx,ts,tsx,mjs,cjs}" "!docs/**"
```

Each ran once, then again for idempotence, then with `--check`. All six exits were 0. Of 327 files, 327 were byte-identical between outputs; changed files = 0; changed lines = 0; baseline rewrite size = 0. No semantic, scope or style differences were observed. This is measured parity on this inventory, not universal compatibility with Oxfmt 0.67.0.

A second candidate experiment deleted only `devDependencies.oxfmt` from the disposable package and used `--flavor=oxfmt` in the native command. Write, second write and check exited 0, with zero changed inventory paths. That copy also contained one clearly identified synthetic `fixture.ts` (328 selected files total). Package/config/ignore controls and added `docs/excluded.ts`, `excluded.css`, `excluded.md` retained identical bytes after the scoped write; a separate explicit-flavor sentinel pass also preserved `out/generated.ts`, `dist/generated.ts`, `node_modules/generated.ts`, `.local/generated.ts` (exit 0, zero sentinel changes); no broader docs/CSS/config/Markdown formatting occurred.

A separate synthetic TSX fixture covered import specifiers, ordinary comments, `oxfmt-ignore`, `prettier-ignore`, JSX attributes/children, an HTML tagged template and a long typed signature. Installed Oxfmt and native Bun with explicit flavor each exited 0; `cmp` exited 0 on the results. Both ignore directives and the ordinary comment survived; imports and Tailwind-like classes were not sorted. No import/Tailwind/package sorting option was enabled. There were no representative differences to reproduce.

## Idempotence and check-only behavior

For both original 327-file copies, all first/second-pass content hashes were equal. Their check-only passes exited 0. The explicit-flavor candidate also stabilized and passed its check. Native `--debug-check` over the 327 original paths exited 0; this is an additional formatter semantic check, not application correctness proof.

On deliberately malformed formatting in disposable `fixture.ts`, `bun fmt --no-script fixture.ts --check` exited 1 and the entire file remained byte-identical. Write mode exited 0 and changed the formatting, subsequent check exited 0, and another write exited 0. Repeating this proof after dependency removal with `--flavor=oxfmt` produced exits 1/0/0/0; check-bad left bytes unchanged, check-good and second write preserved the corrected bytes (`scope.log`). The `prettier-ignore` statement remained unchanged. Commands used Bun 1.4.4; no check-only command was used as a substitute for a writing mode. The [official reference](https://bun.com/docs/format) specifies exit 1 for formatting needed, 0 for clean output and 2 for errors.

## Timing

Bounded tooling measurements only: three fresh process invocations per tool on identical 327-file inputs (write, second write, check). Elapsed milliseconds include process startup, measured with `performance.now()` around synchronous spawn. First invocation: Oxfmt 182.08, Bun 29.51; warm second invocation: Oxfmt 158.73, Bun 25.94; warm check: Oxfmt 263.40, Bun 25.89. Each exited 0. These are one local observation per phase, with uncontrolled shared-machine scheduling/cache effects, not a benchmark or vendor speedup claim. No application workload, load generator, production artifact or Qualification Test ran. Later correctness fixture runs were not additional timing samples.

## Proposed implementation boundary and dependency impact

Keep the public entry points `bun run format` and `bun run format:check`. Proposed `package.json` values:

```json
{
  "format": "bun fmt --no-script --flavor=oxfmt \"**/*.{js,jsx,ts,tsx,mjs,cjs}\" \"!docs/**\"",
  "format:check": "bun fmt --no-script --flavor=oxfmt \"**/*.{js,jsx,ts,tsx,mjs,cjs}\" \"!docs/**\" --check"
}
```

`--no-script` makes native dispatch explicit even if a future `fmt` script appears. `--flavor=oxfmt` makes removal of the direct dependency independent of auto-detection. Alternative: add an empty `.oxfmtrc.json` as the official guide suggests; explicit flavor avoids an otherwise unnecessary extra file. Do not add `[fmt]` sorting defaults or broaden the extension list in this migration.

Remove only direct `oxfmt`; retain Oxlint, type-aware rules and `oxlint-tsgolint`. Static `bun.lock` inspection finds no other inbound reference to `oxfmt`, its 19 platform bindings, or its `tinypool` dependency. The expected lock cleanup removes those entries; this is a graph inspection, **not a regenerated-lockfile measurement**. Frozen installed tools stayed available for the comparison. Regenerate/review the lockfile in the eventual migration, confirm no unrelated resolution changes, and prove a fresh frozen install. Editors requiring the Oxfmt LSP need a separate maintainer decision; repository scripts do not establish editor usage.

Precise future file list: `package.json` (two scripts and one dependency), `bun.lock` (only orphan cleanup), this report if recording adoption. No application/config/source rewrite is expected from the current inventory. Existing historical Oxfmt mentions in `docs/research/sqm-2026-dependency-platform-upgrade-scope.md`, `docs/research/sqm-2026-safe-platform-baseline-refresh.md`, `docs/research/oxlint-configuration.md` describe past evidence and need no retroactive rewriting. Repository search found no active tests or agent policy asserting the formatter's package name. Keep any mechanical changes after rebasing in a separate commit from behavioral work. Preserve ADR0005 and existing deployment gates.

## Validation and limits

Candidate ordinary quality results are recorded below. They temporarily change only the owned worktree's package scripts/dependency; installed frozen tools remain unchanged. No changed lockfile is claimed. All candidate package edits are restored before the report commit. Candidate package edits were restored with `git restore -- package.json`; tracked product/tooling diff is empty. The findings report alone is retained; the coordinator owns `plans/README.md` bookkeeping.

- Candidate `bun run check`: **PASS, exit 0**, including pinned-version policy, testing-policy dry run, native format check on 327 files, type-aware Oxlint and ShellCheck. Log: `evidence006/candidate-check.log`.
- Candidate `bun run test` (ordinary Fast Tests only): **PASS, exit 0**, 1,221 tests across 108 files, 24,442 assertions, 0 failures, 31.27 seconds. Shared lane reserved; original timeout/parallelism preserved. Log: `evidence006/candidate-test.log`.
- Qualification, focused integration, build/deploy and exact-production-artifact checks: **NOT RUN**, outside this investigation.
- Fresh install after removal / lock regeneration: **NOT RUN**, proposed implementation work.

No unresolved output or scope mismatch was found. Remaining limits are platform-specific comparison, editor LSP usage, future Bun output drift, fresh dependency cleanup and repeating affected checks after concurrent source changes. Broader CSS/docs/config formatting is a separate optional project, not part of adoption.

## Rollback and retained evidence

Rollback an eventual migration by restoring the previous two scripts, direct Oxfmt requirement and its prior lockfile in one reviewed commit, followed by the existing ordinary gates. No application state or database migration is involved.

Evidence lives under `/tmp/parallel-work/01a17f65-39e5-7420-9904-625911fbfabf/evidence006/`: `inventory.txt`, `bun-inventory.txt`, `candidate-list.txt`, `result.json`, `final-result.json`, individual formatter logs, TS helpers, paired disposable source copies and the synthetic TSX fixture. `format006-baseline.log` is in the run directory. The helpers record exact commands, exit codes and hashes; no dependency binaries or source edits are transferred to the caller. Worktree source status before candidate edits was empty; final report-only status and staged `git diff --check` exit 0 were verified before commit.
