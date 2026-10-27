# Bun check migration findings (007)

## Decision

ADOPT as a recommendation for a separately approved migration, not an implemented migration. The split passed the clean aggregate and all six independent negative fixtures. No application fixes, suppressions, dependency changes or tsconfig changes were needed. Revalidate after integration changes and tool upgrades.

Evidence: 2026-10-28, Darwin arm64, bootstrap fa3dba9df05a9f5b5f0ab36e6421b92955219908, Bun 1.4.4+5d9cc0f4f, Oxlint 1.82.0, oxlint-tsgolint 7.0.2001. Configured environment helper exited 0 with status prepared after frozen installation. Worktree shares the primary Git common directory. Initial source status was clean. Drift from planning base affects only package.json (expected Bun prerequisite); other compared files match.

## Diagnostics

Baseline `bun run lint` exited 0; native `bun check --no-script --no-pretty --threads=2` exited 0, reporting no errors in 324 files (360.91ms). There are no differing baseline diagnostics to account for, including no third-party declaration errors. This does not prove equivalence on every unsupported TypeScript construct. Bun help confirms check-script collision and --no-script; Oxlint help confirms --type-aware and --type-check. Native check emitted no tracked files.

`typeCheck:true` enables compiler diagnostics; `typeAware:true` enables semantic lint rules. They are independent. Effective `--print-config` reports typescript/no-floating-promises as deny. Its fixture fails retained lint while passing the compiler, demonstrating why oxlint-tsgolint remains required.

## Coverage

Unchanged tsconfig covers repository root with strict, noUncheckedIndexedAccess, noImplicitOverride, allowJs, bundler resolution, noEmit, skipLibCheck and @/* aliases; excludes dist/docs/node_modules. Tracked inventory contains 289 TS, 43 TSX and 3 declaration files, including excluded documentation evidence. Native reports 324 files; this count alone does not establish category parity. Compiler fixtures in scripts, TSX React props, and an alias import from src/components/ui/button demonstrate these resolution paths. Application, ordinary tests, scripts, build code and declarations remain within existing project discovery. No JS source is tracked; allowJs remains enabled but JS-specific behavior is NOT RUN. skipLibCheck intentionally remains unchanged; declaration-library internals are not newly validated. Runtime behavior is NOT RUN.

## Fixture matrix

Each fixture is a disposable scripts/probe007.ts (TSX uses .tsx), formatted before the full aggregate. Each is removed before the next. Candidate changes only typeCheck to false, adds explicit --type-aware lint and native typecheck, and inserts typecheck once after lint in check. All rules, denyWarnings, strict config and dependencies are retained. The full aggregate includes runtime pin, testing-policy static check, format check, lint, typecheck, ShellCheck; it executes no application tests. A separate first pass also demonstrated lint-and-typecheck conjunction failure propagation.

| Input | Lint exit | Native exit | Full aggregate exit |
| --- | --- | --- | --- |
| clean | 0 | 0 | 0 |
| assignment | 0 | 1 | 1 |
| property | 0 | 1 | 1 |
| indexed | 0 | 1 | 1 |
| alias | 0 | 1 | 1 |
| tsx | 0 | 1 | 1 |
| type-aware | 1 | 0 | 1 |

Compiler fixture diagnostics: assignment TS2322 (number to string), property TS2339 (missing), indexed TS2322 (string or undefined to string), alias TS2322 (string to boolean disabled prop), TSX TS2322 (string tabIndex to number). Lint-only exits 0 for each; native exits 1 at fixture locations. Promise.resolve(1) triggers typescript/no-floating-promises at 1:1, lint exits 1 and native exits 0. Full aggregate reaches the appropriate failing gate, without recursion. Compiler fixture baseline combined-Oxlint diagnostics were NOT RUN; parity evidence is clean baseline plus candidate separation, not exhaustive diagnostic equivalence.

## Timing

Bounded warm wall-clock measurements include process startup; concurrent worker activity makes small differences inconclusive. No application workload ran. Two paired samples (seconds), at most three:

- Sample 1: combined baseline 1.11; candidate lint plus native 1.104.
- Sample 2: combined baseline 1.21; candidate lint plus native 1.204.

Both gates still analyze types; this migration separates responsibility, not elimination of duplicate semantic analysis. No speed claim is justified.

## Proposed integration

Future files: package.json, .oxlintrc.json and a new reviewed decision appended to docs/research/oxlint-configuration.md; focused command-contract tests only if required. CI already invokes bun run check (deploy-production.yml:85) and should retain that entry point. ADR0005 deployment policy remains unchanged.

Proposed diff (not applied):

```diff
-    "typeCheck": true,
+    "typeCheck": false,
-    "lint": "bunx --bun oxlint --format=agent",
+    "lint": "bunx --bun oxlint --type-aware --format=agent",
-    "lint:fix": "bunx --bun oxlint --format=agent --fix",
+    "lint:fix": "bunx --bun oxlint --type-aware --format=agent --fix",
+    "typecheck": "bun check --no-script",
```

Insert `bun run typecheck` exactly once after lint in aggregate check. Retain typeAware:true, denyWarnings:true, every rule, oxlint-tsgolint and tsconfig verbatim. No --check additions to tests/build/dev. Candidate used --no-pretty --threads=2 for bounded readable evidence; future default threading is a separate performance choice.

## Rollback

Restore the current scripts and typeCheck:true together. Retain semantic lint engine and existing strict options throughout. Principal unresolved limit: finite fixture evidence cannot certify complete checker parity; repeat matrix after Bun/Oxlint upgrades and review any real-source diagnostic differences without suppression.

## Checks and retained evidence

Clean baseline and candidate aggregate PASS; six negative gate-separation and full aggregate cases PASS. Help/config inspection PASS. Native no-emission/source restoration PASS. Tooling timings completed twice. Qualification, focused integration, application tests/build, deployment and production access NOT RUN. No qualification harness inspected. Only this report persists; coordinator owns plans/README.md status row. Candidate source/config changes restored before commit. `git diff --check` must pass for delivery. No lasting tooling migration.
