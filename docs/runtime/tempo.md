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

## Choosing a machine for a firing

The same caller who may set or edit a trigger may give it `needs` and
`prefers`. Both take arrays of machine facts. Every need must match.
A machine that meets every preference goes ahead of other eligible machines.
A missing preference never holds up work.

For a lane that reads journals on loom, first give only that machine the
owner fact `site:loom`. The machine ID by itself is not a fact. Example
input to `tempo.set`:

```json
{"ownerKind":"agent","owner":"art","sourceKind":"time","times":"07:13","lifespan":"until-stopped","targetKind":"inbox","toKind":"agent","to":"art","note":"Journal triage","instructions":"Read the local journals.","needs":["site:loom"]}
```

For a standing lane that should prefer a house but can run elsewhere, send
`{"id":"<trigger id>","prefers":["house"]}` to `tempo.edit`. The same fields
apply when the firing is started by hand. An omitted preference inherits
the agent's defaults. An explicit empty list uses only the agent's machine
order. Editing the preference to `null` restores inheritance. Admission snapshots these choices. Edits affect subsequent jobs.
When multiple firings share one admitted batch, loom combines their distinct
requirements and their explicit preferences. Retries keep the original lists.

## Who may schedule, and from where

Who may set a trigger is `maySetTrigger` in `src/policy.ts`. On whose word the
caller's job works matters too (`maySchedule`, beside it); where the body sits
does not. A **shared place** is a Discord or Slack conversation that is not one
member's own: a channel, a thread, a group direct message, or a direct message
from somebody who is no member.

- A job working for **owners** (household owners and members who have the
  agent), and the agent's own work, schedules from a shared place what it could
  from the owner's own thread: a trigger naming any conversation or none, with
  a file, at any times, watching an event; and it rewords, stops, starts and
  runs the triggers that person could. A member who has the agent and is no
  household owner is judged as in her own thread: what she has the agent
  schedule is her private work.
- A job with **anybody else** behind it (a guest, a member who does not have
  the agent, somebody loom cannot name) has **no schedule door yet**.
  `tempo.set`, `tempo.edit`, `tempo.start`, `tempo.runNow` and `tempo.stop`
  are refused it with "A job that is not working for the agent's owners sets and changes no schedule yet. Ask the owners a question instead."
  It also neither pauses nor resumes the agent, nor changes any mail's volume.
  The question is asked of the job the caller's credential is bound to, in
  whatever state that job or its conversation is.
- Why switched off: until an owner can grant a named person or a project tools
  of their own, such a body runs with loom's tools only and has nothing
  long-running to come back to. See "Switched off until grants" below for what
  stays in the code and is not reachable.

### A trigger that names a conversation

`tempo.set` takes `conversation`: a Discord or Slack conversation of the agent
the trigger puts to work (`triggers.conversation`). Its firing opens no wake.
It is mail from the schedule in that conversation and starts a job there like
any message: the conversation's stored session, and the answer posted in the
conversation as a new message. Words limit, time zone and occurrence ids are
those of every trigger. The rules are in `src/shared-place-triggers.ts`.

- **Who asked** is recorded with it (`asked_by_kind`, `asked_by`, `asked_at`).
  Set by a person, it is that member. Set by a body, it is the person on whose
  word its job works, wherever the job sits: the member it works for, or the
  person behind its mail (a job holds one asker's mail). The agent is
  the asker only when the work is its own, with nobody behind it. Nobody loom
  cannot name is ever the asker.
  A firing never carries one person's text on another's word. Changing a
  trigger's words (its note, its instructions or its file) makes the editor
  its asker, so an editor with more reach than the asker replaces all of them
  together, the note and the instructions or a file; changing only part is
  refused with a line saying to give both or leave the words alone. Changed
  means different from what is stored: words sent back as they stand are not
  changed, the asker stays, and an edit that sends everything and changes one
  part is refused like one that sends one part. The rule
  bites only when the old asker's reach is lower than the editor's: the asker
  changes their own trigger freely, and an owner or the agent's own work
  changes freely what the agent or an owner asked for.
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
  out). If not, nothing is delivered, the trigger is stopped, and a notice saying
  why goes to the members who have the agent, or to the household's owners
  when nobody has it. The notice is written each time the trigger is stopped
  this way: turned back on and stopped again, they are told again. **A channel rule that was removed does not
  by itself stop a firing: a mention there would still wake the agent.**
- **Held at the firing itself.** Asked where a firing is made, whatever door
  set or changed the trigger: into one member's private conversation a
  trigger fires only on that member's word or as the agent's own work, and one
  that watches an event fires only on the word of an owner or the agent;
  otherwise it is stopped with the notice. No firing is put off or held back
  for how soon it follows another. A stopped trigger's log says `stopped`,
  then `fired`.
- **No numeric limits; notices instead** (the owner's ruling, 2026-11-18). No
  count or interval refuses a trigger. What could run away is told to the
  members who have the agent, or to the household's owners when nobody has it,
  and nothing is stopped:
  - when 10 triggers stand at once for one conversation, and at each further
    10 (`PLACE_TRIGGERS_NOTICE_EVERY`), counted when one is set or turned back
    on; one mark is told once a day;
  - when come-backs follow one another 5 times in a row, and at each further 5
    (`COME_BACK_NOTICE_EVERY`). Dormant: see "Switched off until grants".
- **Switched off until grants** (the owner's decision, 2026-11-18). These are
  in the code and no door of a body on anybody else's word reaches them now:
  - the owner's card for a repeating schedule on such a word (`placeSchedule`,
    filed by `ownersFirst`). The kind still works when loom's own code files
    one: an owner allows or denies it, no standing rule answers it,
    `household.propose` does not take it, and what the owner is asked and what
    the answer says are loom's words only. On the card every word a caller
    chose is quoted: the note, the words, the model wanted, and the trigger's
    id, which is also cut at 80 characters wherever loom shows it. A change
    shows the standing note, words and times beside what changes;
  - the one-time come-back such a job could set, the `comes back` row in the
    trigger's log, and the notice at every fifth come-back in a row
    (`COME_BACK_NOTICE_EVERY`);
  - the finer refusals for such a job (own shared place only, own words, no
    file, no event, the same asker's triggers only, nothing fired by hand).
  A trigger that already stands on such a person's word (in the database from
  before, or made by the card) still fires on that word, at the floor, and is
  stopped as described above when its asker is no longer known.
- **A trigger keeps to its asker.** A trigger's
  words are its instructions, its file and its note (`editsWords`). Whoever
  changes a trigger's words becomes its asker; a change of times alone leaves
  both as they were. So a firing's words and its asker always come from the
  same person.
- **For every job.** No job fires or starts again the trigger whose firing is
  in its mail. One member's private conversation is named only on that
  member's word, or by the agent's own work.
- **For a job working for anybody but owners.** It fires no trigger by hand
  (`tempo.runNow`): it is awake and does the work now. Its trigger carries its
  own words: naming a `file` of the household's repository is refused on
  `tempo.set` and `tempo.edit`. One that watches an event is refused with a
  line of its own. It neither pauses nor resumes its agent (`tempo.pause`,
  `tempo.resume`), which would hold or release every trigger the agent has,
  and it changes the volume of no mail (`inbox.volume`): muted mail starts no
  job and joins none, in whatever conversation it waits.
- An owner, and the agent in its own thread, see, reword and stop these like
  any trigger. A body working for anybody but owners reads its agent's triggers
  as before, all of them, and can change only its own conversation's (see the
  accepted trade-offs).
