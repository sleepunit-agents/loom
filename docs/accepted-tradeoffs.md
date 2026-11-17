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
  asks. Three kinds of card always ask, whatever rule there is (`alwaysAsks` in
  `src/shared-household-proposals.ts`): one that changes a rule, so a rule cannot widen the rules; a request
  to let an agent onto a project (`projectJoin`), since that lets the agent read what is filed under it and
  a blanket rule is not an owner saying so for that project; and a merge of two projects (`projectMerge`),
  which cannot be undone and shows each project's people the other's records. If the last answer to the
  same thing was a deny, it asks again. If the change cannot be made on the rule's word (its setter may not
  make that change, or it cannot be made at all), the rule has answered nothing and the card waits for an
  owner. An agent whose card a rule answers is told the card's state, so it learns whether its change was
  made: that is the result of a change the owner let it make without asking, not a read.
- **Checked.** A body working for a member who is not an owner: the household's own rules (even `*`) do not
  answer; a rule naming that member does, within its kind and scope only; it stops when its setter stops
  being an owner or the member leaves. Test: `src/shared-household-proposals.test.ts`, "answers a card for
  someone who is not an owner only by a rule an owner set naming that person".
- **What would change the answer.** If rules could be set by anyone but an owner, or if a rule with no
  person ever answered for a member who is not an owner.

### A household proposal that cannot be made is still filed
- **What.** `household.propose` answers an agent the same way whatever is in the household: it does not
  refuse because the thing named is missing, is already as asked, or could never be allowed. The card that
  is filed holds the change asked for and not what it would replace. So an owner can be handed a card that
  changes nothing or cannot be allowed. They are told what it would replace, and what already stands
  against it, when they open it (`household.proposal`, owners only); their Allow is refused in the words of
  the rule the change breaks, and the card stays until they deny it.
- **Where.** `src/shared-household-proposals.ts` (the file header, `file`, `check`, `refusal`); the owner's
  view is `web/src/data/work-proposal.ts`.
- **Why accepted.** An agent may name anything in a proposal (a member, a secret rule, a token by its
  label, a machine) and may read almost none of it. Any answer that depended on what is there would let it
  guess and be told: "that is how it already is" confirms a member's role, "no live token has that label"
  lists labels. The card is read by the agent and by members who have it, so the replaced value cannot be
  on it either. An owner denying a card that cannot be made costs one tap.
- **What is kept.** Allow still refuses a card when what it would replace has changed since it was filed.
  The card carries a keyed digest of that value (a random part per card, under the household's Comms key),
  which tells a reader nothing. A program run with no Comms key makes a key that lasts as long as the
  program, so there a card left waiting over a restart is refused as changed and is asked for again.
- **What would change the answer.** Agents being given read access to what they propose to change. Then
  filing can refuse for what that agent may read, and the card can show it.

### The notice of a person's own action is written outside any operation
- **What.** After a signed-in window's call to a registered write, the command door writes one row to
  `action_results` for the caller ("Saved in Tasks", "Could not save in Tasks"), whether the call
  succeeded, failed or was denied. That insert is not a registered operation and has no `may`.
- **Where.** `recordActionResult` in `src/shared-action-results.ts`, called by `executeCommand` in
  `src/shared-root.ts`.
- **Why accepted.** It is a notice about a call, so it cannot be part of that call: a refused or failed
  operation rolls back, and the notice must still be written. The row is the caller's own, its text is one
  of two fixed sentences with the area's name, and nothing of the request, the result or the failure goes
  into it. It is written through the one write queue. Nothing the caller chooses decides what is written
  or for whom.
- **What would change the answer.** The notice carrying anything from the request or its result, or being
  written for anyone but the caller.

### A body keeps the agent's own knowledge, whoever it is working for
- **What.** A body doing a member's private work reaches a project, and what is labelled with its agent,
  only while that member has the same reach (`Viewer.workingFor` in `src/policy.ts`). Four things stay the
  agent's own and are not narrowed by the member: the household's shared knowledge files (`maySee`, the
  `knowledge` clause); the agent's own memory, which is labelled with the agent and with no project, so it
  follows the agent for as long as the member has the agent at all; the days of timing measurements (`tableRules.timingDays`); and which machines the
  agent itself may run on (`tableRules.boxAgents`, the agent case). A member who has the agent reads its
  memory, notes and cards directly as well (`maySee`, the `memory` type). The agent's secrets are the
  same: see "A secret an owner gave an agent is the agent's to use, whoever it works for".
- **Why accepted.** The household's owner ruled it (2026-11-17): what an agent shares with the person it is
  working for is the agent's judgment, sized to who that person is, and not a wall on what it may read.
  They are what the agent knows and where it runs, not records of another person's work.
  An agent that forgot its memory or its machines when working for one of its members could not do the work.
  Timing days hold request names and durations, no words. What an agent chose to remember from one
  member's private thread is in its memory for its next piece of work, whoever that is for: that is what an
  agent's memory is, and it is not labelled by conversation.
- **What would change the answer.** A record of one member's private work becoming readable through any of
  the four. Then that table needs a member label and a rule that reads it.

### A secret an owner gave an agent is the agent's to use, whoever it works for
- **What.** A secret rule, the household default and a grant made for the agent and no one job are
  standing answers about the agent. They serve every body of that agent: its own work, work for a
  household owner, and the private work of a member who is not one. A body whose member has left the
  household or no longer has the agent is served nothing (`agentItself`).
- **Where.** `standingSecretAnswerServes` in `src/policy.ts`; asked by `secrets.request`
  (`src/shared-secret-agent-commands.ts`) and by the private routes (`src/shared-secret-inputs.ts`);
  carried as `standing` into `src/pieces/secrets/requests.ts` and `private-inputs.ts`.
- **The worker's hand-off is still its own.** A worker fetches the house's repository with the agent's
  repository secret while the job is starting, before any body runs. That hand-off has a request of its
  own (`repositoryRequestId` in `src/pieces/secrets/requests.ts`), and the grant it leaves serves that
  hand-off: no body's read counts it (`SecretRequests.grantFor`). A secret that is both the repository
  secret and one of the house's startup secrets is asked for twice, once for each.
- **Why accepted.** The owner's ruling, 2026-11-17: "you have permission to have the key, the ask is
  different: can I perform this task for allison. the secret part isn't really the permissions issue."
  A secret is given to the agent. Whether the agent should do a piece of work for a person is a separate
  question, to be asked of the work and the person, and nothing asks it through a secret. An earlier
  version filed one card per secret for every job a non-owner member started, which asked the owner the
  wrong question many times.
- **What would change the answer.** A way to ask "may this agent do this for this person" becoming part
  of the program. That check belongs where work is given, not where a secret is read.

### Work a member schedules for an agent is that member's private work
- **What.** A trigger that puts an agent to work is the whole agent's when the agent set it for itself (in
  a terminal session, a job for no member, or work for a household owner) or a household owner set it. One
  set by a member who is not a household owner, or by a body doing that member's private work, is recorded
  as that member's (`ownerKind` member) whatever owner the request named, and every firing is private work
  for them: the conversation and the job carry the member, so the body reaches no further than they do.
  Four things follow, and are accepted:
  - Such a member cannot reword the agent's own triggers, or schedule the sweep (or any operation) for it:
    both would run with the agent's whole reach on their word.
  - The firing's job keeps no brief and no log tail, like any private conversation's
    (`src/runtime/job-text.ts`); the body takes its words at the mail door. The member sees what the
    agent then does for them (a thread, a task), not a transcript of the run.
  - The member the work is for is stored on the trigger when it is set (`triggers.member`), apart from
    who set it, and read at each firing. How far the work reaches is judged on that moment's facts. A
    member who left, lost the agent or left the trigger's project makes the firing fail (logged, and tried
    again at the next time); one who became a household owner fires the same trigger as the whole agent.
  - The trigger itself, with its words, is still read by the rule for triggers: the agent's other owners
    and the people in its project see it, as they see any trigger for that agent.
