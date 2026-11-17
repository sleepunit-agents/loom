# Accepted trade-offs

Things in this program that are real, were looked at, and were left as they are on purpose. Each entry says
what it is, where it is, why it was accepted, and what would change the answer. If you find one of these in
the code and think it is a defect, read its entry first: a reviewer who finds one of these has found a
decision, not an oversight, and the site carries a one-line pointer back here.

Entries are grouped by the part of the program they belong to.

## Permissions

### A standing approval rule answers a household proposal with the authority of the owner who set it
- **What.** An agent files a household change with `household.propose` (add a member, change a secret rule,
  revoke a token). If a standing rule matches, the card is allowed at once and the change is made, with no
  owner answering at that moment. The work may have been for a member who is not an owner and who has no door
  to make that change themselves.
- **Where.** `src/shared-household-proposals.ts` (`file`, the last lines), `src/apps/approval-rules.ts`
  (`resolve`, `personFor`).
- **Why accepted.** The rule is the owner's answer, given ahead of time and in writing. Only a current
  household owner can set one. A rule with no person answers only for work done for a household owner. For
  anyone else to be answered, an owner must have set a rule that names that person, for that kind of card
  and that scope. The change is applied as the owner who set the rule: the card records them as
  `decidedBy`, run settings are checked against what that owner may offer, and a rule whose setter is no
  longer an owner answers nothing. A card with nobody known behind it (a terminal session, a room) always
  asks. A card that changes a rule always asks, so a rule cannot widen the rules. If the last answer to the
  same thing was a deny, it asks again.
- **Checked.** A body working for a member who is not an owner: the household's own rules (even `*`) do not
  answer; a rule naming that member does, within its kind and scope only; it stops when its setter stops
  being an owner or the member leaves. Test: `src/shared-household-proposals.test.ts`, "answers a card for
  someone who is not an owner only by a rule an owner set naming that person".
- **What would change the answer.** If rules could be set by anyone but an owner, or if a rule with no
  person ever answered for a member who is not an owner.

### A body keeps the agent's own knowledge, whoever it is working for
- **What.** A body doing a member's private work reaches a project, and what is labelled with its agent,
  only while that member has the same reach (`Viewer.workingFor` in `src/policy.ts`). Four things stay the
  agent's own and are not narrowed by the member: the household's shared knowledge files (`maySee`, the
  `knowledge` clause); the agent's own memory, which is labelled with the agent and with no project, so it
  follows the agent for as long as the member has the agent at all; the days of timing measurements (`tableRules.timingDays`); and which machines the
  agent itself may run on (`tableRules.boxAgents`, the agent case). A member who is not an owner reads none
  of these directly.
- **Why accepted.** They are what the agent knows and where it runs, not records of another person's work.
  An agent that forgot its memory or its machines when working for one of its members could not do the work.
  Timing days hold request names and durations, no words. What an agent chose to remember from one
  member's private thread is in its memory for its next piece of work, whoever that is for: that is what an
  agent's memory is, and it is not labelled by conversation.
- **What would change the answer.** A record of one member's private work becoming readable through any of
  the four. Then that table needs a member label and a rule that reads it.

### A household owner may end a job they cannot read
- **What.** `runtime.jobStop` is allowed to any household owner, and to a member who has the job's agent on
  their own list, by job id. The jobs read rule hides a job of another member's private thread from both.
- **Where.** `rules.stopJob` in `src/policy.ts`; the door is `src/shared-job-control.ts`.
- **Why accepted.** The household must be able to stop work running on its own machines. Stopping reads
  nothing: the caller has to know the id already, and the door answers only that the job stopped or had
  already ended. The owner ruled that an owner does not read another member's private thread; this does not
  let them. Watching such a job with a trigger, which would have told an owner when it ended, is refused
  (`src/shared-tempo-access.ts`).
- **What would change the answer.** The door returning anything of the job (title, brief, log), or a list of
  job ids becoming readable to someone the jobs rule hides them from.

### The private secret-input routes are not registered operations
- **What.** `POST /api/secrets/private/{startup,read,confirm}` write grant and use rows (`startGrants`,
  `dispatch`, `confirm`) without going through `Operations`, so they have no `may` function and no receipt.
