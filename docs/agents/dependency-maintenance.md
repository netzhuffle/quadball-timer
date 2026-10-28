# Dependency maintenance

Use the Bun version pinned by `packageManager`. Keep `bunfig.toml`'s
`minimumReleaseAge = "7d"` (seven days), the exact runtime and `@types/bun` pins, and the
matching locked `bun-types` and transitive Bun peer version. Normal setup and CI
use `bun install --frozen-lockfile`; intentional updates must produce a reviewed
`package.json`/`bun.lock` change before that frozen installation can pass.

## Review an update

Read the old resolved version from the pre-update `bun.lock` and the selected new
version from the proposed lockfile. For **each changed package**, run
`bun pm diff package-name@OLD NEW`, substituting both exact versions (including
for scoped packages). Do not use `bun pm diff package-name` for acceptance: its
implicit target is `latest`, which can differ from the selected, age-eligible
version. Registry access is required for uncached published packages.

Review the complete patch, especially `package.json` dependency, optional/peer
dependency, and lifecycle-script changes (`preinstall`, `install`, `postinstall`,
and `prepare`), plus entry points and binaries. Inspect newly added or removed
packages separately. A package diff does not prove release-age eligibility or
authorize trusting new install scripts. Do not use `bun audit fix` as an
unreviewed shortcut that rewrites pins or installation policy.

For a dependency/lockfile change, use the existing verification commands:

```fish
bun install --frozen-lockfile
bun run check
bun run test
bun run build
```

## Emergency security updates

Use a command-scoped release-age exception only for an urgent fix supported by
an official advisory or release note. Record that evidence and the exact reviewed
old/new versions before resolving the update. Keep the seven-day default in
`bunfig.toml`; do not persist exclusions, set the global age to zero, or exempt
an entire package name.

1. Enumerate every package/version that needs the exception from the proposed
   dependency graph. For a Bun update, review the complete aligned family:
   `@types/bun`, `bun-types`, the direct `bun` executable, every transitive Bun
   peer, and every affected optional platform package actually resolved in
   `bun.lock`. Inspect the selected platform dependencies at each update rather
   than reusing an older list.
2. Pass each exemption as an explicit `name@version` entry to
   `--minimum-release-age-excludes`. A top-level `bun` exemption does not cover
   child packages; do not assume wildcard matching. For syntax only, this
   **types-only example is not a complete runtime update**:

   ```fish
   bun install --minimum-release-age-excludes '@types/bun@1.4.4,bun-types@1.4.4'
   ```

   A full Bun update requires an inspected explicit list including the direct
   executable and all selected platform packages. Build that list from the
   reviewed graph before running the update; the example above is not an
   acceptance command for it.
3. Review every `package.json`/`bun.lock` change using the update procedure above.
   Confirm exact alignment of runtime, types, direct executable, locked
   `bun-types`, and transitive Bun peers, with platform packages matching the
   selected runtime. Updating a host Bun alone does not update compiled releases;
   those embed the runtime used to build them.
4. Run the frozen install and ordinary check/test/build commands above with no
   age-exception flags. Accept only the reviewed resolutions and a successful
   frozen install under the normal policy.

See [Bun 1.4.4 release-age syntax](https://bun.com/blog/bun-v1.4.4#minimumreleaseage-supports-units-and-per-version-exclusions)
for duration units and per-version exclusions.

## Deduplication decision

During dependency maintenance, `bun dedupe --dry-run` previews opportunities;
`bun dedupe --check` is an optional read-only diagnostic (exit 1 means removable
versions, not necessarily a correctness defect). If useful, run `bun dedupe`,
review every changed resolution, and use the verification commands above.
Bun chooses already-locked versions within effective dependency ranges; a direct
dependency can move backwards. Do not force incompatible ranges or peer contexts
together merely to reduce the package count.

On 2026-09-20, at `70e1b56acc08592fe0a6570de8372667612f4303`, Bun
1.4.2 (`50a8a8387`) reported no duplicates across 201 locked packages in both
dry-run and check modes (exit 0). An independent grouping of lockfile package
identities also found no repeated package names. No lockfile change was useful.
Keep deduplication out of ordinary `check` and CI: the current tree has no benefit
to enforce, and later intentionally retained versions should be reviewed in the
dependency change, not forced through a blanket optimization gate. Unavoidable
incompatible versions and distinct peer contexts can legitimately remain.

References: [Bun package diff](https://github.com/oven-sh/bun/blob/main/docs/pm/cli/pm.mdx#diff)
and [deduplication](https://bun.com/docs/pm/cli/dedupe). Verified with the pinned
runtime; its `bun pm diff --help` currently displays generic package-manager help,
but the explicit two-version command works.
