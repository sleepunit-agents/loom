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
- **"Core knows neither"** still holds for *names*: core never names the runtime or a source. Core does know the
  generic offers mechanism (below), through which the runtime offers grants and tools.

**Words.** A **body** here is the agent itself in one conversation: it loads identity and writes the agent's memory
and digests. A runtime body is not CONTEXT.md's *Worker body*, which serves the agent without being it. CONTEXT.md
gains "Body: the agent running in one conversation (a session in a house)".

## What the runtime holds

### 1. Boxes and houses (from runtime.md)

Enrollment, primaries, vacation homes, box and house credentials, and "a box only ever runs containers" all stand as
runtime.md decided them, except who decides secret grants (section 6). The piece that built them (loom-box) becomes the runtime piece.

### 2. Model accounts (from subscriptions)

The household's model accounts move here: sign-ins, credentials, usage, and issuing a credential into a house
(`sub:<provider>`, which box already uses). The runtime keeps a **model list**: each model it can run, its harness,
and its **family** (its provider: `anthropic`, `openai`, …). Grading reads the families (conversations.md, Review).

### 3. Runners

One runner interface over the harnesses, Claude Code and Codex today: start a body with a brief, feed it a message
mid-turn where the harness allows, resume a session from its slot, end it. The clock's session command and shuttle's
runners both go. Whoever needs a body asks the runtime for one.

### 4. Model choice

One resolver picks the model for a body. Its inputs:
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

**The `deliver` contract.** `POST /api/runtime/deliver`, called with the source's piece token. The fields:
- `agent`, `venue` and `place` together are conversations.md's key (agent · venue · place);
- `from` is conversations.md's typed `from`;
- `text` is the message (≤ 40,000 chars);
- `label` is optional.

The runtime:
1. writes the turn to core (`POST /api/loom/conversations/turn`) and its text to core's audit log (conversations.md,
   "The audit log");
2. answers `{conversation, seq, body: "fed" | "resumed" | "started" | "queued"}`;
3. reaches the body.

If step 1 fails, nothing reaches a body and the source gets the error. If step 3 fails, the turn stands and the answer
says why.

Where it comes from:
- **Inbound:**
  - a Slack or Discord message, from a venue adapter;
  - "it's 03:13, run the knowledge lane", from the clock;
  - another agent's relay, from the runtime itself.
- **Outbound:** an agent's reply, or a message it starts. The runtime runs the venue adapter's declared `send`
  (conversations.md's venue declaration gains `send`: an argv like `render`'s, given `--place <place>` and the text on
  stdin), and records the agent's turn.
- **Bodies, capacity and continuity:** as bridges.md has them. Warm houses with sessions as bodies, capacity counted in
  busy bodies, a new conversation taking a warm idle body's place, and continuity through slots with a summary
  handoff. The difference is that bridges.md's "shuttle service" is now the runtime, and the conversation record is
  core's.
- **Agent-to-agent relay** is delivery whose `from` is an agent, on the venue `relay` the runtime declares. Pairing
  rules (who may relay to whom) move out of household.json into the runtime's permissions. The `relay` MCP tool
  becomes an offer the runtime makes (below), so core no longer names a piece.

### 6. Permissions

Who may do what, in one place:

- **Gates** (from bridges.md, "Who someone is"): who a platform id is, and what each person may do with each agent
  (tiers, grants, restricts). They're kept in the runtime's owner-written collection.
- **Agent grants:** which agents may use which pieces. These replace each piece's own environment list. Today those
  are `TASKSTORE_AGENTS` (taskstore, `src/loom-api.ts`) and `WAKE_AGENTS` (the clock), plus the agent lists in the
  approvals, machine and packages pieces. The step is done when no installed piece reads its own agent list. Core
  enforces a grant before a piece call:
  - with exactly one installed piece offering `grants` (the runtime), core asks it;
  - with none, core does what it does today: the piece decides, by its own list;
  - with two, the install of the second is refused.
- **Relay pairing,** as above.
- **Secrets:** the runtime says *where* a secret lands in a house (the repo's house description). The secrets piece
  decides *whether* an agent may have it. Box's own map of which agent gets which secret goes, and so does reading
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
   `POST /api/<piece>/run` `{argv}` with the house's token (`LOOM_TOKEN_FILE`). It answers with the piece's stdout,
   stderr and exit code. Core's own verbs already reach a remote loom this way, through `POST /cli` in
   `src/cli/remote.ts`. `run` becomes a documented standard path in extensions.md "The API", answered by any piece
   that wants remote use. The forwarding code that goes: Art's `bin/piece-call` and the in-house forwarding in the
   clock, approvals and the bridges piece's gates.
2. **Offers.** A managed piece declares in its `loom` block what it offers through core. These are sibling keys in
   the `loom` block, each with its own schema: projects.md's `sections`, conversations.md's `venues`, and two more
   here. They share one runner (the section-feed runner) and one install-time validation path:
   - `mcp_tools`: up to 8 tools core adds to an agent's MCP session. Each has a name, a description and a JSON
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
| shuttle | gates and identities (its owner-written collection) | the runtime's owner-written collection, copied by a one-time migration the runtime runs on install, reading shuttle's store through loom's piece-store API as the owner |
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
   the old bridge for 24 hours: it receives and routes, records nothing, and posts nothing. It switches over when its
   routing agreed with the old bridge's on every message in that window (at least 20 messages, else the window
   extends).
5. **Permissions:** grants replace the per-piece lists, and secrets takes over the grant.
6. **The review job.**

Each step leaves a working household. A step that can't is split until it can.

## What the tests must pin

1. **One way to start a body.** With the runtime installed, a delivery from each of a test adapter, a test clock and a
   relay starts a body through the runner interface, which is observed with a fake runner. The test adapter and test
   clock have no code that starts a session; they only call `deliver`.
2. **Delivery records first.** A delivered message writes its turn to core before any body sees it. With the body
   failing to start, the turn is still recorded and the source gets an error.
3. **Capacity and continuity:** bridges.md's "What the tests must pin" bullets 1–4 (the same key reaches the same
   conversation, which is now conversations.md's; capacity counts busy bodies; a new conversation over the limit takes
   an idle body's place; continuity through slots) move to the runtime's suite. Its gates and migration bullets are
   replaced by tests 5 and 9 here.
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
9. **Gates migration:** after install, the runtime's gates collection equals shuttle's, entry for entry, and shuttle's
   is untouched.

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
