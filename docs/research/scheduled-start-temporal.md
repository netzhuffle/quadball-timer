# Scheduled Start Temporal validation (#323)

The server-side Event Catalog now resolves a validated local date/time with Bun's
native Temporal API. `earlier` and `later` resolve an ordinary local time to the
same instant. A gap changes the resolved wall time; an overlap preserves the wall
time at different instants. This distinguishes the existing gap and overlap errors
without offset iteration, candidate probing, or assumptions about transition size.

The strict input regex, calendar validation, selected Game Day check, and error
ordering remain in place. They deliberately reject Temporal's additional syntax
(offsets, zone/calendar annotations, fractions, alternative separators and expanded
years), leap seconds, and invalid clock values. The old formatter's rejection of
zero-padded years below 1000 is preserved explicitly rather than silently expanding
the accepted Scheduled Start range. Calendar validation already rejects 0000–0099.

Storage and projections still use numeric epoch milliseconds. No browser dependency,
package, schema, or transport shape changed.

## Verification

Verified on 2026-09-20 with Bun 1.4.2, Darwin arm64:

- `bun test --isolate src/lib/event-catalog.test.ts src/lib/event-administration.test.ts`:
  74 passed, zero failures. Coverage includes exact gap/overlap errors, Lord Howe
  half-hour transitions and neighboring valid times, Apia's skipped date, leap day,
  strict syntax and clock boundaries, year boundaries, cross-UTC-date local starts,
  unchanged audit after rejection, and JSON projection of millisecond timestamps.
- `bun run lint:fix`, `bun run format`, and final `bun run lint`: passed.
- `bun run check`: passed (Bun version, testing-policy dry run, formatting, type-aware
  lint/type check, shellcheck). No Qualification Test was executed.
- `bun run build`: passed. The generated browser JavaScript chunk contained neither
  `Temporal` nor the Scheduled Start validator's error text. The implementation stays
  inside server-side Event Catalog operations.

Configured worktree setup reported `status: prepared`. Its dependency installation
left ignored local `bun`/`bunx` binary links targeting uninitialized package shims.
For checks, only those worktree-local links were redirected to the installed
Homebrew Bun 1.4.2 binaries; tracked dependency manifests and lockfile are unchanged.

## References

- [Temporal ZonedDateTime documentation](https://tc39.es/proposal-temporal/docs/zoneddatetime.html)
  describes disambiguation and timezone transitions.
- [Bun 1.4 release](https://bun.com/blog/bun-v1.4) documents native Temporal support.
