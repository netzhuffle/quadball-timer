# Anonymous Game Creation PoC

This probe is local-only. Start a disposable local vulnerable server, then run:

```sh
bun run anonymous-game-creation-poc.ts
```

Optional environment:

```sh
TARGET=http://127.0.0.1:3000 COUNT=25 bun run anonymous-game-creation-poc.ts
```

Do not run this against public or production services. Raising `COUNT` can consume memory and CPU on the target process.
