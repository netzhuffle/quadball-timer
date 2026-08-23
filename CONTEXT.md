# Quadball Game Operations

This context describes the target domain language being planned for preparing, controlling, and recording quadball games at events. A term here defines the intended model; it does not claim that the behavior is already implemented.

## Language

**Event**:
A named quadball gathering configured by the Technical Admin with a local timezone and zero or more Game Days. An Event with zero Game Days is **unscheduled**. Once scheduled, it is current on an actual Game Day in its configured timezone, future between Game Days when a later Game Day exists, and past after its final Game Day.
_Avoid_: Tournament, event window

**Event Catalog Removal**:
A Technical Admin may remove an empty Event, and an Event Admin may remove an unreferenced Event Team, Game Day, Pitch, Gameplay Slot, or Pitch Slot, or an Event Game before Game Commencement and before it has any accepted Control Action. Removal atomically retires attached authority and records its evidence; commenced Games and referenced structure remain and use their ordinary correction, reassignment, Publication Status, Game Lock, or Game Reopening workflows.
_Avoid_: Cascade delete, history cleanup

**Publication Status**:
An Event-level visibility state of Unpublished, Published, or Event Cancelled. Only Published Events have a public Audience Projection; the other two statuses are indistinguishable from unknown Events to public audiences and do not change private operational authority.
_Avoid_: Draft, withdrawn

**Game Day**:
A calendar date on which an Event holds games. Game Days have no event-level start or end time.
_Avoid_: Event session, event time window

**Heat Stoppage Configuration**:
A Game Day-scoped on/off operational setting managed by Event Admins that defaults to off and determines the Heat Stoppage Mode of Event Games that have not commenced. Changing it does not affect commenced Games and requires no recorded forecast evidence or explanation. A Technical Admin may manage it through the Event Admin interface.
_Avoid_: Event-wide heat setting, per-game heat configuration, event director setting

**Heat Stoppage Mode**:
The effective on/off heat-stoppage state of one Event Game. Before Game Commencement it follows the Game Day's Heat Stoppage Configuration; at commencement its value becomes independent of later configuration changes. During the Game, a Controller may change it only on Head Referee direction through an Official Override.
_Avoid_: Heat Stoppage Configuration, game heat setting

**Heat Stoppage Trigger**:
A Game-time decision point at 15:00, 25:00, and every five minutes thereafter while Heat Stoppage Mode is on. Reaching it makes the trigger pending without pausing play until the Head Referee's decision is recorded. Enabling the mode during a Game starts with the next future trigger rather than recreating passed triggers; disabling it cancels a pending trigger.
_Avoid_: Automatic stoppage, heat timer

**Heat Stoppage**:
A complete stoppage started by a Controller on Head Referee direction after a Heat Stoppage Trigger. The first actual Heat Stoppage normally lasts four minutes and later ones two minutes. A required within-one-goal skip and the permitted following extension are ordinary rule operation; suppressing another required trigger, ending early, or extending beyond the rulebook allowance is an Official Override. Disabling Heat Stoppage Mode ends an active heat timer but does not resume play.
_Avoid_: Team timeout, automatic clock pause

**Team Timeout**:
One Game Side's single timeout entitlement in an Event Game. Its stoppage procedure and separate 60-second timeout minute are recorded as immutable Game Facts; the long-whistle cue is due at 45 seconds, and correction or reinstatement rebuilds the entitlement and elapsed state.
_Avoid_: Automatic stoppage, mutable timeout flag

**Game Suspension**:
A Head Referee-directed stoppage of an Event Game while the Game Clock is stopped. It blocks Clock restart until a Controller records a resume targeting the effective suspension Game Fact and does not replace the Game Clock, score, penalties, or possession evidence.
_Avoid_: Pause, inactivity timeout, discarded game state

**Suspension Recovery Snapshot**:
The versioned `live-suspension-snapshot-v1` Game Fact data attached to a Game Suspension. It records the accepted Game Clock and score, every actual remaining penalty segment including simultaneous or queued segments, confirmed volleyball possession, and one entry for every recorded dodgeball possession so another Controller can verify recovery before resume.
_Avoid_: Raw card facts, partial possession list, device snapshot

