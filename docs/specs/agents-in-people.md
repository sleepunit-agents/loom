# Agents in People: the directory is everyone, not only humans

*2026-10-28. Status: **accepted** (Jonathan, terminal: "please do, and then go
ahead and grind on them"). A companion to [owners.md](owners.md): both change
what a directory entry is, so they land together. It extends
[household.md](household.md), "The commons". t-1650.*

## Why

The People directory is built for humans only. The code says so ("one entry
per human", `src/backends/people-household.ts`), and so does shuttle ("Agents
aren't loom people", `shuttle/loomui.py`). Nothing excludes an agent on
purpose. Agents were simply never entries, and it shows:

- **A conversation with an agent links to nothing.** The bridge page lists
  "Mark (peer agent bot)" as a dead name, while Jonathan links to his card.
- **No agent can know another.** Art can't keep a card for Mark the way it
  keeps one for Loren. So nothing records what Art knows about Mark, how to
  reach him, or how they work together, and the page can't show who knows
  whom.
- **The owner isn't an entry either.** `jonathan-barket` lives in the bridge's
  `people.json`, not in the directory, so [owners.md](owners.md)'s "a member
  is a directory entry" has nothing to point at yet.
- **Agents are kept on the side.** `people.json` has its own `agents` section
  (Gabe, Daniel's Claude, Mark) with handles and a `via` (the person whose
  account the agent writes through), invisible to loom.

What Jonathan wants (terminal, 2026-10-28):

> "people excludes agents. I can see Mark had a conversation with you, but
> unlike a person, no link to a mark card. can't know what agent knows which
> other agents, what they know about them, yada fuckin yada."

## A directory entry has a kind

A directory entry is **someone**: a person or an agent.

- **`kind` is a directory fact**, `person` (the default) or `agent`, beside
  `tz` and `pronouns`. It's shared, since it doesn't depend on who's asking,
  and every revision of it names the agent that made it.
- **Every agent in the household has an entry,** with its own name as the slug
  (`art`, `mark`), its display name, and kind `agent`. loom makes it when the
  household is loaded or an agent is added, and never deletes it. An entry
  whose slug is a household agent is always kind `agent`: a write that says
  otherwise is refused.
- **Agents outside the household** (Gabe, Daniel's Claude, a peer
  household's bot) are entries with kind `agent`, written like any card.
  They're in the directory, not the household: no token, no clock, no pages.
- **`via`** is a directory fact on an agent entry: the slug of the person whose
  account it writes through (Gabe via `jonathan-barket`). Descriptive only.
  It's never a trust tier, as `people.json` already says.

## Relationships between agents

They work exactly as they do with people, because they are the same thing:

- **Art's card for Mark is Art's relationship** (summary, `how`, `may`) on
  Mark's directory entry, in Art's own memory. Mark's card for Art is his.
- **No agent reads another's relationship.** That doesn't change: Art never
  reads what Mark thinks of Art, or of anyone. The owner does, on the page, as
  for people. Mark's own memories stay his; Art's card for Mark holds what Art
  knows, never Mark's memory.
- **An agent's own entry is about it, not by it.** Mark's directory entry
  holds his name, kind, handles and `via`. What Mark is like is each other
  agent's relationship, and Mark's identity is his own.

## Handles link conversations to entries

- **An agent's handles go in `where`,** exactly like a person's: Mark's Discord
  bot id, his Slack user, `github: visual-mark`. Then a conversation with him
  resolves to his entry the same way one with Loren does.
- **Shuttle links agents too.** The bridge page links an author to the entry
  whose handle or unique name matches, person or agent. `people.json`'s
  `agents` section stays the bridge's routing config, and shuttle stops
  treating it as unlinkable.

## The page

- **People shows everyone,** with a filter (Everyone, People, Agents) and a
  small `agent` mark on agent rows.
- **An agent's entry links to its agent page** (Today, Mind, Setup) when it's a
  household agent, and the agent page links back to its entry.
- **"Who knows whom."** An entry's page lists which agents have a
  relationship with it (names only, never the relationship's contents unless
  you're the owner), and the owner sees each one. For an agent's own entry,
  that answers "which agents know Mark".

## The owner's entry

[owners.md](owners.md) makes a member a directory entry. This spec makes sure
the owner has one: when `members` (or the legacy `owner`) names a person with
no entry, loom makes a kind `person` entry with the owner's name. Today that
is `jonathan-barket`, already the bridges' slug for Jonathan.

## Moving there

1. **Kind, agent entries and the owner's entry:**
   - `kind` and `via` as directory facts;
   - entries ensured for every household agent and the owner;
   - the refusal on a household agent's kind;
   - the People filter and agent marks;
   - links between an agent's entry and its pages.
2. **Who knows whom** on an entry's page.
3. **Shuttle links agents:** the bridge page resolves authors to agent entries
   by handle or unique name, as it does for people.
4. **Seed the side lists:** `people.json`'s `agents` (Gabe, Daniel's Claude,
   Mark) become entries with their handles and `via`, written by Art through
   the person tools.

## What the tests must pin

- A household with no agent entries gains one per agent on load, kind `agent`,
  and loading again changes nothing.
- A write that sets kind `person` on a household agent's entry is refused. A
  peer agent's entry can be kind `agent` through an ordinary write.
- Art's relationship with Mark is readable as Art and invisible as Mark,
  exactly as a person's is.
- Every existing card renders as before. Kind `person` is the default and
  isn't shown on a person's card.
- The People filter shows people, agents, or both, and a household agent's
  entry links to its agent page.
- The owner named in `members` (or `owner`) has an entry after load.
