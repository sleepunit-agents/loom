# The household — central loom, distributed workers

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

And on the cost, which is the point: "every agent we spin up adds a new
target. if we've got to protect something, having to protect one thing is
better than N things."

## The model

```
loom (one host, always up: loom.one.sleepunit.com)
├── commons            knowledge; the people directory
├── agents/<name>      identity, memory, tape, top of mind, relationships
├── services           household services with their own stores: secrets, tasks
├── nodes              enrolled workers and what each one has
└── the page

nodes (any machine with git + a container runtime): where work happens
├── art LXC, mark LXC, the 5090 box, a laptop, Phil's Thor …
└── each one: a node credential, and sleeves loom placed there
```

Three piles, and where each lives:

| Pile | What's in it | Where |
|---|---|---|
| **Who an agent is and what it knows** | identity, memory, the tape, knowledge, people, tasks | loom |
| **How an agent is set up** | routines, hooks, bridge config, its container | the agent's repo (`~/Art` for Art), cloned onto a node when a sleeve needs it |
| **What's running** | bodies, bridges, a GPU job | a node. Disposable |

**The rule: a node holds nothing that can't be rebuilt from loom plus the
agent's repo.** Losing a node costs uptime, never any part of an agent.

### Nodes, not agents, are what enrolls

A machine joins the household as a **node**: a vat that can host bodies. It
knows nothing about any agent until loom places one there.

1. **Enrollment.** A node starts `loom node`, calls home, and shows a short
   code. The owner approves it on loom's page. This is the approval pattern
   (t-1468): a request, a person saying yes. The node gets a **node
   credential**: long-lived, revocable, and only able to say "I'm node N,
   here's what I have, anything for me?" It can't read memory or secrets.
2. **What a node has.** It advertises facts loom can match on: `gpu:5090`,
   `arch:arm64`, `runtime:podman`, `net:lan-192.168.4.0/22`, `site:home`, a
   free label like `jonathan-rig`. Measured where possible (it reports the GPU
   it finds), declared where not.
3. **Nodes pull.** A node holds a connection open (or polls) and asks for
   work. loom never reaches into a node, so a node behind NAT, on a laptop or
   on a VPS works the same.

### Placement: which agent may run where

Each agent declares what it needs and any hard rules; loom answers yes or no.

- **Needs:** "a GPU with 24 GB", "podman", "the pond LAN".
- **Rules:** "Mark never on the work box", "this agent only on the sandbox
  node".
- **A placement request** names an agent, optional extra needs, and why. loom
  picks an enrolled, healthy node that has the needs and is allowed to host
  that agent, or says why not.

For this household the answer is almost always "anyone, anywhere". The rules
exist for the general case: Phil's house (a G14, a Mac Studio, a Thor, each
with its own agent), an agent that needs one particular machine, a guest
agent kept on one node.

**Who asks:**
- whatever already starts bodies (the bridges when a conversation lands, the
  wake clock when a routine fires): "where can Art run right now?"
- **the agent itself.** A tool, roughly
  `sleeve({needs: ["gpu:5090"], task: "…"})`. Art decides a job needs the
  5090; loom places a sleeve of Art on a node that has one, hands it the
  task, and the sleeve's work lands on the tape like any other body's.

**Not Kubernetes.** The first version is nodes, their facts, the agents'
needs and rules, and a yes or no. No bin-packing, no autoscaling, no
rescheduling. If we ever need more, that's its own decision.

### Credentials

| Credential | Held by | Can | Lifetime |
|---|---|---|---|
| **Owner** | Jonathan (the page) | everything: every agent, the commons, nodes, services | a session, from a real login (t-1487) |
| **Node** | one node | enroll facts, pull work, report status | until revoked |
| **Sleeve** | one body | MCP and the CLI as one agent: its stack + the commons | minted per placement, dies with the sleeve |
| **Peer** | another household's agent | commons knowledge only (today's `--scope knowledge`) | until revoked |

