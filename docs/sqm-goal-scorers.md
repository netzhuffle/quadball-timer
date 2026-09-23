# SQM 2026 goal scorers

The first three games have supplementary goal-scorer annotations transcribed from the three paper score sheets supplied on 23 September 2026 and approved by the requester that day. `src/lib/sqm-goal-scorers.json` maps the original score-action IDs to the approved player number or name, with fixture, side, and game-time guards.

There are 39 goals: 35 numbered scorers, three name-only scorers, and one unknown. Leon scored Basel's first and third goals in game 3. Juri scored Turicum's goal at paper score 20:60. The scorer at 20:50 is intentionally unknown. Turicum's final goal (20:130 on paper) is #10.

Photo order is game 1, game 3, game 2. Game 3's paper side order is opposite the application's internal side order. Its final two goal rows also appear in the opposite order to the recorded actions: Basel's Leon goal at 22:58 precedes Turicum's #10 goal at 23:05 in the action history. Assignments follow team and original action identity; timings and sporting order are unchanged. Undone goals are excluded.

These are public display annotations on the protected SQM fixture, not rewrites of the original score commands or inferred roster identities. A mismatched, undone, or non-goal action receives no annotation. Original scores, catches, penalty events, clocks, and results remain unchanged. Reverting the annotation change removes the displayed scorers without a database rollback.
