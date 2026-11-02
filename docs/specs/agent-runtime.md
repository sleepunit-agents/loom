# The runtime: loom runs agents

*2026-11-02. Status: **proposed**. This is a design doc in the `docs/specs/` sense. It redraws the pieces around one
idea: before loom has any bridge, any clock or anything that reacts to the world, it needs a piece that can run an
agent. It builds on [runtime.md](runtime.md) (boxes and houses, accepted and built as loom-box) and
[bridges.md](bridges.md) (conversations, bodies, capacity, continuity), and on [conversations.md](conversations.md),
which moves the conversation record into core.*

## Why

> "Where does the code that says 'ok here's how to start an agent' live? It sounds like it's in a lot of places, and I
> feel like it needs to go with subscriptions." "Thinking about the pieces as things that add functionality, it feels
> like before you're adding bridges or anything like that, you're adding the ability to execute agents from loom.
> Core is an MCP you connect to before that point." "Subscriptions and the core 'how do we launch shit / manage who can
> do what' is a single piece." — the owner, 2026-11-02

Today three pieces start agent sessions, each its own way:

- **The clock** starts a session locally, or asks box for a house (`loom box up --task -`), and keeps its own model
  setting.
- **The bridges piece (shuttle)** has its own runners (Claude, Codex), its own spawn logic, its own model resolver, and
  its own gates for who may do what.
- **Box** builds and runs houses, and decides which credentials land in them. For model credentials it asks the
  subscriptions code, which ships inside the bridges piece.

There are three launchers, two model choosers and one credential source between them. They're checkable in the
pieces' repos:
- the clock: `dispatch` and the session command in loom-clock's `bin/wake`;
- the bridges piece: `shuttle/runner.py`, `spawn.py` and `runners/codex.py`;
- box: `loom box up` and the house runner in loom-box. Every piece keeps its own list
of which agents may use it. Agent-to-agent relay is split over core, the clock and approvals. A boundary review of
all of it, reviewed independently, is in this doc's sources.

## The layers

```
core      who the agent is, what it knows: identity, memory, knowledge, people, projects,
          conversations (records). An MCP you can connect a harness to and nothing else.
runtime   the agent can run: boxes and houses, model accounts, harness runners, model choice,
          delivery (anything addressed to an agent becomes a body handling it), permissions,
          and the daily review job.
sources   things that knock: venue adapters (loom-discord, loom-slack), the clock. Each needs the runtime.
```

Each layer needs only the one below it. Core works alone. The runtime needs core. A source needs the runtime.

**This changes two accepted rules in household.md** ("The dependency only points one way…"), and household.md is to
be edited to match:
- **"Without the runtime, a bridge spawns bodies locally as today"** no longer holds. A source with no runtime can't
  start a body. A household that wants Discord installs the runtime. A one-machine household's runtime is just loom's
  own machine as its only box (runtime.md, "Boxes", rule 1), so that costs no configuration.
- **"Core knows neither"** is reworded to "core names neither": core never names the runtime or a source, but it does
  run the generic offers (below), through which the runtime offers delivery, grants and tools.

household.md's sentence becomes: "The dependency only points one way. Sources need the runtime, the runtime uses core,
and core names neither. It reaches them only through offers."

**Words.** A **body** here is the agent itself in one conversation: it loads identity and writes the agent's memory
and digests. A runtime body is not CONTEXT.md's *Worker body*, which serves the agent without being it. CONTEXT.md
gains "Body: the agent running in one conversation (a session in a house)". Its "Harness" entry, which calls the harness
"the runtime the agent runs in", is reworded to "the program a body runs in (Claude Code, Codex)", so "runtime" means
only this piece.

## What the runtime holds

### 1. Boxes and houses (from runtime.md)

Enrollment, primaries, vacation homes, box and house credentials, and "a box only ever runs containers" all stand as
runtime.md decided them, except who decides secret grants (section 6). The piece that built them (loom-box) becomes the runtime piece. Its piece name becomes `runtime` (bin
`loom-runtime`, with `loom-box` kept as a second bin through the move). It keeps owners.md's `"owners": 2` opt-in,
and every page and action that was box's, subscriptions' or the bridges piece's keeps its owner rules.

### 2. Model accounts (from subscriptions)

The household's model accounts move here: sign-ins, credentials, usage, and issuing a credential into a house
(`sub:<provider>`, which box already uses). The runtime keeps a **model list**: each model it can run, its harness,
and its **family**. Families are fixed strings: `anthropic`, `openai`, `google`, `mistral`, or `local:<name>` for a
model the household runs itself. Grading reads the families (conversations.md, Review).

