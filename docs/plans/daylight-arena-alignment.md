# Daylight Arena public experience alignment

Status — 21 September 2026: the Daylight Arena implementation for [#333](https://github.com/netzhuffle/quadball-timer/issues/333) is assembled locally, including the public surfaces, dedicated Ad Hoc form, font and verified team artwork. Final acceptance remains pending the responsive long-Event/Pitch header correction and a new terminal review. No deployment is claimed.

The confirmed decisions and planned sequence below preserve the original 20 September planning record. At specification publication, implementation and asset retrieval had not yet started.

## Primary sources

- [Spec #131](https://github.com/netzhuffle/quadball-timer/issues/131).
- [Approved prototype #18](https://github.com/netzhuffle/quadball-timer/issues/18), captured on `codex/prototype-public-experience` at `b2e68e1`. The initial reference to #81 was a numbering mistake: #81 concerns recovery.
- At that commit, `docs/prototypes/public-experience/NOTES.md` identifies `daylight-arena-board.png` and `daylight-arena-game-timeline.png` as the accepted screenshots. Older Live Compass boards are rejected intermediate references.
- Existing SQM boundary: [ADR 0004](../adr/0004-sqm-fixture-event-boundary.md).

## Confirmed decisions — 20 September 2026

1. All public prototype surfaces are in scope: Events Home, Event live overview, Event schedule, individual Game spectator view and Game Timeline, and Ad Hoc creation. Ad Hoc creation must not be excluded. This is not a redesign of private Controller or administration pages.
2. The two approved Daylight Arena screenshots are the visual acceptance reference. Closely match typography, spacing, faceted team-color panels, score hierarchy and timeline layout, accommodating real content, responsive widths and accessibility.
3. Routine pause/resume actions must not appear as separate spectator Game Timeline entries. The user clarified that these are generally not relevant history events for #131; complete history does not require exposing routine clock controls. Preserve current paused/running status and meaningful timeout, suspension, heat-stoppage and lifecycle information. No change to recorded control evidence is implied.
4. Source matching team logos from [quadball.live](https://quadball.live), with initials where no matching logo is available. Add no logo administration. Asset retrieval and reliable team matching require investigation; do not guess a composite team's identity from a constituent club.
5. Preserve existing interactivity and the current SQM Event and games. The redesign must remain connected to real public projections and live updates.
6. Follow the prototype wherever it answers a layout question, without requesting individual confirmation of those details. The user confirmed: “Also grundsätzlich wollen wir die Sachen so wie im Prototyp haben, ja.”
7. The compact score sits at the bottom after the large scoreboard scrolls out. Reserve space for it, mobile safe areas and New play so no content or controls are obscured.
8. On narrow phones, retain opposing team-owned timeline lanes and a central time spine, wrapping real content; center game-wide events. Preserve readability at the supported 360 px minimum without horizontal scrolling.
9. Ad Hoc creation uses its own form surface matching the prototype, reached through the prominent Start an Ad Hoc Game action, with back navigation and immediately submittable defaults.
10. Desktop and states absent from the screenshots receive a responsive adaptation consistent with the approved prototype. Specific desktop arrangements are implementation proposals, not separately approved user choices.

## Preservation requirements

- Preserve public URLs, Published Event visibility and generic unavailable behavior, live subscriptions, reconnect, clock freshness, synchronized team colors and Pitch Orientation.
- Preserve Home discovery and explicit All events navigation, Controller return handoff, chronological schedule navigation, game links and normal modified-click behavior.
- Preserve sticky compact score on scroll, complete eligible newest-first timeline, reading-position preservation and New play navigation.
- Preserve immediate Ad Hoc submission with default names/colors, validation, creation and Controller handoff behavior.
- Preserve keyboard interaction, visible focus, readable names, non-color-only meaning and narrow-phone usability.
- Keep `/events/sqm-2026` and its `secret1`–`secret4` game routes. SQM remains the existing projection over Protected Fixture Ad Hoc Games, outside ordinary Event Catalog records. No reseeding, migration or game-state mutation is required. Preserve existing special result and availability behavior; do not invent timelines to populate a mockup.

## Logo source investigation

Read-only inspection of the [EQC26 D2 team selector](https://quadball.live/tournament?id=254) verified these named mappings:

- Berner Boggarts QC: `https://quadball.live/src/logo/custom_logo/logo_000254_00002043.png`.
- Turicum Thunderbirds: `https://quadball.live/src/logo/custom_logo/logo_000254_00002044.png`.

These are tournament-scoped custom-upload URLs, not stable global team identifiers. The two verified logos and the condensed font are now bundled locally under `src/assets/daylight/`; its README records their sources and the font license. No matching artwork for the combined Basel Basilisks / Luzern identity has been verified; retain initials unless an exact matching identity is established.

## Behavior reconciliation

Use #131 and current behavior for information and interactions, the approved screenshots for visual presentation, and the user's explicit pause/resume clarification for eligible timeline history. Mockup omissions do not remove clock freshness, exceptional statuses, correction effects, keyboard access or recovery navigation. Do not reproduce illustrative scores, players, teams or event dates as application data.

The separate Ad Hoc form changes navigation, not creation semantics. Opening or leaving the form must not itself create a Game or replace Controller return authority. Preserve the existing submission-time Controller-return replacement flow, validation, duplicate-submission protection, busy/retry/capacity states and successful Controller handoff. Present prototype color swatches while retaining access to custom colors supported by the current form.

Phone mockups do not require browser/phone chrome or unsupported fictional metadata in the app. Use the focused accepted timeline reference for the opposing lanes; the earlier board's single-column game preview does not override that focused reference. Prefer the accepted notes' generic straight-line texture over the board's sport-field circles.

## Original planned implementation sequence — 20 September 2026

1. Capture current public interaction baselines and extract the two accepted screenshot references from the recorded commit. Use disposable local representative data for missing states, never mutate SQM to stage a screenshot.
2. Establish public presentation styles, condensed readable typography, spacing, faceted team-color fields, score treatment, accessible flag-catch markers, shared team-logo/initials presentation and public-facing copy.
3. Align Events Home, Event live horizon and chronological schedule; preserve equal visual weight for simultaneous games, live/next ordering, meaningful scheduled/expected times, Pitch naming rules and existing navigation.
4. Align Game score, exceptional-state/freshness presentation, opposing-lane timeline and bottom compact score. Exclude routine pause/resume entries from the public timeline while retaining their operational effects and private evidence. Preserve scroll position and New play behavior across updates.
5. Move Ad Hoc creation to the prototype's dedicated form surface within the existing routing conventions, preserving the full creation and Controller handoff flow.
6. Verify rendered phone views against the approved references and inspect a consistent desktop adaptation. A responsive equal-weight live-card grid and a centered readable Game page are candidate implementation choices, to be judged in rendered output.
7. Run the required formatting/lint sequence and ordinary checks, focused public interaction tests and build; summarize visual evidence and remaining limitations for review.

The main implementation seams are `src/pages/public-event-page.tsx`, `src/pages/public-game-timeline.tsx`, the existing public route registration, and the public timeline projection boundary. Preserve `src/lib/sqm-fixture.ts` behavior. No backend redesign, database migration, deployment or logo administration is part of this plan.

## Remaining gaps and confirmation

No unresolved product decision blocks the plan. Asset retrieval and font delivery are implemented; responsive rendering and interaction evidence remain subject to final acceptance. Use initials whenever logo identity is unverified; that accepted fallback removes the need to block on combined-team artwork.

Do not reopen prototype-covered questions. If rendered evidence reveals a genuine conflict between faithful presentation, required information and accessibility that cannot be resolved by responsive adaptation, bring that concrete conflict back to the user.

The user confirmed shared understanding and requested publication through to-spec. The resulting specification is [#333](https://github.com/netzhuffle/quadball-timer/issues/333). Publication does not itself perform implementation or authorize deployment.

## Documentation and verification handoff

The Game Timeline glossary now records the settled pause/resume exclusion. No ADR is added for reversible visual choices. The clarification of #131 is recorded here and in follow-up specification #333; #131 itself has not been edited.

For final acceptance, compare rendered output against both accepted screenshots with realistic content, including long names, absent logos, empty timelines, unavailable games and exceptional live states. Verify preserved public interactions and SQM routes using ordinary local/browser checks. Follow repository lint/format and fast-test policy; qualification, load, soak, recovery and production-artifact execution are not authorized by this plan.

The acceptance evidence should cover Events Home with zero/one/multiple current Events, live and finished games, the immediate horizon and full schedule, bottom-score activation, New play and scroll preservation, presentation changes and corrected timeline data, reconnect/unavailable navigation, and Ad Hoc creation/Controller return behavior. Include narrow-phone and ordinary desktop rendering, long public details, initial/logo fallback, readable team-color contrast, keyboard focus and non-color-only meaning. Finish code changes with `bun run lint:fix`, then `bun run format`, and a passing `bun run lint`; also run the ordinary `bun run check`, `bun run test` and `bun run build` handoff checks under repository policy.

The first terminal review passed ordinary check/test/build, the Chromium/WebKit public browser coverage and the creation-only Ad Hoc path, but found the long-Pitch header defect and stale status text addressed in this repair. The default broader Ad Hoc browser command still fails at its first server-restart reconnect with a busy/retry timeout. The same failure was reproduced on the exact launch base `2f14428fbab910db1f1a12af6a6a8e917c5200d4`; it is a pre-existing limitation, not a passing check. Its later assertions remain unproven by that command, and backend repair is outside #333. The responsive repair and newly assembled head require independent terminal review before acceptance.
