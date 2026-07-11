# Quadball Game Operations

This context describes the shared language for preparing, controlling, and recording quadball games at events.

## Language

**Event**:
A named quadball gathering configured by the Technical Admin with one or more Game Days. It is current on each Game Day, future before its next Game Day, and past after its final Game Day.
_Avoid_: Tournament, event window

**Game Day**:
A calendar date on which an Event holds games. Game Days have no event-level start or end time.
_Avoid_: Event session, event time window

**Controller**:
A participant admitted to control a game. Every controller has equal authority over the full game, and multiple controllers may collaborate or change during play.
_Avoid_: Scorekeeper role, timekeeper role, primary controller

**Head Referee**:
The game official with final on-pitch authority to make and correct calls, stop or resume play, and direct game timekeeping and scorekeeping.
_Avoid_: HR, referee admin

**Official Override**:
A Head Referee-directed action that intentionally departs from a normal rule-derived guardrail while remaining part of the game's authoritative operational record.
_Avoid_: Rule exception, forced command

**Control Grant**:
A game-specific secret that admits a Controller. Its QR link and verbally transmissible code are interchangeable ways to present the same authority, without an account or login.
_Avoid_: User account, controller account, controller role

**Pitch Manager**:
The person responsible for keeping one pitch operating during an event. A Pitch Manager can access that pitch's games and their Control Grants, but cannot create, edit, or delete event games.
_Avoid_: Event Admin, Controller

**Event Admin**:
A person holding the event's shared Event Admin Grant. Event Admins create and manage the event's Teams, Pitches, Event Games, Pitch Manager Grants, and Control Grants, but cannot change event-level metadata.
_Avoid_: Pitch Manager, Controller

**Technical Admin**:
The operator authorized to create events and change event-level metadata such as their names, dates, and Event Admin Grants. This authority may be exercised through server administration rather than the event interface.
_Avoid_: Event Admin, Pitch Manager

**Event Admin Grant**:
The event-specific shared secret that admits Event Admins. It is created and managed by the Technical Admin without individual accounts.
_Avoid_: Event Admin account, organizer account

**Pitch Manager Grant**:
The pitch-specific secret that admits Pitch Managers to that Pitch's schedule and game Control Grants. It is created and managed by Event Admins.
_Avoid_: Pitch Manager account

**Event Team**:
A team registered within an event, with an Event Admin-managed name and default color. Its name remains fixed during a game, while its displayed color may change and its playing side may be flipped.
_Avoid_: Home team, away team

**Pitch**:
An event-managed identifier used to publish where a game is played and scope Pitch Manager access. It is informational to Controllers and does not affect game operation.
_Avoid_: Court

**Event Game**:
A game scheduled within an event between Event Teams and assigned to a Pitch. Controllers cannot rename its Teams, but an Event Admin may correct which Event Team occupies either side even after control begins.
_Avoid_: Assigned game, scheduled match

**Ad Hoc Game**:
A disposable game started outside any event for a friendly or spontaneous session. Its team names remain editable, and it has neither a Game Lock nor a durable Control Audit Trail.
_Avoid_: Game from scratch, unassigned game

**Game Timeline**:
The spectator-visible history of sporting events, such as goals and cards, ordered by their game time and updated when a correction changes the record.
_Avoid_: Audit log, command log

**Control Audit Trail**:
The permanent record of accepted control actions, corrections, originating Controllers, synchronization, and conflict outcomes for an Event Game. It is operational evidence rather than the spectator-facing history.
_Avoid_: Game Timeline

**Game Lock**:
The automatic safeguard that blocks control of a finished Event Game 15 minutes after its last accepted control action. Paused, suspended, unfinished, and Ad Hoc Games never lock due to inactivity.
_Avoid_: Finalization, inactivity timeout

**Official Score Sheet**:
The paper record signed by referees after a game and treated as authoritative for the event. The app's Game Timeline and Control Audit Trail support live operations but do not replace it.
_Avoid_: Game Timeline, Control Audit Trail