**Known Game Ball Set**:
The authoritative dodgeball identities configured for one Event Game or recovered from its accepted durable suspension history, including corrected facts. A new Suspension Recovery Snapshot must list each known dodgeball exactly once and cannot introduce an extra identity. Before the first suspension, Event Administration must provide the Event-Game-scoped set; without it, suspension admission fails closed.
_Avoid_: Client-entered ball list, partial possession list, device snapshot

**Gameplay Slot**:
A tournament-system-defined row in a Game Day schedule that groups up to one Event Game per Pitch, usually under one Scheduled Start. A general Expected Delay can move its Games together while allowing a more-delayed Pitch Slot to remain later.
_Avoid_: Game Slot, round, timeslot, batch

**Pitch Schedule**:
The ordered Pitch Slots for one Pitch on one Game Day, equivalent to one column in the Event's two-dimensional schedule.
_Avoid_: Pitch Slot, schedule column

**Pitch Slot**:
The intersection of one Gameplay Slot and one Pitch, retaining its Control Grant when its timing or assigned Event Game changes. It may be empty or contain one Event Game; two or more Games in one Pitch Slot form a Schedule Conflict.
_Avoid_: Gameplay Slot, Pitch Schedule, scheduled game

**Scheduled Start**:
The original planned start time of a Gameplay Slot and its Pitch Slots, used as the baseline for their Expected Starts.
_Avoid_: Expected Start, actual start

**Expected Delay**:
A time shift applied to a Gameplay Slot or Pitch Slot relative to its Scheduled Start. An Event Game's Expected Start uses the greater of its Gameplay Slot and Pitch Slot Expected Delays.
_Avoid_: Schedule Shift, delayed start time

**Expected Start**:
The currently anticipated start time of an Event Game, calculated from its Scheduled Start plus the greater of its Gameplay Slot and Pitch Slot Expected Delays.
_Avoid_: Scheduled Start, actual start

**Pitch Reassignment**:
An Event Admin-directed move of an Event Game to another Pitch Slot, usually within the same Gameplay Slot but occasionally across Gameplay Slots. An occupied target may be swapped or deliberately left as a Schedule Conflict.
_Avoid_: New game, duplicate game

**Schedule Conflict**:
Two or more Event Games assigned to one Pitch Slot. It remains visible to Event Admins until the Event Games are reassigned.
_Avoid_: Double booking, invalid game

**Team Schedule Conflict**:
One Event Team assigned to Event Games whose expected playing periods overlap. It remains visible to Event Admins but does not prevent an Event Team Assignment Correction from recording which team is actually playing.
_Avoid_: Schedule Conflict, invalid team assignment

**Controller**:
A participant admitted by a Control Grant to operate an Event Game. Controllers share equal authority over the full Game; Timekeepers and Scorekeepers have no distinct app roles.
_Avoid_: Scorekeeper role, timekeeper role, primary controller

**Offline Clock Holder**:
The Grant Session whose clock action the server most recently accepted, and the only one permitted to continue submitting official clock actions while disconnected. A later clock action transfers this continuity and may simply mean the same Timekeeper changed devices.
_Avoid_: Authority device, Primary Controller, primary phone

**Clock Baseline**:
The accepted game time and running or paused state from which Clock Projections advance. An emergency takeover establishes a new baseline without implying that the Timekeeper changed.
_Avoid_: Clock snapshot, device time

**Clock Projection**:
An informational game-time display derived from the current Clock Baseline. When the Offline Clock Holder cannot be observed, it may remain visible as a clearly labelled stale or estimated value rather than presenting itself as currently synchronized.
_Avoid_: Official Field Clock Display, synchronized clock

**Audience Projection**:
An allowlisted view of Event and Event Game information for one audience—public spectators, Controllers, Pitch Managers, Event Admins, or Technical Admins—that contains only information that audience may see and preserves relevant stale or estimated status. The complete Event is the public publication unit, and its public Audience Projection continuously reflects eligible changes while Published.
_Avoid_: Game State, full snapshot, generic response

**Official Field Clock Display**:
A pitch-facing clock intended to guide players and controlled by the Timekeeper. Controller and spectator Clock Projections are informational and are not Official Field Clock Displays.
_Avoid_: Spectator clock, Controller clock

