# Testing policy

Read this policy before adding, changing, reviewing, or running a qualification, soak, load, crash, recovery, or exact-production-artifact test. This document is the single source of truth for the testing taxonomy, execution boundaries, qualification admission contract, evidence rules, and registry.

Command names and their ordinary behavior belong to `package.json` and the command's `--help` output. This policy records the reasons and boundaries that those files cannot express.

## Route first

Classify the request before reading the qualification sections:

1. **Fast Test or ordinary review:** use the ordinary boundary, then stop. Do not inspect or execute Qualification Test harnesses.
2. **Focused Integration Test:** use its separately named intentional command when the owning boundary or acceptance criteria require it, then stop. Do not route it through the Qualification Test registry.
3. **Qualification Test:** require explicit intent, one named workload, and a complete registry entry; continue through admission, harness, evidence, and lifecycle checks below.

## Test classes

Classify an executable test by its purpose, risk, and execution boundary. Duration is a review signal, not the classifier.

| Class | Purpose and boundary | Invocation and review target |
| --- | --- | --- |
| **Fast Test** | Deterministic, hermetic verification suitable for every implementation loop and ordinary automatically triggered CI. It uses injected clocks, processes, filesystems, and other seams instead of slow real workloads. | Ordinary test commands and automatic CI. The complete ordinary suite targets at most 10 seconds and an individual test file at most 2 seconds on the reference environment. |
| **Focused Integration Test** | Deterministic, isolated verification across real component or artifact boundaries. It proves an owned boundary that unit-level Fast Tests cannot prove while keeping its inputs and targets disposable. | A separately named intentional command when its owning boundary changes or task acceptance requires it. It targets at most 60 seconds and stays outside ordinary test/check commands and automatically triggered CI. |
| **Qualification Test** | A separately named, production-shaped command that proves one acceptance or release risk that cheaper evidence cannot establish. It may exercise load, soak, crash, recovery, or an exact production artifact. | Explicitly requested by name and admitted by a complete registry entry. It runs locally and natively by default; a registry entry may authorize a manually dispatched isolated CI workflow when its platform or artifact requirement justifies that venue. |

The timing values are review targets, not hard assertions. Crossing one requires investigation and an explicit decision; elapsed time alone does not reclassify a test or justify weakening or removing it.

### Issue #75 generated convergence coverage

The fixed-seed 1,000-sequence Event Game correction test remains a Fast Test: it uses the in-memory adapter, injected clocks, and deterministic action fixtures. After splitting the correction tests, the generated file measured 2.54 seconds on Darwin arm64 with Bun 1.3.14, narrowly over the two-second per-file review target while remaining within the ten-second ordinary-suite target. The test retains the required 1,000 sequences and is not weakened; revisit the implementation if the file grows materially or the ordinary suite approaches its ten-second target.

The reference environment for timing review is the supported Bun version from `package.json` on a native development environment. Record the operating system, architecture, Bun version, and relevant resource measurements when investigating a target overrun.

## Ordinary execution boundary

The ordinary boundary is:

- ordinary test commands run Fast Tests only;
- `check`, ordinary implementation, and ordinary code review do not run Focused Integration Tests or Qualification Tests;
- automatically triggered CI and deployment workflows run Fast Tests only, plus the existing quality and build work they already own;
- Focused Integration Tests use distinct commands and are intentional task work;
- Qualification Tests use distinct commands and are never inferred from a request to test, check, build, implement, or review.

An isolated GitHub Actions workflow is allowed only when a complete registry entry authorizes it, it is manually dispatched, and it has no deployment dependency, Production credential, or Production target. Local/native execution is the default.

For a Fast Test, ordinary review, or Focused Integration Test, this ordinary boundary is the completion point. Continue into the qualification sections only for an explicitly named Qualification Test or qualification-related workload that needs registry routing.

## Qualification admission contract

The active registry below is intentionally empty on `main`. A command is not a Qualification Test merely because it is slow, production-shaped, mentioned in an issue, present on another branch, or useful as a research probe. Do not add speculative candidates.

Every registered entry must be complete before the command can run. The entry must identify:

1. the exact separately named command and the owning subsystem or acceptance concern;
2. one unique protected acceptance or release risk;
3. why Fast Tests and cheaper Focused Integration Tests cannot establish that property;
4. the required platform, artifact, and isolation boundary;
5. the expected native duration and resource envelope;
6. hard timeout, process-count, memory, disk, output, and descendant-cleanup behavior;
7. the approved invocation occasions and any authorized manual CI venue;
8. network destinations, credential rules, filesystem targets, and Production exclusions;
9. the structured result and diagnostic evidence produced before cleanup, plus retention;
10. the evidence-based condition under which the test may be weakened, replaced, or removed.

