# Tempo: when a time is missed

Tempo's triggers and their rules live in `src/core/tempo/triggers.ts`; the rule
below is stated on `TriggerEngine` there and pinned by `triggers.test.ts`.

A trigger's time can pass unfired: its agent was paused, loom was not running,
or the clock jumped. What happens then depends on what the trigger is for.

- **A standing trigger** (one that repeats: lifespan `until-stopped` or
  `today`) fires at its time, or up to five minutes after it
  (`MISSED_GRACE_MS`). A time further behind than that is skipped, not fired
  late. The trigger's log gets a `missed` row naming the time, and the next
  time is worked out from now. A 09:00 lane never runs at 14:00 because the
  server came back then, and nothing fires twice to catch up.
- **A once-only trigger** (lifespan `once`) is a thing that is meant to happen
  once. It fires late, however late, as soon as it can, and is never dropped.

A step of the server's wall clock while loom runs (a resume from suspend, an
unpaused machine, a time correction) is judged by the same rule. loom reads the
wall clock again at least every 30 seconds (`STEP_CHECK_MS` in
`src/core/clock.ts`), so a time that comes after a forward step fires at its
time: it came due while loom was running and able to fire. A time the step
passed over is found behind at the next look and is fired or skipped as above,
as if loom had been down for that long.

Two other ways a time passes are not misses:

- A trigger that is off has no times. Turning it on, or changing its times,
  starts from now. A once-only trigger whose time passed while it was off
  cannot be turned on again.
- A firing that fails has used its time. The log gets `failed` and a `failure`
  row naming the step (`operation`, `instructions` or `inbox`); it is not tried
  again. A standing trigger goes on to its next time; a once-only one ends as
  failed.

Events (an answer, a job, a pull request) are not times. One seen while the
agent is paused fires when the agent resumes.

## Who may schedule, and from where

Who may set a trigger is `maySetTrigger` in `src/policy.ts`. Where the caller
is working matters too (`maySchedule`, beside it): the body of a job in a
**room** may set or reword no trigger at all. A room is a Discord or Slack
conversation that is not one member's own: a channel, a thread, a group direct
message, or a direct message from somebody who is no member. Such a body is
refused with "A body working in a room cannot schedule work: ask in your own
thread, or have an owner schedule it."

The reason: a trigger names an agent or a person, never a conversation, and a
firing for an agent opens a wake of the agent's own. Words chosen in a room
would later run outside it, without the room's people and the tool denials
that go with them. When a trigger can be addressed to a conversation, a room's
body will be able to set one that comes back into its own room. A body in one
member's own thread or direct message is not in a room and is judged by who it
is, as before. Stopping, starting and running a trigger are not changed.
