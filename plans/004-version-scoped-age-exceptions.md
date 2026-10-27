# Plan 004: Document narrow security-update age exceptions

> Follow the ordered steps and their verification gates. STOP on a listed escape condition rather than expanding scope. Update only this plan's status row in `plans/README.md` when complete.
>
> Drift check: `git diff --stat 864754c0927ed041966eeed4ca64e71439d87996..HEAD -- bunfig.toml docs/agents/dependency-maintenance.md`. Compare the excerpts below with the execution checkout before editing. Known prerequisite changes described below are expected; unexplained changes in the affected logic require revalidation.

## Status

- Priority: P2
- Effort: S (hours)
- Risk: LOW
- Category: dx / security
- Depends on: none
- Planned at: `864754c0927ed041966eeed4ca64e71439d87996`, 2026-10-28
- Mode: Implementation handoff only: this document does not itself authorize executing the work.

## Execution baseline and non-negotiable boundaries

Repository: `/Users/jannis/Documents/workspace/php js/quadball-timer`. The planning checkout is a dirty feature branch whose package.json still pins Bun 1.4.2. Do not reset, stash, switch, install into, or format that caller checkout. Preserve its pre-existing documentation/workflow edits and untracked GLOSSARY.md. Start execution in a separate clean checkout including merged security PR #368, main commit `0f6659b23ddd679a52e97b328849a647650584fa`, or a descendant. That prerequisite pins packageManager, direct dev Bun executable and @types/bun to 1.4.4 and adds an embedded/builder version guard. Do not redo or downgrade it. Check the actual executable selected inside scripts as well as the shell runtime.

The user's 2026-10-28 instructions supersede older preferences: prefer Bun check for TypeScript checking, Bun fmt for formatting, and Oxlint with type-aware linting. Existing scripts remain the verification baseline until a separate migration is accepted; preference alone does not prove output or diagnostic parity.

Read `docs/agents/testing.md` before work. Ordinary checks/tests remain on the Fast Test boundary. No Qualification Test, soak, load, crash, recovery or exact-production-artifact workload is authorized by this plan; do not inspect or run qualification harnesses. No real server, credentials, production data, deployment, service restart, GitHub write, commit, push or merge is in scope. ADR `docs/adr/0005-post-sqm-automatic-deployment.md` requires one immutable release bundle through Test then Production; preserve that policy. Never put secret values in diagnostics or reports.

## Why this matters

Make emergency fixes possible without removing the supply-chain waiting period for unrelated releases. Record an exact-version procedure at the owning maintenance document rather than relying on chat history.

## Current state and conventions

`bunfig.toml:1-2` currently contains:

```toml
[install]
minimumReleaseAge = 604800
```

`docs/agents/dependency-maintenance.md:1-7` repeats that literal and requires aligned runtime/type/transitive Bun versions, reviewed package/lock changes and frozen setup/CI installs. Later sections require exact old/new package diffs and keep deduplication out of ordinary CI. Preserve those rules. The recently merged security prerequisite also directly pins the script Bun executable because bun-plugin-tailwind's Bun peer can select an older runtime.

Bun 1.4.4 accepts human-readable durations and command-scoped `name@version` age exclusions. The completed security update needed a fresh release younger than seven days; broad package exclusions or age=0 unnecessarily weaken unrelated resolutions.

Follow nearby TypeScript named exports, explicit types and `bun:test` tests. Keep domain terms such as Controller, Grant Session and Game Clock; do not change authority or replay semantics. New helper tests should exercise the callable integrated into the server rather than duplicate its implementation.

## Scope

In-scope future changes:
- `bunfig.toml`
- `docs/agents/dependency-maintenance.md`
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

Use a separate `codex/version-scoped-age-exceptions` branch/checkout. Keep this change independent from other plans and unrelated work. No commit, push, PR or deployment is authorized by the planning request. If execution is separately authorized, report the diff and verification evidence for review; follow any later explicit delivery instructions. A future main push can trigger both deployments automatically.