- **Where.** "Scheduled work" in `src/policy.ts` (`triggerSetFor`, `triggerAsSet`, `maySetTrigger`,
  `mayStartTrigger`); the member is stored by `recordedTrigger` in `src/shared-tempo-access.ts` and read by
  `worksFor` in `src/shared-tempo.ts`; the firing is `inbox` in `src/core/tempo/tempo.ts`.
- **Why accepted.** A body reaches no further than the member it works for, and a schedule is one more
  way of giving an agent words.
- **Checked.** `src/shared-tempo.test.ts`: "fires a trigger a member who is not a household owner set for
  an agent…" and "keeps a trigger an agent set for itself, and one an owner set, the whole agent's…".
- **What would change the answer.** The column for the member is there (schema step 9), and today the door
  fills it from the owner it records, so the two always agree on a trigger set through loom. Two things it
  makes possible are not built: an owner setting a trigger that runs as another member's while staying its
  owner, and a body's trigger keeping the agent as who set it. Hiding a member's trigger from the agent's
  other owners is not wanted: the owner has ruled that owners may see that such work exists.

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
  those. `confirm` settles the use that `read` started and is held to the same proof. Who may call is proof
  of assignment, like a worker's doors, and is checked at the route. The two questions that are sharing
  rules (is this body still its agent for its member, and does a standing answer serve its work) are
  `policy.ts`'s and the routes ask them there. The writes still go through the one write queue (`secretCommit`).
- **The checks these routes make, in order.** The program is not closing. The request authenticates
  (`sharedCredentials.authenticate`) and its credential is a body's (an agent token bound to a job) or a
  worker's. The body is JSON. A body may name no job: its job is the one on its credential, it must be that
  agent's, and it must be running. A worker must name a job, that job must be starting on the
  worker's own machine, and a worker may ask only for the repository secret. A body must still be its agent
  in the household for the member its work is for (`rules.agentItself`): one whose member has left or lost
  the agent is refused at every route. The job's binding (agent,
  machine, conversation, member, project, house repository, file and branch) is recorded and must be
  unchanged, with the credential still valid, when the bytes are handed over and when the use is confirmed.
  A requested secret needs a current grant for that secret and agent, for that job or for the agent alone,
  and not the one a worker was given to fetch the repository
  (`SecretPrivateInputs.dispatch`); a startup secret must be an alias in that job's startup plan with a
  current grant, and still map to the same secret; the repository secret must still be the one the agent's
  run settings name.
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
  other door, refuse program tokens, and are checked before, inside and after the write. The routes that
  hand out a credential (a token, a program token, a link, a passkey) also ask for a new proof of identity
  through one gate, `newProof` in `src/core/data/authentication.ts`: a bearer, or a person's own browser
  that proved who it is in the last ten minutes.
- What would change it: a dispatcher that can run a write without keeping its answer. Then these become
  operations and the gates become `may`.

### A household owner can issue a token in another member's name
- Where: `POST /api/signin/token` with `kind: "owner"` and any existing `member`
  (`src/core/signin/shared-links.ts`, `ownerTokenInput` in `src/core/signin/shared-tokens.ts`).
- What: the door hands the calling owner a bearer that signs in as the member named. With it the owner is
  that member to every rule, their private threads with agents included. The owner ruled that the owner
  role does not read another member's private thread; no rule lets it, and this door is how an owner who
  set out to could. It leaves a token row with its label and the member it names.
- What the door does not do: bind a token to a job. A bearer for a running job would be a second body in
  that job's conversation, so a job's token is made only where its worker enrols it (`enrolBody`), and a
  new one ends the job's other token.
- Why accepted: a new member's first token is how they are let in, and a member who has lost every device
  is let back in the same way. The household owner also runs the machine loom is on and can read its files,
  so this door gives them nothing they could not take; it does not make it a rule that they may.
- What would change it: an invitation the member redeems themselves, so that no bearer in their name is
  ever shown to someone else. Then this door refuses a member other than the caller.

### A startup secret's name can still stop a job on one machine or harness
- Where: `isHouseSecretAlias` in `src/pieces/secrets/input.ts` (the one rule for an alias);
  `src/runtime/body-secrets.ts` (what a body adds).
