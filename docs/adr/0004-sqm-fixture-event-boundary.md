# Keep the SQM presentation fixture outside the Event Catalog

- Status: accepted
- Date: 2026-08-16

For the Schweizer Quadball Meisterschaft 2026 live screen, expose a temporary SQM Fixture Event through the public Audience Projection instead of seeding Event Catalog records. Its four scheduled rows resolve to Protected Fixture Ad Hoc Games keyed by `secret1`–`secret4`; those protected records are durable, excluded from the ordinary 50-game capacity and cleanup, and publicly readable only through the allowlisted SQM Event paths. Secret-key activation is accepted only on 16 August 2026 in the Event's Europe/Zurich timezone, while created records and spectator views remain available afterward.

This keeps the time-critical presentation path separate from Event administration, Event Game authority, and audit semantics while allowing the existing Ad Hoc Controller workflow to operate the games.
