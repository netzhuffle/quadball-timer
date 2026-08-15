# Controller leave is resumable for five minutes

- Status: accepted
- Date: 2026-08-15

## Decision

Leaving an Ad Hoc Game or Event Game requires confirmation and starts a five-minute Controller Leave Grace Period instead of immediately and irreversibly revoking that browser's control authority. Home prominently offers return to the most recently left Game without a countdown; the opportunity survives an ordinary browser restart, and current Game, Grant, lock, reassignment, removal, and expiry rules still take precedence.

Creating, joining, or resuming control of a different Game requires confirmation that the previous Game will no longer be resumable. Browsing Home or public Event pages does not end the opportunity. Returning while offline restores the locally retained Controller state and reconciles authority when connectivity returns.

The five-minute user-facing deadline is primarily client-side. An online departure may coordinate the deadline and final revocation with the server, while a departure started fully offline is enforced locally and finalized at the next server contact; the server may therefore retain the session longer without extending what the browser offers to the Controller.

## Context

The Controller often cannot recover the Control QR after leaving, so a single accidental touch could otherwise destroy the only practical route back into an active Game. Immediate revocation is safer in isolation but disproportionately risky during live event operation, especially on a small touch screen or during intermittent connectivity.

## Consequences

- Leave is a reversible departure for five minutes, not an immediate logout.
- Only one Game per browser is resumable, avoiding a new retained-Game history or recovery interface.
- External authority changes always defeat local return.
- Offline expiry is intentionally best-effort at the server boundary; no background mechanism exists solely to make both deadlines identical.
- Other Controllers and ongoing Event operations remain unaffected.
