# Durable Event Game runtime

The live Event Game Controller runtime is enabled only when all three required
key-ring variables are configured. Each value is exactly 32 bytes encoded as
unpadded base64url:

- `EVENT_GAME_ENCRYPTION_KEY`
- `EVENT_GAME_LOOKUP_KEY`
- `EVENT_GAME_AUDIT_KEY`

If any value is missing or malformed, the server keeps the durable Controller
routes unavailable and does not invent a production secret. `EVENT_GAME_DATABASE`
is optional; when omitted, the runtime database is
`data/<technical-admin-environment>/event-game.sqlite`. Secret provisioning and
deployment scope are owned by deployment operations, not by the application.
Before startup, deployment operations must apply the currently approved
Foundation migrations to this database. Runtime startup only checks schema
readiness and compatibility; it never migrates or upgrades the production
database. Migration remains an explicit operational step with its backup,
quiescence, readiness, and rollback procedure.
