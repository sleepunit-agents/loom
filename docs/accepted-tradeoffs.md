# Accepted trade-offs

Things in this program that are real, were looked at, and were left as they are on purpose. Each entry says
what it is, where it is, why it was accepted, and what would change the answer. If you find one of these in
the code and think it is a defect, read its entry first.

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

### A body is told which member it works for at the outside door, not where its token is resolved
- **What.** `bodyWorkingFor` (`src/shared-sharing.ts`) writes the member onto the viewer inside
  `authenticateOutside` in `src/shared-root.ts`, after `sharedCredentials.authenticate`. The token itself is
  resolved in `src/core/data/authentication.ts` (`currentToken`), which returns the bare agent.
- **Why accepted.** Every outside door (the command door, `/graphql`, the live socket, `/mcp`) authenticates
  through `authenticateOutside`, so no door sees a body without it. A composition that calls
  `dataAuthentication` on its own (tests, `dataHttp`'s default) gets the bare agent, which is today's
  behaviour for a program with no bodies.
- **What would change the answer.** A second outside composition that serves bodies. Then the member should
  be read in `currentToken`, where the job row is already loaded.

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
  agent's, and it must be running or waiting. A worker must name a job, that job must be starting on the
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
