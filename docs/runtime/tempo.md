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

## Scheduled house programs

A program firing belongs to the agent and has its own attempt in the trigger's conversation.
The trigger records the reviewed repository, commit, image, house-relative executable, literal arguments, time limit and named credentials. A program-capable worker checks those pins and uses the same isolated container as a kit invocation. If the configured house moves, attempts fail until an owner replaces the schedule with one carrying matching pins. Stop the old trigger to end its failed attempts. Machine sharing, liveness, available slots, needs and preferences still apply. Model availability and account sign-in play no part in choosing a machine.

The version 1 result is one UTF-8 JSON object on stdout. Zero exit requests application of that
result. A nonzero exit fails the attempt and discards its output. The required fields are
`version: 1` and boolean `wake`. Optional fields are `line` (a short human-readable summary),
`payload` (JSON data for the wake), `state` (JSON for a later firing), and
`post: {channel, text}` (one delivery through a ruled bridge channel). A wake and a post may
occur together. A successful quiet watch returns `{"version":1,"wake":false}`.
Granting a program name does not grant a secret. The worker needs the intersection of the
frozen alias list, the agent's configured house aliases and the current startup grants.

Set an agent-owned time trigger targeting its own inbox. Supply `program: {name, repository, commit, image, program, args, timeoutMs, secrets}`. The inner `program` is the house-relative executable path. Use the usual scheduling fields and wake instructions. In `secrets`, map each `KIT_` environment alias to its configured secret name. Changing that mapping in the house settings invalidates the binding.
An owner, or a job acting on a verified household owner's word, can set the program definition. A firing snapshots the descriptor
and the last state. Set `readStateFrom` to read another program trigger in the same agent and
project. A result always updates its own trigger. Omitting state keeps the previous value.
Use a dated draft in state when an older producer result should expire.

Stdout accepts 16 KiB including whitespace. Payload and state each accept 8 KiB of serialized
JSON, up to 32 levels deep. A line accepts 1,024 characters on one line. A post has a channel
ID of 1–200 characters and text of 1–4,000 characters. The channel must resolve to one ruled
Slack or Discord destination for the agent. Extra fields, extra stdout, malformed UTF-8,
credentials found in the result, or a nonzero exit fail the attempt. The worker discards stderr.
The payload reaches the wake as explicitly labeled, JSON-encoded program data.

Tempo records start, elapsed running time, the outcome and the supplied line. Each program job
has zero model calls and tokens. Its wake uses ordinary inbox admission in the same conversation.
A run requesting a post queues it through the bridge. Delivery then follows the bridge's normal
held, sent and uncertain-delivery handling. Replay of the finish receipt cannot enqueue a second
post or wake. Invalid results apply no effects. Loom reports a failed or lost job and waits for
the next firing. It never re-executes an uncertain program attempt automatically.

Overlapping firings are skipped. Set `programPeriod: "day"` to admit at most one attempt per
household calendar date, including failed or quiet attempts. Leave it unset for a frequent
watch. The trigger details show the latest outcome and its retained state. The scoped query
`tempoProgram(id: String!)` returns the descriptor and state to the owner or the agent.

## Wake me when

An agent that would otherwise poll (a script that checks a pull request every ten minutes) asks loom to do
the waiting: `tempo.wake`, or the tool `wake_me_when`. Input: `what`, an optional `when`, an optional `note`
to self, and for a terminal session, which session it is (`session` or `conversation`).

| `what` | Watches | `when` |
| --- | --- | --- |
| `github:owner/repo#12`, `owner/repo#12` or the pull request's address | a pull request | `changed` (the default), `checks-finished`, `checks-failed`, `review`, `merged-or-closed` |
| `job:<id>` | a job ending | |
| `approval:<id>`, `question:<id>`, `secret-request:<id>` | an ask being answered | |
| `at:<instant with its offset>`, `in:<minutes>` | a time | |

It answers the trigger's id and one sentence of what will happen. The wait is an ordinary once-only trigger
with an inbox target whose `target` is exactly one of a closed list (`wake`, or `wake:<condition>`;
`core/tempo/wake.ts`, `WAKE_TARGETS`). The same exact comparison is used in code (`isWake`) and in SQL
(`wakeRows`). Tempo lists the wait by its note ("Wake Art when checks finish on acme/app#12"), whoever sees
the trigger sees the wait, `tempo.stop` cancels it, and the agent's card says "Waiting on checks on
acme/app#12". `tempo.set` refuses any target that begins like a wake's, in any case: a wake is made only at
its own door.

The note to self is not on the trigger. A trigger is read by household owners, everybody in its project and
everybody who has its agent, which is wider than one member's private conversation. The note is kept as a
closed inbox item in the conversation the wake belongs to, read by whoever reads that conversation, and
handed back with the wake. The title and what is watched are on the trigger, as for any trigger.

### Who may ask, and where it is woken

What `tempo.set` asks of the same caller, in the same order: a job that is not working for the agent's
owners sets none; the caller may set the trigger as it is recorded (`maySetTrigger`); and it reads what is
watched. Every check that needs no network is made before anything is read outside.

