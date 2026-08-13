# SQM 2026 safe platform baseline refresh

Research date: 2026-08-13 (Europe/Zurich)

## Question

Which exact Bun, package, and GitHub Actions baseline is safe and supportable for the first progressive specification and SQM delivery, given the repository already merged part of the July refresh and SQLite/WAL now has a mandatory production-artifact gate?

## Recommended decision

Keep **Bun 1.3.14 and `@types/bun` 1.3.14** as the stable SQM runtime/type baseline. There is no newer stable Bun: GitHub and the npm registry both still identify 1.3.14 as latest. Crucially, the production target compiled by Bun 1.3.14 is suitable even though the locally installed macOS Bun with the same version label is not: the official `bun-linux-x64-modern` target compiled in this investigation reports Bun revision `0d9b296af33f2b851fcbf4df3e9ec89751734ba4` and SQLite **3.53.0**, outside SQLite's affected WAL-reset range through 3.51.2. It also passed the production-shaped concurrent writer/checkpoint probe below. SQLite says the bug is fixed in 3.51.3 and later. [Bun 1.3.14 release](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14), [Bun registry](https://registry.npmjs.org/bun/latest), [`@types/bun` registry](https://registry.npmjs.org/%40types%2fbun/latest), [SQLite WAL-reset description](https://www.sqlite.org/wal.html#the_wal_reset_bug)

Treat **artifact identity and embedded SQLite**, not `Bun.version` alone, as the gate. The installed macOS Bun 1.3.14 revision `d1632b291…` reports affected SQLite 3.51.0, while the stable Linux compile target reports unaffected 3.53.0. Bun's tagged source also vendors 3.53.0, but source inspection is supporting evidence rather than a substitute for querying the actual executable. [Bun 1.3.14 SQLite amalgamation](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/jsc/bindings/sqlite/sqlite3.c), [Bun compile targets](https://bun.com/docs/bundler/executables)

Make only one package correction before the accepted feature freeze: update **Happy DOM to 20.11.2** and require the lock to resolve **`ws` 8.21.3**. The current lock's `ws` 8.19.0 has one high-severity memory-exhaustion advisory and one moderate uninitialized-memory disclosure; `bun audit` confirms both. Happy DOM 20.11.2 declares `ws ^8.21.0`, providing the durable route to a patched major-8 lock. Defer the other routine UI/toolchain patches until after SQM because they do not close a current advisory or the SQLite gate. [Happy DOM 20.11.2 manifest](https://registry.npmjs.org/happy-dom/20.11.2), [`ws` 8.21.3 manifest](https://registry.npmjs.org/ws/8.21.3), [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p), [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx)