## Ordered steps

### 1. Recheck the installed command syntax
Read the official pinned-version release note and `bun install --help`; verify exact-version exclusions are supported before documenting them. This plan is documentation/configuration only and must not perform an update or network resolution experiment.

Verify: `bun --version` → at least 1.4.4; `bun install --help` → includes minimum-release-age and minimum-release-age-excludes.

### 2. Preserve the default and specify a reviewed emergency path
Change only the equivalent default literal to `minimumReleaseAge = "7d"`, updating the matching sentence in the maintenance document. Add an emergency section requiring official advisory evidence, exact reviewed package versions and complete aligned Bun package-family enumeration, including every affected optional platform package actually resolved. Explain that each package/version exemption must be explicit; do not assume wildcard matching or a top-level bun exemption covers children.

Show fish-compatible literal example syntax such as `bun install --minimum-release-age-excludes '@types/bun@1.4.4,bun-types@1.4.4'`, clearly marked as a types-only example, not a complete runtime update. For a full Bun update require an inspected explicit list covering direct Bun and selected platform dependencies; never copy an incomplete list as an acceptance command. Do not save any exclusions in bunfig.toml. Do not use global age=0 or permanent package-wide exemptions.

Verify: `rg -n 'minimumReleaseAge|minimum-release-age-excludes|emergency' bunfig.toml docs/agents/dependency-maintenance.md` → equivalent default plus exact-version guidance present.

### 3. Retain maintenance and verification obligations
Require package.json/bun.lock diff review, exact runtime/types/direct executable alignment, frozen install without exceptions after updating, and the existing ordinary check/test/build commands after a real dependency change. Keep deduplication policy unchanged. Document that updating a host Bun alone does not update compiled releases. If writing agent-facing instructions, use the writing-for-agents skill when available, without expanding scope.

Verify: `git diff -- bunfig.toml docs/agents/dependency-maintenance.md` → only equivalent age literal and the scoped procedure; `git diff --name-only -- package.json bun.lock` → empty for this plan.

### 4. Check without installing packages
Run `bun run check` in the prepared isolated checkout and `git diff --check`. No new tests are warranted for a documentation change or the equivalent seven-day literal.

Verify: both exit 0; neither package.json nor bun.lock changed.

## Test and evidence plan

Do not run dependency resolution simply to prove the documentation example. Inspect syntax using help and official documentation, and inspect the patch for exact-version scoping. A future real security update must produce its own resolution review and frozen-install evidence. No new mirror-the-config test is requested.

## Done criteria

- [ ] Seven-day default is unchanged semantically; no persisted age exceptions exist.
- [ ] Emergency guidance uses exact versions and accounts explicitly for transitive/platform packages.
- [ ] Existing package review, frozen install and dedupe obligations remain.
- [ ] `bun run check` and `git diff --check` exit 0; package.json/bun.lock are untouched.
- [ ] The final changed-path list is within Scope, relative to the recorded execution baseline.
- [ ] This plan's row in `plans/README.md` records DONE, BLOCKED or REJECTED and a brief evidence reference; an investigation's DONE means the decision report is complete, not that migration shipped.

## STOP conditions

- Exact-version exclusion syntax is unsupported in the execution runtime.
- The procedure appears to need wildcard exceptions, a global bypass, new trusted scripts or a dependency update to work.
- Changing the literal causes a verified policy reader to fail; retain the numeric equivalent and report the reader instead of broadening scope.
- A reasonable correction still leaves a verification gate failing a second time; retain the failure rather than weakening an assertion, policy or type setting.
- Required work escapes Scope or would affect real state, secrets or production. Explain the missing capability instead of improvising.

## Maintenance and review notes

Age exceptions are exceptional review decisions, not a standing allowlist. Re-check aligned platform packages at each update; never assume the current family enumeration remains complete.

## References

- https://bun.com/blog/bun-v1.4.4#minimumreleaseage-supports-units-and-per-version-exclusions
- docs/agents/dependency-maintenance.md
