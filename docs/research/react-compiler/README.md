# React Compiler evaluation (#327)

Decision, 2026-09-20: **leave React Compiler disabled**. The tested compiler reaches browser components and a hook, but this Controller workload does not demonstrate a repeatable render-work or interaction benefit that justifies the larger download. No application code, manual `memo`/`useMemo`/`useCallback`, runtime pin, or build default changed. This is a negative adoption decision, not a claim that React Compiler can never help.

## Scope and reproduction

Base: `af2490934de8208d60fc3e31124d87eef058f0bb`, including route splitting and the canonical x64 target. Native Darwin arm64, Bun 1.4.2, React 19.3.0, Playwright 1.63.0, pinned Chromium 1243 and WebKit 2359. Measurements concern this base; later hook/dependency cleanup is not measured here.

From the repository root, with the frozen dependencies and Playwright browsers installed:

```fish
bun docs/research/react-compiler/build-samples.ts
bun docs/research/react-compiler/probe.ts out/compiler-off/index.js out/react-compiler/chromium-off.json
bun docs/research/react-compiler/probe.ts out/compiler-on/index.js out/react-compiler/chromium-on.json
bun docs/research/react-compiler/probe.ts out/compiler-off/index.js out/react-compiler/webkit-off.json webkit
bun docs/research/react-compiler/probe.ts out/compiler-on/index.js out/react-compiler/webkit-on.json webkit
bun run build --compile --compile-target=bun-darwin-arm64 --react-compiler --outfile=out/compiler-native/quadball-timer
bun docs/research/react-compiler/probe.ts out/compiler-native/quadball-timer out/react-compiler/native.json chromium true
bun run build --react-compiler --minify=false --outdir=out/compiler-readable
```

The native target is specifically for this macOS inspection, not the Linux release artifact. Each probe is an intentional Focused Integration experiment with three fresh browser contexts, mocked Controller API fixtures, a disposable local server/database/key ring, the existing 52-second lifecycle deadline, and explicit browser/server/temporary-state cleanup. No Production service or Qualification workload is used. Run probes sequentially: they generate one temporary harness under this directory and remove it in `finally`. The generator reuses the existing Controller browser fixture and cleanup rather than creating another server lifecycle implementation; it extends the fixture only to apply clock corrections. Its UI workload intentionally excludes unrelated mobile geometry assertions. Do not add it to ordinary tests or CI.

## Compilation and delivery evidence

