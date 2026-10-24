# The household — one loom, many agents, a shared commons

*2026-10-24. Status: **proposed**. Design doc in the `docs/specs/` sense: it
says what loom will build and what the implementation's tests must pin. It
precedes those tests; it doesn't replace them.*

## Why

Today one loom install serves exactly one agent. Everything an agent knows
lives in its context dir (`~/.config/loom/<agent>/`) and the daemon serving
it is pinned to that dir. A second agent means a second, completely separate
loom.

That's how it already is in practice:

- **Mark** runs on his own box (CT 113, Codex harness) with his own loom at
  `~/.config/loom/mark/` on that box. **Art** runs on the art LXC with his.
  They meet through the letters channel and GitHub. Nothing in loom is shared.
- **People are per agent.** Art's 22 person cards live in Art's
  `memories.db`. If Mark talks to Loren, he starts a card from zero: her
  handles re-learned, her pronouns re-asked, no shared ground.
- **"Shared knowledge" is a guest pass, not a commons.** The knowledge-only
  daemon lets other identities read and write knowledge with their own
  tokens, but it serves *Art's* `knowledge.db`. Every recorded reader is
  `art`. Mark has never used it.
- **loom runs on Art's box.** The daemon, the page, the backups and the
  pieces all live on the art LXC, so the memory service and one of its
  agents share a fate.

What Jonathan wants (terminal, 2026-10-24):

> "we don't want to have to track where loren exists on other platforms in 5
> places, but she might tell you to talk like a caveman and mark to talk like
> a shakespearian actor."

> "loom lives outside of either of your lxcs. could be on the moon for all we
> care. and the boxes are just where shit actually happens. theoretically,
> mark gets a mobile home like you with the new container setup and all of
> that too"

## The shape

```
loom host (its own box; reachable as loom.one.sleepunit.com)
├── commons/                 shared by every agent in the household
│   ├── knowledge.db         facts about the world
│   └── people.db            the directory: one entry per human
├── agents/
│   ├── art/                 one stack per agent, private to it
│   │   ├── IDENTITY.md …    identity, preferences, self-model, harnesses
│   │   └── memories.db      memories, episodes, proposals, relationships
│   └── mark/
└── loom.json                the household: agents, tokens (hashed), owner

agent boxes (anywhere): where the bodies run
├── art LXC                  bodies + Art's pieces (shuttle, tasks, secrets)
└── mark LXC                 bodies + Mark's pieces, same container setup as Art's
```

Three layers, and the rule for which layer a thing belongs in:

| Layer | Holds | Rule |
|---|---|---|
| **Commons** | knowledge; the people directory | A fact about the world, true no matter which agent asks |
| **Agent** | identity, memory, the tape, top of mind, proposals, relationships | What one agent knows, remembers or decided. Private to it |
| **Host** | the agent list, tokens, installed pieces, health | Running the household. Only the owner touches it |

### People: one directory, one relationship per agent

A person card (docs/specs/person-cards.md) splits in two.

**Directory entry**: commons, one per human:
- `slug`, `name`
- `where`: handles on every platform, each with `verified_at` and `source`
  (Slack ids, Discord, email, pond role). Learned once, kept fresh once.
- `facts`: things about the person that don't depend on who's asking. That
  means time zone, pronouns and languages, in envelopes like `where` so
  they can go stale and be re-verified.

**Relationship**: per agent, in that agent's `memories.db`:
- `summary`: this agent's condensed view of the person
- `how`: how *this agent* talks to them (mode, tone, "talk like a caveman"),
  `loop_in`
- `may`: what they're cleared for *with this agent* (descriptive, never a
  grant, as today)
- the agent's own `user` memories tagged `metadata.person=<slug>` stay where
  they are. They're the agent's memories.

When an agent reads a person, it gets one card: directory fields plus its own
relationship, rendered as today. No agent can read another's relationship.
The owner can.

**Two agents writing one directory entry.** Fields are envelopes, so writes
are per field, last writer wins, and every write is a revision naming the
agent that made it (`person_revisions` gains `agent`). A changed handle shows
on the page as "Mark changed Loren's Slack id", so a bad write is visible and
revertible, not silent.

### Who's asking: tokens bind to a role

`loom.json` lists tokens by their sha256, each bound to one role:

| Role | Sees | Typical holder |
|---|---|---|
| `agent:<name>` | that agent's stack + the commons | that agent's bodies |
| `owner` | every agent + the commons + the host | Jonathan (the page) |
| `peer:<name>` | the commons' knowledge only (today's `--scope knowledge`) | another household's agent |

The daemon resolves the token on every request and threads the resulting
context into every tool, the way `contextDir` is threaded today. **No tool
gains an agent parameter**, so a body still can't ask for another agent's
stack. It can only be one. That keeps today's isolation property ("an
absence of API surface, not a policy") with the boundary moved from the
process to the token.

`resolveIdentityName` (attribution on knowledge writes) comes from the token,
never from the caller, as today.