- What: the door that stores a house's startup secrets, the plan loom hands a body and the body all hold an
  alias to one rule, so an alias the door takes is not refused by the body for its shape or for being a
  name every body runs by (`PATH`, `NODE_…`, `LOOM_BODY_…`). Two refusals remain the body's alone, and
  each fails the job at start: an alias that the body's own environment already sets, and one that the
  job's harness signs in with (`ANTHROPIC_API_KEY` on Claude). An alias stored before the rule that no
  body could take is left out of the plan, so the job starts without it; saving the house's secrets
  again refuses it by name.
- Why accepted: the door cannot know a worker's environment, and a name one harness signs in with is an
  ordinary secret for a house on another harness. Letting a startup secret replace either would hand a
  job's account or its machine's settings to whoever sets aliases.
- What would change it: workers reporting the names their environment sets. Then the door refuses those
  for agents that run there.

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
- What: a browser that calls itself HeadlessChrome gets the short session and may not make tokens, make
  links or add passkeys (`newProof`). One that sends another User-Agent is treated as a person's unless its
  link was made with `loom signin --agent`.
- Why accepted: a link is a member's credential, and whoever is handed one is that member. The limit that
  can be relied on is the one the link's maker sets; the User-Agent check only catches the automation that
  does not hide.
- What would change it: agents being able to ask for links themselves.

### Root keys are readable on disk by their own process
- What: five keys are kept in clear, in files in the home. They are what the other stored secrets rest on:
  a secret is otherwise stored sealed under one of them or as a fingerprint, apart from the exceptions
  that have their own entries here.
  - `push-vapid.json`: the private key that signs pushes to browsers
    (`src/core/signin/notification-key.ts`).
  - `comms.key`: the age identity that seals conversation words, and keys the digests made from them
    (`src/pieces/comms/crypto.ts`).
  - `secret-holder/identity`: the age identity that seals the household's stored secrets
    (`src/shared-holder-storage.ts`, `src/pieces/secrets/holder-store.ts`).
  - `secret-holder/fingerprint.key`: the key for the fingerprints the holder keeps of secret values
    (same files).
  - `secret-holder/daemon-fingerprint.key`: the key the holder program uses for the fingerprints it
    hands to loom (`src/shared-holder-program.ts`).
- Why accepted: the program has to read them unattended, with nobody there to type a passphrase. Each
  file is created exclusively with mode 0600. The push key and the three holder keys are read through
  `privateBytes`, which refuses a file that is not this OS user's, has another mode, or has a second link;
  the holder's directory must be private too, and the holder is a separate process that never opens the
  database. `comms.key` is read by `readKey`, which refuses a symbolic link, anything that is not a regular
  file, and any mode that lets group or others in; it does not check the owner or the link count. Whoever
  can read the home as that user already holds the database.
- What would change it: running loom where an OS keyring or a hardware key is available to an unattended
  service. Then all five move there together.

### A browser's push subscription keys are stored in clear
- Where: `notification_devices.keys` in the household database, written by `notifications.subscribe` and
  read by the sender (`src/core/signin/shared-notifications.ts`).
- What: each enrolled browser's push keys (`p256dh` and `auth`) are kept as they were given, beside the
  browser's push endpoint. No read door returns them: a member sees their devices by name and date only.
- Why accepted: loom must present these keys to the push service to encrypt each push, so they cannot be
  kept as a fingerprint. They could be sealed under the Comms key, but that key is a file in the same home
  as the database, so sealing would protect only a copy of the database taken without the home, and against
  that the keys are worth little: they encrypt a message to that one browser, and sending one also needs
  the push-signing key, which is not in the database. A push carries no words (a fixed title and a link to
  the Inbox). Sealing would also make enrolling a browser wait on the key, where it is one synchronous
  write now.
- What would change it: pushes carrying words, or the root keys moving out of the home (the entry above).
  Then these are sealed under the key that moved.

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

### Every house is built on the core house, and built again each week

- **What.** A worker builds the core house itself from the definition in its own install
  (`house/core`), names it for that definition and the week, and names every house image for the core it
  was built on (`docs/runtime/worker.md`, "The core house"). So each house is built again on its first job
  of a new week, and on its first job after a loom whose core changed.
- **What that costs.** Once a week on each machine: the core's own build (it downloads the system's
  packages, Node, Claude Code and Codex, and made an image of 1.29 GB when it was built once through
  rootless podman 5.4.2 on 2026-11-17; a house of the same contents took about ten minutes on that
  machine), then each house's own steps after `FROM`, which run again because the layers under them
  changed. The first job of the week for each house waits for that, reported as starting, within
  `buildTimeoutMs`. A machine without the network, or a week in which a download address is down, builds
  no core: jobs whose house image is not already there fail as a failed build until it can. A house whose
  image for this week exists is not affected.
- **Once for an engine, because one worker has the engine.** Two workers on one engine would each build
  the core and each remove the cores the other's houses are built on. A worker holds its engine to itself
  (exit 57 for a second one), with the same limit as above for a worker in a network of its own.
- **A house that does not start from the core pays too.** The core is built before every house build
  and every image is named for it, whether or not the Housefile uses `LOOM_CORE`. The worker does not read
  a Housefile, so it cannot tell.
- **The system is as current as the week, and the harnesses as current as loom.** The base system's
  updates come with each week's build. Claude Code, Codex and Node are pinned in the definition and move
  only with a loom that changes the pins. Claude Code's own updater is switched off in the core, so the
  version whose renewal was read is the one that runs.
- **What the build trusts.** Debian's package mirrors and `docker.io` for the base image (not pinned to
  a digest: that is what "current" means), `nodejs.org` and Claude Code's release address (each checked
  against a SHA-256 written in the definition), and the npm registry for Codex at one version.
- **Where.** `house/core/Housefile`; `src/runtime/house-core.ts`; `coreBuilt` in
  `src/runtime/worker-container.ts`; `pruneHouses` in `src/runtime/house-image.ts`.
- **What would change it.** Reading whether a Housefile names `LOOM_CORE`, so that one which does not is
  neither rebuilt weekly nor made to wait for the core; a household that publishes images, which would
  let a machine pull the core rather than build it.
