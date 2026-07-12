# Security evidence

This directory preserves the evidence behind the current-implementation
findings from the Codex Security scan recorded in
[Application Security Audit](../research/application-security-audit.md).
The reviewed source revision is
`caa5dac848e9e865524e44f30becae725048bcdc`.

These reports describe the implementation that existed at that revision. They
do not claim that the planned grant, recovery, projection, persistence, audit,
secret-handling, denial-of-service, or deployment design has been reviewed.
That work is tracked by
[issue #39](https://github.com/netzhuffle/quadball-timer/issues/39).

## Finding evidence

| Finding | Severity | Evidence bundle |
| --- | --- | --- |
| Anonymous clients can self-assert Controller authority | High/P1 | [Report and PoC](findings/self-asserted-controller-authority/self-asserted-controller-authority.md) |
| Unbounded command batches block the shared game service | High/P1 | [Report and PoC](findings/unbounded-command-batch/unbounded-command-batch.md) |
| Unbounded numeric command values corrupt game state | Medium/P2 | [Report and PoC](findings/unbounded-numeric-game-state/unbounded-numeric-game-state.md) |
| Unbounded Team names are retained and repeatedly amplified | Medium/P2 | [Report and PoC](findings/unbounded-team-names/unbounded-team-names.md) |
| Anonymous game creation can retain unbounded server state | Low/P3 | [Report and PoC](findings/anonymous-game-creation/anonymous-game-creation.md) |

Each bundle records the threat actor, root cause, source path, bad state,
impact, validation basis and limits, bounded local reproduction, and the
invariant that remediation must restore. The PoCs are acceptance evidence for
[issue #38](https://github.com/netzhuffle/quadball-timer/issues/38): after a
fix, each relevant PoC must fail before vulnerable state is mutated or
retained.

## Safe reproduction

Use only a disposable local checkout of the reviewed revision. Do not point
the network PoCs at a public or production deployment. From the repository
root, start the vulnerable server on an unused loopback port:

```sh
PORT=45134 bun src/index.ts
```

Run the command shown in the selected report from its `poc` directory, setting
`TARGET` or `TARGET_BASE_URL` to `http://127.0.0.1:45134`. The numeric-state
PoC is a non-network semantic probe. Stop and restart the local server between
runs when clean in-memory state matters.

The full bounded set was rerun locally on 2026-07-12 against the reviewed
implementation:

- unauthenticated Controller subscription changed a disposable game's score;
- a 1,000-command batch produced 1,000 acknowledgements after synchronous
  processing;
- two finite `1e308` inputs produced `Infinity` in game-clock arithmetic and
  `null` on the JSON wire;
- a 100,000-character Team name was retained in a returned snapshot; and
- 25 anonymous creation requests created 25 additional retained games.

The reports also preserve the stronger scan measurements where applicable,
including the 5,000-command batch and 1,000,000-character Team-name parser
validation.
