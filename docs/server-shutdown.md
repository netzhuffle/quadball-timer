# Server shutdown

SIGTERM and SIGINT share one shutdown promise. Signal handlers are installed after
startup completes, so a startup continuation cannot reopen admission after a drain.
A startup exception drains any background work already acquired before the existing
reverse-order resource cleanup. One resource's cleanup error does not skip others.

Shutdown stops dynamic HTTP and WebSocket message admission, pauses Technical Admin
retention, Event reconciliation, public projection refresh, and Ad Hoc disconnect
retry scheduling. Static HTML assets have no storage work and stop with the listener.
Existing sockets receive code 1012 (service restart); their durable disconnect work
is tracked, including queued subscriptions. Requests, admitted socket messages,
background reconciliation and public refresh reads retain storage ownership until
they settle. A successful Control Action response still follows its existing durable
commit. Disconnected Controllers use the unchanged reconnect and operation-ID replay
protocol; shutdown does not change accepted action or replay acknowledgement rules.

Bun's asynchronous [`server.stop(false)`](https://bun.com/reference/bun/Server/stop) stops connection admission and waits for
connections to close. The server allows eight seconds for this and owned JavaScript
work, then calls `server.stop(true)` and allows one more second for forced connection
closure and owned work to settle. Bun force-stop does not cancel JavaScript promises.
If work remains or force-stop fails, shutdown reports failure and exits nonzero
without explicitly closing storage underneath those continuations. Process exit
ends the continuations; it is not an asynchronous SQLite flush. A synchronous SQLite
transaction runs to completion before the JavaScript deadline callback can execute.
Already committed
SQLite transactions retain the existing durability contract, and unacknowledged
Controller work retains the existing replay path. No new durability claim is made
for an operation that had not committed.

Storage closes once, after the connection stop promise and the final owned-work
barrier. Stop rejections and cleanup failures report failure and exit nonzero.
Diagnostics distinguish graceful, forced, and failed completion and include pending
work and error counts. Both tracked native systemd units allow fifteen seconds via
`TimeoutStopSec`, enclosing the nine-second application deadline. Release activation
continues to wait synchronously for `systemctl stop` before taking its backup. No
Production unit installation or live manager configuration is performed by this change.

`bun test src/lib/server-drain.test.ts` uses injected promises and deadlines.
`bun run test:focused:server-drain` separately checks an admitted HTTP request and
WebSocket through a disposable loopback Bun server. It is outside ordinary tests and
CI and uses no Production data or Qualification workload.