- **Not in the core.** `agy`: no pinned install of it exists to copy. It needs one stated version with a
  published checksum, a way to point it at `/run/loom/login/agy`, a body file and its name in the label.

### One layout inside every house, and nothing of it is checked in the image

- **What.** The worker starts every body the same way: `/usr/local/bin/node`, the body file at
  `/etc/loom/body/<harness>.json`, in `/home/agent/repo`, with `HOME=/home/agent` (`docs/runtime/worker.md`,
  "The layout of every house"). An image says only that it was built for this layout (`loom.house="2"`)
  and which harnesses it serves. The worker does not look inside an image, so a house that says so and
  lacks one of those places fails when its body starts (exit 23 for node or the repository, 16 for the
  body file), not when it is built.
- **A house built for the earlier contract is refused, not run.** An image labelled `loom.house="1"`
  fails its job with exit 30 until its Housefile is changed. One layout is read at a time; the worker
  carries no second way to start a body.
- **The user is not fixed, and the core house runs as root.** The home is the same in every house and
  the user is the image's; the core house names none, so a body in it is the container's root. On a
  rootless engine that is the worker's own user outside the container, the one user that can write a
  mounted sign-in directory. On an engine that runs as root it is the machine's root inside a
  container, and a house for such a machine should set a `USER`. Inside the container that body can change
  any file of its house; outside it holds what the worker's user holds through its mounts and no more.
- **Where.** `src/runtime/house-layout.ts`; `createSpec` in `src/runtime/worker-container.ts`;
  `houseStart` in `src/runtime/house-image.ts`.
- **What would change it.** A worker that asks the engine to map its own user to a fixed user of the
  house, which the engine routes it uses today cannot ask for.

### Two bodies on one account share one sign-in directory

- **What.** A container body is given its account's sign-in directory read-write (`accountLogins`). Two
  bodies on the same account and harness are given the same directory, at once or one after the other.
  Each can read and change what the other's provider program wrote there, and two programs can renew the
  sign-in at the same moment. When they do, one of them may be refused by the provider (a renewal that
  was already used) and that body's harness fails.
- **What that failure looks like.** The body ends with its own code for a failed harness (exit 14, "body
  harness", chosen by the body), and the job is recorded failed. It is tried again by the ordinary chain
  when it left mail it had not confirmed: after 5 seconds, 30 seconds and 2 minutes, three times at most.
  The retry reads the sign-in the other program just wrote. A machine that sees this more than rarely
  sets `accountSlots` to 1 for that harness in its worker's configuration, which runs an account's bodies
  one after the other.
- **Why one shared directory and not a copy for each body.** A provider's renewal token changes at each
  renewal. Bodies with a copy each would cancel one another's sign-in at their first renewal; that was the
  fault of the arrangement before this one (each house was handed its own copy as a secret), and sharing
  the one directory in place is what replaced it.
- **What keeps two renewals apart is the harness's own program, not loom. What is known of each:**
  - *Claude Code, read in version 2.1.326* (the program installed on the household's machine, and the
    version the core house pins): before it renews it takes a lock file inside the sign-in directory
    (`.oauth_refresh.lock`, and an older-style `<directory>.lock` beside the directory), reads the
    sign-in again once it holds the lock, and does not renew when another process already has (it counts
    that as a race resolved). The same pattern, a lock and a check of whether the file changed on disk,
    is in that program's source at 2.1.88. A run of the core house on 2026-11-17 showed Claude Code 2.1.326 there with the pinned checksum,
    its sign-in place set to the mounted directory, and that directory writable. **Read, not tested
    here:** no run on this household's machines
    has made two bodies renew at once and watched the outcome.
  - *Codex, looked at in version 0.162.1*: **not established.** Its program knows the error "refresh token
    was already used", which is what a lost race would be, and holds the word `flock`; whether it locks or
    re-reads its `auth.json` before it renews was not found. The core house pins 0.164.0, which was not
    looked at. So Codex's bodies run one at a time on an account by default (`accountSlots`).
  - **The question a supervised check has to answer** before Codex is set above 1: with two Codex bodies
    on one account and its sign-in near the end of its life, do both go on working after both have renewed,
    or does one end with "refresh token was already used"? It needs a real sign-in, so it is a check a
    person runs, not a test in this repository.
- **Where.** `bodyMounts` in `src/runtime/worker-mounts.ts`; the mount is made in
  `src/runtime/worker-container.ts`; the defaults in `src/runtime/worker-limits.ts`
  (`ACCOUNT_SLOTS_BY_HARNESS`); the core house's wiring in `house/core/Housefile`.
- **What is enforced.** The worker mounts into a job's container the directory of that job's account and
  harness and no other. A fixed mount or another entry that names the same directory, one above it or one
  inside it stops the worker at start (another agent's mounts and the worker's own program directory
  included); so does any mounted directory that is, holds or is inside either
  engine socket (`container.socket`, `container.nestedSocket`), the worker's state directory or its token
  file. With `accountLogins` present, a job
  with no exact entry does not run. On one worker, at most `accountSlots` bodies of one harness run on an
  account at once (4 by default, 1 for Codex; `src/runtime/worker-turns.ts`): a job beyond that waits
  until one has ended. The worker never reads, lists, cleans, writes or removes anything inside a sign-in
  directory, so a lock a harness's program holds there is never taken away under it (the arrangement
  before this one cleared the directory of everything but the sign-in before each start, lock included).
- **What is not enforced.** That a house reaches its sign-in in place. The core house does; a Housefile
  that copies a sign-in file into its image or its home brings back the fault of copies, and nothing in
  the worker can see that. One worker counts the bodies on a directory because no second worker can
  name it: a worker holds each sign-in directory, and its engine, to itself for as long as it lives, and a
  second one stops at start (exit 57; `src/runtime/worker-alone.ts`). That hold is a name in the machine's
  table of listening sockets, so a worker inside a container with a network of its own is not held apart
  from one on the host: giving two such workers one directory is not refused.