- **Where.** `src/shared-secret-inputs.ts`, mounted in `src/shared-root.ts`.
- **Why accepted.** `read` answers with the secret's bytes. An operation's result is JSON that is saved as
  a receipt and replayed on retry, and results pass through the action log; a secret must reach none of
  those. `confirm` settles the use that `read` started and is held to the same proof. Who may call is not a
  sharing rule about a member or an agent, so it is not in `policy.ts`: it is proof of assignment, like a
  worker's doors. The writes still go through the one write queue (`secretCommit`).
- **The checks these routes make, in order.** The program is not closing. The request authenticates
  (`sharedCredentials.authenticate`) and its credential is a body's (an agent token bound to a job) or a
  worker's. The body is JSON. A body may name no job: its job is the one on its credential, it must be that
  agent's, and it must be running. A worker must name a job, that job must be starting on the
  worker's own machine, and a worker may ask only for the repository secret. The job's binding (agent,
  machine, conversation, member, project, house repository, file and branch) is recorded and must be
  unchanged, with the credential still valid, when the bytes are handed over and when the use is confirmed.
  A requested secret needs a current grant for that secret, agent and job (`SecretPrivateInputs.dispatch`);
  a startup secret must be an alias in that job's startup plan with a current grant, and still map to the
  same secret; the repository secret must still be the one the agent's run settings name.
- **What would change the answer.** An operation result path that is never stored or logged. Then `confirm`
  could become an operation at once, and `read` with it.

### Two reads that leave a mark
- **What.** `memory.recall` is registered as a read and adds heat to the memories it finds.
  `runtime.accountUsageBasis` is a read that remembers, in the process's memory only, the basis it handed
  out.
- **Where.** `src/pieces/mind/semantic-commands.ts`, `src/shared-account-reports.ts`.
- **Why accepted.** Heat is a ranking hint in the agent's own store, written by the store in its own short
  transaction; recalling twice is meant to warm twice, so there is nothing for a receipt to make
  repeat-safe. The usage basis is not stored data: it is lost at restart and the worker asks again. Both
  have a `may` check.
- **What would change the answer.** Heat deciding anything but order (for example, what is pruned without
  review), or the basis being written to the database.

## Credentials

### A sign-in link carries its one-time code in the URL
- Where: `src/core/signin/shared-links.ts` (`makeLink`, `GET`/`POST /login/:code`); printed by `loom signin`
  and `loom-token link`.
- What: the code is the last part of the link's path, so a reverse proxy's access log, a browser's history
  or a terminal's scrollback can hold it.
- Why accepted: a link a person can be handed and open is the whole mechanism. The code is good once, for
  five minutes at most (`LINK_MS`); opening the page spends nothing, redeeming is a POST from that page, and
  the page sends only its origin as referrer. Putting the code in the fragment would need script on a page
  whose policy is `default-src 'none'`.
- What would change it: links that last longer or can be used more than once, or a deployment whose proxy
  logs are read by people who must not be able to sign in.

### The sign-in routes are not registered operations
- Where: `src/core/signin/shared-links.ts` (`sharedSigninLinkRoutes`): `/api/signin/token`,
  `/api/signin/program`, `/api/signin/link`, `/passkeys`, `/logout`, `/login/*`.
- What: these writes do not go through the operation dispatcher, so they have no `may` function and no
  receipt. Each route carries its own gate.
- Why accepted: every one of them answers with a credential (a token, a link, a cookie), and a registered
  write's answer is kept as a retry receipt for thirty days. The gates use the same authentication as every
  other door, refuse program tokens, and are checked before, inside and after the write.
- What would change it: a dispatcher that can run a write without keeping its answer. Then these become
  operations and the gates become `may`.

### A device sign-in's user code stays in the inbox item
- Where: `src/shared-account-signin.ts` (`runtime.signInPage`).
- What: for a provider's device flow, the short code the person types on the provider's page is part of the
  item's words and is not removed when the sign-in ends.
- Why accepted: it is meant to be read by that person, it grants nothing without the half the provider's
  program keeps on the worker, and it is dead when the flow ends. Rewriting an item's words afterwards
  would change what the person's own history says.
- What would change it: a provider whose user code is enough by itself, or stays valid after the flow.

### A pasted sign-in code is in clear for a moment, in two places
- Where: `inbox.answer_text` between the owner's answer and the worker's take
  (`src/shared-account-signin.ts`, `runtime.signInTake`); the `code` file in the relay's private directory
  on the worker (`src/runtime/account-signin-relay.ts`).
