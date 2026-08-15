# Compiled SQLite runtime gate

`bun run check:sqlite-runtime [compiled-executable]` is the intentional, separately named #179
Qualification Test. It is outside `bun run check`, `bun run test`, automatic CI, and deployment.

The command runs the exact `bun-linux-x64-modern` executable in one newly created disposable Docker
container on a native Linux x86-64 Docker engine. The host and engine identity must be unambiguous;
macOS, emulated architectures, ambiguous identity, unavailable images, and failed containment
admission stop before the SQLite workload starts. The container uses `--network=none`, a read-only
root filesystem, one OS-enforced 16 MiB writable `/tmp` tmpfs, a read-only executable bind mount,
512 MiB memory, an 8-process Docker limit, dropped capabilities, and `no-new-privileges`. It
receives only a fixed sanitized environment. Docker daemon logs use the bounded `json-file` driver
with `max-size=4k` and `max-file=1`, in addition to the harness read cap. No Production path, credential, host namespace, host
cgroup, root login, or host network is used.

The exact workload remains six independent writers, exactly 6,000 committed rows, and 5,000
passive checkpoint attempts. The supplied artifact must report native Linux/x64, the Bun version
pinned by this repository's `packageManager`, a well-formed captured Bun revision, and a supported
embedded SQLite version. A version-shaped but arbitrary identity is not accepted. The gate keeps
its 15-second outer deadline, five-second work budget, 512 MiB memory, 8-process Docker limit,
16 MiB tmpfs, 4 KiB captured diagnostics, single-attempt correctness rule, bounded pre-cleanup and
final evidence, and verified owned-container cleanup.

The focused command `bun run test:focused-admission` uses the same production Docker admission,
start, stop, wait/reap, exact-identity, removal, and absence-proof boundary with a harmless
filesystem/environment helper. It never mounts or launches the SQLite artifact. It may report a
bounded blocker on non-native hosts and is not a Qualification Test. The separately named
`bun run test:focused-signal` sends real SIGINT, SIGTERM, and SIGHUP to the outer runtime entrypoint
and verifies the same bounded stop/kill/wait, owned cleanup, and evidence path.

Every terminal path emits bounded pre-cleanup and final evidence. Pre-cleanup never claims cleanup;
final evidence distinguishes descendant termination, wait/reap, exact identity verification,
container removal, temporary-data disposition, cleanup failures, and evidence-emission failures.
A final evidence sink failure does not turn verified container cleanup into a cleanup failure, and
the truthful pre-cleanup record remains retained. Missing first stats samples on a normally short
workload remain unavailable rather than causing a false resource failure; an observed ENOSPC path
retains `diskBytes: null` with a named `disk-lower-bound` violation while the 16 MiB tmpfs remains hard enforced. Raw workload
files, temporary data, and diagnostics are removed after verified cleanup; only redacted structured
evidence is retained in the coordinator handoff.

Only explicit release qualification or coordinator-directed native-Ubuntu verification may invoke
the Qualification Test. It must never be automatic or retried. The gate may change or be removed
only with explicit maintainer approval supported by evidence that the exact-artifact SQLite/WAL risk
has disappeared or is established by a cheaper trustworthy proof.
