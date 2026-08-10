# Public experience prototype

Question: What phone-first public home, Event page, Game Timeline, spectator view, and Ad Hoc Game creation experience makes current, future, and past activity understandable while keeping frequent live information immediately visible?

Run with `bun dev`, then open `/prototype/public-experience?screen=current`.

- The selected prototype is Daylight Arena: A's bold live-score hierarchy combined with C's Event orientation in a daytime-light design.
- `daylight-arena-board.png` is the accepted Current Event, Event schedule, Events Home, and Ad Hoc reference.
- `daylight-arena-game-timeline.png` is the accepted focused Game Timeline reference.
- The older `daylight-live-compass-*.png` boards are rejected intermediate references because they drifted toward B's dense matchday-programme structure.

Verdict: approved by Jannis on 10 August 2026. Daylight Arena is the selected public home and spectator direction. This entire route is throwaway and must be deleted or rewritten after the ticket records the chosen direction.

## Confirmed direction

- Combine A's live-first emphasis with C's event-oriented wayfinding in a daytime light design; B's matchday-programme direction is rejected.
- When several Event Games are running, show all of them together at a glance with equal visual weight. The primary public question is what is happening right now at the Event.
- Treat the top live area as the immediate Event horizon: show running Event Games first, then all Event Games scheduled to start within the next hour, grouped by start time. During normal between-slot gaps, emphasize the next slot rather than presenting the Event as inactive.
- Make the scheduled start time especially clear for future games in the immediate horizon.
- Label an Event Game whose scheduled start has passed but which has not begun as `Awaiting start`, retaining its scheduled time. Do not infer `Delayed` without an explicit domain fact.
- Each running-game summary shows both team names, live score, game clock, game phase, and Pitch when the Event has multiple Pitches. In overtime it also shows the target score.
- Treat Game Phase (Seeker Floor, Seekers Released, or Overtime) separately from Game Status (Running, Paused, Suspended, or Finished). Show phase on every live summary, and make exceptional non-running statuses explicit.
- Mark the catching team directly at its live score with a deliberately styled superscript asterisk. Give the marker an accessible `Flag catch` label and show a `* Flag catch` legend where space permits.
- Keep the flag-catch asterisk high within the score's cap height, like a handwritten superscript, without letting it rise above the numerals.
- Give each Live Arena team field a shallow faceted edge where its diagonal boundary changes angle; this is a recurring visual signature, not a larger or differently weighted game card.
- Keep past and future Event Games available in the same scrollable experience.
- Present past, running, and future Event Games in one event-wide chronological list. On entry, position the list at the current point in time rather than at its beginning.
- Order the Event schedule by ascending scheduled time: earlier games above the current anchor and later games below it. This intentionally differs from the newest-first Game Timeline because the schedule includes future activity.
- Name the Pitch on an Event Game only when its Event has multiple Pitches.
- Make public Home context-sensitive: when exactly one Event is current, show that Event's live section and chronological schedule directly. When zero or multiple Events are current, show the Event list instead.
- From an automatically opened current Event, provide explicit navigation back to the Event list.
- Do not keep Ad Hoc Game creation in the persistent primary navigation while showing a current Event. Keep it prominent and plainly named on the Event-list Home because it is expected to be used frequently; do not hide it in an overflow menu.
- Place a full-width `Start an Ad Hoc Game` action after current and future Event summaries but before past Events on the Event-list Home.
- Do not ask for a Pitch when creating an Ad Hoc Game; Pitches belong to Events.
- Prefill Ad Hoc team names and colors so the form is immediately submittable. Allow changes before creation and rely on the existing editable Ad Hoc team identity afterward.
- Do not feature one running Event Game above another. Editorial importance such as a semifinal designation is outside the current scope.
- Model multiple simultaneous Pitches in the next prototype revision.
- Embed recent or complete Game Timeline activity directly on the spectator game page without requiring a separate navigation action.
- Order the embedded Game Timeline newest-first so the latest accepted sporting event appears immediately beneath the live score.
- As the spectator scrolls the Game Timeline, collapse the large scoreboard into a compact sticky header that keeps teams, score with flag-catch marker, game clock, and Game Phase visible.
- When new Game Timeline entries arrive while the spectator is reading older entries, preserve their scroll position and show a `new play` control that returns to the top. Insert normally when they are already at the top.
- Expose the complete Game Timeline through ordinary page scrolling without a separate disclosure action. If volume eventually requires pagination, load it transparently rather than changing the interaction model.
- Present only the current sporting record in the public Game Timeline. Forward corrections appear as if the resulting event naturally happened; decreasing a score removes the corresponding prior score entry. Do not expose correction markers, obsolete values, or correction history publicly.
- Include goals, cards, seeker release, flag catch, overtime start with its target score, and game finish in the public Game Timeline. Exclude routine pause and resume changes.
- Place team-owned Timeline events on the owning team's side of a central time spine. Team side communicates ownership; the goal, flag-catch, or card icon communicates event type. Keep game-wide phase events centered.
- Align each team-owned Timeline event as a compact horizontal ledger entry: outer event icon, readable event details, a short connector, and the timestamp on the central spine. Use light separators for scan rhythm, while game-wide phase events remain full-width rows.
- Preserve actual card color independently of team color or side. Keep the team name in each entry so ownership never relies on position or color alone.
- Avoid soccer- or ice-hockey-like circles in decorative Game backgrounds. A future pass may explore the rectangular quadball Pitch and its three hoops; until then, prefer generic straight-line texture.
