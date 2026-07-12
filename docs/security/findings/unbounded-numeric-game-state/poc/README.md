# Unbounded Numeric State PoC

This is a local-only semantic probe for the numeric validation issue. It does
not contact a server and does not modify a checkout.

Run it from this directory:

```sh
bun run numeric-state-corruption-poc.ts
```

Expected result: the probe shows two finite JSON numbers being accepted, the
clock arithmetic producing `Infinity`, and JSON serialization publishing the
numeric field as `null`.
