# Quadball Game Operations

This context describes the target domain language being planned for preparing, controlling, and recording quadball games at events. A term here defines the intended model; it does not claim that the behavior is already implemented.

## Language

**Event**:
A named quadball gathering configured by the Technical Admin with a local timezone and one or more Game Days. It is current on each Game Day, future before its next Game Day, and past after its final Game Day.
_Avoid_: Tournament, event window

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
A Head Referee-directed Control Action that intentionally departs from a normal rule-derived guardrail. It records the direction, guardrail, and reason in the Control Audit Trail while keeping the game operable.
_Avoid_: Rule exception, forced command

**Game Fact**:
An accepted sporting or operational occurrence, such as a goal, card, catch, result, or stoppage, that may contribute to the current game state.
_Avoid_: Mutable event, current value

**Correction**:
A Control Action that names one stable Game Fact and makes it ineffective or effective again without removing either the fact or earlier Corrections from the Control Audit Trail.
_Avoid_: Delete, edit history, undo latest

**Control Action**:
An immutable Controller-submitted record accepted for an Event Game. It has a stable identity within that Event Game across submission, replay, and recovery, records either a Game Fact or a Correction, and may carry an Official Override.
_Avoid_: Mutable command, audit entry

**Derived Game State**:
The current score, phase, overtime target, result, stoppages, and other game state rebuilt from effective Game Facts whenever a Correction changes the record.
_Avoid_: Stored result, patched state

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
A person holding the Event's shared Event Admin Grant. Event Admins create and manage the Event's Teams, Pitches, Pitch Slots, Event Games, Pitch Manager Grants, Control Grants, Publication Status, and Heat Stoppage Configuration, but cannot change other event-level metadata.
_Avoid_: Pitch Manager, Controller

**Technical Admin**:
The sole operator authorized to create Events, change event-level metadata and Publication Status, and manage Event Admin Grants. A Technical Admin may enter the Event Admin interface and exercise every Event Admin capability. Routine administration uses the passkey-authenticated browser interface; a host-local CLI additionally provides selected administration and recovery workflows.
_Avoid_: Event Admin, Pitch Manager

**Technical Admin Passkey**:
The environment-specific WebAuthn credential that authenticates the Technical Admin without an account, username, or Grant. Each environment has at most one active registered credential; provider-synchronized copies remain one credential rather than separate passkeys.
_Avoid_: Technical Admin account, Technical Admin Grant, administrator password

**Production Environment**:
The live Quadball Timer environment whose Events, authority, and operational records may be used for real event operations.
_Avoid_: Live database, production instance

**Test Environment**:
The permanent non-production Quadball Timer environment used for rehearsals, demonstrations, and testing. Its Events, credentials, authority, and operational records are separate from and never authoritative in the Production Environment.
_Avoid_: Rehearsal Environment, staging environment, test database

**Production Acceptance Authority**:
Either of the two people who must approve production use for an Event: the repository maintainer for technical readiness and the organizing association's president for operational readiness. Both approvals are required, and either authority may require fallback to the Official Score Sheet and manual timing.
_Avoid_: Technical Admin, Event Admin

**Event Admin Grant**:
The Event-scoped shared capability that admits Event Admins without individual accounts. It is created and managed by the Technical Admin.
_Avoid_: Event Admin account, organizer account

**Pitch Manager Grant**:
The Pitch-and-Game-Day-scoped shared capability that admits Pitch Managers without individual accounts. It is created and managed by Event Admins.
_Avoid_: Pitch Manager account

**Event Team**:
A team registered within an event, with an Event Admin-managed name and default color. Its name remains fixed during a game, while its displayed color may change and its playing side may be flipped.
_Avoid_: Home team, away team

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
An Event-managed game with an optional Game Designation and Game Code, two assigned Event Teams, exactly one Gameplay Slot, and exactly one Pitch Slot within it. Its state and history remain with it through Pitch Reassignment; Controllers cannot rename its Teams, but an Event Admin may correct which Event Team occupies either side even after control begins.
_Avoid_: Assigned game, scheduled match

