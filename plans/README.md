# Bun 1.4.3/1.4.4 adoption plans

Created with the improve skill on 2026-10-28. These are handoffs, not executed changes. Read each plan fully, preserve its boundaries, and update its row with evidence after separate execution authorization. No issue publishing was requested.

## Source and execution baseline

Planning source: `864754c0927ed041966eeed4ca64e71439d87996` in `/Users/jannis/Documents/workspace/php js/quadball-timer`. This is an older dirty feature checkout, not current deployed main. Its existing workflow/docs edits, deleted CONTEXT.md and untracked GLOSSARY.md were preserved. Only this plans directory was added.

Execution prerequisite for every plan: a clean separate checkout including merged security PR #368, main commit `0f6659b23ddd679a52e97b328849a647650584fa`, or a descendant, with aligned Bun runtime/direct executable/types/platform packages at least 1.4.4. Do not implement against the caller's old 1.4.2 pin or reset its work. Compare each stamped excerpt with the execution checkout and revalidate unexpected drift.

Updated user preferences: Bun check for compiler checking, Bun fmt for formatting, type-aware Oxlint for linting. Existing Oxfmt/combined Oxlint scripts remain the baseline until investigations establish an acceptable migration. In particular, `bun check --no-script` is necessary to invoke the native checker when the project has a check script.

## Execution order and status

| Plan | Type | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|---|
| [001](001-websocket-failure-boundary.md) | Implementation | WebSocket failure boundary | P1 | S | Security prerequisite | DONE — `1707dea`; targeted 23 and full 1227 Fast Tests passed in worker; integration boundary smoke 6 passed |
| [002](002-native-websocket-payload-budget.md) | Implementation | Native incoming payload budget | P1 | S | 001; overlapping server edits | DONE — `ecbfc14`; targeted 37, native/check/quality gates and full 1227 Fast Tests passed; integration parser/failure smoke 33 passed |
| [003](003-metafile-entrypoint.md) | Implementation | Direct metafile source entry points | P2 | S | Security prerequisite | DONE — `28d9593`; TDD red/green and integration smoke 3 tests/13 assertions, native/check/quality gates and full 1221 Fast Tests passed |
| [004](004-version-scoped-age-exceptions.md) | Implementation | Exact-version security age exceptions | P2 | S | Security prerequisite | DONE — `16922cf`; native check (324 files), quality gates and full 1221 Fast Tests passed; integration TOML/diff smoke passed; no manifest or lock changes |
| [005](005-strict-code-generation.md) | Investigation | Compiled-only strict code generation | P2 | M | Security prerequisite | DONE — [findings](005-strict-code-generation-findings.md), DEFER; static flags/types/mode/dependency review, runtime compatibility unresolved; no product adoption or artifact workload |
| [006](006-bun-fmt-migration.md) | Investigation | Oxfmt to Bun fmt | P2 | M | Security prerequisite | DONE — [findings](006-bun-fmt-migration-findings.md), ADOPT recommendation; 327-file byte parity, explicit flavor/scope/idempotence evidence, candidate check and 1221 Fast Tests passed; no migration shipped |
| [007](007-bun-check-migration.md) | Investigation | Oxlint compiler checking to Bun check | P2 | M | Security prerequisite | DONE — [findings](007-bun-check-migration-findings.md), ADOPT recommendation; six negative fixtures and clean baseline/candidate checks; no migration shipped |

Status values: TODO, IN PROGRESS, DONE, BLOCKED (reason), REJECTED (reason). Investigations produce `plans/NNN-<slug>-findings.md` with ADOPT/DEFER/REJECT; DONE does not imply a migration shipped.

## Dependencies and coordination

- Run 001 before 002 to avoid conflicts in src/index.ts and align close/error behavior. Neither changes replay acceptance or durable authority.
- 003 and 004 are independent. 004 may use the writing-for-agents skill for the future maintenance-doc edit.
- 005, 006 and 007 can be investigated independently in separate disposable copies. Revalidate 005's server compatibility inventory after 001/002. Rebase any later implementation before comparing final diagnostics/output.
- Keep eventual formatting churn separate from semantic changes. Keep compiler migration separate from formatter migration so each can be measured and rolled back.
- Ordinary checks and Fast Tests only. No automatic or ad hoc qualification workload; exact-production-artifact testing remains explicitly gated by docs/agents/testing.md.
- ADR0005's one-bundle Test-before-Production policy is unchanged. No deployment, commit, push, merge or issue creation is authorized by this planning step.

## Recon and verification contract

TypeScript/React full-stack Bun application; native Bun.serve WebSockets and bun:sqlite; compiled Linux x64 production executable behind Caddy. Repository commands include `bun run check`, `bun run test`, `bun run build`, and `bun run build:executable`. Code edits require `bun run lint:fix`, `bun run format`, then a passing `bun run lint`. Investigation commands and proposed native tool gates are distinguished explicitly in each plan. No tests, formatter runs, builds or migrations were executed while writing these plans; CLI help was inspected only.

## Findings considered and rejected or deferred

- A bare new websocket.error callback is insufficient: async message rejection needs its own catch boundary.
- Native maxPayloadLength is not new in 1.4.4; this is adjacent hardening enabled by corrected behavior. It does not replace the parser or output budget.
- SQLite hooks cannot replace commit-aware revisions/audit events. No UDF or Bun.SQL migration is justified by the release's unrelated query benchmarks.
- FetchSession, socket pause/resume and dependency cache-prefetch add lifecycle/configuration work without a demonstrated current bottleneck.
- Existing ESM/bytecode builds already receive automatic startup improvements. Profile/JIT tuning has no measured need here.
- ModuleGraph is experimental and not a security sandbox; do not replace process supervision or no-orphans cleanup.
- Blanket duplicate compiler gates are rejected. This does not reject the user's selected investigation into replacing Oxlint's compiler diagnostics while retaining type-aware linting.
- A prior blanket rejection of Bun fmt based on old preference is superseded. Plan 006 evaluates the user's new preference with output/scope evidence instead.
- Do not add CSS/docs/config formatting merely because Bun fmt supports it; that is separate scope.