**Head Referee**:
The game official with final on-pitch authority to make and correct calls, stop or resume play, and direct game timekeeping and scorekeeping.
_Avoid_: HR, referee admin

**Official Override**:
A Head Referee-directed Control Action that intentionally departs from a normal rule-derived guardrail. It records the direction, affected guardrail, confirmation, audit provenance, and any reason required by the applicable workflow in the Control Audit Trail while keeping the game operable.
_Avoid_: Rule exception, forced command

**Game Fact**:
An accepted sporting or operational occurrence, such as a goal, card, catch, result, or stoppage, that may contribute to the current game state.
_Avoid_: Mutable event, current value

**Sporting Order**:
The explicit adjudicated order of close sporting Game Facts, independent of Controller arrival order, device synchronization order, or their actual Game Clock times. A Head Referee close-play decision names the paired opposing fact and whether the candidate is before or after it; it never rewrites either Game Clock time.
_Avoid_: Arrival order, device timestamp, rewritten Game time

**Goal**:
An accepted scoring Game Fact worth 10 points for its recorded Game Side.
_Avoid_: Manual score edit, target score command

**Flag Catch**:
An accepted scoring Game Fact worth 30 points after seeker release and stopped play, subject to Head Referee adjudication where a close goal/catch pair requires an explicit Sporting Order.
_Avoid_: Automatic winner command, catch-time rewrite

**Overtime Target**:
The fixed score required after a trailing or tied Flag Catch: the non-catching Game Side's adjudicated score at the catch plus 30. It is rebuilt when effective pre-catch facts change and cannot be changed by post-catch scoring.
_Avoid_: Manual target, moving target

**Concession**:
An accepted overtime result fact. A Concession is admitted only while the Derived Game State is unfinished overtime and applies the trailing, tied, or leading outcome rules without changing the fixed Overtime Target.
_Avoid_: Pre-overtime concession, generic result

**Directed Forfeit**:
An accepted result fact recorded against the named Game Side. The other Game Side wins; the existing scores are preserved and no scoring points are added by the forfeit.
_Avoid_: Self-awarded winner, score reset

**Double Forfeit**:
An accepted result fact recorded for both Game Sides. It produces a finished result with no winner and preserves both existing scores without adding points.
_Avoid_: Draw winner, automatic score change

**Derived Result**:
The winner, unfinished overtime, or double-forfeit outcome rebuilt from effective scoring and result facts. It is not a manually recorded target winner and remains auditable through Corrections and reinstatement.
_Avoid_: Stored winner, manual target winner

**Correction**:
A Control Action that names one stable Game Fact and makes it ineffective or effective again without removing either the fact or earlier Corrections from the Control Audit Trail.
_Avoid_: Delete, edit history, undo latest

**Opposing Concurrent Corrections**:
Corrections against one stable Game Fact with opposing effectiveness values and no causal relation. Their canonical occurrence and operation identity order selects the effective outcome while retaining the conflict evidence; a later causal Correction may replace it.
_Avoid_: Socket-arrival resolution, conflict UI, undo latest

**Locked-Game Correction**:
An Event Admin-submitted Control Action that directly reconciles a locked Event Game's current score, flag-catching team, catch time, end time, or other displayed end-state fact without reopening Controller operation. It atomically states the corrected values, preserves the previous values in the Control Audit Trail, and requires no reason or stated basis. A rule-inconsistent value receives one confirmation and records an Official Override.
_Avoid_: Reopen Game, edit history, correction reason

**Game Reopening**:
An Event Admin-submitted Control Action that removes Game Lock without changing the Event Game's existing facts. It restores ordinary Controller operation and fresh admission through the existing Control Grant QR, while sessions terminated by the previous lock and its expired Grant Code remain invalid. A reopened, still-finished Game starts a new 15-minute closing timer; making it unfinished stops that timer until it finishes again.
_Avoid_: Locked-Game Correction, revive session, rotate Control Grant

**Control Action**:
An immutable Controller-submitted or Event Admin-submitted record accepted for an Event Game. It has a stable identity within that Event Game across submission, replay, and recovery, records a Game Fact, Correction, Locked-Game Correction, or Game Reopening, and may carry an Official Override.
_Avoid_: Mutable command, audit entry

