# SQM 2026 dependency and platform upgrade scope

## Question and deadline

Which runtime, frontend, UI, test, formatter, linter, GitHub Actions, and transitive dependency upgrades should Quadball Timer complete before SQM on 16 August 2026, and which changes should wait until after the accepted feature freeze on 2 August 2026?

Research was performed on 12 July 2026 against the repository, the npm registry, official project release notes, and GitHub's advisory database. Version claims below are snapshots as of that date.

## Recommendation

Complete one dependency-refresh sequence now, while there are three weeks before feature freeze, then stop routine dependency movement on 2 August. The sequence should be:

1. **Security and runtime first:** regenerate `bun.lock` so `ws` resolves to 8.21.0, then move the Bun runtime, `@types/bun`, and the lockfile's Bun package to 1.3.14 together.
2. **Current direct releases:** update the existing frontend, UI, test-DOM, Tailwind, and Oxc packages listed below. Keep this as dependency maintenance, not a UI redesign.
3. **Low-risk Actions maintenance:** move `actions/checkout` from v6.0.2 to v6.0.3 by immutable SHA. Keep the already-current `setup-bun`, `upload-artifact` v6, and `download-artifact` v7 pins.
4. Run the complete local gate and one real production deployment early enough to observe it before 2 August. From feature freeze through SQM, accept only a security fix or a release-blocking compatibility fix, each with the same gate and deployment rehearsal.

Do **not** introduce Vite, Vitest, Testing Library, a standalone TypeScript compiler, a new shadcn package/layout, or new major GitHub Actions before SQM. None is required by the current architecture, and each expands the failure surface without closing a known event-readiness gap.

## Current architecture and why it matters

