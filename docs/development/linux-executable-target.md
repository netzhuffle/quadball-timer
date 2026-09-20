# Linux executable target (Bun 1.4.2)

`bun run build:executable` and the build script default use `bun-linux-x64`
(Linux x86-64, glibc). This replaces the supported but obsolete `-modern`
selection; it does not change the deployment ABI or bytecode policy.

## Authoritative target semantics

Checked 20 September 2026 against the pinned Bun 1.4.2 runtime:

- [Bun executable documentation](https://bun.com/docs/bundler/executables#supported-targets)
  lists `bun-linux-x64` as the canonical target. The single x64 runtime targets
  Nehalem/SSE4.2 and dispatches AVX2/AVX-512 paths at runtime. It does not require
  a Haswell CPU. `-modern` and `-baseline` remain accepted compiler aliases.
- [Bun 1.4 release notes](https://bun.com/blog/bun-v1.4#x64-builds-are-now-baseline-only)
  separately explain that the old Haswell build was removed and baseline download
  URLs/npm packages remain compatible aliases. A download filename is not a
  requirement to use that suffix in the compiler target.
- CLI compilation of a disposable one-line program accepted `bun-linux-x64`,
  `bun-linux-x64-modern`, and `bun-linux-x64-baseline`. The first two reported
  `bun-linux-x64-v1.4.2`; the last fetched `bun-linux-x64-baseline-v1.4.2`.
  The installed 1.4.2 types accept all three. Target names are not inferred from
  download aliases alone.

## Ordinary verification evidence

On macOS arm64, Bun 1.4.2 revision
`50a8a838737a8f0e226d1c115788aa18192a2f18`, based on commit
`acd401ceab1010451b1506449fb8e24954b22f5a` plus this target change:

- `bun run build:executable` passed: `dist/quadball-timer` was a 92,083,680-byte
  Linux x86-64 ELF using `/lib64/ld-linux-x86-64.so.2`, mode `755`.
- A disposable `create-release-bundle.ts` invocation preserved the executable
  checksum (`0f87a31120c2e597735fb742b6788bc2322938b35559a19c0cefd695d82d4b01`),
  set executable mode `555` and manifest mode `444`, and recorded the source
  commit and local release-attempt metadata. On macOS this script used its existing
  source-runtime identity fallback: Bun 1.4.2, SQLite 3.54.0. This is packaging
  evidence, not execution evidence for the Linux binary.
- The release-manifest, Production deployment, and Test deployment Fast Tests
  passed (30 tests, 216 assertions), including immutable shared artifact modes
  and Test-before-Production ordering.
- `bun run build`, `bun run lint:fix`, `bun run format`, and `bun run check`
  passed; lint reported no warnings. The local ignored broken Bun/bunx package
  shims were redirected to the verified Homebrew Bun 1.4.2 tools for these runs.

The build retains `bytecode: shouldCompile`, disabled dotenv/bunfig autoloading,
production defines, and runtime-identity handling. The deployment workflow still
builds once and passes one immutable Release Bundle through Test to Production.
No activation, Production access, or exact-artifact SQLite Qualification Test was
performed. Native Linux execution and older-CPU execution were not measured.
The Qualification registry and historical research may retain the supported
legacy target spelling; this change neither alters nor claims its acceptance.