[Bun's React Compiler API](https://bun.com/reference/bun/BuildConfig/reactCompiler) and the [Bun 1.4 announcement](https://bun.com/blog/bun-v1.4) document the built-in transform. The installed exact 1.4.2 types mark it experimental and default it off. Although the outer full-stack build targets Bun, its imported HTML graph receives **client** memoization; this was verified in output, not inferred from the top-level target.

The readable build contains `ControllerActionSheet` beginning with `react_compiler_runtime3.c(38)`, memoized effect dependencies and callbacks; `EventControllerActionPanel` uses 96 cache slots, and the actual `useRoute` hook uses 5. The `EventGameControllerPage` function itself retains its original hook/body form: the compiler conservatively skips it. `useControllerDepartureEntry`, `useGameConnection`, and `useNow` likewise have no emitted cache call. No manual exclusions were configured, and no refactor was made just to force compiler eligibility.

Browser resource captures record paths, response byte lengths and SHA-256 values. The off initial Controller graph is `chunk-6t6mkb4n.js` plus `chunk-camex9nx.js`; on is `chunk-m4c23a5h.js` plus `chunk-mb4dr1rs.js`. The extra memo sentinel export appears in the on shared helper (baseline helper has none). The native compiled app serves the compiler-generated shared helper and component/runtime chunks too, with its own splitting and hashes; all three native browser samples pass. A memo-cache symbol in React DOM alone is **not** proof of compiler activation; the transformed application functions and additional helper above establish it.

## Results

`builds.json` records three alternating-order samples per mode. Browser JSON contains the complete three-sample phase measurements and resource hashes. Sizes are uncompressed UTF-8 bytes, not gzip, network latency, or parsed memory.

| Measurement | Off | On | Difference |
| --- | ---: | ---: | ---: |
| All emitted browser JS, excluding server JS and maps | 1,216,755 | 1,278,736 | +61,981 (+5.09%) |
| Initially fetched Controller JS | 1,071,776 | 1,107,324 | +35,548 (+3.32%) |
| Ordinary build time, median | 234.10 ms | 246.76 ms | +12.66 ms (+5.41%) |
| Ordinary build range | 228.67–234.72 ms | 243.37–262.12 ms | Small local sample |
| Native executable size | 73,785,330 | 73,900,914 | +115,584 |
| Native build, one sample | 567.75 ms | 533.97 ms | No speed conclusion from single sample |

The regular bundle report includes linked source-map comments in browser responses. The two browser-byte rows therefore differ from each other both in route coverage and in delivery details; neither includes CSS. Native splitting differs and is recorded separately rather than substituted into the ordinary comparison.

The probe measures start/pause with 1.2 seconds of live clock updates, a controlled-input clock correction to 123000 ms, QR dialog open/outside dismissal/focus restoration, and offline→online authority refresh. It verifies the latest correction value reaches the API fixture, expected start/pause controls and enabled state, accessible dialog role/name, restored trigger focus, refresh requests after reconnect, and absence of uncaught browser errors. Existing memoization stays in place. Effects are exercised through clock updates, network event listeners, focus restoration, and context disposal; this does not establish every effect cleanup or callback identity in the application.

`commits` comes from the React DevTools commit hook. `renderedFibers` counts committed function fibers carrying React's PerformedWork bit; it is an **internal diagnostic proxy**, not an independently instrumented count of component calls or React Profiler duration. It can include retained flags and must not be interpreted as exact renders. Clock observations are 9 commits / 306 work indicators and correction observations are 5 / 170 in every on/off Chromium and WebKit sample; dialog/reconnect counts have scheduling variation. The median diagnostic phase times were:

| Phase | Chromium off / on | WebKit off / on |
| --- | ---: | ---: |
| Clock | 1296.4 / 1293.8 ms | 1309.6 / 1299.4 ms |
| Correction | 162.7 / 165.0 ms | 180.1 / 182.0 ms |
| QR dialog | 146.7 / 145.1 ms | 147.0 / 165.3 ms |
| Reconnect | 431.1 / 415.7 ms | 424.6 / 423.4 ms |

The approximately one-frame Chromium reconnect difference does not recur to the same extent in WebKit and is not enough to establish a benefit. No stable interaction improvement emerged across the browsers. The elapsed phase values include Playwright automation, two animation frames, explicit settling waits, and the fixed clock/offline intervals. They are reproducibility diagnostics, **not user input latency or a speedup claim**. No production measurement, CPU profile, memory measurement, or statistical significance claim is made.

## Verification and limits

- All final on/off Chromium and WebKit probes pass; each contains three clock/correction/dialog/reconnect samples. The enabled native compiled delivery probe also passes three samples.
- `bun run lint:fix`, `bun run format`, `bun run check`, and final `bun run lint` pass. Ordinary Controller/clock/reconnect/departure/header/action-panel tests: 108 passed, 0 failed across six files, 445 assertions (3.60 s). Existing React `act(...)` diagnostics remain visible in the test log.
- The repository's broader mobile Event Controller journey has a pre-existing baseline geometry failure at 390×844 (primary control y=380, height=44 intersects panel starting y=385). The coordinating #330 worker reproduced it on the pre-change baseline. This experiment does not fix it, omit it from that test, or claim the full mobile journey passes. Therefore broad browser compatibility is not established even though the bounded compiler comparison passes.
- One initial ordinary check overlapped a generated temporary harness and reported that file's formatting; the generator now writes under this excluded research directory, removes it, and the full check subsequently passes. Initial probe assertions were corrected to use `gameTimeMs` and the API correction fixture; only final passing samples are retained here.
- Revisit after the Controller's large hook-heavy page becomes compiler-eligible and a representative, instrumented measurement shows useful benefit without regressions. Keep the compiler off until that evidence and the full mobile/browser correctness gate exist. The current experiment does not justify enabling selected leaves either: their changed code was exercised without a demonstrated workload benefit.