- What: the owner hands the code to loom by answering an inbox item, so it is an ordinary answer until the
  worker takes it (one poll, about two seconds), and the owner can read their own answer back in that time.
  After the take it exists only in loom's memory, then in a file only the worker's OS user can read, until
  the provider's program deletes it or the sign-in ends.
- Why accepted: an inbox answer is how a person gives loom words, and a file is how the provider's program
  is given them. The code is a provider's one-time code and is useless without the half that program holds.
- What would change it: an answer kind that never touches the database, or a provider program that reads
  the code from a pipe.

### A taken sign-in code does not survive a restart of loom
- Where: `src/shared-account-signin.ts` (`held`).
- What: once taken, the code is kept in memory for the one worker that took it. If loom restarts before
  that worker has read it, the sign-in fails and has to be asked for again.
- Why accepted: keeping it anywhere durable is what "handed over once" is meant to prevent, and the window
  is one request.
- What would change it: sign-ins failing this way in practice.

### An automated browser is recognised by its own name when nobody said it was one
- Where: `isAgentBrowser` in `src/core/data/authentication.ts`; `startBrowser` in
  `src/core/signin/shared-browser.ts`.
- What: a browser that calls itself HeadlessChrome gets the short session and may not make links or add
  passkeys. One that sends another User-Agent is treated as a person's unless its link was made with
  `loom signin --agent`.
- Why accepted: a link is a member's credential, and whoever is handed one is that member. The limit that
  can be relied on is the one the link's maker sets; the User-Agent check only catches the automation that
  does not hide.
- What would change it: agents being able to ask for links themselves.

### Root keys are readable on disk by their own process
- Where: `push-vapid.json` in the home (`src/core/signin/notification-key.ts`).
- What: the push-signing private key is stored in clear.
- Why accepted: the program has to read it unattended. The file is created exclusively with mode 0600 and
  read through `privateBytes`, which refuses a file that is not this OS user's, has another mode, or has a
  second link. Whoever can read the home as that user already holds the database.
- What would change it: running loom where an OS keyring or a hardware key is available to an unattended
  service.

### Passkey challenges are kept in memory and can be pushed out by a sustained flood
- Where: `src/core/signin/shared-passkeys.ts`.
- What: sign-in challenges live in a set of 1024 that drops its oldest when full. Somebody sending more
  than a thousand requests in the seconds a person's sign-in takes can still make that sign-in fail; a
  restart forgets outstanding challenges.
- Why accepted: the route has to answer strangers, and loom has no rate limiter of its own; a household's
  loom sits behind a proxy or on a private network. Sign-in by link is unaffected.
- What would change it: loom being served to the open internet with nothing in front of it.

## Running work

### The placed account is taken on trust when a machine has one command per harness

- **What.** loom places a job on an account it checked for room. A worker configured with `runners` (one
  command per harness) runs the job with that command, and the command is signed in to an account by its
  own environment. Nothing can check that it is the placed account.
- **Where.** `workerRunner` in `src/runtime/worker-process.ts`; `Dispatcher.accountChoices` in
  `src/runtime/dispatcher.ts`.
- **What is enforced.** loom tells the worker how many accounts of the job's provider are signed in on its
  machine. With more than one, a worker with one command for the harness refuses the job (exit code 27)
  unless the command declares `selectsAccount`. With `accountRunners`, a job runs only on the command
  bound to its account.
- **Why the rest is accepted.** With one account of the provider on the machine, the command can only be
  on that account unless someone signed its program in to another account outside loom. loom has no way
  to ask a third-party program which account it is signed in to.
- **What would change the answer.** A harness that reports the account it ran on. The worker could then
  compare it with the placed one and fail the job.

### Bodies a killed worker left that cannot be told from a stranger

- **What.** A worker that starts ends what a killed worker left (`src/runtime/worker-left.ts`). Three
  things are outside what it can do:
  1. A process group whose leader has gone, whose surviving members do not carry the body's scratch
     directory in their environment (a child that cleared its environment, or any system without
     `/proc`). The group's number may have been reused, so it is left running, counted, and reported on
     the worker's error stream.
  2. A killed worker that is never started again. Its body runs on until then. A body started by loom's
     own body program stops by itself at its next report after loom has ended the job (its credential
     dies with the job). A plain `{job,build}` runner has no such report and runs to its end, beside the
     retry if the retry was placed on another machine.
  3. Containers started by a worker from before the `loom.box` label existed. They are not removed.
