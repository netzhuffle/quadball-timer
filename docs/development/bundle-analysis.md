# Browser bundle analysis

Run `bun run build --analyze` with the pinned Bun version after `bun install --frozen-lockfile`.
This performs the ordinary full-stack build and writes `out/bundle-analysis/report.md`,
`report.json`, and raw `metafile.json`. Reports stay outside `dist`, are git-ignored,
and are not part of the HTML asset manifest. The console also shows the readable report.
Custom `--outdir` works provided it does not overlap `out/bundle-analysis`.

The report consumes the actual `src/index.ts` full-stack build metadata, including the
nested `src/index.html` browser graph. It fails if that nested graph is unavailable;
it never substitutes server bytes for browser bytes. A separate HTML-only build is
not equivalent: with Bun 1.4.2 it produced different browser output than this full-stack
build. Browser roots come from generated HTML; static chunk imports and associated
CSS are initial, while dynamic imports are deferred. Source maps are excluded from
initial download totals. Raw metadata retains every import edge and import kind;
the summary supplies one shortest inclusion chain per browser module.

`emittedBytes` is the exact uncompressed artifact size, not compressed HTTP transfer
size. `metadataBytes` is Bun's output-byte accounting, which can exclude generated
HTML and source-map reference overhead. `bytesInOutput` attributes emitted code to
modules; it does not predict savings from removing a route. Shared dependencies and
bundler overhead prevent adding module sizes to infer transfer savings. `inputBytes`
is source size before bundling. A non-entry output reached through browser imports
is labelled `shared-chunk`; inspect its importing edges to see its actual consumers.

For comparisons, retain a copy of the three report files outside the checkout, build
the other revision with the same Bun/lockfile/flags, and compare initial emitted totals,
entry/chunk sizes, and per-module contributions keyed by module path (chunk hashes
will change). The report records Bun version, source commit, dirty state and flags.
Use clean commits for final comparisons. Changes to minification, source maps, packages,
or environment handling must be held constant. The baseline below uses default flags.

`bun run build` and `bun run build:executable` remain unchanged and do not create
reports. `--analyze --compile` is deliberately rejected before output cleanup: the
compiled result does not expose ordinary emitted browser artifacts for exact size
accounting. Run the ordinary analysis command before compiling. No server, browser
session, Production target, or Qualification workload is launched by analysis.

## Eager baseline

Measured on Darwin arm64, Bun 1.4.2 (`50a8a8387`), application source commit
`250aa0bf34619a35018772e006adad382c6f23ba`, frozen lockfile, default minification and
linked source maps. The analysis-only changes do not alter application sources.

| Output | Uncompressed emitted bytes | Bun metadata bytes |
|---|---:|---:|
| Browser JS `chunk-4nkc5swb.js` | 1,212,151 | 1,212,062 |
| Browser CSS `chunk-85ebmd2z.css` | 76,930 | 76,930 |
| Browser HTML | 404 | 365 |
| Server `index.js` | 1,820,208 | 1,819,549 |

Initial browser JS/CSS: **1,289,081 bytes**. There are no separate shared or deferred
chunks in this eager baseline. All routes use the same initial HTML/browser graph.

Every candidate below is statically reachable through
`src/index.html → src/frontend.tsx → src/App.tsx → src/pages/<page>`:

| Candidate route | Page | Attributed bytes in initial JS |
|---|---|---:|
| `/event-admin` | `event-admin-page.tsx` | 58,826 |
| `/admin`, `/admin/enroll` | `technical-admin-page.tsx` | 20,017 |
| `/pitch-manager` | `pitch-manager-page.tsx` | 11,500 |
| `/prototype/event-operations` | `event-operations-prototype-page.tsx` | 9,063 |
| `/color-test` | `color-test-page.tsx` | 2,203 |

The operations prototype also pulls in its large-event (11,909 bytes), slot-setup
(8,518), pitch-reassignment (4,660), event-hub (2,724), schedule-shift (2,604), and
lens-switch (465) modules. Event Administration also includes the audit browser
(5,424). These uncommon administrative/prototype routes are the first splitting
candidates for #326. Controller pages are also eager (`event-game-controller-page.tsx`
56,450; `game-page.tsx` 19,701), but this ticket does not change route loading.
Public Event pages contribute 27,041 bytes and should be evaluated as the common
landing path when measuring the follow-up. The module numbers are evidence of eager
inclusion, not guaranteed savings; remeasure after splitting.

Bun sources: [build metadata](https://bun.com/reference/bun/BuildOutput/metafile),
[full-stack HTML loader](https://bun.com/docs/bundler/loaders).
