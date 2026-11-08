# The runtime piece — boxes and houses

*2026-10-24. Status: **accepted**, with [household.md](household.md); **v1
built** 2026-10-25 as [loom-box](https://github.com/sleepunit-agents/loom-box)
(`loom box`), on loom 0.14's piece API. This is a **piece**, not core (the
test is in household.md, "Where core ends").*

## What v1 is, and where it differs

- **Enrollment starts on the page, not on the box.** The owner adds a box by
  name ("Add a box", or `loom box add thor`) and gets its credential once; on
  the box, `loom box join <url> --name thor` takes it on stdin. That's the
  same yes from a person as the request-and-code flow below, without an
  unauthenticated endpoint for a box to knock on. The request-and-code flow
  can come with the approval piece (t-1468).
- **Houses are task houses:** started for one task, ended when it's done.
  Long-lived houses (a bridge on an alternate primary) are next.
- **The box credential** is a core token with the role `piece:box/<name>`,
  reaching only `POST /api/box/…` (docs/extensions.md, "The API").
- **Known gap (t-1492), being closed:** in v1 a house command runs as the
  box's user, so it can read what that user can. Decided below: a box only
  ever runs containers.

## Decided 2026-10-25

**A box only ever runs containers.** An agent's repo describes its house:
the image (a Containerfile in the repo), the command, which of its secrets go
where (a file or an env var), static env, and where the box's per-house dirs
mount. The box builds and runs it with podman itself, so no agent code runs
on a box outside a container. The control plane still decides which secrets
an agent's houses get; the repo only says where each one lands. Nested
containers (the capabilities Art's tank needs) are the owner's to allow, per
agent. Running each agent as its own Linux user stays the fallback for an
agent that truly needs the host, which needs root on the box once.

**Long-lived houses move by hand-off, then by lease.** A bridge runs in exactly
one place, or two copies answer every message. For now, moving one (a
per-bridge primary) is a hand-off: the runtime stops it on the old box, waits
until that box confirms it's down, then starts it on the new one, with a short
gap and no bridge. Later, a renewable lease from loom that a bridge must hold
to process messages, so a box that dies loses it and another can take over.
A bridge's read position and history live with loom, so a move doesn't lose
its place. Each bridge can have its own primary.

**The wake clock follows the primary.** The clock stays on loom's machine; a
wake runs as a house on the agent's primary.

## What it's for

> "the containers, the houses, are temporary. they're cattle. but the boxes
> aren't. … first, super easy to "move" you to a new box. I don't even have to
> take the old one down. … second, … a usb drive with the latest db dumped
> from loom brings you back from the apocalypse." — Jonathan, 2026-10-24

- A **box** is a known machine with git and a container runtime: wunder, the
  5090 box, Jonathan's laptop, Phil's Thor. It's a pet: enrolled once and
  kept.
- A **house** is one agent's container on a box, rebuilt from the agent's
  repo (`~/Art` for Art) whenever. It's cattle.
- **The rule:** a box holds nothing that can't be rebuilt from loom plus the
  agent's repo.

**It is not a scheduler.** Nothing chooses a box by itself, there's no
matching beyond "does this box have what was asked for", and there's no
rescheduling, no autoscaling and no ephemeral workers. As far as anyone can
see from here, never.

## Boxes

1. **The control plane is a box.** Wherever loom runs, the runtime makes that
   machine the first box and everyone's default primary. A one-machine
   household needs no configuration at all.
2. **Enrollment.**
   - Any other machine runs `loom box join <loom-url>`, which calls home and
     shows a short code.
   - The owner approves it on the page: the approval pattern (t-1468), a
     request and a person saying yes.
   - The box gets a **box credential**: revocable, and only able to say "I'm
     box B, here's what I have, what should I be running?" It reads no
     memory.
3. **What a box has** is reported for the page and for "has a 5090": GPU,
   architecture, container runtime, network, free labels like
   `jonathan-rig`.
4. **Which agents a box may host** is set per box by the owner. For us it's
   mostly "anyone".
5. **Boxes call home.** A box holds a connection open (or polls). The runtime
   never reaches into a box, so a box behind NAT, on hotel wifi or on a VPS
   works the same.

## Primaries and vacation homes

- **Each agent has a primary box,** per agent. Anything that doesn't say
  where goes there. For Art and Mark that's wunder, the box they share.
- **A request can name a need.** "Bring up Art and do this on a 5090" finds a
  box that has one and may host Art: a vacation home. If there's no such
  box, it says so and names what was missing. It never picks an arbitrary
  box to stand in.
- **The agent can ask for itself.** A tool, roughly
  `house({needs: ["gpu:5090"], task: "…"})`, or `{box: "laptop"}` to name
  one. The house's work lands on the tape like any other body's.
- **Each bridge can name its own primary.** By default every bridge's bodies
  start on the agent's primary. Shuttle's config can give any one bridge an
  alternate primary ("Art's Slack bridge runs on the laptop this week").
  That's shuttle's setting; it asks the runtime for a house on that box.

## Credentials

| Credential | Held by | Can | From |
|---|---|---|---|
| **Box** | one box | report facts, learn what to run, fetch a house's secrets | enrollment |
| **House** | one agent's house on one box | MCP and the CLI as that agent (it's an `agent:<name>` token) | core's token API, labeled "Art · house on wunder" |

- A house token is scoped to one agent on one box. A compromised box reaches
  only the agents housed on it. Revoking a box revokes its house tokens.
- **Bodies can't fetch secrets.** A house token can't read the secrets
  piece. When a house starts, the *box* fetches what that house needs with
  its box credential and injects it (a podman secret, a file only the
  container sees), as the house tank does today. A prompt-injected body
  can't ask for the Discord token, because nothing it holds can.

## The page

The runtime adds, through the piece contract:
- a **Boxes** tab:
  - enrollment requests with the code each box shows;
  - each box's facts, the agents it may host, its houses, and revoke;
  - start a house here.
- a Home tile, and an ask for each pending enrollment.

## Where it comes from

`~/Art/house` (the tank and entrypoint) is already a house. The runtime
piece makes it generic: an agent's repo names its container and entrypoint,
and the runtime runs it on a box with a house token and the secrets it needs.

## What its tests must pin

- A box refuses a house for an agent it may not host. A request with a need
  no permitted box has fails and names the need. Nothing else picks a box.
- A box credential reads no memory and no knowledge. A revoked box gets
  nothing on its next call, and its house tokens stop working.
- A house token can't read the secrets piece. Secrets fetched for a house are
  that house's only.
- With the runtime installed on the loom host and nothing else enrolled,
  every agent's primary is that host and a house starts there with no
  configuration.
- Losing a box leaves loom, the page and every other agent working.

## Open questions

- **Several houses of one agent:** which one runs which bridge is shuttle's
  setting (above); the wake clock follows the primary (decided above).
- **The repo on a box:** one checkout per house, or one per box shared by its
  houses?
- **The piece's name and repo.**
