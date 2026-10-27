# Strict compiled code-generation investigation

## Decision

**DEFER production adoption.** Bun exposes the proposed API and documents the desired restriction, but static inspection cannot establish compatibility of this application's embedded modules, dependency initialization, or maintenance modes. No product change is adopted. No application executable, server, storage mode, Qualification Test, or qualification harness was run or inspected.

Investigation date: 2026-10-28. Baseline: `fa3dba9df05a9f5b5f0ab36e6421b92955219908`, including the Bun 1.4.4 prerequisite. Native tooling: Darwin arm64, Bun `1.4.4`, revision `1.4.4+5d9cc0f4f`. This is a static review, not a runtime compatibility proof.

## Flag and type support

Installed `node_modules/bun-types/bun.d.ts:3737-3739` declares `CompileBuildOptions.execArgv?: string[]`. Official [executable documentation](https://bun.com/docs/bundler/executables#embedding-runtime-arguments) agrees: `compile.execArgv` embeds a string array; CLI equivalent is `--compile-exec-argv`. The same page says compiled programs read `BUN_OPTIONS`. Both local help commands exit zero but omit the disallow flag, so help is not independent confirmation of its spelling.

The [Bun 1.4.3 announcement](https://bun.com/blog/bun-v1.4.3#disallow-code-generation-from-strings-blocks-eval-and-new-function) documents `--disallow-code-generation-from-strings=strict`, process/Worker coverage, eval/Function restrictions and strict coverage of vm, string Workers, module compilation, native script evaluation and inspector execution. It explicitly says an embedded restriction cannot be lowered by `BUN_OPTIONS` (only raised). This environmental precedence is documentation evidence; it was NOT RUN locally.

The [Bun 1.4.4 announcement](https://bun.com/blog/bun-v1.4.4#disallow-code-generation-from-stringsstrict-only-runs-code-that-ships-with-your-program) broadens strict enforcement to code provenance: compiled programs permit built-ins and embedded program code, reject disk JS/TS, source-producing plugins and macros, and reject environment preloads and disk text/Markdown imports. Disk JSON/TOML/YAML and JSON data URLs remain usable. Development source programs retain disk code loading. These are upstream claims, not application acceptance results.

This is defense in depth, not a sandbox: it does not establish protection against native memory corruption, restrict ordinary file/database access, or replace deployment isolation and configuration validation.

## Mode inventory

All application mode statuses below are **static; runtime compatibility unknown**. `src/index.ts:156-209` parses invocations before dispatch, and its static imports (including monitoring) initialize before even the identity early return. A simple early return therefore does not prove dependency compatibility.

| Mode and source | Caller/evidence | Compatibility risk |
| --- | --- | --- |
| Default server, `src/index.ts:209` / `startServer` | No selected maintenance mode; compiled release or development launcher | Bun server, HTML/browser assets, SQLite and monitoring dependencies; full startup and lazy behavior unproved |
| `--release-runtime-identity`, `src/index.ts:161` | `scripts/create-release-bundle.ts:67,77` queries compiled or source identity | Early return still requires module initialization; bundle creation depends on success |
| `--emit-test-monitoring-error`, `src/index.ts:166` | `package.json` `monitoring:test` | Conditional Sentry transport and initialization; no DSN or network exercised |
| `--technical-admin-bootstrap`, `src/index.ts:171-178` | `deploy/technical-admin-bootstrap-root.sh:140`; `scripts/dev.ts:57` | Status/enroll/reset custody and authentication/storage paths need separate compatibility evidence |
| `--production-activation`, `src/index.ts:181-184` | `deploy/activation-maintenance-root.sh:472,494` | Activation maintenance/storage and subprocess boundaries; no operational invocation authorized |
| `--grant-key-ring`, `src/index.ts:187-196` | `scripts/grant-key-ring.ts` is separate source launcher; parser shared with executable | create/convert/verify/rotate/remove-legacy file handling; no real key material inspected |
| Probe dispatch, `src/index.ts:197-207` | Existing imported parser/dispatch references only | Restricted boundary: implementation/harness intentionally not inspected; runtime NOT RUN |
| Event catalog/admin tooling | `package.json` `event:catalog`, `event:admin` point to separate `scripts/` entrypoints | Not additional executable early-dispatch modes; leave development tooling unrestricted |
| Browser routes | `src/App.tsx` build-known lazy routes described by plan; HTML import at `src/index.ts:5` | Browser code is a separate execution environment; browser lazy loading does not itself prove server disk-code loading |

`src/lib/monitoring-server.ts` imports `@sentry/bun` statically and initializes only with a nonempty supplied DSN. It sets `defaultIntegrations: false`, disables tracing and handles initialization/capture failures by disabling or ignoring monitoring. This makes silent loss of monitoring a specific acceptance risk: lack of a startup crash would not prove compatibility. GlitchTip configuration uses the Sentry-compatible integration; no private configuration was opened.

## Dependency inventory and uncertainty

Static server entry dependencies include Bun serving, Node crypto/path, SQLite-backed foundation/auth/ad-hoc storage, release identity, activation/grant/bootstrap modules, and Sentry. Browser React/Radix/lucide/qrcode packages and build-only `bun-plugin-tailwind` must be distinguished from server execution; a package manifest is not an emitted reachability graph. The installed `@sentry/bun` and `@sentry/core` ESM source scan found no matches for the searched code-generation/Worker/import patterns. This is a narrow text scan, not proof of their entire transitive graph, native paths, alternate exports or initialization behavior.

A production-library scan excluded test/focused files and `sqlite-foundation-probe*`. Its `import(...)` matches were TypeScript type positions; the inspected entry/maintenance/monitoring files showed no direct runtime eval/Function/vm/Worker requirement. Computed loading, native dependency behavior and bundler transformations remain unresolved. No emitted application artifact or full dependency reachability graph was generated.

## Compatibility matrix

| Boundary | Expected/property sought | Result |
| --- | --- | --- |
| Compile API and exact spelling | Installed type and official documentation agree | Verified statically |
| Embedded normal code; eval/Function rejection | Tiny disposable fixture could distinguish baseline/strict behavior | NOT RUN |
| Disk JS/TS rejection; disk JSON allowed | Tiny fixture could check provenance/data distinction | NOT RUN |
| BUN_OPTIONS cannot lower embedded restriction | Documentation claim | NOT RUN locally |
| Embedded lazy modules, Workers, bytecode/ESM splitting | Application compatibility | NOT RUN; unresolved |
| Every application mode, enabled/disabled monitoring | No broken mode or silent monitoring degradation | NOT RUN; unresolved |
| Exact application artifact / storage acceptance | Separate explicit authorization and testing-policy admission | NOT RUN; deferred |

No fixture was created: a toy result would not resolve the application compatibility blocker, so the investigation retains the static boundary. A future permitted tiny fixture would be a disposable Focused Integration Test under `docs/agents/testing.md`: fixed tiny TypeScript inputs, no app imports, no network, credentials, database or durable state; compile/run each under a hard deadline with owned-child cleanup and remove the executable/data on every outcome. **No fixture command or deadline was executed or asserted here.** No retained fixture executable/data exists.

## Proposed implementation boundary

Future implementation files: `build.ts` and a meaningful Fast Test at the compile-option configuration seam (location to be selected with that implementation). No global `BUN_OPTIONS`, development launcher, dependency, storage, monitoring-error suppression or deployment lifecycle change is proposed. Preserve ADR0005 immutable Test-before-Production acceptance.

Proposed diff inside the existing compile object, **not applied**:

```diff
         compile: {
           ...compileConfig,
           target: executableTarget,
           outfile: outputPath,
           autoloadDotenv: false,
           autoloadBunfig: false,
+          execArgv: [
+            ...(compileConfig.execArgv ?? []),
+            "--disallow-code-generation-from-strings=strict",
+          ],
         },
```

The existing `compile` property is destructured out before `...buildConfigOverrides` (`build.ts:135-142`), so that later spread cannot currently replace this compile object through a parsed `compile` field. Positioning `execArgv` after `...compileConfig` retains supplied arguments and enforces the strict argument after them. Future Fast Tests must cover this precedence and the unchanged noncompiled branch; malformed override types remain an implementation concern. Do not silently discard required runtime arguments. If precedence cannot be secured without widening the build interface, stop and reassess.

Before adoption: independently authorize and design appropriate acceptance for each mode and conditional monitoring path, including emitted embedded modules and native/runtime dependencies. Reconcile overlapping accepted changes first. Any exact-artifact workload remains subject to the explicit qualification gate; none is registered or run by this report.

## Rollback

If later adopted and rejected during authorized acceptance, remove only the embedded argument and rebuild through the existing immutable release process. Do not downgrade Bun, reuse a changed release artifact, weaken monitoring handling, or change data/configuration loading to accommodate the restriction.

## Checks and provenance

All local commands below used the owned worker005 checkout; no caller source mutation. Read-only shell invocations also print an incidental sandbox denial from `.zprofile` attempting Homebrew; listed command results are the actual tool exit codes. No new tools or resolutions installed.

| Command/check and input | Runtime / exit / observation |
| --- | --- |
| `git rev-parse HEAD --git-common-dir` | Git exit 0; assigned bootstrap and shared primary `.git` verified |
| Required configured preparation helper | Bun 1.4.4; initial exit 1 cache permission error, escalated retry exit 1 postinstall stub; authorized alias repair retry exit 1 because frozen install restored aliases |
| Authorized ignored native-bin materialization, then unchanged preparation helper | Copied installed optional arm64 binary into fresh local temp files and atomically replaced only `node_modules/bun/bin/bun.exe` and `bunx.exe`; no source/cache/trust/manifest/lock edits. Helper exit 0, `status: prepared`; prepared development state in ignored `.local/dev` |
| `bun --version`; `bun --revision`; `uname -sm` | Each exit 0: 1.4.4; 1.4.4+5d9cc0f4f; Darwin arm64 |
| `git status --short` before investigation | Exit 0, empty tracked/untracked status |
| `git diff --stat 864754c0927ed041966eeed4ca64e71439d87996..HEAD -- build.ts src/index.ts src/lib/monitoring-server.ts scripts/create-release-bundle.ts` | Exit 0; only six prerequisite lines in bundle builder; expected Bun guard drift, no other inspected-file drift |
| `rg -n 'process.argv\|execArgv\|autoload' build.ts src/index.ts scripts/create-release-bundle.ts` | Exit 0; dispatch/autoload sites reconciled above |
| `rg -n 'execArgv\|disallow-code' node_modules/bun-types/bun.d.ts` | Exit 0; declaration at 3739 |
| `bun --help`; `bun run --help` | Each exit 0; neither help text lists disallow flag |
| `rg -n 'eval\(\|new Function\|node:vm\|new Worker\|import\('` over inspected app files and production libraries (test/focused/probe files excluded) | App/library scan exit 0 from type-import matches; no runtime match identified, not exhaustive reachability proof |
| Same pattern scan over installed Sentry bun/core ESM `*.js` | Exit 1 (no matches), not a runtime guarantee |
| Grant CLI operation/source and deployment caller searches | Exit 0; inventory above |
| Official release/executable pages | Web retrieval successful on investigation date; primary sources linked above; no shell exit code applies |
| Fixture, full lint/check/test, exact executable, qualification | NOT RUN: report-only work, no product code changed |

Only lasting write is this report. The coordinator owns the `plans/README.md` status row and must link this report with DEFER during integration; worker instructions prohibit editing that shared index. Final report whitespace/name-only checks are recorded in the completion handoff. Retain this report, clean worktree/branch and ignored prepared dependencies until integration is confirmed.