**Event Game Record**:
The app-authoritative operational history of one Event Game, whose permanent authority is its accepted Control Actions and whose Derived Game State is rebuilt from their effective Game Facts. It supports live operations and audit but does not replace the authoritative Official Score Sheet.
_Avoid_: Official game record, mutable Game State, Official Score Sheet

**Ad Hoc Game**:
A publicly listed, disposable game created without an account or Event Grant for a friendly or spontaneous session. Its current state and control authority survive ordinary restarts and return as ordinary data after a full restore, but it has neither a Game Lock nor a durable Control Audit Trail; it cannot be manually removed and remains public until capacity cleanup prunes it.
_Avoid_: Game from scratch, unassigned game

**Ad Hoc Controller**:
A participant admitted through an unfinished Ad Hoc Game's Control QR. All Ad Hoc Controllers for the Game have equal authority; its creator is not an owner or primary Controller, and an admitted browser retains its authority across ordinary browser and server restarts until it explicitly leaves or capacity cleanup removes the Game.
_Avoid_: Ad Hoc Game owner, creator role, primary Controller

**Ad Hoc Control QR**:
A reusable, non-rotatable, high-entropy capability QR that any Ad Hoc Controller may display while the Game is unfinished to admit another Ad Hoc Controller without an account, Event Grant, or claimed identity. Finishing the Game stops display and new admission but does not revoke existing Ad Hoc Controllers; correcting it back to unfinished enables the same QR again.
_Avoid_: Control Grant, Grant Code, controller login, game identifier

**Ad Hoc Public Link**:
A stable, opaque, non-secret spectator link to one publicly listed Ad Hoc Game. It is deliberately separate from the Ad Hoc Control QR and never admits control.
_Avoid_: Ad Hoc Control QR, secret game link

**Ad Hoc Capacity Cleanup**:
Automatic removal when creating an Ad Hoc Game would exceed the 50-Game capacity. It prunes the oldest-created Game with no connected Ad Hoc Controller and whose last Controller connection ended at least five minutes earlier, regardless of finish state or age; creation is refused only while all 50 Games are protected by a current or recent Controller connection.
_Avoid_: Manual removal, finished-game cleanup, retention expiry

**Game Timeline**:
The spectator-visible history of sporting events, such as goals and cards, ordered by their game time and updated when a correction changes the record.
_Avoid_: Audit log, command log

**Game Commencement**:
The irreversible boundary between provisional clock setup and an Event Game whose play has genuinely begun.
_Avoid_: First play tap, current running state, game creation

**Control Audit Trail**:
The permanent record of accepted control actions, corrections, originating Controllers, synchronization, and conflict outcomes for an Event Game. It is operational evidence visible only to Event Admins and Technical Admins, rather than the spectator-facing history.
_Avoid_: Game Timeline

**Recovery Gap**:
An explicit marker that operational or audit evidence could not be recovered after catastrophic data loss. It identifies what is missing without replacing it with inferred or reconstructed evidence.
_Avoid_: Recovered action, assumed history

**Grant Audit Trail**:
The permanent record of Grant credential, session, rotation, expiry, reactivation, and recovery events without raw credentials or claimed human identities. Like every Audit Trail, it is visible only to Event Admins and Technical Admins.
_Avoid_: Control Audit Trail, security log, access log

**Game Lock**:
The automatic safeguard that blocks control and further Grant admission for a finished Event Game 15 minutes after its last accepted control action. Paused, suspended, unfinished, and Ad Hoc Games never lock due to inactivity.
_Avoid_: Finalization, inactivity timeout

**Official Score Sheet**:
The paper record signed by referees after a game and treated as authoritative for the event. The app's Game Timeline and Control Audit Trail support live operations but do not replace it.
_Avoid_: Game Timeline, Control Audit Trail
