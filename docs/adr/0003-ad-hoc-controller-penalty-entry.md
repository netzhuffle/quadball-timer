# Ad Hoc Controller penalty entry is staged

- Status: accepted
- Date: 2026-08-16

## Decision

Ad Hoc Controller action panels use a compact, viewport-aware bottom surface. The surface is attached directly to its Cards/Timeout/Game end navigation, keeps the clock and score controls available whenever the viewport permits, and scrolls only its content when the available height is insufficient. This change is Ad Hoc-only; Event Controller UI and Event card semantics remain unchanged.

Ad Hoc Card entry is delivered in two stacked implementation layers:

1. The first layer is backend-neutral. It makes the Card panel a short wizard (`Card type → Game Side → player number`) and retains the existing final `add-card` command, so a penalty is recorded only after a valid number is entered. `Undo` navigates to the previous uncommitted step; closing the panel discards only the uncommitted draft.
2. The second layer extends Ad Hoc durable state. Selecting type and Game Side records an Ad Hoc Penalty immediately with no player number. The resulting fact keeps its original Game Clock time. A Controller may then assign or correct its player number, card type, or Game Side by selecting the exact visible penalty; `Back` leaves the committed fact intact. Number entry with `OK` may intentionally leave the number absent.

Both layers use the same exact penalty fact identity for later edits. No edit may infer the latest penalty or change the original entry time.

## Context

The existing all-at-once Card form consumes most of a phone viewport and makes the action surface compete with the clock and score controls. A two-layer rollout keeps the first visual/interaction improvement independently deployable while reserving durable correction semantics for a separately reviewable change.

## Consequences

- Ad Hoc Controllers can complete ordinary numbered-card entry without a backend protocol change in the first layer.
- The second layer supports unknown-number penalties and later correction without losing elapsed-time semantics.
- `Undo` is only pre-commit navigation. A committed penalty has no destructive remove action; `Back` returns to the sheet without removing it.
- Event Controller layout and card behavior are deliberately outside this decision.