The owner is a subsystem or acceptance concern, not a person's name. An optional tracker link can provide context but cannot replace the entry's durable justification. An agent may add a complete entry during normal implementation review only when its governing task explicitly requires that Qualification Test. Weakening, replacing, or removing an entry requires explicit maintainer approval tied to evidence that its protected risk changed, disappeared, or is established more cheaply. Runtime inconvenience alone is insufficient.

### Active Qualification Test registry

There are currently no registered Qualification Tests.

The committed security proof-of-concept programs under `docs/security/findings/` are research evidence and remain outside this executable-test taxonomy. Human-only device, accessibility, deployment, restore, and rehearsal procedures are operational acceptance work and also remain outside it.

### Main-branch inventory

The production-shaped compiled-executable SQLite/WAL probe described in `docs/research/sqm-2026-safe-platform-baseline-refresh.md` was a completed disposable research run, not a maintained command committed on `main`. Its documented exact-artifact and concurrency gates are follow-up acceptance work for the future platform/package delivery they concern; they are not an active Qualification Test and are not executable through this policy. If that probe becomes a maintained command, its governing implementation task must add one complete registry entry before execution.

## Harness contract

The Qualification Test harness owns its own safety behavior. Before admission, the skill must be able to verify these guarantees in the command, its source, or its supporting documentation; it does not dynamically wrap or repair an unsafe command.

Every harness must:

- enforce a hard wall-clock timeout and bounded process count, memory, disk, and captured output;
- isolate every target and use only owned filesystem paths;
- deny network access by default; authorize loopback or an isolated disposable non-Production target only when the registry entry says so, and explicitly allowlist every other destination;
- use only purpose-specific non-Production credentials when credentials are unavoidable; Production credentials, Production targets, and Production/server data are prohibited;
- own the full descendant process tree, handle interruption and timeout, terminate descendants, and verify termination;
- clean its owned temporary data on success, failure, interruption, and timeout;
- run a correctness failure exactly once, without automatic retry;
- emit the bounded result record before cleanup.

Before any real workload is admitted, deterministic Fast Tests must cover the harness orchestration and safety boundaries through injected clocks, process runners, filesystem seams, and other test doubles. Those tests cover timeout, interruption, output and resource limits, target and credential gating, descendant cleanup, result emission, and the no-retry rule without launching the expensive workload.

## Evidence and retention

Raw workload files are transient. Each invocation creates a unique, validated directory beneath the operating system's temporary directory; it does not write evidence under the repository's `out/` directory. Workload files and diagnostics are bounded by the registry entry.

Before removing that directory, the harness emits a capped structured result containing:

- command identity and commit;
- platform and start/end timestamps;
- duration and measured resource use;
- outcome and cleanup result;
- evidence location or transient-cleanup disposition;
- references to capped diagnostics.

The harness removes its owned temporary directory on every terminal path. Durable evidence is exceptional: it must be redacted, have an explicit destination and retention period in its registry entry, and contain no Production data or credentials. A run must not leave old raw evidence in `/tmp`.

## Registry lifecycle

Review a registered Qualification Test when its owning boundary, production artifact, or protected risk changes. Re-check whether cheaper evidence now proves the same property. If the risk no longer applies or a cheaper trustworthy proof replaces it, an explicitly approved change may reduce, replace, or remove the entry. A slow run, developer impatience, or CI cost without a changed risk is not enough.

## Deterministic routing evaluation

These cases are the policy's routing contract. They are evaluated by reading the registry and request; no expensive workload is launched to validate the policy or the skill.

| Request shape | Expected result | Launch a command? |
| --- | --- | --- |
| Explicitly asks to run one named registered Qualification Test | Complete registry preflight, then invoke exactly that command if every safety check passes | Yes, once |
| Explicitly asks to validate or review one named Qualification Test | Inspect policy, registry, and harness contract; report findings and routing | No |
| Asks to run tests, `bun run test`, `bun run check`, build, implement, or review | Stay on the ordinary boundary | No |
| Names no Qualification Test, names multiple tests, or supplies parameters that differ from the entry | Clarify or refuse the ambiguous request | No |
| Names an unregistered, redundant, incomplete, or unsafe test | Refuse with the missing admission or safety reason | No |
| Names a test while the active registry is empty | Refuse clearly and launch nothing | No |

The explicit name is execution authority after preflight; a redundant confirmation is not required. Review-only requests always remain non-executing.