- **What is not.** A job allowed nested containers (`run.nestedContainers`, with `container.nestedSocket`
  configured on the machine) is handed the engine's socket. It has that engine, and with it everything the
  engine's user can reach on the machine, every account's sign-in directory included: it can start a
  container of its own with any of them mounted. "Its own directory and no other" holds for every job
  that is not given the engine.
- **Why the rest is accepted.** A sign-in is one set of files per account, which the provider's program
  must be able to rewrite. Many processes signed in to one account share them in the same way on this
  household's machines and have for months, and every such body already acts as that account. Running
  an account's bodies one at a time would make a household whose jobs are mostly on one account wait
  for no gain most of the time. The engine's socket was already broad authority
  over the machine that both an agent's run settings and the machine's operator must opt in to; the
  sign-in directories are one more thing within its reach, not a new kind of reach.
- **Considered and not done.** A renewer or lock of loom's own (it could not see inside a harness
  program's renewal, and the program would still renew for itself), a program on the machine that hands
  bodies short-lived tokens (a broker of a subscription sign-in, which the providers' terms rule out and
  which this arrangement replaced), and a read-only mount (a program that cannot write cannot renew).
- **What would change the answer.** A provider program that takes its sign-in from a file it does not
  rewrite, or renews through the worker; or a lock around renewal that every body of an account takes.
  Each body could then have a copy of its own, or renew in turn. For nested
  containers: an engine of the job's own (one that cannot see the machine's files) in place of the
  machine's socket.

### A Housefile is as dangerous as the engine's builder lets it be

- **What.** A worker with container bodies builds each agent's house from the repository and Housefile in
  that agent's run settings. Every step of a Housefile runs in the engine's builder, on this machine, as
  whatever the engine runs builds as. A build step can use the network, and can do whatever a fault in the
  engine's builder lets it do; with a rootless engine that is bounded by the worker's own user, who can
  read the sign-in directories and the worker's token.
- **Where.** `buildHouse` in `src/runtime/house-image.ts`; `houseSource` in `src/runtime/house-source.ts`.
- **What git reads on the host.** Objects: the pack a fetch brings, and the commit and tree objects that
  say which files a commit has. No file of a repository is interpreted, by git or by the worker: the
  worker writes the build context itself from the tree, file by file.
- **What is enforced.** Only loom's assignment names a house, and only an agent's owners set it, for an
  agent allowed on the machine. The worker fetches `https` addresses only, with `git` run under none of
  the machine user's configuration or credentials. Neither the worker nor git interprets or runs
  anything from a repository: git reads commit and tree objects, the worker reads each link's target to
  write it, and the commit's files go to the engine unread, as a tar stream the worker writes. It adds one build argument, the core house's image, and no secret,
  host path, socket or privilege to a build. The repository's secret goes to the fetch alone.
- **Why the rest is accepted.** Running an agent's house is the point: whoever may set an agent's house
  already decides what that agent's bodies run. A build is the engine's to confine, as a container is.
- **What would change the answer.** An engine whose builds run with no network and in a sandbox of their
  own, asked for by name; or building on a machine that holds nothing else.

### A worker treats its engine's unnamed leftovers as its own to remove

- **What.** After building a house's image the worker asks its engine to remove images that have no name
  and are older than a day, and build cache unused for a week. The request is to the whole engine: an
  unnamed image somebody else left there, for another purpose, goes too.
- **Where.** `pruneHouses` in `src/runtime/house-image.ts`.
- **What is enforced.** Named images are never touched except loom's own house images
  (`localhost/loom-house-…`), of which the two newest of each house and the ten newest in all are kept.
  Nothing is removed by force: the engine keeps what a container uses. The request for leftovers is made
  only when no other build is running in this worker, and only for what is a day old.
- **Why accepted.** Builds leave unnamed layers behind, most of all the ones that failed or were ended,
  and nothing marks them as loom's. A machine that builds houses unattended filled its disk this way.
  What has no name and is not in use is what an engine's own clean-up removes.
- **What would change the answer.** An engine that marks what a build left with the build's own label.

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

### One harness's result-size hint rides on a tool every harness is served
- **What.** `use_secret` carries `_meta: {'anthropic/maxResultSizeChars': …}`, a hint only Claude Code reads.
  It is on the one tool definition all three harnesses get, not inside the Claude adapter.
- **Where.** `src/runtime/body-secret-tools.ts`, with a comment at the site.
- **Why accepted.** The body's tools server builds each tool once; it has no per-harness copy to hang a hint
  on. The key is inert for a harness that does not know it, and adding a harness does not mean touching it.
  Three reviews raised it and none found a failure behind it.
- **What would change the answer.** A second harness needing a hint of its own on a tool. Then each adapter
  adds its hints to the tools it is handed, and this one moves into the Claude adapter.

## Bridges and conversations

### Mail is delivered at least once
- What: mail a body took and accepted is handed to a body again if the first one's job is lost or fails
  before it answered. The agent can see the same outside message twice.
- Where: `src/core/conversations/mail.ts` (`accept` settles nothing; `settle` and `confirm` do),
  `src/runtime/jobs.ts` (mail a job took and did not settle waits again, bound to the retry, whether the
  job was lost, failed, or reported success with none of its mail settled; first attempt plus three).
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
- Would change it: a tier or a card being used to decide who somebody is. Only `bridge_people` may do that,
  and only for a member who is in the household now: removing a member keeps their link, and intake
  (`incoming.ts`) and the run policy (`body-policy.ts`) then take the account for an outside one.

### A reply in doubt is never sent again
- What: when a post fails after its request left, the reply is `uncertain`. A person can dismiss it. Nobody
  can resend it, and that holds for a long reply whose earlier parts were confirmed. The person is a
  household owner who reads the reply; for a reply in a direct message, which the owner role does not
  show, it is whoever the message is shown to (its own member, or the agent's owners for a message from
  anybody else). The same people release a held reply.
- Where: `src/pieces/bridges/sends.ts` (`reviewReply`, and the state a stopped attempt leaves); who may
  review is `rules.reviewsReply` in `src/policy.ts`, asked by `src/shared-bridge-commands.ts`.
