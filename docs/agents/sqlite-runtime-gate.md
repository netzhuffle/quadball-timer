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
bounded by a 15-second total deadline covering setup, workload, evidence, result handling, and
cleanup, with five seconds reserved for final termination, cgroup/filesystem cleanup, and final
evidence; at most seven observed workload descendants, an OS-enforced 512 MiB cgroup peak-memory
limit, an OS-enforced 16 MiB temporary `tmpfs` disk, 4 KiB raw-byte captured diagnostics, and a
small temporary workspace. The exact
writer/checkpoint workload must not be reduced, deleted, retried automatically, or moved into
ordinary tests without an explicit acceptance decision because fast unit tests cover orchestration
and safety boundaries, not this compiled-runtime property. The wrapper owns a sanitized
no-credential environment, a private temporary container, and one detached process group; the
inner worker deadline is five seconds, leaving cleanup and final
reaping margin inside the outer 15-second deadline. A stubborn descendant is terminated with TERM
then KILL, and the wrapper removes the owned container after bounded reaping. One wrapper-owned
`unshare --user --map-root-user --mount --net` namespace both verifies the network boundary and
executes the artifact; no separately verified disposable namespace is reused. The wrapper makes
host mounts read-only in that private namespace, mounts the owned workspace as the only writable
16 MiB `tmpfs`, sets cwd and `TMPDIR` inside it, and fails closed if any writable host mount cannot
be sealed. Its readiness marker is emitted only after namespace, tmpfs, network, and cgroup setup;
the parent then verifies the artifact cgroup before sending the bounded release signal.
After launcher self-attachment, `/sys/fs/cgroup` is bind-remounted read-only and positively
verified with non-empty `ro` and absent `rw` options before readiness is emitted.

Each invocation creates one capability-marked cgroup root below a validated delegated parent.
Helper and workload controllers are children of that root; broad, pre-existing, symlinked,
replaced, or ambiguous targets fail closed, and path/inode/marker evidence is revalidated before
kill or removal. Members of the invocation root itself are included in TERM/KILL, reap,
emptiness, and removal checks; an empty leaf does not make a populated root safe to certify.
Partial creation or cleanup returns explicit retained-controller evidence, keeps the capability
marker while any owned target remains, and blocks generic workspace cleanup until the host
controller is verified gone. The workload child has `pids.max=8`: the outer artifact process plus the seven
registered descendants. Admission/controller helpers use the sibling helper child. The
harness measures `pids.current` and `pids.peak`, cgroup peak memory, bounded raw output, and the
final wrapper disk marker; wrapper control frames (`READY`, `DISK_BYTES`, and `TMPFS_REMOVED`) stay
on stderr so the exact artifact JSON remains the sole stdout document. The wrapper leaves the
mounted workspace as its cwd before unmounting it; `tmpfs` remains the hard disk enforcement
mechanism, so sampling cannot permit an overrun or a reparented/setsid descendant to escape.

The deadline is a composed safety budget, not a copied workload observation: the 10-second
admission/work window leaves up to 1 second for namespace/tool admission, 5 seconds for the inner
artifact gate, and 4 seconds for private-controller setup and evidence handling; the 5-second
cleanup reserve covers the 250 ms TERM grace, 1 second cgroup-wide reap, private mount/controller
teardown, and bounded result construction/emission with remaining margin. The separately named
`bun run test:focused-admission` gate measures safe native namespace/cgroup/tmpfs/readiness,
sampling, emitter, and teardown components with a harmless filesystem-boundary helper (never the
Qualification workload); `bun run test:focused-signal` records native startup and signal-to-exit
measurements for all three installed signals, including direct-child-exit descendant cleanup.
The focused-admission command retains capped portable JSON under one five-second lifecycle
deadline with a two-second cleanup reserve. On a non-Linux-x86-64 host it records a blocker and
null native measurements without attempting the Qualification workload. The production budget
remains conservative but is not empirically accepted until harmless native Linux x86-64 evidence
is captured.

Before removing that container on every terminal path, the wrapper emits one capped pre-cleanup
JSON result with cleanup pending and `temporaryDataRemoved: false`; after bounded cleanup it emits
a separately retained final JSON result with verified cleanup success or failure. Both records carry
the exact command, current commit, platform and Bun/SQLite identity, timestamps, duration, measured
resources, outcome, separate descendant termination/reap, controller-empty/removal,
tmpfs/workspace-removal facts, bounded retained-controller state, named cleanup failures, and
truthful evidence disposition/retention, and
raw-byte references to capped diagnostics. Unavailable failure-path measurements are `null`; raw
database files and diagnostics are never retained. Focused-admission evidence reports descendant
termination/reap, controller empty/removal, tmpfs removal, workspace removal, retained-controller
state, and named failures as separate facts; its total duration is measured after bounded teardown
and evidence emission. A non-native run records the platform blocker and null native measurements
without attempting the Qualification workload.