### 3. Runners

One runner interface over the harnesses, Claude Code and Codex today: start a body with a brief, feed it a message
mid-turn where the harness allows, resume a session from its slot, end it. The clock's session command and shuttle's
runners both go. Whoever needs a body asks the runtime for one.

### 4. Model choice

One resolver picks the model for a body. In order:
1. **Hard limits:** models the agent may use, with quota left.
2. **The agent's preference** among those.
3. **Scorecards** demote the preference when another allowed model's `graded` value for the venue kind is at least
   1.0 higher (conversations.md).

Its inputs:
- the agent's preference;
- the venue kind;
- what each account has left;
- the scorecards (conversations.md).

It replaces the clock's `WAKE_MODEL` and the bridges piece's resolver.

### 5. Delivery

Anything addressed to an agent arrives the same way:

```
a source ──► deliver {agent, venue, place, label?, from, text}
                │  the runtime writes the turn to core's conversation record (and its text to the audit log)
                ▼
             the conversation's body:  live → feed it;  ended → resume it;  none → start one with the brief
```

**The `deliver` contract.** A source calls `POST /api/loom/deliver` with its own piece token. This is one new core
route that every piece token may reach (extensions.md's "a piece credential reaches its own piece's API and nothing
else" gains this exception). Core forwards the call to the piece offering `delivery` (the runtime), through the offers
runner. The body:

| Field | Value |
|---|---|
| `id` | the source's own id for the message (a platform message id, a wake id), ≤ 200; required |
| `agent`, `venue`, `place` | conversations.md's key |
| `from`, `kind`, `at` | conversations.md's turn fields (`kind` is `message`, `wake` or `note`) |
| `label` | optional |
| `text` | the message, ≤ 40,000 chars |

**Idempotent:** the same `(source piece, id)` within 24 hours returns the first call's answer and writes nothing.

The runtime:
1. writes the turn and its audit text to core;
2. tries to reach the body for up to 2 s;
3. answers `200 {conversation, seq, body}`, where `body` is `fed`, `resumed`, `started`, `queued` or `failed` (with a
   `reason`).

If step 1 fails, it answers `5xx`, nothing reaches a body, and no turn exists. A body that fails to start is
`body: "failed"`: the turn stands.

Where it comes from:
- **Inbound:**
  - a Slack or Discord message, from a venue adapter;
  - "it's 03:13, run the knowledge lane", from the clock;
  - another agent's relay, from the runtime itself.
- **Outbound:** an agent's reply, or a message it starts. The runtime runs the venue adapter's declared `send`:
  - conversations.md's venue declaration gains `send`, an argv like `render`'s, given `--place <place>` with the text
    on stdin;
  - it has 15 s, and answers `{ok, id?}`;
  - it's sent first, then the agent's turn is recorded with outcome `answered` (`failed` if `send` failed after one
    retry), and the body is told of a failure.
- **Continuity slots hold raw session state** (a harness needs its history to resume). So, alongside the audit log:
  - slots are encrypted at rest to the runtime's own key;
  - each is kept only for its venue's continuity window, at most 14 days, then deleted;
  - after that, a conversation resumes from its digests (bridges.md's summary handoff).
  - **Harness transcripts:** this decides conversations.md's open question. The runtime deletes a harness's own
    local transcript files for a body when its slot is deleted.
- **Bodies, capacity and continuity:** as bridges.md has them. Warm houses with sessions as bodies, capacity counted in
  busy bodies, a new conversation taking a warm idle body's place, and continuity through slots with a summary
  handoff. The difference is that bridges.md's "shuttle service" is now the runtime, and the conversation record is
  core's.
- **Agent-to-agent relay** is delivery whose `from` is an agent, on the venue `relay` the runtime declares. Pairing
  rules (who may relay to whom) move out of household.json into the runtime's permissions. An unpaired relay is
  delivered only with an allowed approval from the approvals piece (`loom approvals use`), and is refused when no
  approvals piece is installed. The `relay` MCP tool
  becomes an offer the runtime makes (below), so core no longer names a piece.

### 6. Permissions

Who may do what, in one place:

- **Gates** (from bridges.md, "Who someone is"): who a platform id is, and what each person may do with each agent
  (tiers, grants, restricts). They're kept in the runtime's owner-written collection.
- **Agent grants:** which agents may use which pieces.
  - **Who decides.** With one installed piece offering `grants` (the runtime), core asks it before any call an agent
    makes to a piece: `/api/<piece>/…`, `/api/<piece>/run`, and an offered MCP tool. Running a piece's binary
    directly inside a house isn't a call through loom, and isn't covered.
  - **Without a grants authority,** each piece decides by its own agent list, as today. A second piece offering grants
    is refused at install.
  - **Pieces keep their lists** (taskstore's `TASKSTORE_AGENTS`, the clock's `WAKE_AGENTS`, and the lists in agent-made
    pieces) as the fallback for a household without a runtime.
  - **Done** means: with the runtime installed, no piece's own list is consulted. Core's grant check runs first, and a
    piece sees only granted calls.
- **Relay pairing,** as above.
- **Secrets:** the runtime says *where* a secret lands in a house (the repo's house description). The secrets piece
  decides *whether* an agent may have it, through its own `run` path: `may <agent> <name>` answers allowed, denied or
  ask. Without a secrets piece, no secret reaches a house. Box's own map of which agent gets which secret goes, and so does reading
  secrets with an environment flag. This changes runtime.md's "The control plane still decides which secrets an
  agent's houses get". The rest of runtime.md's credential rules stand.

### 7. The review job

conversations.md's daily review (grading, then introspection) runs here, because it runs models. The runtime holds the
timer and reads its config from core.

## The sources

**Venue adapters** are thin pieces, `loom-discord` and `loom-slack`. Each holds its platform connections (one bot per
agent per platform, as bridges.md decided) and routes a platform message to an agent (DM, mention, the channel's
primary). It then calls the runtime's `deliver`, renders its venue for core, and posts what the runtime hands it.
Removing one leaves every conversation in core.

**The clock** keeps scheduling: self-set wakes, recurring schedules, the household's lanes. When one is due it
delivers to the agent on venue `wake`. Starting a body, model choice and relay leave it.

**The now board** (live state: who's talking, who's waiting) is the runtime's own state, shown on its page. Today an
agent-specific piece outside loom's catalog (`loom-now`) receives the bridges' board writes; that piece goes. loom's
own Inbox page is unaffected.

## Seams this needs from core

These are core changes this doc depends on, each small:

1. **Remote pieces.** When `LOOM_URL` is set and the piece isn't installed locally, `loom <piece> …` sends
   `POST /api/<piece>/run` `{argv}` with the house's token (`LOOM_TOKEN_FILE`). It answers `{body: {exit, stdout, stderr}}` within extensions.md's limits (15 s, 8 MB). Core's own verbs already reach a remote loom this way, through `POST /cli` in
   `src/cli/remote.ts`. `run` becomes a documented standard path in extensions.md "The API", answered by any piece
   that wants remote use. The forwarding code that goes: the in-house forwarding in the clock, approvals and the bridges
   piece's gates, and any agent's own forwarding script.
2. **Offers.** A managed piece declares in its `loom` block what it offers through core. These are sibling keys in
   the `loom` block, each with its own schema: projects.md's `sections`, conversations.md's `venues`, and two more
   here. They share one runner (the section-feed runner) and one install-time validation path:
   - `mcp_tools`: up to 8 tools core adds to an agent's MCP session. They have their own limits, not the section feed's:
     120 s, an answer of `{text ≤ 64 KB, isError?}`. A long job (`house`) answers at once with the id of what it
     started. Each has a name, a description and a JSON
     schema, plus the argv that runs it with the arguments on stdin. Core calls it as the session's agent. The
     runtime offers `relay` and `house`. A name another piece or core already uses is refused at install.
   - `grants`: the runtime is the authority core asks before running a piece call for an agent.
3. **A `runtime` role:** the token role conversations.md defines.

## What moves where

| From | What | To |
|---|---|---|
| loom-box | boxes, houses, credentials | runtime (the same code, renamed `loom-runtime`) |
| shuttle | subscriptions, sign-in, runners, spawn, model resolver, gates, relay queue, now board | runtime |
| shuttle | the Discord adapter, the Slack adapter | `loom-discord`, `loom-slack` |
| shuttle | the conversation store, and the digests feed (projects.md's `piece:shuttle` section) | core (conversations.md; its `conversations` section replaces the feed) |
| shuttle | gates and identities (its owner-written collection) | the runtime's owner-written collection. The owner runs `loom shuttle gates export --json | loom runtime gates import`: each piece touches only its own store, as piece-storage.md requires |
| clock | session command, model, relay, approval-spending for relays | runtime |
| core | relay pairing in household.json (`relayOf`/`setRelay` in `src/household.ts`); the HTTP server's relay function that finds the clock by name (`src/transport/http-server.ts`) | runtime; the `mcp_tools` offer |
| each piece | its own agent list | the runtime's grants |
| box | which secret goes to which agent | the secrets piece's policy |

If anything of shuttle is left once this is done, it's named `loom-shuttle` (the owner, 2026-11-02).

## Order

1. **Core seams:** remote pieces, offers (with `sections`, `venues` and `mcp_tools`), and the `runtime` role.
2. **Conversations in core** (conversations.md, first slice).
3. **The runtime** (loom-box renamed):
   - model accounts and runners move in, then delivery;
   - the clock and the bridges piece switch to `deliver`;
   - relay moves.
4. **The adapters:** `loom-discord` and `loom-slack` split out of the bridges piece. Each adapter runs in shadow beside
   the old bridge for 24 hours: it receives and routes, records nothing, and posts nothing. Agreement is checked like this:
   - The adapter logs `(platform message id, agent, place)` for each message it would deliver. The old bridge logs the
     same from its routing.
   - A comparison script, part of the adapter's repo, matches the two logs by message id.
   - The adapter switches over when every message in the window has the same agent and place in both (at least 20
     messages; else the window extends).
5. **Permissions:** grants replace the per-piece lists, and secrets takes over the grant.
6. **The review job.**

Each step leaves a working household. A step that can't is split until it can.

## What the tests must pin

1. **One way to start a body.**
   - With the runtime installed, a delivery from a test source and a relay starts a body through the runner interface,
     observed with a fake runner.
   - In each source's own repo (loom-discord, loom-slack, loom-clock), a test fails if the source's code names a
     harness binary or a session command. Sources only call `deliver`.
2. **Delivery records first, and once.** A delivered message writes its turn to core before any body sees it. With the body
   failing to start, the turn is still recorded and the answer is `body: "failed"`. A repeated `(source, id)` within
   24h writes no second turn.
3. **Capacity and continuity** (from bridges.md, now the runtime's):
   - the same key reaches the same conversation's body;
   - capacity counts busy bodies;
   - over the limit, a new conversation takes a warm idle body's place;
   - only busy bodies make a message wait;
   - a resumed body restores its slot.

   DM/mention routing and per-bot de-duplication are the adapters' (their own suites).
4. **Model choice:** given two models of which one has no quota left, the resolver picks the other. Given two models
   with quota, and a scorecard giving one a `graded` value at least 1.0 lower for a venue kind, the resolver picks the
   higher one for that kind. Venue kinds are conversations.md's: `live`, `scheduled`, `agent`.
5. **Grants:**
   - with the runtime offering grants, a piece call for an agent without the grant is refused by core before the
     piece runs;
   - with the grant, it runs;
   - with no piece offering grants, the piece decides as today;
   - a second piece offering grants is refused at install;
   - owner calls work in all three cases.
6. **Relay:**
   - an unpaired relay is refused unless it carries an allowed approval from the approvals piece. With no approvals
     piece installed, it's refused;
   - a paired one delivers;
   - the `relay` tool appears in an agent's MCP session only when the runtime offers it.
7. **Removing an adapter** leaves its conversations listed in core.
8. **Remote pieces:** with `LOOM_URL` set and no local piece, `loom <piece> list` posts `{argv: ["list"]}` to
   `/api/<piece>/run` with the token file's token, and returns the answer's stdout and exit code. This is tested in core
   against a stub piece.
9. **Gates migration:** a test export from a stub shuttle, imported, gives the runtime's collection entry for entry.
   The import refuses anything but an owner's run, and never reads another piece's store.

## Open questions

- **Is the clock a source or part of the runtime?** It's a source here because "at a time, knock" is a source's job,
  and a household could replace it. If it never is, it could fold in.
- **The board's page:** the runtime's own tab, or core's Home? It shows live state, which is the runtime's.

## Sources

The owner's rulings above come from a conversation with the agent on 2026-11-02. The boundary review (one by the
agent, one independent, with every claim spot-checked in code) is recorded in the agent's operations repo. Both are
provenance only.

## Review gate

Before this doc merges, a context-stripped reviewer reviews it, and every finding is folded, accepted as a trade-off,
or rejected with a quote.