**Derived Game State**:
The current score, phase, overtime target, result, stoppages, and other game state rebuilt from effective Game Facts and Locked-Game Corrections whenever either changes the record. Its scoring bounds and lifecycle must agree with the durable Event Game Record root.
_Avoid_: Stored result, patched state

**Game Phase**:
The sporting phase of an Event Game: Seeker Floor, Seekers Released, or Overtime. Game Phase describes the rule sequence of play and is distinct from operational status, which describes whether the Game is scheduled, running, paused, suspended, or finished.
_Avoid_: Operational status, lifecycle phase, game status

**Controller Device**:
A Controller's personally supplied, working, sufficiently charged phone used to access the app. Each Controller arranges their own device and power; no phone is designated as the primary or backup device, and another person's phone may take over through the same Control Grant.
_Avoid_: Primary phone, backup phone, dedicated timer phone

**Timekeeper**:
The event official responsible for tracking game time, penalty times, and seeker release. A Timekeeper may be a Controller and may also perform Scorekeeper duties, but has no distinct authority within the app.
_Avoid_: Timekeeper app role, primary Controller

**Scorekeeper**:
The event official responsible for tracking the score, operating the scoreboard, and completing the Official Score Sheet during play. A Scorekeeper may be a Controller, but has no distinct authority within the app.
_Avoid_: Scorekeeper app role, score-only Controller

**Penalty Reason**:
An optional broad classification of why a penalty card was issued in the app, supplementary to the exact foul recorded on the Official Score Sheet.
_Avoid_: Foul text, official penalty record

**Penalty Release Cause**:
The sporting occurrence that ends penalty service early, such as an opposing score or a foul-before-score ruling; it is distinct from the optional Penalty Reason that classifies why the card was issued.
_Avoid_: Penalty Reason, foul classification

**Control Grant**:
A Pitch Slot-scoped shared capability that admits Controllers to the one Event Game currently assigned to that slot. Its QR credential remains with the Pitch Slot when the schedule or Game assignment changes.
_Avoid_: User account, controller account, controller role

**Grant Code**:
An optional manually entered credential created on demand for emergency radio admission through a Grant. It is separate from the Grant's QR credential.
_Avoid_: Controller code, written code, verbal code

**Grant Session**:
Device-specific, pseudonymous authority admitted by presenting an Event Admin Grant, Pitch Manager Grant, or Control Grant. It carries the Grant's type and scope but does not identify a natural person.
_Avoid_: Login session, user session, account session

**Event Admin Access Sheet**:
A QR-only physical or digital handoff artifact for the Event's shared Event Admin Grant, shared among Event Admins for access when needed.
_Avoid_: Event Team sheet, recovery-code sheet

**Pitch Manager Access Sheet**:
A QR-only physical or digital handoff artifact containing the Pitch Manager Grant for every Pitch and Game Day in an Event.
_Avoid_: Pitch Manager code sheet, individual manager sheet

**Control Grant Access Sheet**:
A QR-only physical or digital handoff artifact for one Pitch and Game Day, kept by its Pitch Managers and containing every Pitch Slot's Control Grant whether or not an Event Game is assigned. An assigned Event Game is identified by a convenience snapshot of its Scheduled Start, Event Teams, and any Game Code or Game Designation; live admission remains authoritative.
_Avoid_: Pitch Grant sheet, Controller code sheet

**Access Sheet Version**:
The non-secret generation identity printed on every physical or digital reproduction of one generated Access Sheet. It identifies the Environment, sheet scope, and generation time without inventorying copies or tracking the sheet's contents.
_Avoid_: Sheet copy, Copy ID, print serial

**Pitch Manager**:
The person responsible for keeping one Pitch operating during an Event. A Pitch Manager can access that Pitch's Pitch Slots, assigned Event Games, and Control Grants and may rotate those Control Grants, but cannot create, edit, or delete Pitch Slots or Event Games.
_Avoid_: Event Admin, Controller

**Event Admin**:
A person holding the Event's shared Event Admin Grant. Event Admins create and manage the Event's Teams, Pitches, Pitch Slots, Event Games, Pitch Manager Grants, Control Grants, Publication Status, and Heat Stoppage Configuration. They may directly correct a locked Event Game without reopening it, or reopen it for ordinary Controller operation, but cannot change other event-level metadata.
_Avoid_: Pitch Manager, Controller

