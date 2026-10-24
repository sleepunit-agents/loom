# The household — loom core for many agents

*2026-10-24. Status: **accepted** (Jonathan, terminal: "love it. ok, let's
restructure it and then grind this shit out"). Design doc in the
`docs/specs/` sense: it says what loom will build and what the tests must
pin. Its companion, [runtime.md](runtime.md), covers where bodies run. That's
a piece, not core.*

## Why

Today one loom install serves exactly one agent. A second agent means a
second, separate loom, and that's how it is in practice:

- **Mark** runs on his own box with his own loom. **Art** runs on the art LXC
  with his. Nothing in loom is shared between them.
- **People are per agent.** Art's 22 person cards live in Art's
  `memories.db`. If Mark talks to Loren, he starts from zero.
- **"Shared knowledge" is a guest pass into Art's store.** Every recorded
  reader is `art`.

What Jonathan wants (terminal, 2026-10-24):

> "loom is a fully external dependency. … if I installed claude code on some
> new thing, pointed it at the loom mcp and told it boot me up Art, you'd be
> there more or less, regardless of where it was."

> "we don't want to have to track where loren exists on other platforms in 5
> places, but she might tell you to talk like a caveman and mark to talk like
> a shakespearian actor."

> "a usb drive with the latest db dumped from loom brings you back from the
> apocalypse."

## Where core ends

loom is **continuity**: who an agent is, what it knows, who it knows. That
works with nothing else installed. Someone runs a harness on a laptop, points
it at loom, says "boot me up Art", and Art is there. No box, no container, no
secret. The test for whether something is core:

> **Does someone running loom with nothing but a harness need it? Then it's
> core. Does it hold authority (secrets, the right to run code somewhere)?
> Then it's never core.**

| Thing | Where | Why |
|---|---|---|
| identity, memory, tape, top of mind, proposals | core | it's the agent |
| several agents; shared knowledge; the people directory and relationships | core | who exists and who they know is continuity |
| tokens that say "this connection is agent X" | core | MCP can't work without it |
| the page frame, Home, Mind, People, the piece contract | core | a window onto the above |
| export and restore | core, with pieces adding their own parts | the Highlander part that's the agent's |
| boxes, houses, primaries, enrollment | **runtime piece** ([runtime.md](runtime.md)) | where bodies run; a laptop user has none of it |
| secrets | **piece** (loom-secrets) | authority |
| bridges, tasks, the wake clock | pieces | integrations, as today |

The dependency only points one way. Integrations ask the runtime, the runtime
uses core, and core knows neither. Without the runtime, a bridge spawns
bodies locally as today.

## The household on disk

```
$LOOM_HOME/                     (default ~/.config/loom)
├── household.json              agents, owner, the default agent
├── tokens.json                 every token: sha256, label, role, created, last used, revoked
├── commons/
│   ├── knowledge.db            facts about the world
│   └── people.db               the directory: one entry per human
└── agents/
    ├── art/                    a context dir, exactly as today
    │   ├── IDENTITY.md …
    │   └── memories.db         memories, episodes, proposals, relationships
    └── mark/
```

- **An agent's directory is today's context dir.** Nothing inside it changes
  shape except that knowledge and the people directory move to the commons.
- **A plain context dir with no household around it still works:** a
  household of one, with knowledge and people in the agent's own dir, as
  today. Every existing install keeps working, with no migration needed to
  stay on one agent.
- `household.json`:
  `{"v": 1, "agents": ["art", "mark"], "default": "art", "owner": "jonathan"}`.
  Agent names follow the piece-name rule (lowercase letters, digits and
  dashes; 40 at most).

## Who's asking: tokens

`tokens.json` holds every token by its sha256, never the token itself. Each
one has a **label** ("Art · house on wunder", "Jonathan · page") and a
**role**:

| Role | MCP and CLI as | Sees | Typical holder |
|---|---|---|---|
| `agent:<name>` | that agent | its own stack + the commons | that agent's bodies |
| `owner` | the default agent, or `/agents/<name>/mcp` for another | everything, including every agent's relationships, and the page | Jonathan |
| `peer:<name>` | nobody's stack | commons knowledge only (today's `--scope knowledge`) | another household's agent |

- **The daemon resolves the token on every request** and builds the session's
  server for that agent's directory: the same `contextDir` threading as
  today, chosen per token instead of per process.
- **No tool gains an agent parameter.** A body can't ask for another agent's
  stack; it can only be one. Today's isolation property ("an absence of API
  surface, not a policy") holds, with the boundary moved from the process to
  the token.
- **Attribution comes from the token.** Knowledge authorship and directory
  revisions record the agent the token belongs to, never what the caller
  claims.
- **Tokens are managed in core:**
  - `loom token create --agent art --label "…"` prints the token once.
  - `loom token list` shows labels, roles and when each was last used.
  - `loom token revoke <label>`.
  - The page lists and revokes them too.

  The runtime piece uses the same API when it builds a house.
- **The env vars keep working.** `LOOM_BEARER_TOKEN` is the owner's token,
  and `LOOM_KNOWLEDGE_BEARER_TOKENS` entries become `peer:` tokens. A
  household without `tokens.json` behaves exactly as today.

## The commons

**Knowledge** moves to `commons/knowledge.db` unchanged: it already holds
facts about the world. Every agent reads and writes it, and authorship is the
token's agent.

**People** split in two. A card (docs/specs/person-cards.md) today is
`{slug, name, summary, where, how, may}`.

