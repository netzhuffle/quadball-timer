# Compiled SQLite runtime gate

`bun run check:sqlite-runtime [compiled-executable]` is an intentional, separately named #71
qualification command. It is not part of `bun run check`, `bun run test`, or an automatic
deployment workflow.

The command runs the exact compiled executable with a private temporary database and six
concurrent writers (6,000 committed rows) plus 5,000 passive WAL checkpoint attempts. It proves
the #71/#70 acceptance risk that a version label alone cannot establish: the delivered Bun
revision and embedded SQLite build preserve concurrent-write and checkpoint integrity. The gate
rejects SQLite earlier than 3.51.3 and failed integrity as a human database-choice decision.

Run it deliberately on the native Linux artifact during release qualification or the coordinator's
bounded native-Ubuntu verification. A native run should normally finish in under a second and is
bounded by a 15-second watchdog, capped diagnostics, and a small temporary workspace. The exact
writer/checkpoint workload must not be reduced, deleted, retried automatically, or moved into
ordinary tests without an explicit acceptance decision because fast unit tests cover orchestration
and safety boundaries, not this compiled-runtime property. The wrapper owns a private temporary
container and one detached process group; the inner worker deadline is five seconds, leaving
cleanup and final reaping margin inside the outer 15-second deadline. A stubborn descendant is
terminated with TERM then KILL, and the wrapper removes the owned container after bounded reaping.