Where the caller is, is proven by its credential and never named freely:

- A runtime body is woken in the conversation its job works in. It names no other.
- A terminal credential is woken in a terminal session of its own machine, member and agent that is live
  now. It says which, with `session` (its harness session id) or `conversation` (the id `terminal.session`
  answered its hook), and loom checks it. Naming none is refused; loom does not guess.
- Any other credential of the agent is in no conversation. Its wake starts a new conversation, private to
  the one member who has the agent. With several such members, or none, it is refused.

No credential aims a wake at a conversation of any other venue.

An agent holds at most 50 pending waits, held ones counted. The engine holds that bound wherever a wake
comes to stand: when one is set and when a stopped one is started (`triggers.ts`, `wakeRoom`). A wake is not
changed after it is asked: `tempo.edit` refuses one. A wait ends 14 days after it was asked, whatever it
watches and whatever state it is in; a time further off is refused.

### Pull requests

Whether the caller may watch a pull request is decided from what loom holds, never from GitHub
(`shared-tempo-access.ts`, `pullWatchable`). If loom holds the pull request, the changes rule decides. If it
does not, the caller must be one who would read any pull request of that repository by the rule's project
part: the repository is one project's, and the caller is in that project. Then, and only then, loom reads
the repository once with the household's GitHub sign-in and stores the pull request as Changes stores any
(this is the pull request opened a moment ago, which the poll has not seen yet). The repository is one the
poller already reads, so nothing else keeps the row fresh, and no row is made that Changes would not have
made.

Every other case gets one answer, the same in status, code and words, with nothing read outside: "That is
not a pull request you can watch." That covers a repository loom does not read, one it reads for a project
the caller is not in, a pull request that does not exist, and one loom holds that the caller does not read.
A caller who may read the repository is told when the read failed or found no such pull request. A job or
an ask the caller does not read, or that is not there, likewise gets one answer.

A condition is judged between two readings of the pull request, and fires when it becomes true, not while it
stays true. `checks-finished` means no check pending or running and at least one reported, so a head commit
whose checks have not begun is unfinished, and checks already finished when the wait was set are not news
until a new head finishes. `review` is any change in where the review stands: somebody new reviewed, or its
state moved either way, which includes an approval taken back by a new push; the words say which. A pull
request that is merged or closed ends any other wait on it, and says so.

### What the wake says

Built by code from the records, under the asking agent's read rules as they stand when it fires, at most 4,000
characters: loom's line that this is a wake and not a person, with what was asked and when; what happened,
with before and after ("Checks on acme/app#12 finished on 1a2b3c4: 2 failed: build, DCO sign-off. Before: 3
still running."); a link or reference; and the note, quoted as the agent's own words. An agent that may no
longer read what it watched is told only that the watch ended. One fired by hand says so.

### Where it is delivered

One function, `deliverWake` (`shared-wake.ts`), for every wake:

1. Find the session it belongs to: the conversation it was asked from.
2. A body is awake there: relay it in. A runtime body takes its mail once, as its turn begins, so the wake is
   mail in the conversation that the next turn of the same kept session reads, started the moment this one
   ends. A live terminal session is handed it by its hook (below).
3. Nothing is awake there: the wake is mail in the conversation, and waiting mail starts a job there.
4. No session to resume (asked outside any conversation, its thread archived or deleted, its bridge place
   closed, or a terminal session that has ended): a new conversation for the agent, with the same words and
   which conversation it continues. **It is never readable by anybody who could not read the one it
   replaces.** It carries exactly the old conversation's labels: its member, household owner or not, whether
   it is direct, and its project. Who reads a conversation is decided by those labels and the agent alone
   (`policy.ts`, `conversation`), so the same people read the new one and nobody else.

Where step 4 cannot make a place that private (the old conversation's row is gone, or its member may no
longer be worked for), the wake's words are not delivered. The trigger is stopped, its log says why
(`undelivered`), and one bare line with no note, no subject and no conversation id ("A wait you set has
ended; the conversation it was set in is gone.") goes to a conversation private to whoever asked: the member
on whose word it was asked, or for the agent's own work the one member who has the agent. With no such
member, nothing is said.

A wake asked on the word of somebody no longer known, or of somebody who is not one of the agent's owners
whose place is gone, is stopped. The agent's people are told that it was and why, and nothing of the wake.

### The terminal hook

`terminal.session` takes `wakes: true` on any report, and its answer then carries
`wakes: [{ id, at, words }]`, oldest first, at most ten. They are handed only on a report the session took
as its current instance's and that moved its last-heard time: an `open`, a new `turn` or a `heartbeat`. A
report from a superseded instance, a turn already recorded, a `usage` report and an `end` are handed none
and close none. Each wake is handed once and closed as taken by that session; a retry of the same report
(the same operation id) is answered with the same ones. A hook that does not send `wakes: true` is handed
none. A wake no hook picks up within 15 minutes (`terminalSilenceMs`), or whose session ends first, goes to
step 4.