**Technical Admin**:
The sole operator authorized to create Events, change event-level metadata, and manage Event Admin Grants. A Technical Admin may enter the Event Admin interface and exercise every Event Admin capability, including managing Publication Status alongside an Event Admin. Routine administration uses the passkey-authenticated browser interface; a host-local CLI additionally provides selected administration and recovery workflows.
_Avoid_: Event Admin, Pitch Manager

**Technical Admin Passkey**:
The environment-specific WebAuthn credential that authenticates the Technical Admin without an account, username, or Grant. Each environment has at most one active registered credential; provider-synchronized copies remain one credential rather than separate passkeys.
_Avoid_: Technical Admin account, Technical Admin Grant, administrator password

**Technical Admin Enrollment Authorization**:
An environment-bound, ten-minute, single-use authorization issued through host operator authority that permits the browser to register the environment's sole Technical Admin Passkey. It is not a passkey and grants no routine Technical Admin access by itself.
_Avoid_: Passkey link, setup key, Technical Admin credential

**Technical Admin Bootstrap Authority**:
The human host authority used to inspect, establish, or deliberately reset an Environment's Technical Admin Passkey before browser authentication is available. It is distinct from deployment automation and routine passkey-authenticated Technical Admin authority.
_Avoid_: Deployment authority, bootstrap account, emergency administrator

**Production Environment**:
The live Quadball Timer environment whose Events, authority, and operational records may be used for real event operations.
_Avoid_: Live database, production instance

**Test Environment**:
The permanent non-production Quadball Timer environment used for rehearsals, demonstrations, and testing. Its Events, credentials, authority, and operational records are separate from and never authoritative in the Production Environment.
_Avoid_: Rehearsal Environment, staging environment, test database

**Event Admin Grant**:
The Event-scoped shared capability that admits Event Admins without individual accounts. It is created and managed by the Technical Admin.
_Avoid_: Event Admin account, organizer account

**Pitch Manager Grant**:
The Pitch-and-Game-Day-scoped shared capability that admits Pitch Managers without individual accounts. It is created and managed by Event Admins.
_Avoid_: Pitch Manager account

**Event Team**:
A team registered within an event, with an Event Admin-managed name and default color. Its name remains fixed during a game, while its Displayed Team Color and Pitch Orientation may change without changing its identity.
_Avoid_: Home team, away team

**Event Team Roster**:
An Event Admin-managed mapping from each player number used by an Event Team to that player's public name, intended for public Game Timeline display rather than accounts, eligibility decisions, or individual authority.
A game event may use an unmapped player number without being blocked; public output then shows the number alone, and later roster additions or corrections retroactively relabel that Event Team and number's Game Timeline events.
_Avoid_: User directory, private roster, player account

**Game Side**:
One of the two stable participant positions within an Event Game. Game Facts remain attached to the Game Side; correcting its assigned Event Team changes how the whole record is identified without moving or rewriting those facts.
_Avoid_: Home team, away team, display side, physical end

**Event Team Assignment Correction**:
An Event Admin correction that replaces the mistakenly selected Event Team on one Game Side with the Event Team actually playing that side for the whole Event Game. It takes the corrected Event Team's current name as that Game's fixed team name, but is not a substitution and does not move or rewrite Game Facts.
_Avoid_: Team substitution, rename team, swap teams

**Displayed Team Color**:
The presentation color used for one Event Team in one Event Game. It defaults from the Event Team, may be changed to match the team's appearance, and never changes team identity or Game Facts.
_Avoid_: Team identity, Game Side color

**Pitch Orientation**:
The Event Game-wide assignment of its two Event Teams to the opposite physical ends they defend. Flipping it swaps those defended ends for every Controller and spectator without changing Game Sides, Event Team identity, Displayed Team Colors, or Game Facts.
_Avoid_: Team swap, side correction, display preference

**Game Presentation Change**:
An Event Game-wide change to Pitch Orientation or a Displayed Team Color by a Controller or Event Admin. It is permanently attributable and synchronized to every Controller and spectator but is neither a Game Fact, Correction, nor Official Override.
_Avoid_: Control Action, Event Team Assignment Correction, display preference