- **Why accepted.** Killing a process group that cannot be shown to be loom's own is worse than leaving
  one running. Case 2 needs something on the machine that outlives the worker, which is a supervisor
  loom does not ship. Case 3 is one upgrade.
- **What would change the answer.** Running bodies under a supervisor that ends them when the worker
  dies (a systemd scope or a container for every body), or a harness-independent way to mark a process
  as a body's.

### Silence is measured on the server's wall clock

- **What.** A job or a machine is silent when its last report is more than two minutes old by the
  server's clock (`src/runtime/silence.ts`, `Jobs.sweep`, `Machines.sweep`, `selectPlacement`).
- **What is enforced.** After a jump of that clock, or a stall of the program, the sweep waits one whole
  interval before it calls anything silent (`createRuntime`), and a stamp left later than now is counted
  from now. A forward step no longer loses live jobs; a backward step no longer hides dead ones for its
  length.
- **Why the rest is accepted.** A jump therefore delays noticing a job that really died by up to one
  interval. Placement still passes over a machine whose stamp looks old or is in the future until its
  next report, at most fifteen seconds later.
- **What would change the answer.** Stamping reports with a count that only moves forward instead of a
  time, which is a schema change.

### A queued job has one deadline, whatever keeps it queued

- **What.** A job no machine has taken 24 hours after it could first be claimed is ended as failed
  (exit code 31) and not tried again (`QUEUE_DEADLINE_MS` in `src/runtime/jobs.ts`).
- **Why accepted.** Placement leaves a job queued for several reasons (no machine reporting, no account
  with room, no harness that can run it). Most pass by themselves, and loom does not record which one
  applied, so there is one rule and one number rather than a rule per reason. Work that waited a day
  for a usage window is ended although it could still have run.
- **What would change the answer.** Recording why placement passed a job over. A job no harness can ever
  run could then fail at once, and one waiting for room could wait as long as the window.

### A body's credential and its tools bearer cannot be erased from memory