- **Directory entry**, in `commons/people.db`, one per human:
  - `slug`, `name`
  - `where`: handles on every platform, each an envelope with `verified_at`
    and `source`, as today
  - `facts`: things about the person that don't depend on who's asking:
    `tz`, `pronouns`, `languages`. Envelopes, like `where`, so they go stale
    and get re-verified.
- **Relationship**, in each agent's `memories.db`:
  - `summary`: this agent's condensed view
  - `how`: how *this agent* talks to them (mode, tone, `loop_in`)
  - `may`: what they're cleared for *with this agent*; descriptive, never a
    grant, as today
  - the agent's own `user` memories tagged `metadata.person` stay where they
    are

Reading a person (`person`, the page, identity's "In the room") gives **one
card**: the directory entry plus the reader's own relationship, rendered as
today. An agent never reads another agent's relationship. The owner does.

**Two agents writing one directory entry.** Writes are per field, last writer
wins, and every write is a revision naming the agent that made it
(`person_revisions` gains `agent`). The page shows "mark changed Loren's
slack" with a revert.

**The split, for existing cards:**
- `how.tz`, `how.timezone`, `how.pronouns` and `how.languages` move to
  `facts`.
- Everything else in `how`, plus `summary` and `may`, becomes the owning
  agent's relationship.
- `name` and `where` go to the directory.

A card rendered after the split must read the same as before it, and the
migration is checked against that.

## Export and restore

loom is the one thing to protect, which also makes it the one thing to carry
out of a fire.

- **`loom export --to <file>`** writes one bundle: `household.json`,
  `tokens.json`, the commons, every agent's directory (SQLite through the
  backup API, not a file copy), and **each installed piece's own part**.
- **Pieces add their own part** with a new optional verb,
  `loom-<piece> export`. It writes the piece's store to stdout, already
  encrypted however the piece encrypts it: the secrets piece hands over its
  sops store as is, and core never sees inside it. `loom-<piece> import`
  reads the same bytes back. A piece without the verb is listed in the bundle
  as not included.
- **The bundle is encrypted to an age recipient the owner holds** (a YubiKey,
  or a key in his password manager); `--recipient` is required. That key
  opens the whole household. For the secrets piece, the bundle's key is the
  recovery copy t-1482 asked for.
- **`loom restore <file>`** on an empty `$LOOM_HOME` lays the household back
  down, then hands each piece its part through `import`.
- **On a schedule,** offsite. The page shows the last bundle's age and the
  last restore drill.
- **The drill:** restore into a throwaway `$LOOM_HOME` and compare it with
  the live household (below). An untested backup is a hope.

## The page

The page becomes the owner's view of the household:

- **Home:**
  - every agent, with what it's doing now from its tape;
  - "Your call" across every agent and piece;
  - the commons' knowledge and the people directory.
- **An agent's view:**
  - what `/` is today: its tape, Mind, its people as it sees them, its
    pieces' tabs;
  - **Setup**: its identity (read-only), its tokens (list, revoke, create),
    and health (stack version, digest size, last bundle).
- **People:** the directory, each person with every agent's relationship and
  the revision trail on shared fields.
- **Add an agent:**
  - create its directory (the bootstrap `mcp__loom__bootstrap` does);
  - create its first token, shown once;
  - give the snippet a harness needs: `LOOM_URL`, the token, the MCP config.

Runtime things (boxes, houses) come in through the piece contract like any
other piece.

## Moving there

Each phase ships on its own and leaves everything working. Art's install is
the first household.

1. **Household and tokens.** `$LOOM_HOME/household.json`, `tokens.json`, the
   `loom token` verbs, and per-request agent resolution in the daemon and
   `/cli`. Art's context dir moves to `agents/art/`, with the old path kept
   as a symlink for a release.
2. **The commons:**
   - knowledge moves to `commons/knowledge.db`;
   - the people split, with the before-and-after render check;
   - directory revisions name their agent.
3. **Export and restore,** the piece `export`/`import` verbs (loom-secrets
   first), and the drill.
4. **The household page:** Home, agent views with Setup, People with
   relationships, add an agent.
5. **Mark moves in:**
   - his directory comes over;
   - his knowledge merges into the commons, with conflicts by slug listed for
     him and never overwritten;
   - his people become relationships on directory entries.

   It's his memory, so he runs this step or signs off on it.

The runtime piece ([runtime.md](runtime.md)) follows once phase 1 has
landed, since it only needs tokens.

## What the tests must pin

- An `agent:<a>` token reads and writes only `agents/<a>/` and the commons,
  through every MCP tool and every `/cli` verb. A `peer:` token sees only
  knowledge tools. An unknown or revoked token gets nothing.
- A plain context dir with no household behaves exactly as today, and the
  full existing suite passes against it unchanged.
- A person read as agent A returns the directory entry plus A's relationship,
  never B's. A directory write records its agent. Every existing card renders
  identically before and after the split.
- `loom restore` of a fresh bundle into an empty `$LOOM_HOME` gives a
  household that answers identically:
  - the same identity payload, the same recall results, the same cards and
    knowledge, the same tokens;
  - each piece's part comes back through its `import`, byte for byte;
  - a bundle without the owner's key is unreadable.
- Core never decrypts or reads a piece's export.

## Open questions

- **Tasks:** one household queue with assignees, or a queue per agent? That's
  taskstore's question, not core's.
- **Mark's knowledge:** what's in it, and how much overlaps Art's.
- **The owner as a person:** Jonathan is in the directory like anyone else.
  Does the owner role hang off his directory entry?
- **How often the bundle is written,** and whether a warm standby is worth
  having, or the USB stick is enough.