- Bun is the runtime, package manager, dev server, bundler, test runner, and Linux executable compiler. The project deliberately pins the runtime and `@types/bun` together and deploys the compiled executable ([`package.json`](../../package.json#L6), [`package.json`](../../package.json#L8), [`package.json`](../../package.json#L11), [`scripts/check-bun-version.ts`](../../scripts/check-bun-version.ts#L1)).
- There is no Vite, Vitest, Testing Library, or direct `typescript` dependency. Tests use `bun:test`; component tests use React DOM directly with Happy DOM ([`package.json`](../../package.json#L12), [`src/App.test.tsx`](../../src/App.test.tsx#L1)).
- Tailwind is compiled by `bun-plugin-tailwind` inside `Bun.build`; the production build uses bytecode and `bun-linux-x64-modern` ([`build.ts`](../../build.ts#L168)).
- shadcn/ui is source-owned in `src/components/ui`, with only the individual Radix packages used by those components installed. `components.json` is a generator configuration, not a runtime dependency ([`components.json`](../../components.json), [`src/components/ui`](../../src/components/ui)).
- CI installs from the frozen Bun lock, runs checks and tests, creates the same Linux executable that is deployed, and passes it between jobs as an artifact ([`deploy-production.yml`](../../.github/workflows/deploy-production.yml#L34)).

These choices make a targeted in-place refresh substantially safer than a toolchain migration.

## Upgrade before feature freeze

| Area | Current | Target | Why now / compatibility assessment | Primary sources |
| --- | --- | --- | --- | --- |
| Bun runtime and types | 1.3.13 | 1.3.14, with `packageManager`, `@types/bun`, and lockfile Bun package identical | This project uses `bun test --isolate`, `bun test --changed` with `@/*` aliases, `Bun.build`, `--compile`, and `--hot`. Bun 1.3.14 fixes isolate crashes, alias traversal in `--changed`, bundler/plugin crashes, compiled-executable issues, and macOS hot reload. It is a directly relevant patch upgrade. | [Bun 1.3.14 notes](https://bun.com/blog/bun-v1.3.14), [npm registry](https://registry.npmjs.org/bun/latest), [types registry](https://registry.npmjs.org/%40types%2fbun/latest) |
| Transitive `ws` | 8.19.0 via Happy DOM | 8.21.0 | The current lock is in the affected range for a high-severity memory-exhaustion DoS and a moderate uninitialized-memory disclosure. The high-severity advisory requires 8.21.0; 8.20.1 is not sufficient. Although this path is test-only here, an audit-clean lock is the correct pre-event baseline. | [DoS advisory](https://github.com/advisories/GHSA-96hv-2xvq-fx4p), [disclosure advisory](https://github.com/advisories/GHSA-58qx-3vcg-4xpx), [ws registry](https://registry.npmjs.org/ws/latest) |
| React runtime and types | React/DOM 19.2.6; React types 19.2.14 | React/DOM 19.2.7; React types 19.2.17; keep React DOM types 19.2.3 | These are patch/type-only moves within React 19.2. React Server Component advisories do not apply: the vulnerable `react-server-dom-*` packages are absent and the app uses a client root plus a Bun server rather than an RSC framework. Keep React and React DOM exactly aligned. | [React registry](https://registry.npmjs.org/react/latest), [React DOM registry](https://registry.npmjs.org/react-dom/latest), [React types registry](https://registry.npmjs.org/%40types%2freact/latest), [official RSC advisory](https://react.dev/blog/2025/12/11/denial-of-service-and-source-code-exposure-in-react-server-components) |
| Radix primitives | label 2.1.8; select 2.2.6; slot 1.2.4 | label 2.1.11; select 2.3.3; slot 1.3.0 | The current shadcn components use only established APIs. The releases include React 19 ref-loop fixes, Select touch/placeholder fixes, and Slot fixes. Because Select is used in the phone controller, manually verify touch scrolling, opening/closing, selection, and outside-tap dismissal at about 360 px after upgrading. | [Radix release notes](https://www.radix-ui.com/primitives/docs/overview/releases), [label registry](https://registry.npmjs.org/%40radix-ui%2freact-label/latest), [select registry](https://registry.npmjs.org/%40radix-ui%2freact-select/latest), [slot registry](https://registry.npmjs.org/%40radix-ui%2freact-slot/latest) |
| Tailwind stack | Tailwind 4.2.4; tailwind-merge 3.5.0 | Tailwind 4.3.2; tailwind-merge 3.6.0 | Both stay within their current major versions and the existing CSS-first configuration. `bun-plugin-tailwind` 0.1.2 and `tw-animate-css` 1.4.0 are already current. Build output and every active controller tab need visual verification because utility generation and class conflict resolution can change appearance without a type error. | [Tailwind release](https://github.com/tailwindlabs/tailwindcss/releases/tag/v4.3.2), [Tailwind registry](https://registry.npmjs.org/tailwindcss/latest), [tailwind-merge release](https://github.com/dcastil/tailwind-merge/releases/tag/v3.6.0), [plugin registry](https://registry.npmjs.org/bun-plugin-tailwind/latest), [animation registry](https://registry.npmjs.org/tw-animate-css/latest) |
| Icons | lucide-react 1.14.0 | 1.24.0 | Imported icon names used by the app still resolve in the rehearsal. Treat any visual glyph change as a manual controller QA item; do not use this refresh to replace icons. | [Lucide release](https://github.com/lucide-icons/lucide/releases/tag/1.24.0), [registry](https://registry.npmjs.org/lucide-react/latest) |
| Test DOM | Happy DOM 20.9.0 | 20.10.6 | This remains within major 20 and preserves the existing direct React DOM test approach. Its updated manifest requires `ws ^8.21.0`, making it the durable route to the patched transitive version. Run all contextual interaction tests; do not infer that it makes pointer/outside-tap browser-equivalent. | [Happy DOM release](https://github.com/capricorn86/happy-dom/releases/tag/v20.10.6), [20.10.6 manifest](https://registry.npmjs.org/happy-dom/20.10.6) |
| Formatter and linter | oxfmt 0.48.0; oxlint 1.63.0; oxlint-tsgolint 0.22.1 | oxfmt 0.58.0; oxlint 1.73.0; oxlint-tsgolint 0.24.0 | The current commands and repository pass unchanged at the targets. Oxfmt is still pre-1.0 and its releases intentionally adjust formatting, so take any mechanical rewrite in its own reviewed commit and freeze the version after 2 August. Oxlint adds/fixes rules; review new diagnostics instead of suppressing them wholesale. | [Oxc combined release](https://github.com/oxc-project/oxc/releases/tag/oxlint_v1.73.0), [oxfmt registry](https://registry.npmjs.org/oxfmt/latest), [oxlint registry](https://registry.npmjs.org/oxlint/latest), [tsgolint registry](https://registry.npmjs.org/oxlint-tsgolint/latest) |
| Other direct packages | `@types/react-dom` 19.2.3, `bun-plugin-tailwind` 0.1.2, CVA 0.7.1, clsx 2.1.1, tw-animate-css 1.4.0 | no change | The first-party registry reports these as current. Avoid churn where there is no upgrade. | [React DOM types](https://registry.npmjs.org/%40types%2freact-dom/latest), [CVA](https://registry.npmjs.org/class-variance-authority/latest), [clsx](https://registry.npmjs.org/clsx/latest) |

### Lockfile requirement

Do not hand-edit only the two visible Bun version fields. `bun-plugin-tailwind` declares a Bun peer, and this lock currently contains a platform Bun package at 1.3.13 ([`bun.lock`](../../bun.lock#L221), [`bun.lock`](../../bun.lock#L223)). Regenerate with Bun 1.3.14 and confirm all three agree:

- `packageManager: bun@1.3.14`;
- `devDependencies["@types/bun"]: 1.3.14`;
- the lockfile's `bun`, `bun-types`, and platform packages: 1.3.14.

Also explicitly confirm the regenerated lock selects `ws` 8.21.0 or newer within major 8; Happy DOM 20.10.6 requires that patched line, while the current 20.9.0/frozen-lock combination preserves 8.19.0 ([`bun.lock`](../../bun.lock#L239), [`bun.lock`](../../bun.lock#L279)).

## GitHub Actions

The workflow already uses immutable commit SHAs, which should be retained.

| Action | Current pin | Recommendation before SQM | Reason / source |
| --- | --- | --- | --- |
| `oven-sh/setup-bun` | v2.2.0 (`0c5077e...`) | Keep | It is the current v2.2.0 release and already uses the Node 24 action runtime. [Official release](https://github.com/oven-sh/setup-bun/releases/tag/v2.2.0) |
| `actions/checkout` | v6.0.2 (`de0fac2...`) | Update to v6.0.3 (`df4cb1c069e1874edd31b4311f1884172cec0e10`) | Take the patch within the current major. This is the dereferenced commit, not the annotated tag-object SHA. Defer v7 because it is a new major with ESM/dependency and fork-checkout behavior changes that this push-only deploy does not need before SQM. [v6.0.3 release](https://github.com/actions/checkout/releases/tag/v6.0.3), [v7.0.0 release](https://github.com/actions/checkout/releases/tag/v7.0.0) |
| `actions/upload-artifact` | v6.0.0 (`b7c566a...`) | Keep | v6.0.0 is the final v6 tag. v7 adds direct uploads and migrates the action to ESM; neither is needed for the existing directory artifact. [v7.0.0 release](https://github.com/actions/upload-artifact/releases/tag/v7.0.0) |
| `actions/download-artifact` | v7.0.0 (`37930b1...`) | Keep | v7.0.0 is the final v7 tag. v8 moves to ESM and changes digest mismatch from warning to failure. That security-hardening behavior is desirable later, but a new artifact-transfer major immediately before an event is not necessary. [v8.0.0 release](https://github.com/actions/download-artifact/releases/tag/v8.0.0) |

Revisit the three deferred majors together after SQM, when the complete upload/download chain can be exercised without event pressure.

## Explicit deferrals

- **Vite, Vitest, Testing Library, and Playwright as a default suite:** defer. The present Bun-native build and test path is small, deterministic, and deployed as a compiled executable. A migration would change module resolution, dev-server behavior, test globals, and CI without addressing a current defect.
- **Standalone `typescript` / `tsc`:** defer. Bun executes TypeScript and the required repository gate is Oxlint type-aware/type-check mode. Adding a second compiler is a policy and diagnostics change, not a version refresh.
- **Bulk shadcn regeneration or migration to the `radix-ui` umbrella package:** defer. The current UI primitives are checked-in application source. Regeneration can change markup, focus behavior, Tailwind classes, and mobile layout all at once.
- **Bun canary, Bun 2, React 20 prereleases, Tailwind 5 prereleases, or any other new major:** defer until after SQM and evaluate as separate compatibility work.
- **Routine upgrades after 2 August:** defer until after SQM. Security advisories remain exceptions, but require an isolated patch, full gate, compiled build, phone-width QA, and deployment rehearsal.

## Isolated compatibility rehearsal

An isolated copy of the current commit was upgraded to every direct target in the table, Bun/runtime/types/lock packages 1.3.14, and `ws` 8.21.0. No source or configuration fixes were applied. Results:

- `bun run check`: pass, including Bun/type alignment, oxfmt 0.58.0, Oxlint 1.73.0 with tsgolint 0.24.0, and ShellCheck;
- `bun run test`: **75 passed, 0 failed** under Bun 1.3.14;
- `bun run build`: pass in the parent rehearsal;
- `bun run build:executable`: pass for `bun-linux-x64-modern` with bytecode;
- `bun audit`: **no vulnerabilities found** after selecting `ws` 8.21.0.

This proves source-level compatibility with the proposed dependency set. It does not replace the required touch/phone-width visual pass, GitHub-hosted workflow run, Linux executable smoke test on the production host, or a real artifact handoff between the CI and deploy jobs.

## Acceptance gate for the upgrade work

Before merging the refresh:

1. Inspect `package.json` and the complete `bun.lock` diff; verify the Bun alignment and `ws` 8.21.0 explicitly.
2. Run `bun run check`, `bun run test`, `bun run build`, `bun run build:executable`, and `bun audit`.
3. At about 360 px wide, manually inspect every active bottom tab and exercise Select touch scroll/selection/dismissal, contextual panels, game clock/play controls, penalty panels, and icon legibility.
4. Run the production GitHub workflow from the refreshed SHA, confirm artifact upload/download, deploy the compiled executable, and pass both the public smoke test and a short controller/spectator WebSocket session.
5. Record the deployed dependency baseline and stop routine upgrades at feature freeze.
