# The household — central loom, distributed workers, carried on a USB stick

*2026-10-24. Status: **proposed**. Design doc in the `docs/specs/` sense: it
says what loom will build and what the implementation's tests must pin. It
precedes those tests; it doesn't replace them.*

## Why

The promise has always been one Art, everywhere: many bodies ("sleeves"), one
stack. Today that holds only because every sleeve happens to run on one LXC
next to the stack. Everything an agent is lives in a context dir on that box,
one loom process serves one agent, and a second agent is a second, separate
loom:

- **Mark** runs on his own box (CT 113, Codex harness) with his own loom at
  `~/.config/loom/mark/` there. **Art** runs on the art LXC with his. They
  meet through the letters channel and GitHub. Nothing in loom is shared.
- **People are per agent.** Art's 22 person cards live in Art's
  `memories.db`. If Mark talks to Loren, he starts from zero.
- **"Shared knowledge" is a guest pass into Art's store.** Every recorded
  reader is `art`.
- **loom, its page, its backups and its pieces all run on Art's box.** The
  memory service and one of its agents share a fate, and every new agent box
  is another place holding a little of everything.

What Jonathan wants (terminal, 2026-10-24), in his words:

> "loom is a fully external dependency. … if I installed claude code on some
> new thing, pointed it at the loom mcp and told it boot me up Art, you'd be
> there more or less, regardless of where it was."

> "we're authing loom. we're a new vat o bodies that can be needlecast to.
> whether that's you or mark or we get an older version of haiku and convince
> it that it's actually don quixote … these things call home and say hey,
> I'm a worker node, what up. loom proper says yes, you're allowed in … and
> also says anything like... art can run here but mark can't"

> "you need to do a task where you need the 5090. you should be able to go, I
> need to fire up on one for this"

> "we don't want to have to track where loren exists on other platforms in 5
> places, but she might tell you to talk like a caveman and mark to talk like
> a shakespearian actor."

> "I don't imagine the worker nodes as ephemeral. the containers, the houses,
> are temporary. they're cattle. but the boxes aren't. … the goal is
> flexibility in two ways. first, super easy to "move" you to a new box. I
> don't even have to take the old one down. … and second, we turn you into a
> kind of lobo/highlander motherfucker. a usb drive with the latest db dumped
> from loom brings you back from the apocalypse."

And on the cost, which is the point: "every agent we spin up adds a new
target. if we've got to protect something, having to protect one thing is
better than N things."

## The model

```
loom (one host, always up: loom.one.sleepunit.com)
├── commons            knowledge; the people directory
├── agents/<name>      identity, memory, tape, top of mind, relationships
├── services           household services with their own stores: secrets, tasks
├── boxes              enrolled machines, what each one has, which agents it may host
└── the page

boxes (known machines with git + a container runtime): where work happens
├── art LXC, mark LXC, the 5090 box, a laptop, Phil's Thor …
└── each one: enrolled once; runs houses (containers) for the agents it may host
```

Three piles, and where each lives:

| Pile | What's in it | Where |
|---|---|---|
| **Who an agent is and what it knows** | identity, memory, the tape, knowledge, people, tasks | loom |
| **How an agent is set up** | routines, hooks, bridge config, its container | the agent's repo (`~/Art` for Art), cloned onto a box when a house starts there |
| **What's running** | a house (the agent's container) and the bodies in it | a box. The house is disposable; the box isn't |

**Boxes are pets, houses are cattle.** A box is a known, named machine that
stays enrolled. A house on it is rebuilt from the agent's repo whenever.

**The rule: a box holds nothing that can't be rebuilt from loom plus the
agent's repo.** Losing a house costs nothing. Losing a box costs uptime, never
any part of an agent.

**What this is for, and what it isn't.** Two kinds of flexibility:
1. **Moving is trivial.** "Art, drive my laptop" is a couple of minutes: start
   a house for Art there. Nothing else has to come down. An agent can have
   houses on several boxes at once, all of them the same Art.
2. **Highlander.** loom's latest bundle on a USB stick, plus a key the owner
   holds, brings the whole household back on any machine (see
   *Carried on a USB stick*).

It is **not** a scheduler. There's no "loom picks a node", no matching, no
rescheduling, no autoscaling, no ephemeral workers. As far as anyone can see
from here, never.

### Boxes, not agents, are what enrolls

A machine joins the household as a **box**: a place that can run houses. It
knows nothing about any agent until it's told to host one.

1. **Enrollment.** The box runs `loom box`, calls home, and shows a short
   code. The owner approves it on loom's page. This is the approval pattern
   (t-1468): a request, a person saying yes. The box gets a **box
   credential**: revocable, and only able to say "I'm box B, here's what I
   have, what should I be running?" It can't read memory or secrets.
