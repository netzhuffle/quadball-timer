# Ad Hoc goal scorer annotations

Scorer annotations are stored in `adhoc_games.goal_scorers_json` in the Ad Hoc SQLite database. Each annotation references a score-action ID and guards its game time and side. Its player can have a number, a name, or both; a null player means the scorer is unknown. Public projection uses only matching effective ten-point goals. Sporting commands, scores, timings and results remain immutable.

Startup adds the optional column with an empty-array default. It imports no scorer data. This is additive metadata compatible with schema version 5: older binaries ignore and preserve the new column on sporting writes. Existing SQLite snapshots include the column without adding a new relation or changing the backup contract.

The requester supplied and approved the first three SQM games' scorer assignments on 23 September 2026. Their separate database import is a user-executed sudo handoff, not deployment code. Future database corrections are read directly; there is no compiled scorer lookup or startup reseeding.

For SQM, the handoff validates the original effective score-action IDs, sides, points and source timestamps, backs up the database, then updates only the three annotation values in one transaction. It leaves one unidentified scorer blank and gives three goals names without fabricated jersey numbers. The last two game-3 paper rows differ from action order; scorer attribution follows team and original action identity, retaining recorded timings.
