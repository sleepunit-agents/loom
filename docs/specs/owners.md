# Owners: a household's people, and which agents each one owns

*2026-10-28. Status: **proposed**. Jonathan's calls on the open points (terminal,
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
  else, so what an agent knows about Jonathan and what loom lets Jonathan do
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
  member, not the household. Existing passkeys map to the first household
  owner through the token digest they were made with (`docs/specs/passkeys.md`),
  so nobody re-registers.
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
- Passkeys registered before `members` still sign in, as the first household
  owner.
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
