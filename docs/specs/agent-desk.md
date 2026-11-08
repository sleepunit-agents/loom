# The agent desktop: agent cards and Needs you instead of widgets

*2026-11-07, t-1959. The owner clicked through the prototype (the "agent desktop" artifact, 2026-11-07) and approved it
the same day: "the desktop is the least interesting view; loom is agent-centric, so the agents should be front and
centre all the time." Status: **being built, in phases** (below). This supersedes the widgets of
[desk-tiling.md](desk-tiling.md) ("Widgets", "A fresh desktop", "Needs you and the Inbox", rule 1); the tiling rule for
apps, the dock, the keys and the address stand as they are.*

## What it is

A big screen (1024 px and wider, in a household) has two modes, by whether any app is open:

- **Home** (nothing open): a slim **Needs you** band, then one **big card** per agent, filling the desktop.
- **Work** (apps open): the tiles, and a **rail** of fixed width on the right: Needs you at its top, then a
  **compact card** per agent.

The agents are always there. There are no widgets: nothing to add, remove or arrange (the owner's ruling: removed, not
optional). Pre-1.0, so what a device kept from before is read past, not migrated: an address's `w` and a kept
layout's `w` are ignored and never written again; its apps open as they were.

## Which agents, in what order

The viewer's own agents only: loom narrows the household to the agents a member owns (owners.md), and the shell carries
only those. Alphabetical by display name (case-insensitive, then id). Always present: an agent with nothing going still
has its card.

## What a card says, and where it comes from

| On the card | From |
|---|---|
| Face, colour | the shell's agent mark (its pixel sheet where it has one) |
| How it is (a word, a tone) | Home's page (handler.ts agentCards): trouble first, then an ask (the shell's per-agent `asks`), then working, unavailable, quiet |
| Now | what it's on (`doing`, with its thread's link for its member: t-1945), else a problem, else "Nothing right now" |
| Last thread | the member's own Comms summary (below): the thread that last moved, its title and when |
| Next wake | the Clock's reading named `Next` for the agent (docs/extensions.md, "agents") |
| Unread | the member's own Comms summary: how many replies they haven't read, and the first one's line |
| Ask | the first of the agent's asks in Needs you; it opens in the Inbox, picked |

### Unread (read state is the member's own)

`GET /comms/agents` (comms-routes.ts; comms.ts `agentsComms`), for a signed-in member only, answers each agent they
own with: the thread they last talked in (`last`), how many of the agent's replies they haven't read across their open
(unarchived) threads (`unread`), and the first of those replies, one line of its words (`first`: its thread, cut to 160
characters), in the newest thread that has any. A thread is one member's (comms.md), and its `read_seq` is theirs: so
the count is per viewer by construction, another member's thread with the same agent never counts, and an agent they
don't own never shows. It answers `cache-control: no-store`, and its words are never put in Home's page (which a
device keeps a copy of). A caller that isn't signed in as a person is sent to sign in (`303`) and gets nothing; a session with no member
behind it gets `403`.

The desktop asks for it on load, whenever the live stream says something moved (a reply landing or a read bumps the
member's stream), when a Comms pane posts a read, when the tab comes back, and every minute as a fallback.

## Home

- **Needs you band**: one line. "NEEDS YOU · N", the first three as chips (title, who asks and why), and "Inbox ›"
  (with "+N more"). A chip answers in a line only where that's safe: Yes and No for a yes/no ask, a plain ask's own
  buttons. An approval, or buttons with lines of their own ("If you allow…"), are read whole before they're pressed
  (views.tsx ApprovalBox's rule), so those open in the Inbox, picked. Buttons wait until loom says, now, the ask is
  still open (ask-open.ts), and it's asked again right before a send. With nothing: "All clear."
- **Big cards**: 1 across, 2, 3, then 2+2, 3+2, 3+3; more scroll in threes. The face is a whole-number scale of the
  sprite chosen by the card's own box (96, 192 or 288 px). The face opens the agent's window; the composer starts a
  thread (POST /comms/new) and opens it in Comms.
- **Filling the card over time** (the owner wants the spare room used): a big card is `BIG_ROWS` (a label and a line
  each) and `BIG_SECTIONS` (blocks the card's width) in desk-agents.tsx. A new fact is one entry there.

## Work

- **The rail**: 296 px from 1280, 320 px from 1440, at the right edge (under 1280 there's no rail: two apps need the
  room there, and the agents are Home's and the dock's); the apps share the rest by the tiling rule
  (layout.ts `railWidth`; the desktop takes it off the area first). Needs you at its top: its count and its top
  item, opening the Inbox on Needs you. Then a compact card per agent: face, name, how it is, what it's on, its ask,
  what's unread (count and first line). No composer. A card opens the agent's thread: the one with its first unread
  reply, else its last, else Comms.
- **The accordion** (phase 2, built): when the cards don't all fit at their own size, they fold to one line each (face,
  name, a dot, ASK, a count) and one stays open: the agent whose thread Comms shows, else one that's talking, else one
  with an ask, else one with something unread, else the first. A Comms pane in a tile says whose thread it shows
  (desk-rail.ts `RailContext`); a line opens its agent's thread. The rail measures before it paints, so a fold never
  flashes, and tries the cards at full size again whenever its height or what they hold changes.
- **The comm screen moves to the rail** (phase 3, built): the avatar appears once. While Comms shows an agent's thread and
  the rail is shown, that agent's rail card is the comm screen (static on a reply, talking, its channel line) and the
  Comms band drops its avatar. With the rail hidden or auto-hiding, under 1280 px, and on a phone, the band keeps it.
  The Comms pane draws the screen into the card (a portal, desk-rail.ts), so it plays the thread's own state; without
  the screen the band is who's in the conversation and the work, 140 px tall, and two panes fit Comms from 880 px
  (comms.tsx ONE_PANE_BELOW_RAIL) instead of 1100.

## Hiding the rail and the dock (phase 4)

A right-click on the rail, or on the dock's ground, offers **Always show**, **Minimize to strip** and **Auto-hide**.
Kept per device (localStorage, as the device's own UI choices are), not synced. A strip is a thin bar that brings it
back on a click; auto-hide slides it in over the apps from its edge when the pointer reaches the edge (or a swipe in)
and away when it leaves, never reflowing the tiles. A strip or an edge shows a glowing dot while anything is unread or
asking. Ctrl+Shift+1…9 opens the Nth agent's thread (in the cards' order).

## The ticker (phase 5)

Centred on the screen (the bar's two sides are equal), each item a button that opens its app. Tasks, bridges and boxes
say what they have there (they were widgets and Home's tiles).

## A phone (phase 6)

A phone's Home is the same: Needs you, then a card per agent (face, how it is, what it's on, unread), in one column.

## Build, in phases

1. Widgets removed; Home (band and big cards) and Work (tiles beside the rail); `GET /comms/agents`.
2. The accordion.
3. The comm screen in the rail.
4. Hide modes for the rail and the dock; Ctrl+Shift+N.
5. The ticker.
6. A phone's Home.

Each phase has UI tests at 1280, 1440 and 1920 (and a phone's width where it applies), in all three looks
(src/ui/agent-desk.integration.test.ts), and the first page's JS stays under 250 KB gzipped (the desk is its own chunk).
