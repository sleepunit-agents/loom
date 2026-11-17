# Owners: a household's people, and which agents each one owns

*2026-10-28. Status: **accepted** (Jonathan, terminal: "this is good as is"). His calls on the open points (terminal,
2026-10-28): two kinds of owner, yes; with several owners on one agent the first
answer wins; an agent owner asks for household things rather than granting them;
a view-only role later. A design doc in the `docs/specs/` sense: it says what
loom will build and what the tests must pin. It answers [household.md](household.md)'s
open question "does the owner role hang off his directory entry?". t-1649.*

## Why

A household has exactly one owner today, and that owner has no identity:

- **The owner is a string.** `household.json` says `"owner": "jonathan"`, used
  for display (`src/household.ts`), tied to no person and no credential.
- **Every owner login is the same login.** All owner tokens resolve to
  `{kind: 'owner'}`. Every passkey is the same WebAuthn user (`loom-owner|rpId`,
  `src/ui/handler.ts`). `ui act` reaches a piece with no caller at all
  (`src/ui/pieces.ts`), so every piece treats a page action as the owner's.
- **Nothing records who decided.** loom-secrets writes `by: 'owner'`, loom-box
  acts as `OWNER`, and the approvals piece records an allow with no name.
- **One Inbox for the house.** Read state is one record per household
  (`src/ui/sessions.ts`), and every new ask is pushed to every subscription
  (`src/ui/push.ts`).
- **The owner reaches every agent.** Nothing says whose agent an agent is.

What Jonathan wants (terminal, 2026-10-28):

> "Theoretically different agents could have different owners or even
> multiple owners in a team situation."

## Members

A household's people are **members**, and a member is a [People](household.md#the-commons)
directory entry with a role:

```json
{
  "v": 1,
  "agents": ["art", "mark", "pond-bot"],
  "members": [
    {"person": "jonathan", "role": "owner", "agents": "*"},
    {"person": "loren",    "role": "owner", "agents": ["pond-bot"]}
  ]
}
```

- **`person` is a directory slug.** The owner is in the directory like anyone
  else ([agents-in-people.md](agents-in-people.md) makes sure the entry exists), so what an agent knows about Jonathan and what loom lets Jonathan do
  hang off the same entry.
- **`"owner": "<name>"` keeps working.** A household without `members` reads as
  `[{"person": <owner>, "role": "owner", "agents": "*"}]`. Writing `members`
  replaces it; nothing else changes until a second member exists.
- **`role` is `owner` only, for now.** A view-only role comes later (Jonathan:
  "later"). The field exists so adding it isn't a format change.

## Two kinds of owner

The household has two levels (the Home and Inbox design, 2026-10-27): what's
shared, and what's one agent's. Owners follow them.

| | Household owner (`agents: "*"`) | Agent owner (`agents: [...]`) |
|---|---|---|
| Their agents' cards, Today, Mind, Setup | every agent | theirs |
| Their agents' asks, notices, pushes | every agent | theirs |
| Household asks (a box joining, a piece's own ask) | yes | no |
| Boxes, Secrets, Subscriptions, Clock, pieces, People, tokens | manage | not shown |
| Grant a household thing (a secret, a box, a slot) to an agent | yes | **ask**: a card for the household owners |
| Add an agent, add a member | yes | no |
| MCP `/agents/<x>/mcp` as owner | every agent | theirs |

- **An agent owner asks; a household owner grants.** An agent owner who wants
  their agent to have a secret or a box asks for it from the agent's Setup,
  and that's a `permission` ask on the household owners' Inbox. Granting
  household things stays with whoever owns them (Jonathan: "ask").
- **There's always a household owner.** loom refuses to remove or narrow the
  last member with `agents: "*"`.

## Several owners on one agent

- **A body working for a member reaches no further than that member.** When an
  agent's body runs a job that is for one member (their private thread with
  the agent), each way the agent reaches a record counts only while that member
  has the same reach: a project only if the member is in it too or is a
  household owner, what is labelled with the agent only while the member has the
  agent on their own list, and nothing once the member has left. The body is
  still the agent, never the member: it gains nothing that only a member holds.
  A terminal session, and a job that is for no member, is the agent alone. The
  rule is stated at `Viewer.workingFor` in `src/policy.ts`; what stays the
  agent's own whoever it works for is in `docs/accepted-tradeoffs.md`.