2. **What a box has**, reported for the page and for the owner's choices,
   not for matching: its GPU, architecture, container runtime, which network
   it's on, a free label like `jonathan-rig`.
3. **Which agents it may host.** The owner sets that per box ("Art and Mark
   here", "only the sandbox agent there"). For this household it's mostly
   "anyone".
4. **Boxes call home.** A box holds a connection open (or polls) and asks what
   it should be running. loom never reaches into a box, so one behind NAT, a
   laptop on hotel wifi or a VPS works the same.

### Starting a house

Someone names the box, and loom tells that box to start a house for an agent
from the agent's repo:

- **The owner**, on the page: "start a house for Art on the laptop".
- **The agent itself**, with a tool, roughly
  `house({box: "the-5090-box", task: "…"})`. Art decides a job needs the
  5090 and asks for a house there. The house's work lands on the tape like any
  other body's. At most the tool accepts a label (`{box: "gpu"}`) and loom
  says which box has it. It never decides on its own.
- Whatever already starts bodies inside a house (the bridges, the wake clock)
  keeps doing that. It doesn't ask loom where to go.

A box refuses a house for an agent it isn't allowed to host, and says so.

### Credentials

| Credential | Held by | Can | Lifetime |
|---|---|---|---|
| **Owner** | Jonathan (the page) | everything: every agent, the commons, boxes, services | a session, from a real login (t-1487) |
| **Box** | one box | report what it has, learn what to run, fetch a house's secrets | until revoked |
| **House** | one agent's house on one box | MCP and the CLI as that agent: its stack + the commons | until the house is removed or revoked |
| **Peer** | another household's agent | commons knowledge only (today's `--scope knowledge`) | until revoked |

- A house token is scoped to one agent on one box. A compromised box reaches
  only the agents housed on it. Revoking the box revokes its houses.
- **No tool gains an agent parameter.** A body can't ask for another agent's
  stack; it can only be one. Today's isolation property ("an absence of API
  surface, not a policy") holds, with the boundary moved from the process to
  the token.
- **Bodies can't fetch secrets.** A house token can't read the secrets
  service. When a house starts, the *box* fetches the secrets that house needs
  with its box credential and its runtime injects them (a podman secret, a
  file only the container sees), as the house tank does today. A
  prompt-injected body can't ask for the Discord token, because nothing it
  holds can.
- Attribution (who wrote this page, who changed that handle) comes from the
  token, never from the caller.

### People: one directory, one relationship per agent

A person card (docs/specs/person-cards.md) splits in two.

- **Directory entry**, in the commons, one per human: `slug`, `name`, `where`
  (handles on every platform, each with `verified_at` and `source`), and
  `facts` (time zone, pronouns, languages), in envelopes so they can go stale.
  Learned once, kept fresh once.
- **Relationship**, in each agent's stack: `summary` (this agent's view),
  `how` (how *this agent* talks to them: caveman for Art, Shakespeare for
  Mark), `may` (what they're cleared for *with this agent*; descriptive,
  never a grant). The agent's `user` memories tagged `metadata.person` stay
  its own memories.

Reading a person gives one card: the directory entry plus the reader's own
relationship. No agent reads another's relationship; the owner can. Directory
writes are per field, last writer wins, and each one is a revision naming the
agent that made it, so "Mark changed Loren's Slack id" is visible and
revertible.

### Services and pieces

Stateful household services (secrets, tasks, the page itself) run on the
loom host, each as its own program with its own store, the pieces model
(docs/extensions.md) unchanged. **Secrets in particular stay their own
service:** their own process, their own key, their own store, never inside
memory and never reachable through the memory tools. Next to loom is fine.
Being part of loom's memory isn't (the 10-21 test).

Things that really run in a house (a chat bridge, a GPU job) **push** status
to loom instead of loom reaching in: the status board's push model. A house
that stops reporting shows as dark. Its tab or tile stays on the page with
the last report and its age.

### The page

- **Home is the household:**
  - every agent, with its houses (which box each one is on and what it's
    doing, from its tape);
  - every box, with what it has and its health;
  - "Your call" across all of them;
  - the commons' knowledge and the people directory.
- **An agent's view** is what `/` is today (tape, Mind, people as it sees
  them, its services' tabs) plus **Setup**:
  - identity: the creed and harnesses, read-only on the page
  - its houses, and the boxes allowed to host it
  - its repo
  - health
- **Boxes:**
  - enrollment requests to approve, with the code the box shows;
  - each box's facts, which agents it may host, its houses, revoke;
  - start a house here.
