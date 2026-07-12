# Self-Asserted Controller Authority PoC

This proof of concept is local-only. It creates a disposable game on a local
Quadball Timer instance, subscribes to that game with `role: "controller"`
without presenting a grant or credential, sends a controller command, and
verifies the score change through the local API.

Run it from the report directory:

```sh
cd poc
TARGET_BASE_URL=http://127.0.0.1:3000 bun run self_asserted_controller_authority.ts
```

The target must be a local development or lab instance. Do not run this against
public production.

Representative vulnerable output:

```text
[+] created local game game-1a2b3c4d
[+] subscribed as controller without presenting a grant or credential
[+] unauthenticated controller command changed score to 10-0
```
