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

When this doc was drawn, three pieces started agent sessions, each its own way:

- **The clock** started a session locally, or asked box for a house (`loom box up --task -`), and kept its own model
  setting.
- **The bridges piece (shuttle)** had its own runners (Claude, Codex), its own spawn logic, its own model resolver, and
  its own gates for who may do what.
- **Box** built and ran houses, and decided which credentials landed in them. For model credentials it asked the
  subscriptions code, which shipped inside the bridges piece. That broker is gone (section 2): no model credential is
  issued anywhere now.

There were three launchers, two model choosers and one credential source between them. They're checkable in the
pieces' repos as of 2026-11-02:
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

### 2. Model accounts

The household's model accounts live here, and **loom never handles a model login**: it never reads, stores, copies,
refreshes or issues a token, and never calls a provider's API. The subscriptions broker that did (its sign-ins, and
issuing a credential into a house as `sub:<provider>`) was deleted on 2026-11-02 (loom-box#49, shuttle#47). The
runtime's [docs/model-accounts.md](https://github.com/sleepunit-agents/loom-box/blob/main/docs/model-accounts.md) is
the source for all of this:

- **Each box signs its own CLI in.** A box runs the real `claude` and `codex`, logged in on that box with its owner's
  own subscription. **Log in** (Boxes, Model logins, or `loom runtime login <box> claude|codex`) runs the CLI's own
  login on that box, in a throwaway container, and the CLI keeps and refreshes its login in the box's login dir. Only
  the box's owner can start it.
- **Accounts are what the boxes report.** Each box asks the CLIs' own status commands whether they're installed and
  logged in, with the method and plan (and, for Claude, a short hash of the org and account, so boxes on one login
  share its quota). The runtime keys an account by the box's owner and that hash, so one owner's box never merges into
  another owner's account. Bodies and agent owners see a label, never the key.
- **Houses use their box's login.** A house whose house file names the harnesses it runs (`"harnesses": ["claude"]`)
  gets the box's login for those, mounted at `/run/loom/login/<harness>`, and no other. A box that isn't logged in
  doesn't start such a house.
- **Agents run only on boxes their owner owns.** An agent's houses and bodies run only on its owner's boxes, or on a
  box lent to it by name, which runs its work but never on the box owner's login. On its owner's box it gets only the
  logins the owner granted it (`loom box agent <agent> --logins`; by default a household owner's agents get both and
  another member's get none). The resolver (section 4) offers an account by exactly the rule a house's login is
  mounted by, and a box not seen for 10 minutes offers nothing.
- **Usage comes from run output.** A house reports how full its account's windows are, from its harness's own output:
  Claude Code's stream-json `rate_limit_event`, Codex's `token_count` events. It pipes them to
  `loom runtime usage report --harness claude|codex`, and only for a login it was given. Readings are clamped, and the
  resolver skips an account whose window is full.
- **An API key is a plain secret,** mapped into a house as `anthropic-api-key` or `openai-api-key`. It counts as an
  account for that agent on any box.

The runtime also keeps a **model list**: each model it can run, its harness, and its **family**. Families are fixed
strings: `anthropic`, `openai`, `google`, `mistral`, or `local:<name>` for a model the household runs itself. Grading
reads the families (conversations.md, Review).

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

**When an account runs out** (loom-box t-1907, Jonathan 2026-11-06: "I don't want slack bodies to stop responding as
Art if we hit 100%"). "Quota left" also means no **hold**. A hold is written when a provider refuses a body's turn for
a usage limit, read from the harness's structured error and never its words, and lasts until that limit's reset. A
window past its reset time has room again.
- A resume whose slot's harness has no room parks that slot as the conversation's home, and starts a fresh body on
  another harness, from the digests.
- The conversation goes home at its next run once that harness has room and the reset has passed.
- A refused turn runs once more elsewhere, never twice.
- When nothing has room, the conversation is answered plainly and the owner alerted.
- The owner gets one Inbox FYI per agent per switch, and one when it's back. The agent's card reads "Model: on Codex",
  and the comm screen's channel line reads `ON CODEX`.
- A deny list Codex can't keep (anything but whole MCP servers) keeps that body off Codex.

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
| `from`, `kind`, `at` | conversations.md's turn fields (`kind` is `message` or `wake`: a `note` is the agent's own turn, and comes only through its session) |
| `label` | optional |
| `text` | the message, ≤ 40,000 chars |
| `local` | optional, `true`: a wake that needs loom's own machine; its body runs there instead of in a house, when the runtime runs local bodies for that agent (else it refuses, `403`). Only on venue `wake` as a `wake`, so only from a piece that delivers on it (the clock), which sends it only for a wake set on loom's machine. Never inferred from the text |
| `source` | the calling piece's name: added by core when it forwards, never sent by the caller |

**Idempotent:** the same calling piece and `id` within 24 hours, whichever of the piece's credentials calls, returns
the first call's answer and writes nothing. The same pair with a different body is refused with `409`.
Core keeps a hash of the body, never its text.

**Who may deliver what.** Core checks before forwarding:
- the `venue` must be one the calling piece declares (`venues`). The runtime declares `relay`. `wake` is core's own
  venue, so a piece that delivers on it says so with an empty entry, `"wake": {}`, which references core's venue rather
  than defining one. The clock declares that. A `wake` delivery's `from` is `{kind: schedule}`;
- the `agent` must be one the calling piece is granted (section 6), checked like any piece call;
- `from: {kind: person, slug}` is accepted only from a venue adapter, and the runtime checks it against its gates:
  a platform id that resolves to no person becomes `{kind: unknown}`;
- `from: {kind: agent}` only comes from the runtime itself (a relay).

A delivery failing any check is refused with `403` and the reason, and writes nothing.

**Limits.** Core forwards under the `mcp_tools` limits (120 s, an answer ≤ 64 KB), in delivery's own pool (8 running,
32 waiting), apart from `mcp_tools`' and the page's. One calling piece has at most 2 forwards running and 4 waiting; past that it's refused with `503`, and other pieces aren't held
back. Core keeps at most 10,000 answers per piece in 24 hours; past that, `429`. The body is ≤ 256 KB (`413`). A
runtime that fails, or refuses the body, exits 1 with `{status: 4xx or 5xx, error}`, which core passes on with that status, unkept. Any other failure is a
`502`, and a timeout is a `504`. None of these is kept.

The runtime:
1. writes the turn and its audit text to core. It writes the turn with `key: "<source>:<id>"`
   (conversations.md, turn writes), so a retry after a lost answer finds the first turn instead of writing a second;
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
    on stdin, plus `--agent <agent>` so the adapter posts as that agent's own bot (bridges.md: one bot per agent per
    platform). An adapter without that agent's bot answers `{ok: false, reason}`;
  - it has 15 s, and answers `{ok, id?}`;
  - it's sent first, then the agent's turn is recorded with outcome `answered` (`failed` if `send` failed after one
    retry), and the body is told of a failure.
  - **As built** (loom-box `src/delivery.mjs`, t-1920): an adapter that refuses only because it's in shadow says
    `{ok: false, permanent: true, shadow: true}`. A body's `loom runtime send` waits for the post's outcome and
    answers `posted: true` only once the venue took it, never "accepted". A DM (`--person --via`) to a venue whose
    adapter answers `shadow` while its old bridge still posts there (Slack) goes to that bridge's relay, as the agent,
    and is answered `posted: false, relay`: on its way, not sent.
  - **Two more adapter calls, as built** (loom-box `src/delivery.mjs`, `src/policy.mjs`), on the same argv and
    limits. `send --describe` answers `{ok: true, guest?, peer?, venue?, readers?, notes?}`: the place's rules for
    the brief. It's asked before a body starts, and if it fails no body starts. `send --status working|done
    [--message <delivery id>]…` is sent with the delivery ids when messages reach a body, every 15 s while it's
    busy, and with `done` when its turn ends. It answers `{ok: true, stop?: true}`, and `stop: true` ends that body.
  - **A venue core adapts itself** (`loom`, [comms.md](comms.md)) has no bin. Its row in `GET /api/loom/venues`
    says `"adapter": "core"` instead of `send`. For it, the runtime makes the same three calls (post, describe,
    status) as `POST /api/loom/comms/adapter` `{op, place, agent, …}` with its own token. A switched body's post adds
    `on` (its harness, e.g. `"Codex"`; comms.md). They have the same limits,
    the same retry rule and the same answer shapes. A delivery on `loom` from core's own source `loom` comes only
    from one of the agent's owners, so the runtime takes its sender as tier 3 without reading the gates.
- **Activity, for `loom` conversations only** ([comms.md](comms.md), "Activity"). The runtime reads a body's own
  harness record (Claude's session transcript, Codex's `events.jsonl`) and turns each tool step into a plain card
  `{id, at, tool, summary ≤ 120, state}`, from a fixed table and never from a model. It never carries a tool's output, a
  file's contents, a command line or an environment value. The body host adds cards to its `body-sync` report, and the
  runtime posts them to `POST /api/loom/comms/activity`. No other venue's bodies are read this way.
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
  - **A gate entry names a person card.** Its key is the person's card slug (person-cards.md), and the card is where
    that person is one person: the People page, the room block and every agent read it there. The gate holds only
    what gates (tier, grants, restricts), which a card never carries (its reserved keys).
  - **Adding one ensures the card,** through the same seam the bridges piece uses today: `POST /api/loom/people/ensure`
    with the runtime's token (person-cards.md, "Ensure"). With no card, a minimal one is made (the name, the role and
    where the entry came from, its platform ids); with one, only the ids it lacks are added. A gate write stands even
    when the ensure fails, and the owner's answer says the card wasn't made and why.
  - **A card merge is followed by the gates** (t-1746). `POST /api/loom/people/merge` with the runtime's token makes
    two cards one (person-cards.md, "Merge"): the old slug is a redirect to the survivor. loom doesn't hold the
    gates, so after a merge the runtime renames the old slug to the survivor in every agent's gates, as shuttle's
    people-merge owner action does for one agent's list today.
- **Agent grants:** which agents may use which pieces.
  - **Who decides.** With one installed piece offering `grants` (the runtime), core asks it before any call an agent
    makes to a piece: `/api/<piece>/…`, `/api/<piece>/run`, and an offered MCP tool. Running a piece's binary
    directly inside a house isn't a call through loom, and isn't covered.
  - **Without a grants authority,** each piece decides by its own agent list, as today. A second piece offering grants
    is refused at install.
  - **Pieces keep their lists** (taskstore's `TASKSTORE_AGENTS`, the clock's `WAKE_AGENTS`, and the lists in agent-made
    pieces) as the fallback for a household without a runtime.
  - **Done** means: with the runtime installed, no piece's own list is consulted. Core's grant check runs first, and a
    piece sees only granted calls. Core tells it so: an agent caller the authority allowed carries `granted: true`
    (extensions.md, "The API"), and a piece with its own list skips that list for such a caller (t-1971).
  - **Asked for, and given on a Yes** (t-1970). An agent that needs a piece (its own, or another agent's request it
    passes on) never grants it and never asks the owner to go and do it: it files a `grant` approval (approvals piece,
    target `<piece>:<agent>[:<path>,<path>]`) and its Needs you waits on it, so Allow and Deny sit on the ask. Right
    after a household owner's Allow on a `grant`, core reads the approval's agent and target from the approvals piece
    (`state`, never the form) and posts `grant-approved` to the grants authority as that owner. The authority spends
    the approval (allowed, for exactly that target, once) and only then adds the agent to that piece's grant, keeping
    everyone else's. Deny records no and nothing else. A member who owns some agents can't answer one (approvals
    refuses it, and the authority refuses a non-owner's call); a body can't spend one (only the authority does).
    Without grants yet, nothing is written: every agent may already use every piece.
  - **Whose work it is, asked the same way** (t-1975; Jonathan, 2026-11-08: "It needs to have the site ask me"). The
    two owner-only actions that were typed at a terminal on loom's machine are asked on loom's page too, and applied on
    his Allow: a `vouch-wake` (target `<agent>:<w-id>,…`: 1 to 12 wake ids, each `w-` and 6 hex as the clock mints
    them, sorted and each once, so one set has one text; the approvals piece refuses any other, filed by the clock: "Count these 5 scheduled jobs as your
    work?", core posts `vouch-approved` to the piece with role `clock`) and a `principal-reset` (target
    `<agent>:<cv>` with `cv-` and 12 hex, filed by the runtime: "Count this conversation as your work from now on?", core posts
    `reset-approved` to the delivery piece). As for a grant: read back from the approvals piece, only the household
    owner's Allow, the piece spends the approval for exactly its target and only then applies it, Deny records no.
    The card shows exactly what Allow does, resolved by the filing piece, never only an agent's words: a vouch-wake's
    details list each wake (its id, when it fires, its note and the start of what it runs), a principal-reset's name the
    conversation (its label and id) and list each waiting message it counts; the approvals piece refuses a card whose
    details leave one out. The clock files a vouch-wake by itself only for unknown wakes set from a house of the agent
    whose body sent no principal statement (no evidence of anyone else), one card per agent at a time (a new candidate
    withdraws the waiting card and files one with the whole list; a No is never asked again); a body that knows asks with
    `wake ask-vouch`. More than 12: the first 12 on one card, the rest on the next once it's answered.
    The approvals piece marks these cards `lead` (as a grant's), so an Allow core can't read back is never a quiet
    "Allowed"; core also refuses a target that isn't the asking agent's own wakes or conversation, or is malformed,
    and a reset for a conversation core has on record as another agent's. The applying piece checks the same on its
    side before it spends: the clock that the wakes are that agent's clock's, the runtime that the conversation is that
    agent's and still asked about by exactly that card.
    Nothing an owner decides is a command for him to type: a body files the approval (or the piece does), never hands
    him a command. `wake vouch` and `loom runtime principal --reset` at a terminal stay as the fallback.
  - **Where to see them.** The authority's page `permissions` is the household owner's Permissions app (the launcher's
    System section), and `permissions/<agent>` is one agent's, linked from its window as "What <Agent> can use".
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
   - `delivery`: an argv. Core runs it with the `deliver` body on stdin, under the `mcp_tools` limits below, and passes
     its answer back. Only a piece whose `loom` block role is `runtime` may declare it, and only one installed piece
     may.
   - `mcp_tools`: up to 8 tools core adds to an agent's MCP session. They have their own limits, not the section feed's:
     120 s, an answer of `{text ≤ 64 KB, isError?}`. A long job (`house`) answers at once with the id of what it
     started. Each has a name, a description and a JSON
     schema, plus the argv that runs it with the arguments on stdin. Core calls it as the session's agent. The
     runtime offers `relay` and `house`. A name another piece or core already uses is refused at install.
   - `grants`: an argv. Core runs it with `{agent, piece, path}` on stdin before an agent's call to a piece, with 2 s to
     answer `{allow: true}` or `{allow: false, reason}`.
     - **Fail closed:** when the authority times out, errors, or is uninstalled while a call is in flight, the call is
       refused with `503` and the reason. Owner calls never ask it.
     - **Fallback:** a household with no authority installed uses each piece's own list, as section 6 says.
     - **Reuse:** an authority that declares `grants_store` (the collection of its own store its answer rests on) is
       asked with `basis: true` and names whose store and collection it read, the document it decided on and its sha256; core keeps the answer only for
       exactly that state of the collection, read from the store itself, and any write to it is a new ask at once
       (docs/extensions.md, `grants_store`).
3. **A `runtime` role:** the token role conversations.md defines.

## What moves where

| From | What | To |
|---|---|---|
| loom-box | boxes, houses, box and house credentials | runtime (the same code, renamed `loom-runtime`) |
| shuttle | subscriptions: the broker, its sign-in pages, issuing a credential into a house (`sub:<provider>`) | nowhere: deleted (2026-11-02, shuttle#47, loom-box#49). Each box signs its own CLI in, and accounts are what the boxes report (section 2) |
| shuttle | runners, spawn, model resolver, gates, relay queue, now board | runtime |
| shuttle | the Discord adapter, the Slack adapter | `loom-discord`, `loom-slack` |
| shuttle | the conversation store, and the digests feed (projects.md's `piece:shuttle` section) | core (conversations.md; its `conversations` section replaces the feed) |
| shuttle | gates and identities (its owner-written collection) | the runtime's owner-written collection. The owner runs `loom shuttle gates export --json | loom runtime gates import`: each piece touches only its own store, as piece-storage.md requires |
| clock | session command, model, relay, approval-spending for relays | runtime |
| core | relay pairing in household.json (`relayOf`/`setRelay` in `src/household.ts`); the HTTP server's relay function that finds the clock by name (`src/transport/http-server.ts`) | runtime; the `mcp_tools` offer |
| each piece | its own agent list | the runtime's grants |
| box | which secret goes to which agent | the secrets piece's policy |

If anything of shuttle is left once this is done, it's named `loom-shuttle` (the owner, 2026-11-02).

## Order

Each step leaves a working household, and each has its own "done".

1. **Core seams:** remote pieces, offers (`sections`, `venues`, `mcp_tools`, `delivery`, `grants`), and the `runtime`
   and `review` roles. **Done:** each merged with its tests, and a stub piece in core's suite declares every offer key
   and is installed, refused and run as the specs say.
2. **Conversations in core** (conversations.md, first slice). **Done:** its criteria 1–5 and 11–15 pass, and a
   harness `session` writes turns and a digest on loom's machine.
3. **The runtime** (loom-box renamed), in this order:
   - model accounts and runners move in;
   - delivery is added;
   - the clock and the bridges piece switch to `deliver`;
   - relay moves.

   **Done:** tests 1–6 and 8 pass in the runtime's suite. For a week of real traffic, every wake and every bridge
   message reaches a body through `deliver`. No session is started by the clock's or the bridges piece's own code
   (their spawn code is deleted).
4. **The adapters:** `loom-discord` and `loom-slack` split out of the bridges piece. Each adapter runs in shadow beside
   the old bridge for 24 hours: it receives and routes, records nothing, and posts nothing. Agreement is checked
   like this:
   - The adapter logs `(platform message id, agent, place)` for each message it would deliver. The old bridge logs the
     same from its routing.
   - A comparison script, part of the adapter's repo, matches the two logs by message id.
   - The adapter switches over when every message in the window has the same agent and place in both (at least 20
     messages; else the window extends).

   **Done:** both adapters switched, and the old bridges' units removed.
5. **Permissions:** grants, the gates import, and secrets' `may`. **Done:** section 6's "Done" holds, test 5 and test 9
   pass, and box no longer reads secrets with an environment flag.
6. **The review job.** **Done:** a daily run takes audit entries, posts scores and findings, marks them done, and the
   7-day sweep finds nothing older on a normal day.

## What the tests must pin

1. **One way to start a body.**
   - With the runtime installed, a delivery from a test source and a relay starts a body through the runner interface,
     observed with a fake runner.
   - In each source's own repo (loom-discord, loom-slack, loom-clock), a test fails if the source's code names a
     harness binary or a session command. Sources only call `deliver`.
2. **Delivery records first, and once.** A delivered message writes its turn to core before any body sees it. With the body
   failing to start, the turn is still recorded and the answer is `body: "failed"`. A repeated `(calling piece, id)`
   within 24h writes no second turn; the same pair with a different body is refused with `409`.
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

Quota-blocked failed delivery replies may include `code: "quota"` and `retryAfter`
(an ISO UTC timestamp, milliseconds and Z) for the earliest known reset. Core validates
and preserves these fields. The clock waits for that reset without incrementing its
job failure count; absent a reset it waits an hour. Successful replies carry neither.