**Pitch**:
A named playing area within an Event whose Game Day schedule consists of numbered Pitch Slots and whose scope bounds Pitch Manager access.
_Avoid_: Court

**Game Designation**:
An optional human-readable description of an Event Game's place in the competition, such as “Quarterfinals (Upper Bracket).”
_Avoid_: Game name, Game Code

**Game Code**:
An optional compact event-facing identifier for an Event Game, such as `UB.QF.1`.
_Avoid_: Game ID, game identification, Game Designation

**Event Game**:
An Event-managed game with an optional Game Designation and Game Code, two Game Sides each assigned a distinct Event Team, exactly one Gameplay Slot, and exactly one Pitch Slot within it. Its state and history remain with it through Pitch Reassignment; Controllers cannot rename its Teams, but an Event Admin may correct a mistaken Event Team assignment even after control begins.
_Avoid_: Assigned game, scheduled match

**Event Game Record**:
The app-authoritative operational history of one Event Game, whose permanent authority is its accepted Control Actions and whose Derived Game State is rebuilt from their effective Game Facts. It supports live operations and audit but does not replace the authoritative Official Score Sheet.
_Avoid_: Official game record, mutable Game State, Official Score Sheet

**Ad Hoc Game**:
A controller-only, disposable game created without an account or Event Grant for a friendly or spontaneous session. Its current state and control authority survive ordinary restarts and return as ordinary data after a full restore, but it has neither a spectator experience, a Game Lock, nor a durable Control Audit Trail; it cannot be manually removed and remains retained until capacity cleanup prunes it. Its rate-limit state and resource budget are separate from Event operations: exhausting an Ad Hoc limit may affect only Ad Hoc work and never throttles, rejects, disconnects, or otherwise degrades an ongoing Event operation.
_Avoid_: Game from scratch, unassigned game

**Protected Fixture Ad Hoc Game**:
An Ad Hoc Game temporarily bound to a named public fixture slot, whose state and spectator view remain durable beyond ordinary Ad Hoc cleanup and whose public access is allowlisted by that fixture's Event and slot. It remains an Ad Hoc Game for authority, operation, and audit purposes rather than becoming an Event Game.
_Avoid_: Fake Event Game, permanent Ad Hoc Game, public Ad Hoc Game

**SQM Fixture Event**:
The temporary Published Event projection for Schweizer Quadball Meisterschaft 2026 on 16 August 2026 in Europe/Zurich. It supplies a public schedule for four Protected Fixture Ad Hoc Games without creating ordinary Event Catalog records.
_Avoid_: SQM tournament record, seeded Event, production Event

**Ad Hoc Controller**:
A participant admitted through an unfinished Ad Hoc Game's Control QR. All Ad Hoc Controllers for the Game have equal authority; its creator is not an owner or primary Controller, and an admitted browser retains its authority across ordinary browser and server restarts until its Controller Leave Grace Period expires or capacity cleanup removes the Game.
_Avoid_: Ad Hoc Game owner, creator role, primary Controller

**Ad Hoc Penalty**:
A penalty card fact recorded for an Ad Hoc Game Side at an original Game Clock time. Its card type and affected Game Side remain associated with that original entry even when a Controller later assigns or corrects its optional player number or changes its card details.
_Avoid_: mutable penalty timer, latest card, player-only penalty

**Controller Leave Grace Period**:
The five-minute interval after a Controller leaves an Ad Hoc Game or Event Game during which the departing browser can resume its most recently left control authority from Home, subject to the Game's current authority rules. The opportunity survives an ordinary browser restart, replaces any earlier Leave Grace Period for that browser, and makes the departure final only when it expires.
_Avoid_: Undo leave, logout timeout, session expiry

**Ad Hoc Control QR**:
A reusable, non-rotatable, high-entropy capability QR that any Ad Hoc Controller may display while the Game is unfinished to admit another Ad Hoc Controller without an account, Event Grant, or claimed identity. Finishing the Game stops display and new admission but does not revoke existing Ad Hoc Controllers; correcting it back to unfinished enables the same QR again.
_Avoid_: Control Grant, Grant Code, controller login, game identifier

