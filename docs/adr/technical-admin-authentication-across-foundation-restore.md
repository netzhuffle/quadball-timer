# ADR: Technical Admin authentication across Foundation restore

- Status: accepted
- Date: 2026-08-15
- Scope: Foundation backup and restore composition for #192, #193, #81, and #70

## Decision

Use Policy A: keep Foundation and Technical Admin authentication in separate SQLite stores.
Foundation backup uses a closed Foundation-only relation allowlist. It validates the live
Foundation schema before `VACUUM INTO`; every relation must be explicitly included. A
`technical_admin_*` relation or any other unclassified authentication relation inside Foundation
fails closed before backup publication.

Foundation backup never opens, reads, copies, filters, sanitizes, or restores the separate
Technical Admin database. The separate auth path is not a backup input, and no auth relation is
dropped from a Foundation snapshot. The allowlist is structural exclusion rather than a
post-copy removal step.

During restore, after Foundation staging and verification and after both writer domains are
quiesced, Foundation consumes only
`TechnicalAdminAuth.prepareForFoundationRestore({ mode })`. The adapter is the sole owner of
credential validation, compatibility classification, and atomic invalidation of sessions,
fresh-verification state, challenges, and enrollment authorizations.

The finite adapter result remains separate from Foundation outcome:

- `preserved-transients-invalidated` preserves the exact compatible credential and storage
  identity while invalidating all transient authority.
- `re-enrollment-required` represents only `missing`, `invalid`, `incompatible`, or
  `explicit-reset`; Foundation never fabricates or resets credentials.
- `sanitation-failed` aborts before Foundation replacement.

The sanitized auth store remains at its live path on successful Foundation replacement and on
Foundation rollback. A later Foundation failure rolls back only Foundation state and never
revives pre-sanitation sessions, challenges, enrollment authorizations, or fresh-verification
authority. Evidence exposes only the finite auth outcome and allowlisted reason.

## Context

Foundation records, Grants, and their lifecycle evidence have a different recovery authority and
retention boundary from browser Technical Admin authentication. Copying authentication tables into
a Foundation image, then dropping them, creates both an avoidable secret-residue problem and a
false impression that the backup owns auth state. It also makes future auth-schema additions easy
to miss.

A closed allowlist makes an unexpected auth relation a backup policy violation at the source. The
separate auth store can then remain wholly owned by the Technical Admin module, including its
SQLite identity and sidecars.

## Consequences

Positive consequences:

- An auth relation accidentally added to Foundation cannot be published in a backup.
- The separate auth database has no Foundation backup read or mutation path.
- Credential/storage identity survives normal restore without copying auth state.
- A failed Foundation cutover cannot restore pre-sanitation transient authority.
- New Foundation relations require an explicit backup-policy decision.

Tradeoffs:

- The Foundation relation allowlist must be updated when an intentional Foundation relation is
  added.
- A malformed or unexpectedly extended Foundation schema fails backup rather than producing a
  partial snapshot.
- Re-enrollment remains an operator-owned Technical Admin action outside Foundation restore.

## Superseded alternatives

The following alternatives are superseded:

1. Copy the full Foundation database, drop known Technical Admin relations from the copy, and
   publish the filtered result.
2. Treat a separate Technical Admin database as a Foundation backup input or restore image.
3. Move the sanitized auth database to a Foundation failed-image path and restore it during
   Foundation rollback.
4. Let Foundation inspect Technical Admin tables or duplicate the #193 validation/sanitation
   implementation.

## Verification

The focused recovery suite rejects synthetic Technical Admin and other unclassified relations
inside Foundation before publication and proves that a real separate auth SQLite file keeps its
inode and bytes unchanged. The accepted #193-backed composition test separately proves credential
and storage-identity preservation, transient invalidation, restart, and fresh ordinary sign-in.
