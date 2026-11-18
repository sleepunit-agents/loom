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
is working matters too (`maySchedule`, beside it). A **room** is a Discord or
Slack conversation that is not one member's own: a channel, a thread, a group
direct message, or a direct message from somebody who is no member. The body
of a job in a room may set, reword, stop, start and run only a trigger that
**names its own conversation**. Every other call from a room is refused with
"A body working in a room cannot schedule work: ask in your own thread, or
have an owner schedule it." A body in one member's own thread or direct
message is not in a room and is judged by who it is.

### A trigger that names a conversation

`tempo.set` takes `conversation`: a Discord or Slack conversation of the agent
the trigger puts to work (`triggers.conversation`). Its firing opens no wake.
It is mail from the schedule in that conversation and starts a job there like
any message: the conversation's stored session, and the answer posted in the
conversation as a new message. Words limit, time zone and occurrence ids are
those of every trigger. The rules are in `src/shared-room-triggers.ts`.

- **Who asked** is recorded with it (`asked_by_kind`, `asked_by`, `asked_at`).
  Set by a room's body, it is the person whose message started the job that
  set it; when the job's mail is from several people, the one of least reach.
  Set by a person, it is that member. Set by the agent outside a room, it is
  the agent. Nobody loom cannot name is ever the asker.
- **A firing runs on the asker's word.** The mail carries the asker
  (`inbox.on_word_kind`, `on_word`), and the job counts them as in the room at
  the tier they have when it is claimed (`src/runtime/body-policy.ts`): a guest
  asker brings the tools a guest's body is not given. With the agent or an
  owner as asker only the always-denied tools apply. The body is told the mail
  is from the schedule, who asked and when.
- **Stopped when it can no longer fire.** At a firing loom asks whether the
  asker is still known to the agent (a member in the household now, or an
  outside account that still has a tier), and whether the conversation is
  there and can be posted to (its connection in use, its channel not filtered
  out). If not, nothing is delivered, the trigger is stopped, and the agent's
  owners get one notice saying why. **A channel rule that was removed does not
  by itself stop a firing: a mention there would still wake the agent.**
- **Bounds.** At most 10 triggers stand at once for one conversation
  (`ROOM_TRIGGERS_MAX`). Set or reworded from a room, a repeating one lists
  times at least an hour apart (`ROOM_REPEAT_MIN_MS`) and watches no event.
- An owner, and the agent in its own thread, see, reword and stop these like
  any trigger. A room's body reads its agent's triggers as before, all of
  them, and can change only its own conversation's (see the accepted
  trade-offs).
would decide in the room what happens outside it.
