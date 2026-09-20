# Development and browser launcher lifecycle

Use the package commands, such as `bun dev` and
`bun run test:focused:event-game-controller-browser`. They pass `--no-orphans`
to their owning Bun process. Direct `bun scripts/test-…` invocations bypass
that policy; include `--no-orphans` when invoking these files directly.
The mobile Controller aggregate also passes the flag to each child journey.

## Ownership and cleanup

| Launcher | Owned processes |
| --- | --- |
| `dev` | Hot-reloading application runtime and any runtime descendants |
| Technical Admin browser | Application server, bootstrap CLI, certificate/curl helpers, Chromium and its helpers; includes intentional server restart |
| Event Admin WebKit | Application server, certificate helpers, WebKit and its helpers |
| Public Event browser | Application server, certificate/curl helpers, Chromium and WebKit trees |
| Event Game Controller browser | Application server, certificate/curl helpers, Chromium and WebKit trees |
| Ad Hoc browser | Application server, certificate/curl helpers, Chromium tree; includes intentional server restart |
| Mobile Controller aggregate | Ad Hoc and Event Game Controller journeys, sequentially, and their descendants |

Existing browser/context closure, server TERM/wait/KILL fallback where present,
output capture, failure diagnostics, and temporary-file cleanup remain the primary
normal-completion path. Server draining remains owned by the application.
The flag does not replace these steps: surviving descendants are forcibly killed
when the launcher exits. Parent loss is emergency containment and does not promise
browser flushing, application draining, or JavaScript `finally` execution.
No flag is set globally in `bunfig.toml` or the environment; production, builds,
ordinary tests, and Qualification commands retain their existing lifecycle policy.

[Bun's 1.4 release documentation](https://bun.com/blog/bun-v1.4#no-orphans)
and Bun 1.4.2 `bun --help` describe original-parent monitoring and recursive
termination of descendants on exit. Bun documents Linux/macOS support and Windows
Job Objects. This repository's browser launchers and verification are supported on
macOS and Linux: they use POSIX signals and native command-line helpers. Windows
browser lifecycle behavior has not been verified here. On Unix, killing the
flagged Bun process itself with uncatchable SIGKILL bypasses its exit cleanup;
parent-loss protection means killing its **parent**, allowing Bun to perform the
cleanup. Do not treat this as OS-level containment of deliberately detached or
already-reparented processes.

## Intentional verification

`bun run test:focused:launcher-lifecycle` is a Focused Integration Test, outside
ordinary `test`, `check`, and CI. It needs no network, server, database, or browser
installation. It creates disposable Bun/native-sleep descendants, verifies normal
completion (including a nonzero exit status), SIGINT, SIGTERM, original-parent
loss, and same-process `--hot` reload. Normal and signal paths verify explicit
cleanup and retained stdout/stderr before the fallback removes a residual child
and native grandchild. Every teardown checks all recorded PIDs are absent and an
unrelated sibling remains alive. It only signals recorded owned PIDs, never names
or process groups. Temporary files are removed after the run.

The whole check has a 25-second watchdog, each readiness/absence wait has a
three-second deadline, and fixtures self-expire within 20 seconds. At most seven
fixture processes coexist, output is fixed and small, and no application workload
or Qualification harness is launched. The ordinary Fast Test locks the narrow
command scope and keeps this check out of ordinary execution.

Verified on Darwin arm64 with Bun 1.4.2 (50a8a8387): all five scenarios passed in
under one second; normal/interrupt statuses were 23/130/143, parent supervisor
loss returned 137, all recorded descendants disappeared, and the unrelated
sibling survived. Linux and Windows were not executed for this change. Existing
full browser journeys exercise browser behavior separately; the disposable tree
check establishes launcher/native-descendant semantics without asserting browser
correctness or production qualification.

The existing Event Game Controller browser journey was also invoked with and
without the flag after installing Playwright 1.63's pinned Chromium 1243 and
WebKit 2359. Both returned status 1 with the identical pre-existing Chromium
layout assertion: primary control 0 (`y=380`, height `44`) intersects the covered
region (`y=385`, height `405`) at `390x844`. This confirms failure status and
useful diagnostics survive the launcher change, but is not a passing full
browser compatibility result; the WebKit portion was not reached. No UI
assertion was changed or weakened for this launcher work.
