# Unbounded Team Names PoC

This probe is local-only. Start a disposable vulnerable server, then run:

```sh
bun run unbounded-team-names-poc.ts
```

Optional environment:

```sh
TARGET=http://127.0.0.1:3000 NAME_LENGTH=100000 bun run unbounded-team-names-poc.ts
```

Do not run this against public or production services. Raising `NAME_LENGTH` can consume memory and CPU on the target process and connected clients.