**Ad Hoc Capacity Cleanup**:
Automatic removal when creating an Ad Hoc Game would exceed the 50-Game capacity. It prunes the oldest-created Game with no connected Ad Hoc Controller and whose last Controller connection ended at least five minutes earlier, regardless of finish state or age; creation is refused only while all 50 Games are protected by a current or recent Controller connection.
_Avoid_: Manual removal, finished-game cleanup, retention expiry

**Game Timeline**:
The spectator-visible complete history of effective game events, ordered newest-first by game time and updated when a Correction changes the record. Player names, player numbers, Penalty Reasons, and other game-event details are intentionally public; correction provenance and Audit Trail evidence remain private.
_Avoid_: Audit log, command log

**Game Commencement**:
The irreversible boundary between provisional clock setup and an Event Game whose play has genuinely begun.
_Avoid_: First play tap, current running state, game creation

**Control Audit Trail**:
The permanent record of accepted Control Actions, Corrections, Controller-originated Game Presentation Changes, originating Grant Sessions, synchronization, conflict outcomes, Locked-Game Corrections, Game Reopenings, Game Locks, rejected locked-game replay counts, Official Overrides, and references to Event Administration Audit Trail entries that change how its Game Sides are identified or presented. It records previous and resulting values but requires no correction or reopening basis. It is operational evidence visible only to Event Admins and Technical Admins, rather than the spectator-facing history.
_Avoid_: Game Timeline

**Event Administration Audit Trail**:
The permanent record of Event Admin changes that affect Event structure or the identity, interpretation, or shared presentation of Event Games, including their originating Grant Sessions, before-and-after values, lifecycle context, and required reasons. It is visible only to Event Admins and Technical Admins.
_Avoid_: Control Audit Trail, Game Timeline

**Recovery Gap**:
An explicit marker that operational or audit evidence could not be recovered after catastrophic data loss. It identifies what is missing without replacing it with inferred or reconstructed evidence.
_Avoid_: Recovered action, assumed history

**Grant Audit Trail**:
The permanent record of Grant credential, session, rotation, expiry, reactivation, recovery, and locked-game authority-use events without raw credentials, sporting details, or claimed human identities. Locked-game authority use links to the corresponding Control Audit Trail entry. Like every Audit Trail, it is visible only to Event Admins and Technical Admins.
_Avoid_: Control Audit Trail, security log, access log

**Game Lock**:
The automatic safeguard that blocks control and further Grant admission for a finished Event Game 15 minutes after its last accepted Control Action. An Event Admin may apply a Locked-Game Correction without reopening control or restarting the closing timer, or may use Game Reopening so ordinary Controller operation and closing behavior resume. Queued offline actions rejected because the Game locked are discarded after confirmed rejection; the Control Audit Trail retains only their count, originating Grant Session, Game, and rejection time. Paused, suspended, unfinished, and Ad Hoc Games never lock due to inactivity.
_Avoid_: Finalization, inactivity timeout

**Official Score Sheet**:
The paper record signed by referees after a game and treated as authoritative for the event. The app's Game Timeline and Control Audit Trail support live operations but do not replace it.
_Avoid_: Game Timeline, Control Audit Trail

## Deployment Language

**Release Bundle**:
An immutable deployable candidate whose bytes and provenance are fixed as one unit. A Release Bundle is identified by its exact source and attempt provenance.
_Avoid_: build, deployment package, latest artifact

**Test Activation**:
The automatic validation of a Release Bundle in the disposable Test Environment after a deploy-affecting push to `main`.
_Avoid_: Test promotion, Test deployment candidate

**Promotion Source Run**:
The successful validation record whose Test Activation certified the Release Bundle selected for Production Promotion.
_Avoid_: latest run, source build, production run

**Production Promotion**:
The transfer and activation of the exact Release Bundle validated by a Promotion Source Run. Under the temporary post-SQM deployment policy, it starts automatically after successful Test Activation.
_Avoid_: Production deploy, rebuild-and-deploy, hotfix push

**Production Approval**:
An explicit human review that may be required before Production Promotion under a guarded deployment policy. The temporary post-SQM automatic deployment policy does not require one.
_Avoid_: deployment confirmation