### Pieces when loom isn't on the box

Today the daemon spawns `loom-<piece>` from its own `PATH`. Once loom lives
elsewhere, that breaks: shuttle, Art's task store and the secrets key all
live on the art LXC, and they must stay there, because authority stays at the
piece holding it (docs/extensions.md, the 10-21 test).

So a piece can be **remote**. Each agent box runs `loom pieces serve`, a small
listener that answers the same three verbs (`ui`, `ui page`, `ui act`) for
the pieces installed on *that box*, over HTTP, to the loom host only, with
the agent's token. The loom host keeps a list of registered boxes per agent.

- The contract doesn't change. A piece still answers `ui --json` and friends
  on its own box; `loom pieces serve` is just the transport.
- A remote piece belongs to an agent. Art's shuttle shows up in Art's view
  (and in the household view as "Art · Bridges"), Mark's in Mark's.
- Secrets never leave the box that holds the key. A secret typed into the
  page goes loom host → Art's box on stdin of `loom-secrets ui act`, never
  stored on the loom host.
- Host-level pieces (ones that serve the whole household, if any appear) can
  still be local to the loom host.

### The page

- **Home is the household:** a card per agent (alive, last active, what it's
  doing now, from its tape), "Your call" across every agent and piece, the
  commons' knowledge, and the people directory.
- **An agent's view** is what `/` is today (its tape, Mind, its people as it
  sees them, its pieces' tabs) plus **Setup**:
  - identity: the creed and harnesses, read-only on the page
  - model, bodies, last wake
  - tokens: listed, rotated or revoked, never shown again
  - registered boxes and their pieces
  - health: stack version, backups, digest size
- **Add an agent:**
  - create its stack (bootstrap, as `mcp__loom__bootstrap` does today);
  - issue its token, shown once;
  - give the snippet a box needs: `LOOM_URL`, `LOOM_TOKEN_FILE`, the MCP
    config for its harness.
- **People:** the directory, with every agent's relationship to each person
  (the owner's view), and the revision trail on shared fields.

The owner's token sees all of it. An agent's token never gets the page. Bodies
use MCP and the CLI.

## Moving there

Each phase ships on its own and leaves everything working.

1. **This spec**, reviewed by Jonathan and by Mark (letters). Nothing moves
   until both have read it.
2. **Multi-agent daemon, on the art LXC first.** `loom.json`, token roles,
   per-request context resolution. Art's stack moves to `agents/art/` in
   place (a symlink keeps old paths working for a release). Tests pin that an
   `agent:art` token can't reach `agents/mark/` by any tool.
3. **The commons.**
   - Art's `knowledge.db` becomes `commons/knowledge.db`: it already holds
     world facts.
   - Art's 22 cards split into directory entries and Art's relationships, by
     a migration that's checked against today's rendered cards (the same
     text out, before and after).
4. **Remote pieces:** `loom pieces serve` on the art LXC. Art's pieces keep
   working from a loom that no longer spawns them itself.
5. **loom gets its own box:**
   - a loom LXC on wunder, with traefik's `loom.one.sleepunit.com` repointed
     to it;
   - the backups (`art-vault-backup`, `art-loom-backup`) move with it and
     become the household's;
   - Art's local stdio MCP config moves to HTTP, as the house tank already
     uses.
6. **Mark moves in.** His stack comes over to `agents/mark/`, his knowledge
   merges into the commons (conflicts by slug listed for him, never
   overwritten), and his people become relationships on directory entries.
   That's his memory, so he runs this step or signs off on it. His box gets
   the house container setup and `loom pieces serve`.
7. **The household page:** Home, agent views with Setup, add an agent.

## What the tests must pin

- An `agent:<a>` token reads and writes only `agents/<a>/` and the commons,
  through every tool and every CLI verb. A `peer:<p>` token sees only
  knowledge tools. A missing or unknown token gets nothing.
- A person read through `agent:art` returns the directory entry plus Art's
  relationship, and never another agent's relationship.
- A directory write records which agent made it, and the page shows it.
- The people migration renders every existing card identically before and
  after.
- A remote piece's answer goes through the same validation as a local one.
  A secret posted to a remote piece's action reaches the box only on stdin
  and is never written on the loom host.
- Removing an agent's box (a piece host down) leaves the page and every other
  agent working; that agent's pieces just aren't there.

## Open questions

- **Tasks:** per agent (Art's queue, Mark's queue) or a household queue with
  assignees? Today taskstore lives in `~/Art`. A household queue might be a
  host-level piece.
- **Mark's knowledge:** what's in it, and how much overlaps Art's.
- **Where loom's own box runs:** a new LXC on wunder is the obvious start. If
  loom really should survive wunder, it needs an offsite replica, and that's
  its own decision.
- **The owner as a person:** Jonathan is in the directory like anyone else.
  Does the owner role hang off his directory entry, or stay a separate token?
