---
name: run-qualification-tests
description: "User-invoked guard for explicitly requested qualification, soak, load, crash, recovery, or exact-production-artifact tests. It excludes ordinary implementation, code review, bun run test, bun run check, build requests, and automatically triggered CI."
---

# Run Qualification Tests

Read `docs/agents/testing.md` first. That policy is the sole source of truth for classification, registry data, safety limits, evidence, and retention; this skill contains only the execution procedure.

## Procedure

1. Identify the request mode: run, validate, or review. Continue only when the user explicitly asks about exactly one named qualification-related workload, such as a Qualification, soak, load, crash, recovery, or exact-production-artifact test. Treat an ordinary test, check, build, implementation, or review request as outside this skill. Clarify or refuse a missing name, multiple names, or parameters that do not match the registered command.

2. Read the active Qualification Test registry in `docs/agents/testing.md`. If it is empty, or the named command is absent, redundant, incomplete, or unsafe, refuse and state the reason without launching anything.

3. Confirm that the entry's unique acceptance or release risk still exists and is not already established by cheaper evidence. For validate/review requests, report the inspection without execution and stop here.

4. For a run request, verify the target platform and artifact, disposable isolation, owned filesystem paths under the operating system's temporary directory, hard timeout, bounded process/memory/disk/output limits, process-tree cleanup, interruption handling, network allowlist, and absence of Production credentials or targets. Verify that the harness itself owns these controls and that deterministic Fast Tests cover its orchestration and safety seams.

5. Invoke exactly the registered command and authorized parameters once. Do not add a wrapper, repair an unsafe harness, or automatically retry a correctness failure.

6. Verify that the harness terminated its full descendant process tree and cleaned its owned temporary directory on success, failure, interruption, and timeout. Before cleanup, require the capped structured result defined by the policy. Do not retain raw temporary files.

7. Report the command identity, commit, platform, start/end timestamps, duration, measured resource use, outcome, cleanup result, evidence location or transient-cleanup disposition, diagnostic references, and whether the protected risk still justifies retention. If any verification fails, report the failure and do not claim a clean run.

Completion means the request was routed according to the policy, and a run report contains every required result and cleanup field. A refused or review-only request completes without executing a workload.