- A sleeve token is scoped to one agent and one node. A compromised node can
  reach only the agents sleeved on it, and only while they're there.
- **No tool gains an agent parameter.** A body can't ask for another agent's
  stack; it can only be one. Today's isolation property ("an absence of API
  surface, not a policy") holds, with the boundary moved from the process to
  the token.
- **The body never holds secrets it didn't need, and can't fetch more.** A
  sleeve token can't read the secrets service. When loom places a sleeve, it
  hands the *node* the secrets that sleeve needs (a podman secret, a file
  only the container sees), and the node's runtime injects them. A
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

Things that really run on a node (a chat bridge, a GPU job) **push** status
to loom instead of loom reaching in: the status board's push model. A node
that stops reporting shows as dark. Its tab or tile stays on the page with
the last report and its age.

### The page

- **Home is the household:**
  - every agent, with its sleeves (where each one is running and what it's
    doing, from its tape);
  - every node, with its facts and health;
  - "Your call" across all of them;
  - the commons' knowledge and the people directory.
- **An agent's view** is what `/` is today (tape, Mind, people as it sees
  them, its services' tabs) plus **Setup**:
  - identity: the creed and harnesses, read-only on the page
  - needs and placement rules
  - sleeves now, and recent ones
  - its repo
  - health
- **Nodes:**
  - enrollment requests to approve, with the code the node shows;
  - each node's facts, its sleeves, revoke.
- **Add an agent:** create its stack, point it at its repo, set its needs.
  Its first sleeve can go anywhere it's allowed.

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
4. **Nodes:**
   - `loom node`: enroll, report facts, pull work, run a sleeve from the
     agent's repo and container.
   - Approve-on-the-page.
   - Sleeve tokens.
   - The art LXC becomes the first node.
5. **Placement and the `sleeve` tool.** Bridges and the wake clock ask loom
   where to start a body. Art can ask for a node with what a job needs. The
   5090 box is the second node.
6. **loom gets its own host:**
   - secrets and tasks move there as services;
   - backups become the household's;
   - `loom.one.sleepunit.com` points at it.
7. **Mark moves in:**
   - his stack comes over;
   - his knowledge merges into the commons, with conflicts by slug listed
     for him and never overwritten;
   - his people become relationships on directory entries;
   - his box enrolls as a node.

   It's his memory, so he runs this step or signs off on it.
8. **The household page:** agents, nodes and enrollment, Setup, add an agent.

Through all of it, `*.one` stays LAN plus tailnet. Being reachable from
anywhere ("hacking the gibson at the library") waits on real auth: per-node
and per-sleeve credentials (above) and a real owner login (t-1487). The
design shouldn't need to change for it.

## What the tests must pin

- A sleeve token reads and writes only its agent's stack and the commons,
  through every tool and CLI verb. A node credential reaches no memory and no
  secret. A peer token sees only knowledge tools. An unknown token gets
  nothing.
- A revoked node gets nothing on its next call, and its sleeves' tokens stop
  working.
- Placement never puts an agent on a node its rules forbid, or one missing a
  stated need. A request that can't be met says which need or rule stopped
  it.
- A sleeve token can't read the secrets service. Secrets handed to a node for
  a sleeve are only that sleeve's.
- A person read as agent A returns the directory entry plus A's relationship,
  never B's. A directory write records its agent. The people migration
  renders every existing card identically.
- A node going away leaves loom, the page and every other agent working.

## Open questions

- **Tasks:** one household queue with assignees, or a queue per agent?
- **What a sleeve gets from the repo:** the whole repo cloned per node, or a
  cached checkout per node that sleeves share?
- **Long-running node work** (Art's bridges today): a sleeve that lives for
  days, or a node-level service the agent owns?
- **loom's own resilience:** one host is one target, which is the point, and
  also one thing to lose. Offsite replica, and how often?
- **Mark's knowledge:** what's in it, and how much overlaps Art's.
- **The owner as a person:** Jonathan is in the directory like anyone else.
  Does the owner role hang off his directory entry?