- **The first answer wins.** An ask goes to every owner of its agent, and
  the first Allow or Deny decides it (Jonathan: "yes"). The others see it
  answered, and by whom.
- **Answered says who.** Every answered item, page action and piece record
  names the member who acted (`by: "loren"`). Past records keep `by: "owner"`:
  there is no way to attribute them, and nobody pretends to.

## Who's asking: the caller

**Tokens and passkeys belong to a member.**
- `tokens.json` records gain `member: "<person>"` on owner tokens. `loom token
  create --owner --member loren --label "…"`, and the page makes them for a
  member. An owner token with no member belongs to the first household owner,
  which is today's case.
- **One WebAuthn user per member.** A passkey's `user.id` is derived from the
  member, not the household. A passkey signs in as an owner token of its own
  that names its member (`docs/specs/passkeys.md`, t-1969); one made before
  that moved onto one, for its old token's member, if that token was live.
- **Sessions carry their member.** A sign-in link is made for a member and
  opens that member's session.

**The caller gains who and which agents, and keeps its kind.** Over the piece
API, and now on `ui page`/`ui act` too:

```json
{"kind": "owner", "who": "loren", "agents": ["pond-bot"]}
```

- **`kind` stays `owner`.** It's part of the published contract
  ([extensions.md](../extensions.md), "The API"), and every piece branches on
  it. The new fields are additions: a piece that ignores them keeps working
  for household owners.
- **`agents` is `"*"` or a list.** loom resolves it from `members` on every
  request, never from what a caller says.
- **`ui act` and `ui page` get the caller** on stdin, beside `{action, path,
  fields}`. Until now they had none.

## A piece that doesn't know about agent owners

An agent owner must never act through a piece that ignores `agents`, because
that piece would treat them as owning everything.

- **Pieces opt in.** A manifest that says `"owners": 2` understands `who` and
  `agents`: it scopes what it shows and refuses what isn't theirs.
- **Until then, agent owners don't see it.** A piece without `"owners": 2`
  appears only for household owners: no tab, no tiles, no asks, no agent
  readings for anyone else. loom drops them before rendering, so a piece
  can't leak by accident.
- **loom filters what it can on its own,** whatever the piece says: asks,
  notices, answered items and agent readings that name an agent the member
  doesn't own never reach that member.

## The Inbox, per person

- **Read state is a member's.** `seen` and `opened` move from one household
  record to one per member. A household's current record becomes the first
  household owner's.
- **Pushes go to the ask's owners.** An ask that names an agent pushes to that
  agent's owners' devices. One that names none (a household ask) pushes to the
  household owners. A device's push subscription belongs to the member whose
  session registered it.
- **Badges count your own.** Needs-you and the tab badge count only items
  this member can answer.

## What an agent knows about its owners

- **Identity names its owners.** An agent's identity payload lists the members
  who own it (person slugs and names), from `members`, not the string baked in
  at creation (`user: h.owner`, `src/ui/household-pages.ts`).
- **People entries say so.** A member's directory entry shows which agents
  they own. An agent's relationship with them is still its own.

## Moving there

Each step ships on its own and leaves everything working.

1. **Members.** `members` in `household.json` (with the `owner` fallback),
   `member` on owner tokens, per-member WebAuthn users with the digest
   mapping, sessions with their member, `who` on the caller, and `by: <who>`
   in loom's own records. With one member nothing visibly changes; every
   decision gains a name.