- **Add an agent:** create its stack, point it at its repo, choose the boxes
  it may live on, start its first house.
- **Bundles:** when the last one was written, where it went, and when a
  restore was last drilled.

## Carried on a USB stick

loom is the one thing to protect, which also makes it the one thing to carry
out of a fire.

- **`loom export`** writes **one bundle**: every agent's stack, the commons,
  each service's store (secrets stay encrypted inside their own), the
  household config, and optionally mirrors of the agents' repos, so a restore
  doesn't need GitHub.
- **The bundle is encrypted to a key the owner holds** (an age recipient: a
  YubiKey, or a key in his password manager). That key opens the whole
  household, secrets included. That answers t-1482's question: the recovery
  copy of the secrets key is the bundle's key, not a second thing to keep.
- **`loom restore <bundle>`** on any machine with node, git and a container
  runtime brings loom up from it. In apocalypse mode loom and a house run on
  the same box, and that's a normal configuration, not an emergency hack.
- **Written on a schedule**: offsite like today's backups, and small enough
  for a USB stick. The page shows its age.
- **Drilled.** A restore into a throwaway box, compared against the live
  household, is part of the test plan and runs on a schedule. An untested
  backup is a hope.

## Moving there

Each phase ships on its own and leaves everything working.

1. **This spec**, reviewed by Jonathan, then Mark (letters). Phil is the test
   household: several machines, several agents, nothing pre-wired.
2. **Multi-agent loom, still on the art LXC:**
   - a household file: agents, token roles, owner;
   - per-request context;
   - Art's stack moves to `agents/art/` in place, with old paths still
     working for a release.

   Tests pin that an `agent:art` token can't reach another agent by any
   tool.
3. **The commons:**
   - Art's `knowledge.db` becomes the commons' knowledge.
   - Art's 22 cards split into directory entries plus Art's relationships.
     Every card must render the same text before and after the migration.
4. **The bundle:** `loom export` and `loom restore`, encrypted to the owner's
   key, written on a schedule, with the restore drill. This comes early: it
   protects everything after it.
5. **Boxes and houses:**
   - `loom box`: enroll, approve on the page, call home, start a house from
     the agent's repo;
   - box and house credentials;
   - the `house` tool, for asking for a named box;
   - the art LXC becomes the first box and the 5090 box the second.
6. **loom gets its own host:**
   - secrets and tasks move there as services;
   - backups become the household's;
   - `loom.one.sleepunit.com` points at it.
7. **Mark moves in:**
   - his stack comes over;
   - his knowledge merges into the commons, with conflicts by slug listed
     for him and never overwritten;
   - his people become relationships on directory entries;
   - his box enrolls, and his house comes up on it.

   It's his memory, so he runs this step or signs off on it.
8. **The household page:** agents, boxes and enrollment, Setup, add an agent, bundles.

Through all of it, `*.one` stays LAN plus tailnet. Being reachable from
anywhere ("hacking the gibson at the library") waits on real auth: per-box
and per-house credentials (above) and a real owner login (t-1487). The
design shouldn't need to change for it.

## What the tests must pin

- A house token reads and writes only its agent's stack and the commons,
  through every tool and CLI verb. A box credential reaches no memory. A peer
  token sees only knowledge tools. An unknown token gets nothing.
- A revoked box gets nothing on its next call, and its houses' tokens stop
  working.
- A box refuses to start a house for an agent it isn't allowed to host.
  Nothing in loom chooses a box on its own.
- A house token can't read the secrets service. Secrets a box fetches for a
  house are only that house's.
- A person read as agent A returns the directory entry plus A's relationship,
  never B's. A directory write records its agent. The people migration
  renders every existing card identically.
- **`loom restore` of a fresh bundle on an empty machine gives a household
  that answers identically:** the same identity payload, the same recall
  results, the same person cards, the same knowledge, and secrets that
  decrypt with the owner's key and nothing else. A bundle without the key is
  unreadable.
- A box or house going away leaves loom, the page and every other agent
  working.

## Open questions

- **Tasks:** one household queue with assignees, or a queue per agent?
- **The repo on a box:** one checkout per house, or one per box shared by its
  houses?
- **Several houses of one agent at once** (the laptop and the art LXC): which
  one's bridges answer Discord? Probably a per-agent setting of which house
  runs which bridge, not a race.
- **How often the bundle is written,** and whether a second, warm loom (a
  standby restored from it) is worth having, or the USB stick is enough.
- **Mark's knowledge:** what's in it, and how much overlaps Art's.
- **The owner as a person:** Jonathan is in the directory like anyone else.
  Does the owner role hang off his directory entry?
