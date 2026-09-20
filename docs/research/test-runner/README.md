# Ordinary test scheduling measurements

Issue [#324](https://github.com/netzhuffle/quadball-timer/issues/324) evaluates the unchanged ordinary suite at base `250aa0bf34619a35018772e006adad382c6f23ba` with Bun 1.4.2 (native revision `50a8a8387`, hosted revision `744846f84`; platform distributions differ). No Focused Integration or Qualification workloads are included.

## Reproduction and method

From the repository root, run `bun docs/research/test-runner/measure.ts <fresh-output-directory>`. The output directory must be fresh: an existing table would contaminate a nominal no-scheduling run. The harness runs an unmeasured serial seed, then three order-rotated rounds of serial, two-worker, and four-worker runs, each with and without duration-based scheduling. Every run keeps `--timeout=10000 --isolate`, the existing per-test deadlines, every assertion, and all generated sequences. It never enables `--concurrent`.

Each measured run writes a separate durations table using `--update-timings`. No-scheduling runs start without that file; scheduled runs copy the immutable full-suite seed collected on that same machine. Thus both modes pay the same measurement-write overhead. Native durations are never passed to the hosted runner. Raw logs include per-test durations, assertion counts, failures, and `/usr/bin/time` resource counters. JSON records elapsed wall time, exact command, process resource usage, runtime, CPU model, architecture, available physical memory, and source commit. `/usr/bin/time` reports process high-water memory, not simultaneous aggregate RSS across every worker; aggregate worker peak memory is unavailable. GitHub runner image metadata is recorded where available.

The hosted venue is a temporary, branch-only `ubuntu-latest` workflow at [run 35537110636](https://github.com/netzhuffle/quadball-timer/actions/runs/35537110636). Its only jobs install frozen dependencies, run this ordinary matrix, and retain evidence for 30 days. It has read-only repository permissions, no environment, production secrets, deployment dependency, application build, or production target. The deployment workflow remains unchanged.

## Isolation audit

Bun's supported [`--parallel` mode](https://github.com/oven-sh/bun/blob/main/docs/test/parallel.mdx) uses worker processes and implies per-file isolation; the explicit existing `--isolate` is retained. No shared module registry or within-file concurrency is introduced. Ordinary filesystem fixtures use unique `mkdtemp` roots and owned cleanup (`finally`/`afterEach`); the one external-pointer literal in the activation safety test is a rejected input, not a written shared fixture. The ordinary HTTP fixture uses port zero and stops its server. Child environment overrides are passed to subprocesses rather than mutating a shared parent environment. The ordinary test inventory has no `mock.module` calls. Existing injected clocks, stores, and mocks remain file-local. Repeated success across schedules provides a further behavioral check; it cannot prove absence of all possible future resource collisions.

## Timings data semantics

The installed CLI supports `--timings=<path>` and `--update-timings`. [Bun's documentation](https://github.com/oven-sh/bun/blob/main/docs/test/parallel.mdx) says missing paths are ignored, unknown files are prioritized in parallel mode, and updating a non-sharded partial run merges entries while retaining deleted-file entries. Those properties make a blindly committed or shared local/CI table inappropriate. The benchmark avoids these issues by using fresh destinations and an environment-local full-suite seed. A future maintained cache would need a runtime/platform/suite identity, full-suite refresh policy, and explicit stale/deleted-file handling.

## Reliability finding and timings decision

Reject maintained timings data. Native round 1 showed no speed benefit; round 2's two-worker seeded run then failed to settle. After 137.08 seconds, one worker remained at approximately 99% CPU and was terminated with SIGTERM. Bun reported `production-activation-fast.test.ts (worker crashed: SIGTERM)`, 1,099 passes, one failure, and 23,629 assertions. The normal successful runs contain 1,104 tests and 23,900 assertions. A bounded one-second native stack sample showed unsymbolicated Bun frames, which does not establish a root cause. This is an observed reliability failure of that measured mode, not a demonstrated defect in the activation assertions or proof that timings alone caused the stall.

The failed cell was not retried. Remaining native seeded cells were skipped; only the previously unrun no-timings cells continued. No committed/cached timings file or refresh owner is introduced. Ordinary runs therefore have no missing, stale, partial, deleted-file, or cross-environment scheduling-data lifecycle to maintain. Reconsider only after a newer supported runner has evidence that the observed reliability issue is absent and scheduling provides a repeatable benefit.

Raw native records are retained under the coordinator's run evidence directory. The native coordinator was paused once between child runs to let other worktrees finish dependency setup. Its `r1-w1-discovery` monotonic elapsed value therefore includes a coordination pause and is not a test duration. The independent `/usr/bin/time` child measurement is authoritative for **all** native elapsed values in the summary; the original coordinator values are retained separately, not rewritten. Other repository builds/tests were held during measured cells.

## Native results

Native macOS 27.0 (26A428), arm64, Apple M2 Max (12 logical CPUs), 64 GiB RAM. Values below are child wall seconds, three independent measured runs; the seed is excluded. Full per-file durations, counts, resource counters, and failures are retained in [native.json](native.json).

| Workers | No timings: runs (seconds) | Median | Peak process RSS range (MiB) | Result |
| --- | --- | --- | --- | --- |
| serial | 68.64, 69.34, 69.66 | 69.34 | 975.6–1050.6 | 3/3 pass |
| 2 | 34.18, 34.69, 35.07 | 34.69 | 776.1–817.9 | 3/3 pass |
| 4 | 29.35, 30.69, 29.96 | 29.96 | 620.3–641.1 | 3/3 pass |

With the same-machine timings seed: serial 68.56 seconds (one pass); two workers 35.35 seconds (pass) then 137.08 seconds (terminated failure); four workers 30.27 and 30.33 seconds (two passes). The remaining seeded cells were deliberately skipped after the failure. Do not average the terminated run into successful performance figures.

Four workers improve the local median by 56.8% over serial; two workers improve it by 50.0%. The spread is much smaller than either improvement. Resource counters do not provide aggregate concurrent RSS, so lower process peaks are not evidence that total parallel memory usage is lower.

## Remaining individual slow tests (#248 evidence only)

Parallel files cannot split the work inside `live-event-game-control.test.ts`: its no-timings median remains 29.318 seconds serial and 29.713 seconds with four workers, nearly the entire parallel suite's elapsed time. The composed fixed-seed 1,000-sequence proof and its 60-second deadline are unchanged, as are the individual overflow checks. Other serial/four-worker median file seconds are `production-activation-fast.test.ts` 6.313/6.477, `foundation-recovery.test.ts` 3.546/3.818, `event-game-corrections.generated.test.ts` 3.542/3.756, and `foundation-storage-sqlite.test.ts` 3.169/3.316. File parallelism improves suite feedback, not these individual costs or the existing two-second per-file/ten-second suite review targets. All generated sequence counts and assertions remain untouched. This evidence does not resolve, modify, or close the human-owned [#248](https://github.com/netzhuffle/quadball-timer/issues/248).

## Hosted results and final configuration

The standard `ubuntu-latest` GitHub Actions runner reported Ubuntu 24, Linux x64, four AMD EPYC 7763 logical CPUs, and 15.6 GiB RAM. Bun's hosted distribution reported `1.4.2+744846f84`, while Homebrew's native distribution reported `1.4.2+50a8a8387`. These are separate environment-specific comparisons, not interchangeable timings. See [hosted.json](hosted.json) for complete measured cells and per-file data.

| Workers | No timings: runs (seconds) | Median | Peak process RSS range (MiB) | Result |
| --- | --- | --- | --- | --- |
| serial | 104.03, 110.21, 107.08 | 107.08 | 555.1–570.4 | 3/3 pass |
| 2 | 58.95, 64.97 | 61.96 | 563.8–654.3 | 2/2 pass |
| 4 | 66.38, 66.18 | 66.28 | 626.4–628.4 | 2/2 pass |

With a hosted-only timings seed, serial runs took 108.20/103.94 seconds; two workers 61.70/59.70/58.50; four workers 73.14/67.16/67.08. All completed hosted cells passed all 1,104 tests and 23,923 assertions (the native platform executes 23,900; source and sequence counts are unchanged). The two-worker seeded median gain of 2.26 seconds is smaller than the unscheduled two-worker run spread (6.02 seconds), and does not overcome the native reliability failure or maintenance cost.

The hosted workflow was administratively cancelled after approximately 22 minutes because live job logs were unavailable and a stall was suspected. The preserved artifact then showed normal successful progress, **not a hosted hang**. Cancellation interrupted the third two-worker unscheduled run; the third four-worker unscheduled and third serial seeded runs never started. The interrupted run has no final duration, peak memory, count, or timings table and is excluded from performance statistics. No failed or interrupted cell was rerun, and the workflow's cancelled conclusion is not represented as a successful CI run. The existing two hosted repetitions of both bounded configurations plus three serial repetitions establish the material improvement without another run.

Use `bun run test` locally and in CI: the package script now keeps the existing timeout/isolation and adds only `--parallel=2`. The deployment workflow already invokes that script and needs no change. Two workers reduce the median by 50.0% natively and 42.1% hosted; four workers are another 4.73 seconds faster locally but 4.32 seconds slower hosted. A single conservative two-worker default avoids host-detection policy and unbounded CPU-based fan-out. For an intentional local four-worker run, use `bun test --timeout=10000 --isolate --parallel=4`; for serial investigation, omit `--parallel`. Existing focused commands and `test:changed` retain their behavior.

The temporary measurement workflow is absent from the final change; its exact source remains at measurement commit `f2605ed25c6c0b0b848425e60743669c772f2925` and the linked Actions run. The retained reproduction script refuses existing output directories, stops at its first failure, and now bounds each measurement process group to four minutes with TERM/KILL cleanup. This outer measurement bound does not change ordinary test deadlines. Test-before-Production ordering, release build count, immutable Release Bundle creation/upload/promotion, and deployment triggers are untouched.

## Final verification

`bun run lint:fix`, `bun run format`, `bun run lint`, and `bun run check` passed. The final unchanged suite through `bun run test` passed 1,104 tests/23,900 assertions in 34.97 seconds using the installed Bun `1.4.2+744846f84` and the new two-worker script. This final smoke validates command wiring; it is not substituted into the quiet-window timing matrix. The installed optional Bun peer initially contained its uninitialized launcher stub; running that already-installed package's installer repaired only `node_modules`, with no dependency or lockfile edit. The retained measurement script also completed its full matrix against a disposable one-test fixture. No application or test source was changed.