- **What.** The body's loom credential is erased as bytes, but the same value exists as JavaScript
  strings in the worker (when it writes the body's input) and in the body (in request headers). Strings
  cannot be erased; they last until the process ends or the garbage collector takes them.
- **Where.** `src/runtime/body-bootstrap.ts`, `src/runtime/worker-process.ts` (`release`),
  `src/runtime/body-program.ts`.
- **Why accepted.** The credential is good only while its job is unended and is useless after. Reading
  another process's memory needs the same user or root, who can already read everything the body can.
- **What would change the answer.** A runtime that sends bytes over HTTP and to a child's stdin without
  making a string of them.

### The body-tools bearer is readable by the body's own user

- **What.** Each body serves its tools on loopback behind a bearer made for that body. Claude Code gets
  it on a file descriptor. Codex takes a bearer only from an environment variable, and agy only from a
  file in its workspace. While the body lives, a process of the same user can read the variable from
  the Codex process, or the file (mode 0600, in the body's 0700 scratch directory).
- **Where.** `src/runtime/codex-body.ts`, `src/runtime/agy-body.ts`.
- **What is enforced.** The bearer is in no argument. Codex is told to leave the variable out of the
  commands its shell runs. The agy file is written only inside the scratch directory the worker named,
  which is removed after the body, and by the next worker if this one is killed.
- **Why the rest is accepted.** The bearer opens only that body's tools, which the model can already
  call, and it dies with the body. Another user cannot read either. Neither program offers another
  way in.
- **What would change the answer.** Codex or agy accepting a bearer on a pipe or file descriptor.

### A timezone change while loom is down is seen one firing late

- **What.** When the household's timezone changes while loom runs, standing wall-time triggers move to
  their next time in the new zone at once. The engine notices by comparing with the zone it last saw,
  which it keeps in memory. A change made while loom is down is not noticed: each trigger's stored next
  time is still the old zone's until it has fired or been skipped once.
- **Where.** `TriggerEngine.scan` and `rezone` in `src/core/tempo/triggers.ts`.
- **Why accepted.** The timezone is changed through loom, which is running when that happens.
- **What would change the answer.** Storing the zone each next time was worked out in, which is a schema
  change.

## Bridges and conversations

### Mail is delivered at least once
- What: mail a body took and accepted is handed to a body again if the first one's job is lost or fails
  before it answered. The agent can see the same outside message twice.
- Where: `src/core/conversations/mail.ts` (`accept` settles nothing; `settle` and `confirm` do),
  `src/runtime/jobs.ts` (a lost job's taken mail waits again, bound to the retry).
- Why: the other choice is at most once, where a body that dies after taking a message leaves it answered
  by nobody. A message read twice costs a little work; a message never answered is a person ignored. An
  answer is still given once: the reply settles everything its job took, in the reply's own write.
- Would change it: evidence that bodies act on mail before they answer in ways that must not repeat
  (payments, posts elsewhere). Then mail needs a "seen before" mark the second body is shown.

### An answer is kept in up to three records
- What: a person's answer is on the question's Inbox row (`answer`, `answerText`), in the answer mail sent
  to the agent, and, in a Comms thread, in the answer message (`messages.verdict`, sealed words).
- Where: `src/core/conversations/index.ts` (`answer`), `messages.ts` (`prepareAnswer`,
  `prepareInboxAnswer`); the rule for all three writers is `answer-rule.ts`.
- Why: each record has its own reader and its own keep time: the row shows the person what they said, the
  mail is what a body takes, the thread message is the sealed transcript. One transaction writes them, one
  rule accepts or refuses, and the readers refuse when they disagree (`answer-context.ts`,
  `body-input.ts`). `redactAnswer` replaces the plain copies together.
- Would change it: a schema step that drops `messages.verdict` and derives it from the answered item.

### An outside account is named in three places
- What: a platform user id appears in `bridge_people` (which household member it is), in `agent_people`
  under `outsidePersonKey` (how one agent treats that account) and in a person card's handles (what the
  agent has noted about the person).
- Where: `src/pieces/bridges/settings.ts`, `src/shared-agent-body-policy.ts` and
  `src/runtime/body-policy.ts`, `src/backends/people.ts`. The key's format has one definition,
  `src/pieces/bridges/keys.ts`.
- Why: they are three facts with three owners, not three copies of one. A tier belongs to the outside
  account and is meant to stay when that account is linked, re-linked or unlinked; a card is descriptive
  and decides nothing. Removing a link therefore leaves both, on purpose.
- Would change it: a tier or a card being used to decide who somebody is. Only `bridge_people` may do that.

### A reply in doubt is never sent again
- What: when a post fails after its request left, the reply is `uncertain`. A person can dismiss it. Nobody
  can resend it, and that holds for a long reply whose earlier parts were confirmed.
- Where: `src/pieces/bridges/sends.ts` (`reviewReply`, and the state a stopped attempt leaves).
- Why: the platform may have it, and neither Discord nor Slack lets a post be made idempotent. A missing
  part is visible and a person can say it again; a doubled one cannot be taken back by loom.
- Would change it: a platform nonce that makes a repeat safe (Discord's `enforce_nonce`), used on every post.

### The Bridges screen shows a partly posted reply whole
- What: a long reply is one row with all its words whatever happens to it. When it stops part way and is
  `held` or `uncertain`, the screen shows the whole text and the state; which parts the platform confirmed
  is on record (`bridge_send_parts`) and is not shown.
- Where: `src/pieces/bridges/sends.ts`; `web/src/pieces/bridges-view.tsx`.
- Why: one row per reply means a reply has one id, one state and one review. A held reply that is released
  goes on from the parts on record, so nothing confirmed is posted twice whatever the screen shows.
- Would change it: owners dismissing replies in doubt without being able to tell what had arrived. Then
  the screen reads the parts and marks the words that are out.

### An unread event is kept for a day
- What: the raw frame of an event nothing could read yet is kept for a day, not the hour raw words are
  otherwise kept. It holds everything the platform sent, not only the message's words.
- Where: `src/pieces/bridges/events.ts` (`UNREAD_EVENT_LIFETIME`), `receiver.ts`.
- Why: the platform has already been told the event arrived, so the frame is the only copy. Deleting it
  at the hour lost the message whenever the program was stopped, the connection paused or the channel's
  details unreadable for that long. A day is what a held message is retried for; after it an answer
  would come too late to be wanted, and the loss is reported.
- Would change it: the owner preferring a shorter wait and an earlier report. The two lifetimes are one
  constant each.

### A Discord bot is connected in one guild at a time
- What: settings refuses a second enabled connection for the same Discord bot in another guild.
- Where: `src/pieces/bridges/settings.ts`; `incoming.ts` holds a direct message if a database has the
  setup anyway.
- Why: a connection names one guild, but a Discord bot's session hears every guild it is in and every
  direct message. Two sessions would each deliver the same direct message, under two guilds' person
  links, as two conversations. Messages from a guild that has no connection are set aside.
- Would change it: a household that wants one bot in two guilds. That needs a connection to name several
  guilds, so there is still one session and one home for the bot's direct messages.

### Some Discord channels carry no conversation
- What: a message in the text chat of a voice or stage channel, or any other kind that is not a text
  channel, an announcement channel, a thread or a direct message, is set aside. A mention there is not answered.
- Where: `src/pieces/bridges/channels.ts` (kind `other`), `normalize.ts`.
- Why: those places have no routing or threading rule in loom, and guessing one would file words in the
  wrong conversation.
- Would change it: someone wanting an agent in voice-channel chat; it would be routed like a text channel.

### A reply carries a copy of its address
- What: `bridge_sends.channel` and `thread` repeat the channel and thread of the message being answered.
- Where: `src/pieces/bridges/sends.ts` (`queue`). The rule for where a message sits is `place.ts`.
- Why: a received message's channel and thread never change after it is stored, so the copy cannot drift,
  and the send queue reads one row.
- Would change it: a way to move a received message between threads.

### Taking mail is a route, not an operation
- What: `POST /api/conversation/take` claims a body's waiting mail and returns its words, outside the
  operations registry: no `may`, no receipt.
- Where: `src/shared-root.ts` (the route), `src/core/conversations/body-input.ts`.
- Why: an operation's result is kept as its retry receipt, and this result is the decrypted words of
  private mail, which must be written nowhere. The response is also withdrawn mid-stream if anything it
  rests on changes, which a stored result cannot be. A retry needs no receipt: mail taken and not
  confirmed is returned by the next take.
- What it checks in an operation's place, in order: the program is not closing; the request is
  same-origin JSON; the caller authenticates and the credential is still valid; the caller is the current
  body of a live job in a conversation whose labels match the job (`conversationBodyScope`, which also
  requires the member's current right to run private work); every item about to be taken carries the
  conversation's own agent, member and project; handoff mail in an open conversation comes from an agent
  that is still a peer (`mayHandOff`); all of this again after decryption and before the claim; the claim
  is one write through the shared writer, so it is published like any other; the read version is exactly
  the one that claim made; and the words' keep time has not passed when the bytes are released.
- Would change it: operations gaining a result that is never stored. Then this becomes one.

### Policy is asked about the person a request names
- What: two doors build a viewer from an id in the request and ask the read rules about it: asking
  someone about a task (`tasks.command` `ask`) and a body's question to a person.
- Where: `src/shared-task-access.ts`, `src/shared-conversation-questions.ts`, through `addressee` in
  `src/policy.ts`.
- Why: the question is "could the person this is addressed to read it", so that nothing is sent to
  someone about a record they may not see. The answer only ever narrows what the caller may do.
- Would change it: any use of such a viewer to allow, read or write something. `addressee` says so.

## Stored data

### Upgrade step 6 removed three kinds of existing data
- **What.** A household upgraded from schema 5 or earlier lost every stored Discord resume cursor, the
  `outside_effects` table, and each conversation's `job` pointer.
- **Where.** Step 6 of `upgrades` in `src/core/data/database.ts`; `src/core/data/upgrade.test.ts` asserts it.
- **Why accepted.** None of the three was the only copy of anything. A resume cursor is a convenience: without
  one a Discord connection identifies afresh once, and the cursors from before named no credential, which was
  the defect the step closed. `outside_effects` was never written or read. The job working in a conversation is
  the one row in `jobs` that has not ended, so the pointer repeated it.
- **What would change the answer.** A step that removes data a household cannot get back. That needs the
  owner's say first, and a line printed at startup.

### Upgrade step 7 removed four kinds of existing data
- **What.** A household upgraded from schema 6 or earlier lost every unused sign-in link, the
  `signin_challenges` table and the `waiting` job state (a job in it became `running`), and each posted
  reply's one recorded id became the first row of its parts.
- **Where.** Step 7 of `upgrades` in `src/core/data/database.ts`; `src/core/data/upgrade.test.ts` asserts it.
- **Why accepted.** A sign-in link lives five minutes, and one made before the step cannot say which browser
  made it, which is what the step added; ask for another. `signin_challenges` was never written or read.
  No program ever set a job to `waiting`. A reply posted in several parts before the step had kept only its
  last part's id, so a thread under an earlier part of an old reply is still not known as the bot's.
- **What would change the answer.** As for step 6: a step that removes data a household cannot get back
  needs the owner's say first.

### A new person is two commits, not one
- **What.** `mind.personAdd` writes a person's card into two SQLite files (the directory's `people.db` and the
  adding agent's `memories.db`). A refusal or a failure on either side saves neither, but a process crash
  between the two commits leaves the agent's card alone.
- **Where.** `src/pieces/mind/people-actions.ts`; the repair is in `src/backends/people-creation.ts`.
- **Why accepted.** SQLite has no atomic commit across two WAL files. The survivor is harmless and is repaired
  by the next add of the same person, under any operation id: the agent's card is kept as it is and the
  directory card is written. Words that differ from the kept card are refused instead of dropped.
- **What would change the answer.** People moving into one file, or a need for the directory to be complete
  without anyone adding the person again.

### Only `loom.db` and `knowledge.db` are checked for being the right kind of file
- **What.** `memories.db`, `people.db` and `notes.db` are refused when a newer program has changed them (their
  version number in the file header), but a wrong SQLite file at one of those paths is not recognised as
  wrong: the store's tables would be created in it.
- **Where.** `refuseNewerStore` in `src/backends/migrations.ts`, the constructor in `src/notes.ts`; compare
  `recogniseDataSchema` in `src/core/data/database.ts`.
- **Why accepted.** The paths come from `program.json`, which the program writes at first install and nothing
  else chooses. Several modules legitimately make their own tables in `memories.db` first (cards, receipts,
  command bookkeeping), so "a file with other tables in it" is the normal case and "foreign" has no cheap
  definition. The household database, which a person might plausibly point at the wrong file, is recognised
  in full.
- **What would change the answer.** A way to choose these paths by hand, or an importer that writes them.

### The memory and knowledge tables are defined in their own stores, with no pinned shapes
- **What.** `memories`, `pages` and the tables beside them are created by the store that owns them and brought
  up to date by steps that read the file's shape. Nothing compares an upgraded file with a fresh one column by
  column, as `src/core/data/upgrade.test.ts` does for the household database.
- **Where.** `src/backends/sqlite-vec.ts`, `src/backends/migrations.ts`, `src/backends/sqlite-knowledge.ts`.
  `src/core/data/schema.ts` describes `loom.db` and nothing else (`docs/architecture.md`, "Where every table
  lives").
- **Why accepted.** These files predate the household database and already hold people's memories; every
  step is additive, runs whole or not at all, and is covered by `src/backends/migrations.test.ts` and
  `src/backends/upgrade-steps.test.ts`. Each table has one definition now that the script with a second copy
  is gone.
- **What would change the answer.** A step that rebuilds or narrows a table. Pin the shapes before writing one.

### Some household tables are written by more than one module
- **What.** A table has one module that owns its rows' life. A few other modules write single columns of
  those rows, because the column records a fact that is theirs.
- **Where, and whose fact it is.**
  - `inbox.job`, `messages.delivery`, `threads.working`: `src/runtime/jobs.ts`. Which job holds a piece of
    mail, whether it was delivered to a body, and whether a body is working are facts about a job.
  - `inbox.volume`, `inbox.quiet_until`: `src/core/tempo/volume.ts`. Tempo owns how loudly an item is shown.
  - `jobs.title`, `conversations.label`: `src/core/conversations/threads.ts`, the one place a title changes
    (next entry).
  - `inbox.words`, `bridge_sends.text`, `bridge_incoming.text`: `src/core/conversations/private-bridge-words.ts`
    erases the words of private direct messages when they expire, across the three tables that hold them.
  - `tokens.last_used_at`, `sessions.seen_at`: `src/shared-credentials.ts` stamps a credential when it is used.
  - `tokens` (a job body's token): `src/shared-body-enrollment.ts` registers a fingerprint the body made, which
    the issuing function cannot take, under stricter checks than issuing has.
  - `operation_results`: `src/shared-account-signin.ts` deletes, once at start, the receipts of an operation
    that used to keep a one-time code.
  - `approvals.state`, `changes.waiting_on`: `src/shared-work-lifetime.ts` expires an allowed card on the clock.
  - `agents.sprite_version`: `src/desk-sprites.ts`, with the sprite it describes, in one transaction.
  - `bridge_connections` (switched off): `src/apps/household.ts`, when the connection is removed.
  - `agent_run_settings.repository_secret`: `src/shared-secret-commands.ts`, which owns which secrets a house gets.
  - `household.secrets_default`: `src/shared-root.ts`, the settings operation for that one answer.
  - `boxes.last_seen_at`: `src/runtime/machines.ts`, on a machine's report.
- **Why accepted.** Each was read against its owner: none skips a check the owner makes, and each write is in
  the transaction of the fact it records. Routing them through the owner would give every owner a method per
  foreign fact and move no rule.
- **What would change the answer.** A second writer that repeats or skips a rule of the owner (a second copy
  of how a machine is revoked, or of how the approval record is appended to). That is a defect, not this
  pattern: the second writer calls the first.

### A thread's title is kept in three tables
- **What.** `threads.title`, `conversations.label` and `jobs.title` hold the same words.
- **Where.** `src/core/conversations/threads.ts` changes all three together; `src/runtime/jobs.ts` copies the
  title when a job is queued.
- **Why accepted.** Each is read alone on a hot path (the thread list, the conversation list, the jobs list)
  by a visibility predicate that does not join. A finished job keeps the title it ran under, on purpose.
- **What would change the answer.** A second place that changes a title, or a new job state that should
  follow a rename: add it to the list in `threads.ts`.

### An account's usage summary is stored beside the windows it is worked out from
- **What.** `model_accounts.usage`, `usage_read_at`, `resets_at` and `has_room` are derived from
  `model_account_windows`.
- **Where.** `src/runtime/account-windows.ts`. The function that writes the summary is not exported and has
  one caller, the one that records the windows.
- **Why accepted.** Admission reads the summary for every placement and the app shows it; both read one row.
- **What would change the answer.** A second writer of either table.

### Each agent's `memories.db` still has four unused conversation tables
- **What.** `conversations`, `conversation_turns`, `conversation_days` and `conversation_digests` are created
  in every agent's memory file and never read or written. Conversations live in `loom.db`.
- **Where.** `src/backends/conversations.ts`, run by the `conversations` step in `src/backends/migrations.ts`.
- **Why accepted.** An older home's conversations are in these tables, and the move of that data reads them
  (owner's ruling, 2026-11-16).
- **What would change the answer.** The move being done. Then a step drops the four tables.

### Retry receipts are kept in the file whose write they protect
- **What.** There is more than one receipt table: `operation_results` in `loom.db`, `mind_operation_receipts`
  in each memory, knowledge and people file, and `memory_command_receipts` in each `memories.db`.
- **Where.** `src/core/data/operation-results.ts`, `src/pieces/mind/receipt-schema.ts`,
  `src/pieces/mind/semantic-commands.ts`.
- **Why accepted.** A receipt has to commit with the effect it answers for, and these effects are in different
  files. `memory_command_receipts` differs from the other memory table because a memory command reserves its
  id in one short transaction and commits its answer in a later one, around an embedding that takes time.
  `mind_operation_receipts` has one reader and writer.
- **What would change the answer.** Memory moving into the household database.

### The command-line clients and `loom mcp` take the program's address by different rules
- **What.** `loom-taskstore`, `loom-token` and their siblings accept plain `http` to any host. `loom mcp`
  accepts plain `http` only to this machine. All three read the token file the same way.
- **Where.** `src/cli/connection.ts` (`doorUrl`); `bodyOrigin` in `src/runtime/body-bootstrap.ts`.
- **Why accepted.** A household reaches its program over its own network with the command-line clients, and
  that has worked over plain `http`. An MCP session is started by a harness for an agent and carries that
  agent's token on every call.
- **What would change the answer.** The owner deciding either way: the stricter rule for all would refuse a
  plain-`http` address the clients take today.

### `memories.salience` is written and never read
- **What.** Each memory is stored with a `salience` of 1 and the column is not updated afterwards.
- **Where.** `src/backends/sqlite-vec.ts` writes it; `src/backends/salience.ts` works heat out at every read
  (`heatOf`, `hottestIds`) and ignores it.
- **Why accepted.** Dropping a column from every agent's memory file is a step with no gain in behaviour, and
  the stored number went stale whenever its refresh was missed, which is why nothing reads it.
- **What would change the answer.** A read that must rank many memories in SQL. Then store heat again, and
  refresh it where memories are written and recalled.