Keep the already-merged immutable GitHub Actions pins. They are the current upstream releases: checkout 7.0.1, setup-bun 2.2.0, upload-artifact 7.0.1, and download-artifact 8.0.1. Do not churn Actions again before SQM. [checkout 7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1), [setup-bun 2.2.0](https://github.com/oven-sh/setup-bun/releases/tag/v2.2.0), [upload-artifact 7.0.1](https://github.com/actions/upload-artifact/releases/tag/v7.0.1), [download-artifact 8.0.1](https://github.com/actions/download-artifact/releases/tag/v8.0.1)

This means the mandatory SQLite gate **does not reopen the PostgreSQL decision** on the evidence available: the selected stable production artifact is unaffected and passed the concurrent integrity probe. PostgreSQL remains the fallback only if the implementation's real release artifact fails the repeated gate, per the storage decision.

## Exact baseline

### Runtime and packages

| Item | Repository on 2026-08-13 | SQM baseline | Decision |
| --- | --- | --- | --- |
| `packageManager` / stable Bun | 1.3.14 | **1.3.14** | Keep. It is still latest stable and the Linux compiled target passes the SQLite gate. |
| `@types/bun`, `bun-types`, lockfile `bun` packages | 1.3.14 | **1.3.14 everywhere** | Keep the exact-version invariant and reject a mixed lock. |
| `happy-dom` | manifest `^20.9.0`, lock 20.9.0 | **20.11.2** | Take the patch before freeze to carry the patched `ws` requirement. |
| transitive `ws` | 8.19.0 | **8.21.3** | Security-blocking lock correction; confirm with `bun pm ls --all` and `bun audit`. |
| `oxfmt` / `oxlint` / `oxlint-tsgolint` | 0.63.0 / 1.78.0 / 7.0.2001 | **same** | The newer Oxc baseline is already merged; no further release exists in the registry snapshot. |
| React / React DOM | 19.2.6 / 19.2.6 | **same for SQM** | 19.2.8 exists, but the audit finds no applicable advisory; defer routine patch churn. |
| Radix label/select/slot | 2.1.8 / 2.2.6 / 1.2.4 | **same for SQM** | Newer patches exist; defer because controller interaction QA is required and there is no current security blocker. |
| Tailwind / tailwind-merge | 4.2.4 / 3.5.0 | **same for SQM** | 4.3.3 / 3.6.0 exist; defer visual-output churn until after the event. |
| lucide-react | 1.14.0 | **same for SQM** | 1.31.0 exists; defer glyph churn. |
| remaining direct packages | current lock | **same** | `bun-plugin-tailwind` 0.1.2, CVA 0.7.1, clsx 2.1.1, and tw-animate-css 1.4.0 are already latest. |

The registry checks were made directly against each package's `latest` document, including [React](https://registry.npmjs.org/react/latest), [React DOM](https://registry.npmjs.org/react-dom/latest), [Radix Select](https://registry.npmjs.org/%40radix-ui%2freact-select/latest), [Tailwind](https://registry.npmjs.org/tailwindcss/latest), [tailwind-merge](https://registry.npmjs.org/tailwind-merge/latest), [Lucide React](https://registry.npmjs.org/lucide-react/latest), [oxfmt](https://registry.npmjs.org/oxfmt/latest), [oxlint](https://registry.npmjs.org/oxlint/latest), and [oxlint-tsgolint](https://registry.npmjs.org/oxlint-tsgolint/latest).

### GitHub Actions

| Action | Immutable repository pin | Upstream release | SQM decision |
| --- | --- | --- | --- |
| `actions/checkout` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | v7.0.1 | Keep |
| `oven-sh/setup-bun` | `0c5077e51419868618aeaa5fe8019c62421857d6` | v2.2.0 | Keep |
| `actions/upload-artifact` | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` | v7.0.1 | Keep |
| `actions/download-artifact` | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` | v8.0.1 | Keep |

The July recommendation to defer these majors is superseded by merged repository state: all three majors and checkout 7.0.1 are already present. Current upstream release metadata resolves each SHA to the stated release, so reverting would add churn without improving the baseline.

## Production-shaped compiled-executable probe

### Method

The probe was a disposable TypeScript program compiled twice and run in an isolated Linux/amd64 Debian container under a disposable Colima VM with Rosetta translation. No repository dependency, lockfile, workflow, release, GitHub, or Production state was changed.

The stable candidate was built from the repository's production command shape:

```sh
bun build probe.ts --compile --target=bun-linux-x64-modern --outfile=probe-stable
```

The program opened one SQLite file through `bun:sqlite`, selected WAL mode, `synchronous=FULL`, foreign-key enforcement, and disabled automatic checkpoints. Six independent executable processes each committed 1,000 `BEGIN IMMEDIATE`/insert/`COMMIT` transactions using distinct `(writer, sequence)` keys while a seventh process issued 5,000 `PRAGMA wal_checkpoint(PASSIVE)` calls. A final process issued `wal_checkpoint(TRUNCATE)`, `integrity_check`, `quick_check`, `foreign_key_check`, a row count, and a duplicate-key query.

### Stable result

| Observation | Result |
| --- | --- |
| Bun version / revision | 1.3.14 / `0d9b296af33f2b851fcbf4df3e9ec89751734ba4` |
| Embedded SQLite | **3.53.0**, unaffected |
| Writes | 6,000 expected; **6,000 present** |
| Checkpoints | 5,000 passive attempts; 5 reported busy while writers overlapped |
| Final truncate checkpoint | `busy=0`, `log=0`, `checkpointed=0` |
| Integrity | `integrity_check=ok`; `quick_check=ok` |
| Referential/identity checks | no foreign-key failures; zero duplicate `(writer, sequence)` keys |

The SQLite advisory notes that the historic race had tight timing and required SQLite's own special test logic to reproduce reliably. Therefore this successful stress probe is necessary production-shape evidence, not a proof that an affected build would never corrupt. The decisive first gate remains the embedded version outside the affected range. [SQLite WAL-reset details](https://www.sqlite.org/wal.html#the_wal_reset_bug), [SQLite 3.51.3 release](https://www.sqlite.org/releaselog/3_51_3.html)

### Canary comparison, not a recommendation

For comparison, the current official Linux canary was 1.4.0-canary.1 revision `9a543cc18f4bc70fb6c70ec88b6502d6cba4b6b0` and embedded SQLite 3.53.2. A smaller four-writer/2,000-row probe with 5,000 passive checkpoints also passed every count, duplicate, checkpoint, foreign-key, quick, and integrity check. This corroborates Bun main's continued fixed SQLite line, but canary is not a stable or SQM-supportable pin and must not replace stable 1.3.14. [Bun canary release assets](https://github.com/oven-sh/bun/releases/tag/canary)

## Implementation and acceptance gates

The package refresh is acceptable only when all of the following are true:

1. `packageManager`, `@types/bun`, `bun-types`, the lockfile `bun`, and every platform Bun package are exactly 1.3.14.
2. The regenerated frozen lock resolves Happy DOM 20.11.2 and `ws` 8.21.3; `bun audit` reports no vulnerabilities.
3. `bun run check`, `bun run test`, `bun run build`, and `bun run build:executable` pass. Because the package change touches test infrastructure, the complete test suite is required; no UI behavior should change.
4. Execute the **actual produced** `dist/quadball-timer` on Linux and query `SELECT sqlite_version()` through `bun:sqlite`. Require SQLite `>=3.51.3` and reject the release on any affected result. Also capture `Bun.version` and `Bun.revision`; do not accept version text alone.
5. Re-run the concurrent writer/checkpoint probe against that exact executable/runtime shape with at least the stable workload above. Require exact row count, no duplicate operation identities, clean foreign keys, successful final checkpoint, and `integrity_check=ok`.
6. The real GitHub workflow must complete its immutable checkout/setup, frozen install, full gate, executable build, upload/download handoff, and public/internal smoke checks. A local compile does not validate the Actions artifact path.
7. After the accepted feature-freeze boundary, allow only this security correction or a release-blocking compatibility/security fix; defer all routine UI, styling, icon, formatter, linter, framework, and Actions movement until after SQM.
8. If the real stable release artifact reports an affected SQLite version or fails concurrency/integrity, stop SQLite delivery. That is the mandatory-gate failure described by the storage decision and requires a new live human choice about PostgreSQL rather than an agent silently substituting a canary or custom Bun build.

## Uncertainties and limits

- The same `1.3.14` label produced different embedded SQLite results across artifacts: installed macOS revision `d1632b291…` reported 3.51.0, while the downloaded Linux compile target revision `0d9b296af…` reported 3.53.0. This is why every release must record revision and embedded SQLite from the production executable.
- The probe used Linux/amd64 userspace under Rosetta on the development Mac, not the production host/kernel/filesystem. The implementation gate must repeat on the actual release artifact and production-shaped host storage before acceptance.
- No dependency compatibility rehearsal was run with a changed lock in this research task, because the ticket explicitly forbids applying dependency or lockfile updates. The implementation session owns that frozen-lock rehearsal and the full repository gate.
- Package registry `latest` is a point-in-time signal, not a reason to take unrelated movement immediately before SQM. The exact SQM baseline above deliberately minimizes change.

## Concise resolution-comment text

Keep stable Bun and `@types/bun` at 1.3.14. Although the installed macOS Bun 1.3.14 revision reports affected SQLite 3.51.0, the actual stable `bun-linux-x64-modern` compile target reports revision `0d9b296af…` with unaffected SQLite 3.53.0 and passed a 6-writer/6,000-transaction WAL probe with 5,000 concurrent passive checkpoints, exact row/identity counts, and clean checkpoint, foreign-key, quick, and integrity checks. The SQLite choice therefore remains viable, but release acceptance must query Bun revision and SQLite from the exact Linux executable and repeat the integrity probe; version text alone is insufficient. Before freeze, update Happy DOM to 20.11.2 so the lock resolves patched `ws` 8.21.3 and `bun audit` is clean. Keep the already-merged/current immutable Actions pins and Oxc versions; defer all other routine package/UI/toolchain movement until after SQM. If the real release artifact ever reports affected SQLite or fails the probe, stop and reopen the database choice with the human—do not substitute canary automatically.