2. **Agent owners in core.**
   - The caller's `agents`.
   - loom's own filtering of Home, the Inbox, agent pages and MCP.
   - Per-member read state and pushes.
   - `"owners": 2` gating.
   - Adding a member on the page: Household Setup → Members, and a sign-in
     link made for them.
3. **Pieces opt in,** one PR each: secrets (requests, Always allow, the
   policy: grants stay household owners'), box (houses and sessions scoped to
   an agent owner's agents, boxes household-only), approvals, the clock (an
   agent owner's clock and lanes for their agents), subscriptions, shuttle.
   Each records `by: <who>`.

## Moving a task, and merging or splitting projects

*Added 2026-11-17, for the move of old tasks into loom: they are sorted into projects by a first guess, and
the household needs the tools to put right what lands in the wrong place.*

A task belongs to a project, and everyone on that project sees it. A task with no project is its owner's
alone. Three things change where work is filed.

- **Move a task** (`tasks.command`, action `moveToProject`, with `ids` and `project`; the named tool
  `task_move_to_project`).
  Up to 500 tasks go to another project, or with `project: null` out of every project.
  - *Who may.* The mover must be able to act on each task where it is now, and must be someone who could
    have filed a task where it is going: a member or agent on that project, or a household owner. Out of
    every project a task becomes its owner's alone, so only its owner or a household owner may do that. So
    nobody gains sight of a task by a move who could not already have been given it. The rule is `moveTask`
    in `src/policy.ts`, with the other task rules.
  - *All or nothing.* If one task named cannot be moved, none is. A project that is removed, or is not
    there, is refused.
  - *What goes with the task.* Its own project, and the labels of mail that was filed under the task's
    labels: a question put to a person about it, and the answer sent on from one. Mail filed in a
    conversation keeps that conversation's labels, with one exception: an answer sent on to the agent that
    asked, in a thread that is not a member's own, carries the task's project and so follows the task.
  - *What stays.* Links stay: a parent and its children may be in different projects. Comments stay.
  - *The record.* One comment on each moved task, by the mover, saying from where to where. A task already
    in the project is left alone and gets no comment.
  - *A waiting question stays with someone who can read it.* A question about a task is put only to a
    person who can read the task (a household owner always can). So a move is refused while the task carries
    an unanswered question for someone who could not read it where it is going: have it answered, or put
    the question to someone who can, first. Both ask the one rule, `mayBeAskedAbout` in `src/policy.ts`.
    Nothing is handled when the answer comes.
  - *One way.* An `edit` that names another project is this same move for one task: the same rule, the
    same mail, the same comment. Before 2026-11-17 such an edit left no comment and left the task's mail
    under the old project. `move` still means only a task's place in the hand-kept order.
- **Merge two projects** (a household change, `projectMerge`, with `from` and `into`). An agent proposes it
  and a household owner allows the card. A merge cannot be undone, so the card is a dangerous one: the owner
  must also confirm, and no standing approval rule answers it, not one for dangerous actions either. In one write:
  - every record filed under `from` is filed under `into`: its tasks, conversations, inbox items, approval
    cards, triggers, jobs and pull requests. `projectLabelled` in `src/shared-projects.ts` lists every table
    that names a project and what the merge does with it, and a test fails when a table is missing from it;
  - the members and agents of `from` are added to `into`, and its repositories move to `into`, since a
    repository has one project;
  - `from` is marked removed. Its row is kept, like any removed project, with its own lists of people and
    agents, which grant nothing while it is removed.

  It is refused for a project merged into itself, for one that is removed or not there, and when a
  repository would be left with two projects. The card is the record: who asked, who allowed it, and the
  two projects. Tasks get no comment. A merge is not undone by restoring `from`, which puts back an empty
  project. A standing approval rule whose scope is `project:<from>` is not carried over. It was an owner's
  word about that one project; carried over, it would answer for every card of the project merged into.
- **Split a project.** There is no command for it. It is two steps that already exist:
  1. make the new project (a household owner in the app, or an agent with `propose` and `change: "project"`);
  2. move the chosen tasks into it (`moveToProject`).
- **Ask to be let onto a project** (a household change, `projectJoin`): see [projects.md](projects.md),
  "Asking to work on a project".
- **Retire a project, or revive it** (`projectRetire`, `projectRevive`): see [projects.md](projects.md),
  "Retiring a project". A retired project takes no task by creation, move or merge; tasks may be moved out
  of one, and it may be merged into another.

## An agent's own work, and what it may raise

*Added 2026-11-18, so the agent's own scripts can ask loom what a standing rule says and tell its owners
when something is wrong.*

- **Whose standing rules answer.** A standing approval rule with no person is the household's own: a household
  owner's answer, given ahead of time, for work done for a household owner. A rule that names a person
  answers for that person's work only. Every piece of an agent's work has a principal, kept on its card:
  - work for a member (their own thread, their trigger) is that member's, as it always was;
  - the agent's own work is a terminal session, or a lane for no member. It reads the household's own rules
    while a current household owner has the agent on their own list, and none otherwise. So an agent that only
    members who are not owners have gets nothing from an owner's rule through its lane or its terminal;
  - a room on Discord or Slack, and a handoff, are nobody's and always ask: people outside the household talk
    to an agent there.

  The rule is `workPrincipal` and `rulesPerson` in `src/policy.ts`. A household change proposed with no
  member behind it still always asks; the agent's own account is for merges and commands.
- **Asking, filing and spending from a terminal.** `approvals.rule`, `approvals.request`, `approvals.use`,
  `approvals.report` and `approvals.withdraw` take an agent's terminal credential as well as a body's. A
  terminal credential acts on its own agent's merge and command cards that were filed from no conversation.
  Nothing lists the rule table for an agent: it asks about one kind and one target.
- **A merge target.** `github:<owner>/<repo>#<n>@<commit>` names one pull request at one exact commit. For
  a repository loom reads, the target must be the agent's own open change at that commit, and a card carries
  that change's project. For a repository loom does not read, loom has nothing to hold it to: the rule is
  read, and a card filed, allowed and spent, on the target's own words. Such a card has no project, so a
  project's rule never answers for it. Whoever merges must merge that commit and no other.
- **Raising a notice.** `notices.raise` puts one waiting notice in the Inbox of each member who has the
  calling agent (the household owners when nobody has it), private to each, and pushes to their devices
  unless it is raised `quiet`. One notice per agent and key while it waits: raising it again brings its words
  up to date and tells nobody twice. `notices.clear` resolves it with a reason. Only the agent's own
  credential raises one, for itself; the agent is told its own key, whether the notice was new and how many
  devices were pushed to, and nothing of anyone's Inbox. The limits are in `src/shared-notices.ts`.

## What the tests must pin

- A household with only `"owner": "x"` behaves exactly as today, and the full
  existing suite passes against it unchanged.
- An agent owner, through every route (page, `/cli`, MCP, piece API, `ui act`),
  sees and acts on only their agents. A request naming another agent is
  refused, and a piece without `"owners": 2` is invisible to them, its asks
  included.
- With two owners on one agent, the first answer decides the ask, the second
  is refused as already answered, and Answered names who decided.
- Every new record of a decision names its member. No record names a member
  who didn't make it.
- Removing or narrowing the last household owner is refused.
- Passkeys registered before `members` still sign in, as the member their
  token names (the first household owner, for one that names none).
- An agent owner's request for a household thing is a `permission` ask on the
  household owners' Inbox, never a grant.
- Read state and pushes: one member opening an item doesn't mark it read for
  another; an ask for agent A never pushes to a member who doesn't own A.

## Later

- **A view-only role** (`role: "viewer"`): reads their agents' pages, answers
  nothing.
- **Asks that need two yeses** (a teardown, a key rotation), if first-answer
  ever proves too loose.
- **Members across households** (one person in two looms) is the peer
  question, not this one.
