# Unbounded Command Batch PoC

This probe is local-only. Start a disposable vulnerable server, then run:

```sh
bun run unbounded-command-batch-poc.ts
```

Optional environment:

```sh
TARGET=http://127.0.0.1:3000 COUNT=1000 bun run unbounded-command-batch-poc.ts
```

Do not run this against public or production services. Raising `COUNT` can block the target process and disrupt connected clients.