- Why: the platform may have it, and neither Discord nor Slack lets a post be made idempotent. A missing
  part is visible and a person can say it again; a doubled one cannot be taken back by loom.
- Would change it: a platform nonce that makes a repeat safe (Discord's `enforce_nonce`), used on every post.

### An edited message is not read again
- What: a second event for a message already on record, with other words, is taken for an edit. Nothing
  new is recorded: the stored words, the turn and the agent's mail stay as first received, and the event
  is counted as read. So a message edited to mention the bot after it was dropped stays dropped, and an
  agent never sees a correction to a message it was given.
- Where: `receive` in `src/pieces/bridges/incoming.ts`. The same id from another user, channel or time is
  not an edit and is refused; `drain` in `receiver.ts` keeps that frame, reports it once and goes on.
- Why: loom takes a message once. Discord edits are not listened for at all, and Slack tells loom of an
  edit only as an `app_mention` when the edit adds a mention, so acting on edits would act on a small and
  arbitrary part of them. A person who wants the agent to have the new words can say them again.
- Would change it: wanting agents to follow edits. Then both platforms' edit events are taken, and an edit
  becomes a new turn that names the message it changes.

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
- What: four places build a viewer from a member's id and ask the read rules about it: asking someone
  about a task (`tasks.command` `ask`), a body's question to a person, a body setting how loudly its
  member's own inbox item arrives, and the Tasks service deciding whether mail to a person about a task
  goes into the task's conversation (it does only if that person reads the conversation). The first two
  take the id from the request; the third takes it from the body's credential; the fourth takes it from
  the task's stored question, the person asked or the member who asked.
- Where: `src/shared-task-access.ts`, `src/shared-conversation-questions.ts`, `src/shared-tempo-access.ts`
  (`volume`), `src/shared-root.ts` (the `reads` given to `taskService`), through `addressee` in
  `src/policy.ts`.
- Why: the question is "could the person this is addressed to read it", so that nothing is sent to
  someone about a record they may not see, a body changes the volume only of an item its member
  reads, and mail is never filed in a thread its addressee cannot open. The answer only ever narrows what the caller may do: what allows the caller is its own rule
  (`rules.inboxVolume` for the third, whose body half is `forItsMember`).
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
  reply's one recorded id became the first row of its parts. It also moved, losing nothing, the two lines
  the program itself had written into a job's `log_tail` (a lost job's "Lost while …" and a never-started
  job's "Never started: …") into the new `ended_note` column, and cleared `log_tail` on those rows.
- **Where.** Step 7 of `upgrades` in `src/core/data/database.ts`; `src/core/data/upgrade.test.ts` asserts it.
- **Why accepted.** A sign-in link lives five minutes, and one made before the step cannot say which browser
  made it, which is what the step added; ask for another. `signin_challenges` was never written or read.
  No program ever set a job to `waiting`. A reply posted in several parts before the step had kept only its
  last part's id, so a thread under an earlier part of an old reply is still not known as the bot's.
- **What would change the answer.** As for step 6: a step that removes data a household cannot get back
  needs the owner's say first.

### Upgrade step 8 removed one kind of existing data
- **What.** A household upgraded from schema 7 or earlier lost the retry receipts of `runtime.signInCode`
  (rows of `operation_results`).
- **Where.** Step 8 of `upgrades` in `src/core/data/database.ts`; `src/core/data/upgrade.test.ts` asserts it.
- **Why accepted.** Those receipts held a one-time sign-in code, from when that operation was a write. It
  is a read now and leaves none. The program already deleted them at every start; the step does it once.
- **What would change the answer.** As for step 6.

### Upgrade step 9 removed one column, and left two new ones unsaid on old rows
- **What.** A household upgraded from schema 8 or earlier lost `bridge_files.incoming`, the message a kept
  Slack file was first fetched for. The step also added two columns it could only partly fill. `jobs.exit_by`
  (who chose a job's exit code) is set to `loom` on a job no machine took and left empty on every other
  ended job, so job history shows those older jobs' exit codes with no stage beside them.
  `triggers.member` (whom a trigger's work is for) is copied from the owner of each trigger a member owns
  that puts an agent to work, which is what a firing read before the step.
- **Where.** Step 9 of `upgrades` in `src/core/data/database.ts`; `src/core/data/upgrade.test.ts` asserts it.
- **Why accepted.** The messages that carried a file are the rows of `bridge_file_messages`, which step 8
  filled from that column; the column was a second copy that went stale when its message stopped listing
  the file. An exit code a machine reported before the step may have been loom's body program's or a
  machine's own runner's, and the row never said which: no stage is better than a guessed one.
- **What would change the answer.** As for step 6.

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
- **What.** `memories.db`, `people.db`, `notes.db` and the secret holder's `holder.db` are refused when a
  newer program has changed them (their version number in the file header, checked at every start), but a
  wrong SQLite file at one of those paths is not recognised as wrong: the store's tables would be created
  in it.
- **Where.** `refuseNewerStore` in `src/backends/migrations.ts`, the constructor in `src/notes.ts`,
  `openHolderStore` in `src/pieces/secrets/holder-store.ts`, all run for the Memory files by
  `prepareSharedMemorySources` in `src/shared-memory.ts`; compare `recogniseDataSchema` in
  `src/core/data/database.ts` and `recogniseKnowledgeStore` in `src/backends/sqlite-knowledge.ts`.
- **Why accepted.** The commons paths come from `program.json`, which the program writes at first install, and
  each agent's files are in `<home>/agents/<agent>` (`householdMemorySources` in `src/shared-memory.ts`);
  nothing else chooses a path. Several modules legitimately make their own tables in `memories.db` first (cards, receipts,
  command bookkeeping), so "a file with other tables in it" is the normal case and "foreign" has no cheap
  definition. The household database, which a person might plausibly point at the wrong file, is recognised
  in full.
- **What would change the answer.** A way to choose these paths by hand, or an importer that writes them.

### A Memory file the program did not make is not given its retry tables
- **What.** A start brings every Memory file's own tables up to date. The door's bookkeeping tables
  (`mind_operation_receipts`, and in a `memories.db` the command and card tables) are made with a fresh
  file and kept up to date in a file that has them. A file that was already there and never had them, such
  as one copied in from an older home, is not given them: it is read as it is, and each command that would
  write there is refused as unavailable.
- **Where.** `prepare` in `src/shared-memory.ts`; `upgradeMindReceipts` in
  `src/pieces/mind/receipt-schema.ts`, `checkSemanticMemory` in `src/pieces/mind/semantic-schema.ts`;
  refused per command by `mindReceiptsReady`, `semanticMemoryReady` and `semanticCardsReady`.
- **Why accepted.** It is the stricter of the two answers and was the tested one before starts upgraded
  anything. Bringing an older home's files in is the data move's job, and the move decides when a file is
  this program's to write.
- **What would change the answer.** The owner deciding that any file at a declared path is the program's:
  then `prepare` runs the same preparation for an existing file as for a fresh one.

### The memory and knowledge tables are defined in their own stores, with no pinned shapes
- **What.** `memories`, `pages` and the tables beside them are created by the store that owns them and brought
  up to date, at every start, by steps that read the file's shape. Nothing compares an upgraded file with a
  fresh one column by column, as `src/core/data/upgrade.test.ts` does for the household database.
- **Where.** `src/backends/sqlite-vec.ts`, `src/backends/migrations.ts`, `src/backends/sqlite-knowledge.ts`,
  run at start by `src/shared-memory.ts` (`src/shared-startup-stores.test.ts` starts on an older file).
  `src/core/data/schema.ts` describes `loom.db` and nothing else (`docs/architecture.md`, "Where every table
  lives").
- **Why accepted.** These files predate the household database and already hold people's memories; every
  step is additive, runs whole or not at all, and is covered by `src/backends/migrations.test.ts` and
  `src/backends/upgrade-steps.test.ts`. Each table has one definition now that the script with a second copy
  is gone.
- **What would change the answer.** A step that rebuilds or narrows a table. Pin the shapes before writing one.

### Some household tables are written by more than one module
- **What.** A table has one module that owns its rows' life: one file, or one directory whose files are one
  part (`src/core/conversations/`, `src/core/signin/`, `src/pieces/bridges/`, `src/runtime/`). A few other
  modules write single columns of those rows, or one kind of row, because the fact is theirs. This is every
  such write. `src/stored-data.contract.test.ts` reads the writers of every table from the source and fails
  on one that is not in its list and in this one.
- **Where, and whose fact it is.**
  - `inbox.job`, `messages.delivery`, `threads.working`: `src/runtime/jobs.ts`. Which job holds a piece of
    mail, whether it was delivered to a body, and whether a body is working are facts about a job.
  - `inbox.volume`, `inbox.quiet_until`: `src/core/tempo/volume.ts`. Tempo owns how loudly an item is shown.
  - `jobs.title`: `src/core/conversations/threads.ts`, the one place a title changes (next entry). It
    changes `conversations.label` with it, in its own module.
  - `inbox.words`, `bridge_sends.text`, `bridge_incoming.text`, and the rows of `bridge_file_messages` and
    `bridge_files`: `src/core/conversations/private-bridge-words.ts` erases the words of private direct
    messages when they expire, across the three tables that hold them, and removes their files with them.
  - `tokens.last_used_at`, `sessions.seen_at`: `src/shared-credentials.ts` stamps a credential when it is used.
  - `approvals.state`, `changes.waiting_on`: `src/shared-work-lifetime.ts` expires an allowed card on the clock.
  - `approvals.details`, `approvals.change_summary`, `approvals.what`: `src/shared-household-proposals.ts`,
    for household cards an older version filed, once at start ("One rewrite of stored rows runs at start",
    below).
  - `agents.sprite_version`: `src/desk-sprites.ts`, with the sprite it describes, in one transaction.
  - `bridge_connections` (switched off, and `removed_at`) and `projects.removed_at`: `src/apps/household.ts`.
    Removing and restoring is one household action for a member, an agent, a project and a connection; a
    removed connection is switched off in the same transaction.
  - `agent_run_settings.repository_secret`: `src/shared-secret-commands.ts`, which owns which secrets a house gets.
  - `boxes` has a writer for each fact about a machine. `src/shared-machine-registry.ts` makes the row
    when a machine is enrolled. `src/shared-box-settings.ts` writes what its owner chose (`boxes.name`,
    `hosts_any`, `report_only`, `always_on`). `src/runtime/machines.ts` writes `boxes.last_seen_at` on a
    machine's report. `src/shared-root.ts` writes `boxes.revoked_at`, the one place a machine is revoked.
  - `box_facts`: the owner's facts are written by `src/shared-box-settings.ts`, and the facts a machine
    reports about itself by `src/runtime/machines.ts`. Each replaces only its own kind (`from_owner`).
  - `action_results.read_at`: `src/core/conversations/operations.ts`. The notice of a person's own action is
    written by `src/shared-action-results.ts`; marking it read is the inbox door's, with the other reads.
  - `model_accounts` (`usage`, `usage_read_at`, `resets_at`, `has_room`): `src/runtime/account-windows.ts`
    and `src/runtime/account-usage.ts` write the usage summary; the row is made and renamed by
    `src/shared-model-account-admin.ts` ("An account's usage summary is stored beside the windows", below).
- **Why accepted.** Each was read against its owner: none skips a check the owner makes, and each write is in
  the transaction of the fact it records. Routing them through the owner would give every owner a method per
  foreign fact and move no rule.
- **What would change the answer.** A second writer that repeats or skips a rule of the owner (a second copy
  of how a machine is revoked, or of how the approval record is appended to). That is a defect, not this
  pattern: the second writer calls the first. Three were: the household's answer for secrets and the listing
  order of members and agents are now written by `src/apps/household.ts` alone, and which machines an
  account is signed in on by `src/runtime/account-boxes.ts` alone.

### One rewrite of stored rows runs at start, outside the upgrade steps
- **What.** A household card filed by an older version kept the value it would replace in its `details`,
  where the asking agent could read it. At every start `src/shared-household-proposals.ts` looks for such
  cards and rewrites each: the value is replaced by a keyed digest of it, and the card's summary no longer
  shows it. A decided card loses its record of the earlier value.
- **Where.** The transaction after `apply` in `src/shared-household-proposals.ts`.
- **Why it is not a numbered step.** A step is SQL run against a database nothing else has opened. The
  digest is keyed with the household's key, which only the running program holds, and a waiting card needs
  that digest so its Allow is still refused when what it would replace has changed.
- **What is kept instead.** The three rules for such a rewrite (`docs/data-schema.md`). It changes nothing
  the second time: a rewritten card has no `before` and is not selected again. It prints one line with the
  number of cards it rewrote. It is listed here. A test holds all three
  (`src/shared-household-proposals.test.ts`).
- **What would change the answer.** A second rewrite of this kind. Then they get a table of their own that
  records which have run, as `migrations` does for steps.

### A thread's title is kept in three tables
- **What.** `threads.title`, `conversations.label` and `jobs.title` hold the same words.
- **Where.** `src/core/conversations/threads.ts` changes all three together; `src/runtime/jobs.ts` copies the
  title when a job is queued.
- **Why accepted.** Each is read alone on a hot path (the thread list, the conversation list, the jobs list)
  by a visibility predicate that does not join. A finished job keeps the title it ran under, on purpose.
- **What would change the answer.** A second place that changes a title, or a new job state that should
  follow a rename: add it to the list in `threads.ts`.

### An account's usage summary is stored beside the windows it is worked out from
- **What.** `model_accounts.usage`, `usage_read_at` and `resets_at` are derived from
  `model_account_windows`. `has_room` holds two facts: whether the windows leave room, and whether the last
  read of the provider failed. A failed read sets it to false and changes no window, so it cannot be worked
  out again from the windows alone; only the next successful read sets it back.
- **Where.** `src/runtime/account-windows.ts`: the function that writes the summary (`recordSummary`) is not
  exported and has one caller, the one that records the windows. `accountUsageUnavailable` in
  `src/runtime/account-usage.ts` is the one other writer, of `has_room` only, called when a refresh fails
  (`refreshAccountWindows`) and when a worker reports a failed read (`runtime.accountUnavailable` in
  `src/shared-account-reports.ts`). `currentAccountCapacity` reads both facts: the stored `has_room` and the
  windows as they have aged.
  A new account's row is made by `src/shared-model-account-admin.ts` with no usage read and no room, so
  nothing is placed on it before its first successful read.
- **Why accepted.** Admission reads the summary for every placement and the app shows it; both read one row.
  The failed-read fact has no column of its own because closing admission is all it is used for.
- **What would change the answer.** Another writer of the summary columns or of the windows, or anything that needs to tell "no room"
  from "the last read failed": then the failed read gets its own column, in a schema step.

### Each agent's `memories.db` still has four unused conversation tables
- **What.** `conversations`, `conversation_turns`, `conversation_days` and `conversation_digests` are created
  in every agent's memory file and never read or written. Conversations live in `loom.db`.
- **Where.** `src/backends/conversations.ts`, run by the `conversations` step in `src/backends/migrations.ts`.
- **Why accepted.** An older home's conversations are in these tables, and the move of that data reads them
  (owner's ruling, 2026-11-16).
- **What would change the answer.** The move being done. Then a step drops the four tables.

### Retry receipts are kept in the file whose write they protect
- **What.** There is more than one receipt table: `operation_results` in `loom.db`, `mind_operation_receipts`
  in each memory, notes, knowledge and people file, and `memory_command_receipts` in each `memories.db`.
- **Where.** `src/core/data/operation-results.ts`, `src/pieces/mind/receipt-schema.ts`,
  `src/pieces/mind/semantic-commands.ts`, `src/shared-notes.ts`.
- **Why accepted.** A receipt has to commit with the effect it answers for, and these effects are in different
  files. `memory_command_receipts` differs from the other memory table because a memory command reserves its
  id in one short transaction and commits its answer in a later one, around an embedding that takes time.
  `mind_operation_receipts` has one reader and writer.
- **What would change the answer.** Memory moving into the household database.

### A client states the shape of the answer it expects
- **What.** The household's vocabulary (the kinds of household change, memory categories, note lifespans, a
  secret's answers, card slug caps and the like) is written once and read by every door. Two kinds of code
  still write shapes of their own beside the operation they call: the terminal's named tools, which give each
  tool's fields a bound (a title of at most 200 characters, a body of at most 65536); and the body's clients,
  which check what loom answers them (the state of a secret request, an agent's status).
- **Where.** `src/shared-mcp-named.ts`; `src/runtime/conversation-client.ts`, `src/runtime/body-program-tools.ts`.
  The operations they call are in `src/pieces/mind/semantic-commands.ts`, `src/shared-secret-agent-commands.ts`
  and `src/core/conversations/body-output.ts`.
- **Why accepted.** The operation decides. A tool's bound only describes the tool to the model that calls it,
  and every call is checked again by the operation, so a tool that is looser changes nothing and one that is
  tighter refuses early, in words the model can act on. A body is a separate program that may be an older
  build than the loom it talks to; it checks the answer it was built to understand and treats anything else
  as loom being unavailable, which is the safe reading. Sharing the operation's own shape would not remove
  that check, only move it.
- **What would change the answer.** A named tool whose list of choices differs from its operation's (that is a
  defect: the lists above are imported, not copied), or a tool bound tighter than the operation's that a real
  caller hits.

### `memories.salience` is written and never read
- **What.** Each memory is stored with a `salience` of 1 and the column is not updated afterwards.
- **Where.** `src/backends/sqlite-vec.ts` writes it; `src/backends/salience.ts` works heat out at every read
  (`heatOf`, `hottestIds`) and ignores it.
- **Why accepted.** Dropping a column from every agent's memory file is a step with no gain in behaviour, and
  the stored number went stale whenever its refresh was missed, which is why nothing reads it.
- **What would change the answer.** A read that must rank many memories in SQL. Then store heat again, and
  refresh it where memories are written and recalled.
