# Desk tiling: apps share the screen, and widgets are tiles too

*2026-11-05; accepted 2026-11-06; phases 1 to 6 built 2026-11-06, and that day tiling became the only desktop (t-1884:
"holy fuck this is so good. it should be the default ... if there's any significant amount of code required to keep the
old way that we're not using, toss it and make this the only option"). Status: **built**. This is a design doc in the `docs/specs/`
sense: what loom builds, and the acceptance criteria its suites must pin. The owner played with the prototype (the
desktop prototype's Level 2, "Tiling") and said go on 2026-11-06: "tiling fucks, lets do that for sure" (t-1884). His
answers to the open questions are under "Decided" at the end, and the text below already follows them.*

## Why

> "I want to bring back the tiling idea. reason being, right now we have stuff like, the comms app that looks cool as
> hell, but its in this giant chrome window… oversized for what it is. if we tile them, I figure we can make it look
> more natural. but… I don't want to have 3 spaces where I swap stuff out or whatever like our original example. I want
> omarchy style tiling. one big window, then I open another and I get two split, then I open another, and maybe I get
> one on the left and two above/below each other on the right. with it using the type of app and what it can show to
> know what to do." — the owner, 2026-11-05

> "I think the widgets should effectively be part of the tiling system too. they already look like little windows
> here… I'm imagining being able to have art and mark's status cards up and also a chat with one of them and also tasks
> and whatever. like our fake OS is doing real shit" — the owner, 2026-11-05

Before this, at 1024 px and wider, an app opened in one big window over the desktop (`DeskWindow`, removed 2026-11-06).
Comms in a 1,800 px window was mostly empty. With tiling there are no saved layouts and no workspaces. Opening a second
app splits the screen by a rule. The rule reads each app's own declaration of how much room it can use. Home's widgets
are small tiles in the same arrangement. It is the only desktop: the old window, its setting and its code are gone.

This is loom's own design. It borrows the family (automatic dynamic tiling: each new window subdivides the newest) and
no product's look, keys or names.

## Words (to be added to CONTEXT.md)

**Tile**:
one app on a big screen, sharing the screen with others by the tiling rule. It has its own page, its own history and
its own frame.
_Avoid_: window (the old single big frame, gone 2026-11-06), pane, panel

**Widget**:
a small tile: one of Home's cards (an agent's card, Needs you, Vitals, Backup). (The ticker was one until 2026-11-06; the
desktop's bar scrolls it, so it went.) It is
live, it never gets a split of its own, and it opens its app beside it.
_Avoid_: gadget, applet

**Fit**:
what an app declares about the room it can use: a minimum, an ideal and a maximum width, a minimum height, and whether
it wants the big slot. The maximum is the width past which the app gains nothing. It decides who gets room only when
one side of a split can use more and the other can't (rule 2, step 2), and how much the widgets get beside the apps
(rule 1); otherwise a split's ratio stands, even past a max.
_Avoid_: size hint, constraints

**The big slot**:
the first app tile, which is the large one on the left once there are three or more apps.

**The rail**:
the column the widgets stack in, on the right, while apps are open. **The strip** is the rail folded to one 64 px key
per widget.

## The rule

The layout is a pure function: `layout(apps, widgets, area, screen) → rectangles`. It has no state of its own. Given the
same tiles in the same order, it draws the same screen, whatever it was asked before. Gutters are 10 px.

- `area` is the room the tiles share, in px: the desk between the bar and the dock, inside the desk's own 24 px side
  gutters (`desk.css` `--desk-gutter`).
- `screen` is the viewport's width (`innerWidth`). The caps (rule 4) and the widget column's width read it, never the
  area.
- Each widget brings its height as drawn at the column's width (measured), or, until it's measured, the default height
  in the widget table below.

The rule lives in `web/src/tiling/layout.ts`, its tests in `src/ui/desk-tiling-layout.test.ts`. An app is
`{ id, name, fit, pinned? }`, a widget `{ id, name, kind, h? }`; all of these are pure:

- `layout(apps, widgets, area, screen)` → each app's and widget's rectangle, the widgets' mode (desk, board, rail or
  strip), their column count and the desktop's groups;
- `place(apps, app, from?)` → the order with `app` in it (rule 3; `from` is `{ tile }` or `{ widget: true }`);
- `admit(apps, app, widgets, area, screen, { from?, usedAt? })` → the order after rule 3 and rule 4, and the apps sent
  to the dock, each with its words (`usedAt` is each app's last focus time);
- `promote(apps, id)` and `swap(apps, i, j)` → the order after "make this the big one" and a swap;
- `capFor(screen)` and `columnWidth(screen)` → rule 4's cap and rule 1's column width.

### 1. Widgets first: the desktop, a rail, or a strip

- **No app open:** the widgets *are* the desktop, laid out as Home is today, and nothing else: no headline or status
  line (Jonathan, 2026-11-06: "just cards, widgets and windows"). Needs you is the left column, the agents are the middle
  (their cards fill it two or three across), and everything else is the right column. A fresh device starts here, with
  the seed (below, "A fresh desktop").
- **Apps open:** the widgets move to the right edge.
  - A widget column is 280 px wide on a screen under 1440 px, 300 px under 1920, and 340 px from 1920.
  - If the apps' combined **max** leaves room for at least one column and a gutter, the widgets get as many columns as
    fit there, up to 3 and no more than the groups the widgets fall in (Needs you, the agents, the rest: so Needs you,
    Art and Mark make 2 groups). The columns go left to right in that group order, each widget in the order it was
    added; with fewer columns than groups, the last groups share the last column, in group order.
  - Else, if the apps' combined **min** leaves room for one column, the widgets stack in a **rail** one column wide.
  - Else the rail folds to the **strip**: one 64 px key per widget, with a face or an icon and a count. A key opens the
    widget's app. The strip always takes its 64 px and a gutter; an app that then falls under its minimum is rule 4's
    (it goes to the dock), never drawn over.
  - "Combined" is the width the apps would need if each split alternated, starting side by side (an estimate: rule 2
    really splits each region by its shape):
    `need(run, side) = side ? w(first) + 10 + need(rest, stacked) : max(w(first), need(rest, side by side))`, and
    `need` of one app is its own `w` (its min or its max). An app without a max makes any combined max it's in
    unlimited.
- A rail taller than the area draws its cards and Needs you compact (a card shows its face, name and status line; Needs
  you shows its first ask and "N more"). If it's still taller, the rail scrolls inside itself.
- A widget never takes a split of the app area. A widget in half the screen is the failure this rule exists to prevent.

### 2. Apps: one fills, two split, then each new one subdivides the newest

In the app area (the screen minus the widgets and a gutter):

- **1 app** fills it.
- **2 apps** sit side by side.
- **3 apps:** the first is the big slot on the left, and the other two stack on its right.
- **4 or more:** each new app subdivides the region the previous one sat in. So the fourth app sits beside the third,
  under the second.

Every split is the same step, applied again inside what's left: a region holding a run of apps gives the run's
**first** app its share, and **the rest** (every app after it in the run) share the remainder the same way. A region
wider than 1.15 times its height (`w > 1.15 × h`) is split side by side; otherwise it's stacked. So 1,200×1,000 is side
by side and 1,100×1,000 is stacked.

Split ratios come from fit, in this order:

- **Side by side,** where `W` is the region's width less one gutter:
  1. The first's width is `round(W × ideal(first) / (ideal(first) + ideal(widest of the rest)))`, the share clamped to
     34 to 66 percent first. "Widest of the rest" is the largest ideal among the rest.
  2. Then the maxes: if the first has a max and at least one of the rest has none (so the rest can use any room), the
     first stops at its max. If the first has no max and the rest all have one, the first takes at least what the rest can't
     use (`W − their combined max`). When both sides have a max, or neither does, step 1's width stands: a max only
     decides who takes the room when one side can use it and the other can't. (Room past every max goes to widget
     columns when rule 1 gives them more; otherwise the apps keep it.) A max applied here can take the first under 34
     percent.
  3. Then the minimums: the rest keep their combined minimum, taken starting stacked (`need(rest, stacked)`: the
     widest minimum among a stack, which is the least the rest's region can be), and the first keeps its own as far as
     that allows.
- **Stacked:** half each (`round((h − gutter) / 2)`), then clamped so the rest keep the largest minimum height among
  them, and the first keeps its own as far as that allows.

Rule 2 always draws a layout; step 3 and the stacked clamp can still leave an app under its minimum when there isn't
room. Rule 4 then reads that layout, and while any app in it is under its minimum, or there are more apps than the cap,
it sends one to the dock and lays them out again.

### 3. Which app is first

The order is a list. Position 0 is the big slot.

The first of these that applies places a new app:

1. Opened from a link inside another app's tile: **right after that tile**, `big` or not.
2. Opened from a widget: **last**, which puts it next to the rail, beside the widget it came from.
3. Its fit says `big`, the app at position 0 isn't `big`, and you haven't made that app the big one: **first**. So
   Tasks opened from the dock beside Comms takes the left, and Comms keeps the column beside the cards.
4. Otherwise **last**: it subdivides the newest tile.

"Make this the big one" moves a tile to position 0 and pins it there; only one tile is pinned. A wide app opened later
goes last, not first. Swapping a pinned tile out of position 0 unpins it.

### 4. Too many, or too small: the least recently used goes to the dock

A split is never made if it would put an app under its minimum width or height. Below the minimum, the tile does
**not** fall back to a phone layout. Instead:

- Opening an app that doesn't fit sends the app **used least recently** to the dock, minimized, keeping its place in
  its history. "Used" is the last time its tile had focus; an app never focused counts as used at 0, and a tie goes to
  the one earlier in the order. Never the one being opened, never the one it was opened from, never a pinned one. It
  repeats this until the layout fits. When no app may go, what's left stays, each at what the split gives it.
- The same happens past the cap for the screen's width: **2** apps under 1280 px, **3** under 1600, **4** under 2560,
  and **6** from 2560.
- A toast says which app went to the dock and why, and the live region (Accessibility) says the same words:
  `<gone> went to the dock to make room for <opened>: ` and then one of
  - `it would have been under its <n> px minimum` (plus ` height` for a height), when the app that went is the one
    that would have been too small;
  - `<app> would have been under its <n> px minimum` (or ` height`), when another app was too small and this one went
    because it was used least recently (the first app the layout puts under its minimum, in the order);
  - `<cap> apps is the most this screen holds`.

Why this and not a phone layout: a phone layout in a 300 px tile is a page you can't use beside the others. Moving the
oldest app to the dock keeps every tile usable and loses nothing, because its key brings it back where it was.

Above its minimum but narrow, an app uses its own compact layout, through container queries on the tile's body, not the
viewport. Comms under 620 px shows one pane (the thread, with a way back to the list). Tasks and Changes under 900 px
drop the detail pane, and under 600 px drop their extra columns.

## Fit: what each app declares

| app | min (w×h) | ideal w | max w | big | why |
|---|---|---|---|---|---|
| Comms | 380×360 | 680 | 820 | no | a thread list and one thread |
| Tasks | 520×320 | 1040 | none | yes | a wide list with a detail pane |
| Changes | 560×320 | 1100 | none | yes | a wide list with a detail pane |
| Inbox | 420×320 | 760 | 980 | no | one column of asks |
| an agent's pages | 420×360 | 760 | 1000 | no | a page about one agent |
| Boxes | 420×300 | 820 | 1200 | no | cards with meters |
| Knowledge, People, Activity | 420×300 | 760 | 1100 | no | reading |
| Setup, Appearance, Accessibility, Account, Passkeys, Secrets | 360×280 | 560 | 680 | no | settings |
| **no fit (the default)** | 420×300 | 720 | none | no | |

| widget | min (w×h) | default height, until measured | compact height |
|---|---|---|---|
| an agent's card | 260×108 | 236 | 108 |
| Needs you | 260×130 | 240 | 130 |
| Vitals | 260×110 | 180 | as drawn |
| Backup | 260×90 | 110 | as drawn |

A widget's height is its own, measured as drawn at the column's width (its asks, its places, its lines); the default is
what the rule uses before it has been measured. "Compact" (rule 1) is the card's face, name and status line, and Needs
you's first ask and "N more"; it's `min(height, compact height)`.

- **Core apps** declare fit in code, one table in `web/src/tiling/fit.ts`, keyed by the app's label (as `tint.ts` keys
  apps' colours). Tasks, Changes, Boxes (the `runtime` piece) and Secrets are pieces, not core: the table carries their
  rows by label as loom's defaults for them until their own manifests declare a `fit` (phase 6), and a manifest's `fit`
  wins over the table's row.
- **Pieces** declare it in their manifest, as a small addition to `tab` (`docs/extensions.md`):

  ```json
  { "tab": { "label": "Garden", "fit": { "min": [420, 300], "ideal": 760, "max": 1000, "big": false } } }
  ```

  Every key is optional and falls back to the default row. A `min` narrower than 320 or shorter than 240, an `ideal`
  under the `min`'s width,
  or a `max` under `ideal` makes the manifest refuse with a message, the way a bad `accent` does.
- **Widgets from pieces (designed, not built):** a manifest's `widgets: [{ "id", "label", "page", "fit", "opens" }]`.
  `page` is a piece page drawn small, with the same blocks. `opens` is the page its "Open" goes to. The `tile` Home
  summary a piece already has is its default widget, so every piece with a tile has a widget for free. Building it waits
  until a piece wants more than its tile.

## Widgets: adding, linking, removing

- **Adding:**
  - A **right-click on the desktop's ground** (or the Menu key or Shift+F10 with nothing focused) opens "Add a
    widget": Needs you, each agent's card, Vitals and Backup. One already on the desktop shows "on the desktop" and
    focuses it. (It was the dock's + key until 2026-11-06, t-1925 E.)
  - **Find** lists the same as "Add widget: …".
  - An agent's window has **Shrink to widget** in its strip (it was Pin card to the desktop, before the card and the
    window were one app: "An agent's window", below): its card goes on the desktop and the window closes.
- **Linked:** a widget's actions open its app beside it. On an agent's card, **Chat** opens that agent's latest Comms
  thread and **Open** opens their pages. On Needs you, an ask opens in the Inbox. An app opened this way goes last, next
  to the rail. A widget is live: it draws from the same live data its app does (`/events`), so it never goes stale.
- **Removing:** a widget's × removes it, like any tile. Removing the last widget leaves the ground. With no app and no
  widget, the desktop says "No tiles. Open an app from the dock, or right-click the desktop (or press Shift+F10) to add a
  widget."
- **Order:** widgets keep the order they were added in. Drag one onto another to swap them. In the desktop layout (no
  apps) they group by kind, as Home does.

## A fresh desktop

A person with no saved layout on this device (a new device, a first visit) gets the **seed**, so the desktop is never
blank: Needs you, each agent's card they can see (pixel faces where they have them), Vitals and Backup (when it's set up).
It's one short list in code, `web/src/tiling/widgets.ts` `SEED`, so it's easy to change; an entry that
isn't there (no backup, no agents yet) is left out, and a household with no agents shows "No agents yet" and New agent
where their cards would be. A saved layout (`loom-tiles`, or a set in the address) is never touched.

The seed opens **no app tile**. An Inbox tile when something needs you was weighed and left out: Needs you already shows
those asks and answers them where they stand, and an open app moves every widget to the rail, so the first screen would
be busier and say the same thing twice.

## The launcher (t-1925 G)

Every app in one grid, the desktop's own app list (`web/src/launcher.tsx`, its list in `web/src/launch-list.ts`): the
dock's last key (All apps, nine lit dots) opens it, and so does **Ctrl+Shift+Space** (⌘⇧Space on a Mac). Not ⌘Space or
Ctrl+Space, the mockup's first pick: ⌘Space is Spotlight's on a Mac and Ctrl+Space switches the input language on
Windows, Linux and any Mac with two keyboards, so the browser doesn't reliably get either.

- Sections come from loom's own list: **Work** (the Inbox, Activity, Projects, then each piece that's a place), **People
  & agents** (Comms, each agent, People), **Library** (Knowledge), **System** (pieces whose kind is a setting, and loom's
  own first-party pieces that run the household while being places: Boxes, Bridges, Clock, Machine, Secrets…, by their
  tab's label, since a manifest has no section field yet; then Members), **Look & feel** (Appearance, Accessibility),
  **Pieces**. A third party's place piece is Work's. Each app is in one section only; an empty section isn't drawn.
- Each tile says its live state under its name: "3 need you" or "Nothing waiting", "2 unread" or "All read", an agent's
  "Working" or "1 waiting on you", a piece's own tile value, the look's name, Accessibility's motion choice ("As this
  device", "Less motion", "Full motion"), how many pieces are installed. An app with no number of its own to say
  (Activity, People, Projects, Knowledge, Members) shows no line rather than a made-up one.
- Search has focus when it opens and filters as you type (an app's name or its section's). Enter opens the best match,
  marked on its tile (the first app before anything's typed; then a name that starts with what's typed, else the first
  shown); Esc closes; the arrow keys move between apps (up from the
  first row is the search again); Tab stays inside it.
- Opening an app adds it to the tiling, or focuses it when it's open, or brings it back from the dock.
- The account is the launcher's corner (your name), not a dock key, on a desktop.

**More and Setup aren't desktop destinations.** The dock has no Setup key and no More key, and neither page is a tile: each of their apps
(Appearance, Accessibility, Members, Pieces, each setting piece) is its own tile, keyed by its own address. An old link
to `/setup` or `/places` (with or without a query) opens the launcher over the desktop, and a saved layout with a Setup or Places tile loads
without it.

**A phone keeps its More and Places.** On a phone they're already what the launcher is on a desktop: whole screens of
app tiles a dock key away, like a phone's home screen, and they read the same list (`nav.ts` placesOf, settingsOf). A
dialog over a phone's one page would add a step to reach the same tiles, and swiping between dock pages already works.

## An agent's window (t-1925 D)

An agent's pages are one window (`web/src/agent-window.tsx`), the mockups' (2026-11-06). "Window" here is the
mockups' word for the agent's **tile** (the glossary's): the frame inside it, not the old single window.

- **The header:** the agent's face (its pixel face where it has one) in a Neon frame (a cut corner, a lit top edge, faint
  scanlines; no 000h shapes), its name with a **working** pill (or "N waiting on you"), its **description**, and a line
  of facts (today's count, its memories, when it was last active). No clock element: the Clock is a section. Message
  opens Comms. The window's corner (its title strip) and Comms' thread list wear the agent's **letter**, not a cropped
  face: the pixel face is the one big picture. (A place with room for the whole face, 36 px and up, such as Find's
  rows, keeps the face: it's a crop only below that.) The page under the header keeps the agent's tiles (Memories, its
  pieces'), each a link into its sections.
- **The description** is the household's word for what the agent does, for whom, in a sentence or two: household.json
  `about` (`setAbout`), never its creed (an agent with none shows "No description yet." to its owner, and nothing to
  anyone else). A household owner writes it in place (Edit, `about-set`; Setup's Description too), or asks the agent to write its own
  (**Regenerate**, or "Ask Art to write it" while there's none; `about-ask`:
  a Comms thread from them asks, and the agent saves its answer with the `describe_self` MCP tool, which is refused
  unless an ask is open (24 hours; the owner's own words close it), writes once, at most 300 characters and one or two sentences, and is told to keep its
  memories out of it). An agent owner (not the household's) reads it and can't change it.
- **Its sections** (its own tabs: Today, Mind, Setup, and every piece's agent tab, Clock, Bridges, Houses, Secrets…) are
  a sidebar inside the window; under 640 px wide an icon rail, each still named for a screen reader. The desktop's dock
  never swaps to an agent's. On a **phone** the same header, and the dock still swaps to the agent's sections: a sidebar
  would take a third of a 390 px screen, and the swap is how a phone already reaches them.
- **The card and the window are one app at two sizes.** On the desktop an agent's card has Expand (and the card itself
  opens it): its window opens beside the widgets and the card stands aside while it's open (its place in the widgets is
  kept, `w` unchanged); a lit outline in the agent's colour travels from the card to the window (`tiling/morph.ts`). The
  window's **Shrink to widget** (its strip's button, where Pin card was, and its strip's right-click menu; the card's
  menu has **Expand**) closes it and the card comes back where it was (added to the desktop when it wasn't
  there), the outline travelling back. Reduced motion: no outline, the change is instant.

## One window at a time

An Accessibility choice, per person, off unless turned on (`oneWindow` in `/appearance/prefs`; this device's copy is
`loom-one-window`). It is the same tiled desktop, with the widgets on the desktop, in the rail or the strip as the rule
says, the same keys and the same dock, and one difference: **one app tile at most**.

- Opening a second app sends the one on screen to the dock, kept where it was (its page, its history, how far down),
  as rule 4 sends one that doesn't fit, and a toast and the live region say
  `<gone> went to the dock to make room for <opened>: one window at a time is on`.
- Turned on with several apps open, the focused one stays and the rest go to the dock. An address with several apps
  (`?t=`) opens the focused one, the rest in the dock.
- A pinned app (the big one) goes like any other: one is the most there is.

It replaces Appearance's old "Desktop" choice (Tiling, or One window at a time in the old window). Whoever had One
window at a time saved there (`tiling: false`) has this on, until they choose in Accessibility: loom serves it so
(`src/ui/sessions.ts` `oneWindowOf`), and a device that kept `loom-tiling` as `off` starts with it on
(`web/src/look.ts` `oneWindowKept`). The old `tiling` field is still taken and kept, so a device running the older app
gets no error.

## The bar

One line across the top, as a desktop OS has (Jonathan, 2026-11-06): loom's clock and the focused page's name on the
left; LOOM//OS, the status glyphs (`system-bar.tsx`) and the needs-you count on the right; the ticker scrolls between
them (`phone-bar.tsx` `PhoneBar` with its `clock` and `status`, drawn as one line by `desk.css` `.loom-pbar--one`). A
quiet dot (`·`, hidden from screen readers) stands between the clock and the name, and between LOOM//OS and the glyphs.
The ticker fills the room between the two groups: when its words fit they stand in its middle; when they don't they run
across all of it (or, under reduced motion, are cut short from its left).
Narrower than a desktop, a screen keeps two (loom's status bar over the phone's), and a phone its own one.

## Interaction

- **Opening, from the dock, Find or a link:**
  - If the app isn't open, a tile is added, and it takes focus.
  - If it's open, its tile is focused, and goes to the page asked for when that's another page.
  - If it's minimized, it comes back into the layout where its history stands.
- **The focused app's own dock key** minimizes it, as it does today (`desk.tsx`, loom#532).
- **Home** (its key, or Alt+H) sends every app to the dock and shows the desktop. Home again brings them back in their
  order.
- **Links:**
  - A link to a page in the **same** app stays in the tile.
  - A link to **another** app opens that app beside this tile, or focuses it if it's open.
  - Two tiles of the same app (two Comms threads side by side) are **later**, not in this build. Until then a tile is
    one app, and opening an app that's open focuses its tile.
- **Closing** (×, or Alt+Shift+W) removes the tile and forgets its history (`trail.forget`, as Close does today).
  **Minimizing** (_, or Alt+Shift+M) keeps it. Either way the rest reflow.
- **Focus** goes to a tile when you press anywhere in it (click to focus; hover never moves focus). The focused tile's
  frame is lit in its app's colour.
- **Swap:** drag a title strip onto another tile of the same kind, or use Alt+Shift+, and Alt+Shift+. to swap with the
  tile before or after. **Make this the big one:** the strip's ⤢ or Alt+Shift+Enter. A double-click on the strip
  minimizes the tile, as it minimized the old window.
- **Resizable gutters:** not built (decided 2026-11-06). The split ratios come from fit, and a dragged ratio would need
  saving per pair of apps per screen width. If the owner misses it after use, it's a phase of its own.

### Context menus

Short, and only where they help (t-1925 E; `web/src/tiling/menu.tsx`, `tiles.tsx` `menuFor`). The pointer's right
button, or the Menu key or Shift+F10 on what has focus, opens one at it:

- **The desktop's ground:** Add a widget (above).
- **A tile's strip:** Minimize, Make it the big one (not the big one already), Pin its card / Take its card off the
  desktop (an agent's tile), Close. A tile has no window of its own to open it in, so no such item.
- **A widget:** an agent's card has Chat, Open and Unpin from the desktop; another widget Open and Remove from the
  desktop.
- **A dock key:** Open; Minimize while it's open; Close while it's open or in the dock. Home, All apps (the launcher), More and your own key
  (Account) have none.
- **A list row that says what it offers** (`data-row-menu="id:Label|…"`, answered by a `loom-menu` event on the row): an
  Inbox item has Open (in the reader), and Mark done when it has a plain Done and no unsent reply (a kept draft: Open
  only, so the reader's Done sends it first); Mark done asks loom first whether it's still open, as the reader's own
  buttons do, and opens it in the reader when it isn't.
- Anywhere else (a tile's page, a link, a field), the browser's own menu.

A menu is `role="menu"` with its items `role="menuitem"`, named for what it's about. Focus goes to its first item; ↑ ↓
Home End move (round the ends), Enter or Space chooses, Esc closes and gives focus back, Tab closes and lets focus
move on (it never traps focus), and a press outside, a wheel, a resize or leaving the window closes it.

### Keys

Tiling keys use **Alt+Shift**. No browser binds it, Option+Shift on a Mac only types characters (and these keys rest
while a field has the keys), and the alone-chord that switches input language on Windows is never pressed with an arrow
or a letter.

| keys | what |
|---|---|
| Alt+Shift+← ↑ → ↓ | focus the tile that way, widgets included: of the tiles that start past this one's edge that way, the one whose centre is nearest this one's; a tie goes to the earlier in the order |
| Alt+Shift+Enter | make this the big one |
| Alt+Shift+, / . | swap with the tile before / after |
| Alt+Shift+M | minimize to the dock |
| Alt+Shift+W | close the tile |
| Alt+← / → | Back and Forward in the focused tile, only when it has somewhere to go (as today, loom#536) |
| Alt+H | Home: apps to the dock, the desktop shows |

Esc never closes a tile: with several on screen, it would close the wrong one too easily. Esc still closes a sheet, a
dialog and Find.

## Per-tile pages and history (reusing loom#536)

loom#536 gave each app its own history (`web/src/trail.ts`: `note`, `step`, `keepTop`, `lastAt`, `visited`, `minimize`,
`restore`, `forget`, keyed by app). The old window's strip drew Back, Forward and a trail from it. Tiling reuses all of
it:

- **History key:** a tile's key is its app's key, as `trail.ts` has it. So a tile's Back, Forward, trail, Recent here
  and minimize-where-it-was are #536's, unchanged. (Two tiles of the same app, later, would need a key of their own.)
- **One page loader per tile:** `App.tsx` loads one page for the whole screen today (`url`, `data`, `error`, `waiting`,
  `load()`). Phase 1 moves that into a hook, `usePage(url)`, that each tile runs for its own URL. The phone and the
  shell keep using it once, so nothing visible changes. Redirects, `_flash`, live refresh (`/events`) and the page's own
  refresh rules move with it.
  Two things stay one for the whole tab, however many tiles: the live stream (`/events`, one per open app as
  `docs/specs/ui-app.md` "Live" has it; every tile listens to it) and the kept copies of pages (each page's last answer
  and its fingerprint), so a tile opening a page another has shown opens it at once. The refresh timer's pause (a dialog
  open, a field in use, the tab hidden) is the screen's: a dialog in one tile pauses every tile's timer, never the live
  stream's refreshes.
- **The tile's Env:** each tile renders inside its own `EnvContext` (`web/src/blocks.tsx` `Env`). The tile's `go`
  follows the link rules above, and its `send` is its own page's. Blocks need no change: they already link and act
  through `useEnv()`.
- **The frame:** the old window's strip became the tile's strip, slimmer: 30 px with the app's key, Back, Forward, the
  trail, then ⤢, _ and ×. The trail never says the app's name twice: a page named as its app (a Comms thread, which
  has no title of its own) shows the name alone, and the name is the link up to the app's start (Jonathan,
  2026-11-06: "COMMS › COMMS"). The side column (`SIDE_COLUMN`) shows in a tile only when the tile is at least 1,100 px
  wide; Recent here only when, as well, another app tile shares the screen (widgets don't count): the only app tile,
  with no side of its own, gets the room. A double-click on the name minimizes the tile, as anywhere on the strip.
- **What the old window did that a tile now does** (2026-11-06, when the window went): a tile's page wears its app's
  colour (or its agent's) as its accent (`data-accent`); each page a tile opens is noted for Find's Recent; the bar's
  ⓘ is the focused tile's page's intro; and the dock lights the focused app's key, Home's with none.

### Sheets and dialogs stay inside their tile

Radix dialogs and sheets portal to `<body>`, trap focus across the whole page and hide everything else from assistive
tech. In a tile:

- Each tile has its own portal root. A tile's `Dialog`, `AlertDialog`, `Drawer`, `Sheet`, `DropdownMenu` and `Select`
  render into it, through a `PortalContainer` context the `components/ui` wrappers read.
- A tile's dialog is modal to its tile only. Its overlay covers the tile, its focus trap is the tile, and the other
  tiles stay usable and readable. The desk's keys ask whether a pop-up is open in this tile (`tiles.tsx` `popUpFor`)
  before taking Alt+←/→ or the tiling keys.
- `Sheet` here is `web/src/panel.tsx`'s (a `components/ui/dialog` when wide); it takes the same container.
- Find, toasts and the boot stay screen-wide.
- As built (phase 5, 2026-11-06): Radix's `Select` and `AlertDialog` are always modal to the whole screen (neither has
  a `modal` choice), so in a tile a choice of many is the browser's own list (`choice-select.tsx`), and a danger
  button's confirm is a `Dialog` with the alert's role (`block-extras.tsx` `Confirm`). Anything else that reaches for
  `AlertDialog` in a tile gets the screen's modality. Radix keeps one stack of open layers for the page, so with sheets
  open in two tiles at once, Esc closes the one opened last, wherever focus is; the other closes with its own Close or
  a press on its tile's scrim.

### Transitions

- **Reflow:** each tile carries `view-transition-name: tile-<id>`, so one document View Transition morphs every tile
  from its old box to its new one when tiles are added, closed, swapped or promoted.
- **A page change inside a tile** names only that tile's body, so the others don't move.
- Only one transition runs at a time. A change during one applies without animation.
- **A tile's own move** (t-1925 B; Jonathan, 2026-11-06: "nothing reads as a page refresh"): the one tile opened,
  closed, minimized, made the big one or brought back from the dock wears its own effect, in loom's look: a CRT's
  power-on (open) and power-off (close), a scanline wiping it down to the dock (minimize) and back up (bring back), a
  glitch as it takes the big slot. It is the same View Transition as the reflow: that tile is named `loom-fx` for it and
  `<html data-tile-fx>` says which effect (`tiles.css`); the rest morph as before. 220 to 320 ms; transform, opacity
  and clip-path only. Home sending every app to the dock, and back, is the plain reflow.
- **Reduced motion** (`access.ts`) skips all of it, and the layout simply changes.

## The address, and what each device keeps

- **The path** is the focused tile's own page, so a copied address opens that page anywhere, a phone included.
- **The query** holds the set:
  - `t` is the apps on screen in order, each by its key's name (the last part of its dock key's path: `comms`,
    `inbox`, `tasks` for `/p/tasks`), a `*` before the focused one and a `!` after the pinned one: `*tasks!` is both.
    An agent's pages are an app of their own per agent (key `/a/<id>`, name its id), so two agents' pages are two
    tiles; a household app's name wins over an agent with the same id.
  - `m` is the minimized apps, in the order they went to the dock.
  - `w` is the widgets in order (`needs`, `vitals`, `backup`, and an agent's card by the agent's id). A retired
    widget's id (`ticker`, 2026-11-06) is dropped as the set loads, and the device's copy is written again without it.
  - For example, `/comms/th/7f3a?t=tasks!,*comms,inbox&m=boxes&w=art,mark,needs`. Each app's page is its own history's
    (`trail.ts`, this tab's), and the path is the focused one's.
- **On reload**, the address restores the set, minimized apps in the dock.
- **An address with no set** (a bare `/`, a link, a bookmark) restores this device's last set from `localStorage`
  (`loom-tiles`, wrapped in try/catch), else the fresh-device set, and the address's own page opens focused in its
  app's tile.
- **Under 1024 px,** `t`, `m` and `w` are ignored, and the saved set is neither read nor written: the path's page draws
  as a phone's. A window narrowed under 1024 px with tiles open shows the focused
  tile's page as today's phone page, and the address drops its set; widened again, the set comes back from this
  device's saved one.
- **Inside a tile, a page change** is a `pushState` of the new address, with `{tile}` in its state. So the browser's
  Back and Forward walk the focused tile's history, the way `trail.ts` takes a `pop`.
- **Opening, closing, swapping and promoting** use `replaceState`, so the browser's Back never closes a tile.

## Accessibility

- **Focus order:** the DOM order is the order list (`t`): position 0 (the big slot), then 1, 2 and so on, which is the
  order the rule subdivides them in; then the widgets as drawn, column by column, top to bottom. Tab order and reading
  order follow it.
- **Each tile** is a `region` with `aria-roledescription="tile"` and the label "tile 2 of 3, Comms". Moving focus with
  the keys moves it to the tile's title, which announces exactly that.
- **One polite live region** says what changed: "Tasks opened, tile 1 of 3"; "Inbox closed"; and rule 4's toast,
  word for word.
- **The plain mode** is Accessibility's One window at a time (above): the same desktop, one app tile at most. Tiling
  itself is not a setting: it is the only desktop (2026-11-06).
- **Reduced motion** skips the reflow animation (above).
- The hover-only parts (the strip's buttons' hover state) also show on focus.

## Budget

First-page JS was about 240 KB of the 250 KB budget on 2026-11-06 (`src/ui/web-app.test.ts`, run on a built app).

- Tiling lives in `web/src/tiling/`, loaded with the desk's own chunk, at 1024 px and wider only. A phone never fetches
  it.
- `usePage` replaces code App.tsx already has, so it moves weight rather than adding it.
- The `?t=`/`&m=`/`&w=` parser lives in the desk chunk, not the first page.

## Acceptance criteria

**The rule (vitest, pure function; no browser; `src/ui/desk-tiling-layout.test.ts`).** Areas are given as `w×h`
on a screen `screen` px wide; with no screen named, it's the area's width.

1. **One, two, three.** In 1920×890, with no widgets:
   - Inbox alone: its rectangle is the whole area;
   - Inbox, Comms: side by side, one 10 px gutter between, together the area's width;
   - Tasks, Inbox, Comms: Tasks on the left at full height, Inbox over Comms on the right, one gutter between each,
     each at least its minimum.
   - Tasks, Comms, Inbox: Tasks is 1,104 px, `round(1910 × 1040/(1040+760))`: the widest ideal of the rest (Inbox's
     760), not the first of them (Comms's 680, which would give 1,155).
2. **Dwindle, and every split the same step.** Tasks, Inbox, Comms, Knowledge in 2560×1300: Knowledge sits beside
   Comms, under Inbox; Comms's width is `round(W × 680/(680+760))` of its own region's `W` (the region less a gutter).
   The threshold: Inbox and Comms in 1200×1000 sit side by side, in 1100×1000 they're stacked.
3. **Fit sets the ratio, then the maxes, then the minimums.**
   - In 1538 wide, Tasks then Comms gives Tasks `round(1528 × 1040/1720)` = 924 px and Comms the remaining 604 px.
   - In 3200 wide, Boxes (max 1200) then Tasks (no max) gives Boxes 1,200 px, its max, not the ratio's 1,406.
   - In 3000 wide, Setup (max 680) then Tasks gives Setup 680 px, its max, not its 35 percent share (1,047).
   - In 1810 wide, Comms (max 820) then Inbox (max 980) gives Comms 850 px and Inbox 950: with both capped, the ratio
     stands.
   - In 1810 wide, Setup then Changes gives Setup 612 px: its raw share (560/1660, 33.7 percent, 607 px) is clamped up
     to 34 percent.
   - In 3000 wide, Tasks (no max) then Comms (max 820) gives Tasks 2,170 px and Comms 820: Tasks takes what Comms can't
     use, past its ratio's 1,808.
4. **Where a new app goes.**
   - From the dock: Tasks with Comms open goes first; Comms with Tasks open goes last; with Comms made the big one,
     Tasks goes last.
   - From a link in a tile: with Inbox then Comms open, Tasks opened from the Inbox tile goes between them (position 1),
     not first.
   - From a widget: Tasks with Comms open goes last.
   - Swapping the pinned tile out of position 0 unpins it.
5. **Widgets never split.**
   - With Needs you, Art and Mark, and the first 1 to 4 of Tasks, Comms, Inbox and Knowledge, on screens of 1280, 1600
     and 1920 (areas 48 px narrower, 800 tall), no widget's rectangle is wider than 340 px.
   - With no apps, Vitals, Art, Needs you, Mark and Backup group into [Needs you] | [Art, Mark] | [Vitals, Backup].
6. **Rail, columns, strip, compact.** The widgets are Needs you, Art and Mark unless named.
   - Comms alone in 1872×890 on 1920 gives the widgets 2 columns (2 groups).
   - Comms alone in 1552×800 on 1600 with Needs you, Art and Vitals (3 groups) gives 2 columns, by room: Needs you in
     the left one, Art over Vitals in the right one.
   - Tasks and Comms there give a rail of 340 px; in 1552×800 on 1600, 300 px; in 1232×800 on 1280, 280 px.
   - Tasks and Changes in 1232×600 on 1280 give the strip (64 px).
   - Tasks and Comms in 1872×600 on 1920 with Needs you and three agents' cards draw the cards and Needs you compact,
     and don't scroll; with seven cards, the rail scrolls.
7. **Minimum or the dock.**
   - In 1232×597 on 1280, with Tasks and Comms open and Tasks focused after Comms, opening Changes from the dock sends
     Comms to the dock (it would be under its 360 px minimum height), its words "Comms went to the dock to make room for
     Changes: …minimum…", and every remaining app is at or above its minimum.
   - The same, opened from the Comms tile: Tasks goes instead, its words "Tasks went to the dock to make room for
     Changes: Comms would have been under its 360 px minimum height". The same with Comms made the big one: Tasks goes.
   - In 1104×700 on 1152, with Tasks open and the three widgets, Tasks and Changes would leave only the strip, and
     Tasks under its minimum beside it: opening Changes sends Tasks to the dock, and Changes alone then has a rail.
8. **The cap.** Areas are 48 px narrower than the screen; no app has had focus.
   - With Inbox and Comms open (760 tall), opening Knowledge on 1279 sends Inbox to the dock ("2 apps is the most this
     screen holds"); on 1280 it doesn't.
   - With Appearance, Accessibility and Account open (1000 tall), opening Passkeys on 1599 sends Appearance ("3 apps…");
     on 1600 it doesn't.
   - With those and Passkeys open (1300 tall), opening Secrets on 2559 sends Appearance ("4 apps…"); on 2560 it
     doesn't.
9. **Deterministic.** Tasks, Comms, Inbox and Knowledge and the three widgets in 1872×890 on 1920 give identical
   rectangles before and after laying out a different set in between.

**The desk (vitest + Chrome, `src/ui/desk-tiling.integration.test.ts`).** Criteria 10, 11, 16 and
19 run at 1024×768, 1280×800 and 1920×1080; 12 at 1280×776 and 1920×1080 (at 800 the desktop's one bar leaves room for
three tiles, and 12 is about one that doesn't fit); 13, 14, 17 and 18 at 1280×800 and 1920×1080 (17's four apps at
1920×1080 only); 15 at 1920×1080; 20 at 390×844 and across 1024.

10. **Open, focus, minimize.**
    - The Inbox key, then the Comms key, gives two tiles and an address whose query has `t=inbox,*comms`.
    - Comms's key again minimizes it: one tile, Comms in the dock, and `m=comms`.
    - Its key again brings it back on the page it was on, scrolled where it was.
11. **History per tile.**
    - In two tiles, a page change in each, then Back in the first: only the first goes back.
    - The browser's Back walks the focused tile's history.
    - Opening and closing tiles adds no browser history entries.
12. **Links.** With the Inbox and Comms open, a link to a task inside the Inbox tile opens Tasks in a tile at position
    1. A link between two Inbox pages stays in its tile.
13. **Widgets.**
    - Chat on Art's card opens Comms beside the rail on Art's latest thread.
    - Shrink to widget on Mark's window adds Mark's card and closes the window.
    - × removes a widget.
    - Every widget updates from `/events` without a reload: a new ask shows in Needs you.
14. **Reload.** A reload of `/comms?t=tasks!,*comms&m=inbox&w=art,needs` draws Tasks (pinned, first), then Comms,
    focused, the Inbox in the dock, and the two widgets, in that order.
15. **Keys.**
    - With Tasks, Inbox and Comms open and Tasks focused, Alt+Shift+→ moves focus to position 1 (the upper of the two on the
      right), and the live region says "tile 2 of 3, …"; Alt+Shift+↓ from there moves to position 2.
    - Alt+Shift+Enter makes it first. Alt+Shift+, swaps it with the tile before, Alt+Shift+. with the one after.
    - Alt+Shift+M minimizes it, Alt+Shift+W closes it.
    - Alt+H shows the desktop with every app in the dock; Alt+H again brings them back in their order.
    - Alt+← and Alt+→ move the focused tile's history only.
    - With a field focused, Alt+Shift+→ does nothing to the tiles. Esc with no pop-up open closes no tile.
16. **Scoped dialogs.**
    - A sheet opened in one tile has its overlay inside that tile's box.
    - Focus stays inside that tile on Tab.
    - Another tile's buttons still respond to a click.
    - Nothing outside that tile has `aria-hidden`.
17. **Nothing sideways, nothing overlapping, in order.**
    - With the first 1 to 4 of Tasks, Comms, Inbox and Knowledge (and, from phase 4, Needs you, Art and Mark), no two
      tiles' boxes overlap.
    - Every tile is inside the area between the bar and the dock, and the page never scrolls sideways.
    - The tiles' DOM order is the `t` order, then the widgets.
18. **The only desktop, seeded, and One window at a time** (`src/ui/desk-tiling-only.integration.test.ts`).
    - At 1280 and 1920, a fresh session (nothing saved) lands on the seeded widgets, Needs you, both agents' cards,
      Vitals and Backup, with no setting chosen; Appearance has no Desktop choice.
    - A saved `tiling: false` is served as `oneWindow: true`, and a device's `loom-tiling` of `off` starts with it on.
    - With One window at a time on, the Inbox then Comms gives one tile, Comms; the Inbox is in the dock, and the toast
      says `Inbox went to the dock to make room for Comms: one window at a time is on`. The widgets stay. Turning it
      on in Accessibility with two apps open leaves the focused one.
19. **Reduced motion.** With reduced motion, opening a second app starts no View Transition.
20. **Budget, and phones untouched.** First-page JS stays under 250 KB gzipped (`src/ui/web-app.test.ts`; it needs the
    built app, which CI builds before it tests, `.github/workflows/ci.yml`; locally, `npm run build` first). A 390 px
    screen fetches no `desk-*` asset, and `/comms?t=tasks,*comms` there draws Comms as today's phone page. A desktop
    window with the Inbox and Comms tiled, narrowed from 1280 to 900 px, draws Comms as today's phone page; widened back
    to 1280, the two tiles return.

**Pieces (vitest):**

21. A manifest's `tab.fit` reaches the desk's fit table. A `min` of `[200, 100]`, an `ideal` under its `min`'s width,
    or a `max` under its `ideal` is refused with a message naming the field.

22. **One bar** (`src/ui/desk-chrome.integration.test.ts`). At 1024, 1280 and 1920 the bar is one line, 34 px tall: the
    clock, then the name, on the left; LOOM//OS, then the glyphs, on the right; the ticker between, wider than either
    side's gap; a dot after the clock and one before the glyphs, `aria-hidden`, in the quiet colour, the bar's gap on
    both sides; the ticker's words, when they fit, within 3 px of the room's middle, and when they're too long, running
    (or under reduced motion starting at its left). No second bar; at 1023, two. iOS's home-screen app shows neither loom's clock nor its glyphs. A saved
    layout or an address with `ticker` in its widgets loads without it, and the
    device's copy is written again without it; the seed has no ticker; the desktop draws no headline. 390 px: the
    phone's bar, no clock, no glyphs.

23. **Tiles' strips, room, loader, moves** (`src/ui/desk-chrome.integration.test.ts`, `src/ui/spinner.test.ts`). A
    Comms thread's strip reads "Comms" once, no crumb; the name goes up to `/comms`, and a double-click on it
    minimizes the tile. Setup's Appearance reads "Setup › Appearance". At 1920 a lone Setup tile, with pages of Setup
    visited and a widget in the rail, has no Recent here and its page takes the tile's width; at 3000 with the Inbox
    beside it, Recent here is there. `Spinner` draws `data-size` sm, md (its default) or lg with four segments, as a
    status; those sizes are 16, 24 and 40 px under text of 12 px and of 40 px; no built asset carries the old spinner
    (`v-pulse__orbit`, `__hub`, `__mark`, `__label`). With motion, opening the Inbox and Comms, making Comms big, minimizing it,
    bringing it back and closing it wear `open, open, max, min, restore, close` and run `loom-fx-on`, `-glitch`,
    `-wipe-out`, `-wipe-in` and `-off`, none longer than 350 ms; under reduced motion the same steps wear none and run
    none.

24. **Context menus** (`src/ui/desk-chrome.integration.test.ts`). No + key in the dock. A right-click on the ground
    lists Needs you (on the desktop), each card, Vitals and Backup, and Vitals adds it; on a tile's page, none of
    ours. With nothing focused, Shift+F10 opens it with focus on the first item; ↓ and End move, ↓ from the last goes
    round, Home goes to the first, ↑ from the first goes round, Esc closes, Tab closes, Enter on Vitals adds it, Space
    on Backup adds it; the Menu key on the Inbox's dock key opens its menu and Esc
    gives focus back to it. A second tile's strip: Minimize, Make it the big one, Close; the big one's: Minimize,
    Close; an agent's: Minimize, Pin its card to the desktop, Close, and Pin adds the card, then Take its card off
    removes it. An agent's card: Chat, Open, Unpin from the desktop. A dock key: Open; then Open, Minimize, Close; then
    Open, Close; Home, All apps and your own key none. An Inbox row: Open (picks it in the reader) and Mark done (posts `needs-done`, the row leaves); with
    a reply kept unsent, Open only. On a tile's page and on a link in it, a `contextmenu` is left to the browser
    (`defaultPrevented` false).
25. **A page inside its frame** (`src/ui/desk-window-overflow.integration.test.ts`). For every app a test household has
    and a piece's long page, one window at 1280×800, 1920×1080 and 1280×600, and each as one of three tiles at 1280:
    nothing in a tile's body or its sheet layer is seen past the frame's ring (each box clipped as it's shown), at the
    body's top, middle and bottom; neither the frame nor the page ever scrolls, after focus too. The ring is drawn over
    the page, the frame's width, in the app's tint when focused, and a control keeps the look's focus outline. A sheet
    in a narrow tile on a short screen; Home's widgets and the launcher held to their own boxes.

## Build, in phases

Each phase is its own PR and leaves loom working, and every one passes criterion 20.

| phase | what | sessions |
|---|---|---|
| 1 | `usePage(url)` out of App.tsx; the phone and the shell use it once. No visible change. | 2–3 |
| 2 | `tiling/layout.ts`, the pure rule, with criteria 1–9 as its tests | 1 |
| 3 | The Appearance setting (off by default; gone since 2026-11-06), app tiles: the frame, focus, close, minimize and the dock, `?t=`/`&m=` and the device's saved set, history per tile (10–12, 14, 17 for apps) | 3–4 |
| after 6 | Tiling the only desktop: the old window and its setting removed, the seed, One window at a time in Accessibility (18) | 1 |
| 4 | Widgets as tiles: the rail, the strip, the launcher, pin, Chat beside, live, `&w=` (13, 14's widgets, 17 with widgets) | 2–3 |
| 5 | Scoped dialogs and sheets, per-tile transitions, keys, announcements, reduced motion (15, 16, 19) | 2–3 |
| 6 | `tab.fit` for pieces (21); widgets from pieces stay designed only | 1 |

The total is **about 11 to 15 sessions**. Phase 1 is the risky one: App.tsx is shared with other work in flight, so it
lands alone and early. Phases 1 to 4 are a usable tiling desktop. Phase 5 is what makes it solid for keyboards and
screen readers. It shipped before tiling could be the default; the owner then made it the only desktop (2026-11-06).

## Decided (the owner, 2026-11-06)

1. **Rail side:** the widget rail goes on the **right**.
2. **Two tiles of the same app** (two Comms threads side by side): **later**, not in this build.
3. **Tiling is opt-in** at first, a per-person Appearance setting: "Tiling" / "One window at a time". It becomes the
   default once phase 5 (tile-scoped dialogs, transitions, keys, plain mode) has shipped and been checked, when the
   owner says so: the build says when it's ready and doesn't flip it itself. **Superseded 2026-11-06:** after using it,
   the owner made tiling the only desktop ("toss it and make this the only option"), with a seeded start, and One
   window at a time an Accessibility option inside tiling ("I'd rather it behave like this and just prevent opening the
   second window"). The old window and its setting are gone.
4. **No drag-to-resize gutters** for now.
5. **Day-one widgets:** agent cards, Needs you, Vitals and Backup (the ticker widget retired 2026-11-06: the bar has it). A box's own vitals as a widget is
   allowed: the owner's rule of 2026-10-27 is that Home shows no box's own state (a box's state lives on its page),
   and a widget the person chooses to pin is a view of that page, not Home's. It is a follow-up, not in phases 1 to 6.
   A project's status widget is later too.

## Sources

- The owner's words: the coordinator's relay, 2026-11-05 (t-1884).
- The desktop before tiling: `web/src/desk.tsx` (`DeskHome`, `DeskWindow`, `deskGo`) before loom's tiling-only change
  (2026-11-06), which removed them.
- Per-app history: `web/src/trail.ts` (#536, t-1879).
- The first-page budget: `src/ui/web-app.test.ts`.
- The manifest: `docs/extensions.md` ("The manifest", `tab`, `tile`).
- Comms's layout: [comms.md](comms.md) ("The app").

## Review gate

Before this doc merges, a context-stripped reviewer reviews it. Every finding is folded in, accepted as a trade-off, or
rejected with a quote.
