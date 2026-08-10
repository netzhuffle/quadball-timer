# Quadball Game Operations

This context describes the target domain language being planned for preparing, controlling, and recording quadball games at events. A term here defines the intended model; it does not claim that the behavior is already implemented.

## Language

**Event**:
A named quadball gathering configured by the Technical Admin with a local timezone and one or more Game Days. It is current on each Game Day, future before its next Game Day, and past after its final Game Day.
_Avoid_: Tournament, event window

**Game Day**:
A calendar date on which an Event holds games. Game Days have no event-level start or end time.
_Avoid_: Event session, event time window

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
An immutable Controller-submitted record accepted for an Event Game. It records either a Game Fact or a Correction and may carry an Official Override.
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

**Pitch Manager**:
The person responsible for keeping one Pitch operating during an Event. A Pitch Manager can access that Pitch's Pitch Slots, assigned Event Games, and Control Grants and may rotate those Control Grants, but cannot create, edit, or delete Pitch Slots or Event Games.
_Avoid_: Event Admin, Controller

**Event Admin**:
A person holding the Event's shared Event Admin Grant. Event Admins create and manage the Event's Teams, Pitches, Pitch Slots, Event Games, Pitch Manager Grants, and Control Grants, but cannot change event-level metadata.
_Avoid_: Pitch Manager, Controller

**Technical Admin**:
The operator authorized to create events and change event-level metadata such as their names, dates, and Event Admin Grants. This authority may be exercised through server administration rather than the event interface.
_Avoid_: Event Admin, Pitch Manager

**Production Acceptance Authority**:
Either of the two people who must approve production use for an Event: the repository maintainer for technical readiness and the organizing association's president for operational readiness. Both approvals are required, and either authority may require fallback to the Official Score Sheet and manual timing.
_Avoid_: Technical Admin, Event Admin

**Event Admin Grant**:
The Event-scoped shared capability that admits Event Admins without individual accounts. It is created and managed by the Technical Admin.
_Avoid_: Event Admin account, organizer account

**Pitch Manager Grant**:
The Pitch-scoped shared capability that admits Pitch Managers without individual accounts. It is created and managed by Event Admins.
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

**Ad Hoc Game**:
A disposable game started outside any event for a friendly or spontaneous session. Its team names remain editable, and it has neither a Game Lock nor a durable Control Audit Trail.
_Avoid_: Game from scratch, unassigned game

**Game Timeline**:
The spectator-visible history of sporting events, such as goals and cards, ordered by their game time and updated when a correction changes the record.
_Avoid_: Audit log, command log

**Game Commencement**:
The irreversible boundary between provisional clock setup and an Event Game whose play has genuinely begun.
_Avoid_: First play tap, current running state, game creation

**Control Audit Trail**:
The permanent record of accepted control actions, corrections, originating Controllers, synchronization, and conflict outcomes for an Event Game. It is operational evidence visible only to Event Admins and Technical Admins, rather than the spectator-facing history.
_Avoid_: Game Timeline

**Grant Audit Trail**:
The permanent record of Grant credential, session, rotation, expiry, reactivation, and recovery events without raw credentials or claimed human identities. Like every Audit Trail, it is visible only to Event Admins and Technical Admins.
_Avoid_: Control Audit Trail, security log, access log

**Game Lock**:
The automatic safeguard that blocks control and further Grant admission for a finished Event Game 15 minutes after its last accepted control action. Paused, suspended, unfinished, and Ad Hoc Games never lock due to inactivity.
_Avoid_: Finalization, inactivity timeout

**Official Score Sheet**:
The paper record signed by referees after a game and treated as authoritative for the event. The app's Game Timeline and Control Audit Trail support live operations but do not replace it.
_Avoid_: Game Timeline, Control Audit Trail
