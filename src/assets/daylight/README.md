# Daylight public presentation assets

Verified 2026-09-21 against the public quadball.live tournament API:
https://quadball.live/api/open/tournament/game_tournament/all/254
Tournament 254 is European Quadball Cup 2026 D2 (EQC26 D2).

- Berner Boggarts QC (2043): https://quadball.live/src/logo/custom_logo/logo_000254_00002043.png
- Turicum Thunderbirds (2044): https://quadball.live/src/logo/custom_logo/logo_000254_00002044.png

Both retrieved images are transparent 256×256 PNGs. Local delivery avoids third-party requests
and provides predictable loading. These tournament-scoped identifiers are provenance, not
persistent team IDs. The exact existing SQM name Berner Boggarts is an explicit alias for
Berner Boggarts QC. No fuzzy matching, Basel/Luzern inference or logo administration is added.
Unmatched identities and failed image loads render initials beside the full team name.

Roboto Condensed variable font is from Google Fonts:
https://github.com/google/fonts/tree/main/ofl/robotocondensed
Bundled under the adjacent SIL Open Font License. The font face and CSS variable alone are
shared; public surfaces explicitly opt into its typography, leaving Controller styles intact.
