# Administrative route loading

Event Admin, Technical Admin (including enrollment), Pitch Manager, Event Operations
Prototype, and Color Test are separate dynamic entry points. The selection follows
the [eager bundle baseline](bundle-analysis.md): administration and the prototype
hierarchy were substantial, uncommon additions to every browser visit.

Both Controller pages, their action panels, session persistence, departure, and
reconnect logic remain statically imported. The initial bundle metadata confirms
those modules are initial assets. No action during a Game gained a dynamic import.
The route parser, authority requests, admission, and server authorization are unchanged.

Each deferred route announces loading with a polite status. A failed import offers
an alert, Reload page, and Home. Reload deliberately obtains a fresh document and
module cache: retrying the same React lazy object would retain its rejected promise,
and an old document can point at chunks removed by a deployment. Changing routes
resets the error boundary. Enrollment props and URL credentials still reach the
existing destination page; the wrapper does not consume or copy credentials.

## Build and delivery

`splitting: true` is required: the first experiment with dynamic imports alone still
emitted one browser JS bundle. `format: "esm"` is also explicit because compiled
bytecode defaults to CJS, which rejects splitting. `bytecode: shouldCompile` and
the executable's disabled dotenv/bunfig loading remain in place. Bun documents
[ESM bytecode with compilation and splitting](https://bun.com/blog/bun-v1.4#bytecode-compilation-for-es-modules).

The custom HTML route now registers Bun's `HTMLBundle.files` manifest in addition
to direct HTML references. Otherwise deferred/shared requests can receive the SPA
document instead of JavaScript. It uses only browser-manifest files, including
embedded compiled files, and excludes HTML and source maps. Existing asset cache
policy is retained; this does not introduce a filesystem wildcard route.

No chunk-size threshold or manual preloading was added. Bun's
[module preloading option](https://bun.com/reference/bun/build) applies to browser
targets. The actual full-stack `target: "bun"` builds emitted no modulepreload links,
and browser inspection found none added during navigation. Shared dependencies
were requested after their importing chunk, not all at initial load. Development
HMR served its large development graph eagerly, so navigation there created no
new JS/CSS requests. Production build evidence is required to assess savings.

## Measurements

Measured 2026-09-20 on Darwin arm64, Bun 1.4.2 (`50a8a8387`), frozen dependencies,
Chrome 153.0.8010.48 via Playwright 1.63.0. Browser plugin was not available; the
installed Chrome channel was used because this machine lacked Playwright's matching
downloaded Chromium. Each sample used a new browser context, without HTTP cache
reuse, on loopback without network or CPU throttling. Three samples were taken for
each mode with a disposable Test database. No Production data or workload was used.

The equivalent ordinary builds use default minification and linked maps. The eager
assets are the retained #325 full-stack baseline (`bb42e886`, unchanged application
sources from `250aa0bf`); the lazy build adds this ticket's code and splitting flags.
HTML and source maps are excluded from these JS/CSS totals.

| Metric | Eager ordinary build | Lazy ordinary build |
|---|---:|---:|
| Initial emitted/downloaded body bytes | 1,289,081 | 1,148,748 |
| Initial JS/CSS requests | 2 | 3 |
| Additional first Event Admin navigation bytes | 0 | 64,813 |
| Additional first Event Admin JS requests | 0 | 3 |
| Median initial asset completion, ms from navigation start | 9.3 | 32.1 |
| Median observed Home readiness, ms | 75.5 | 97.3 |
| Event Admin DOM reveal, three samples, ms | 2.3 / 2.5 / 2.1 | 302.0 / 303.4 / 302.5 |

Initial savings are **140,333 bytes (10.89%)**. These are uncompressed body bytes,
confirmed by Resource Timing `encodedBodySize`, not compressed network estimates.
Initial completion is the latest initial asset `startTime + duration`; Home readiness
includes browser automation observation overhead. Navigation is measured inside
the page from popstate dispatch to a MutationObserver seeing the admission input.
The roughly 300 ms reveal cost is a controlled local observation of the Suspense
transition, not a network latency forecast. The extra shared request also delays
initial completion locally. This change reduces bytes, not measured loopback latency.
That tradeoff is accepted for these infrequently visited routes; Controllers remain
eager. These samples do not justify a particular chunk-size threshold.

The deferred ordinary entries are 58,848 bytes (Event Admin), 20,632 (Technical
Admin), 11,586 (Pitch Manager), 45,316 (operations prototype), and 2,632 (Color Test).
Two deferred shared chunks are 5,544 and 421 bytes; one initial shared chunk is
1,004 bytes. These figures must not be added as independent route savings.

The native standalone compiled build uses no source maps and is a separate pipeline,
not an equivalent before/after size comparison. It downloaded 1,165,796 initial
JS/CSS bytes and 64,542 more on first Event Admin navigation; reveal samples were
302.8 / 303.1 / 302.8 ms. Development HMR downloaded 6,420,845 initial bytes and no
additional navigation assets; its first server compile is included in the first
development sample. These development sizes are not release measurements.

## Verification and reproduction

Run `bun run build --analyze` to reproduce emitted sizes and inspect the initial
Controller module graph. Use the same runtime, lockfile, flags, and fresh browser
contexts for comparisons. Keep reports outside the served output as described in
the bundle-analysis guide. Native disposable verification used
`bun run build --compile --compile-target=bun-darwin-arm64 --outfile=out/lazy-native/quadball-timer`;
the existing Linux executable command also built successfully. Both retain bytecode.
Linux execution/production qualification was not performed.

The actual development server, built full-stack server, and standalone native
executable passed direct navigation to all deferred routes, enrollment, browser
Back/Forward, and Controller entry without another JS/CSS request. Built and compiled
servers also passed an aborted dynamic-chunk request followed by the alert and a
successful Reload page. Explicit HTTP probes confirmed status 200, JavaScript MIME,
and non-HTML bodies for initial, deferred, and shared JS assets. The compiled probe
ran from a directory containing only its executable, using its embedded assets.
Desktop (1280×800) failure/retry and mobile (390×844) Controller screenshots were
inspected; no unexpected page errors or blank/overlay screens occurred. This browser
probe validates route delivery and admission screens, not a complete authenticated
administration workflow or all browser engines.

184 relevant Fast Tests passed, covering route UI, loading/rejection, Controller
actions/reconnect/departure, authorization, and bundle analysis. `bun run lint:fix`,
`bun run format`, `bun run check`, ordinary analysis build, native compilation, and
the existing Linux executable build passed. No Qualification Tests ran.
