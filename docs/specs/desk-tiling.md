# Desk tiling: apps share the screen, and widgets are tiles too

*2026-11-05; accepted 2026-11-06. Status: **accepted, building in phases**. This is a design doc in the `docs/specs/`
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

Today, at 1024 px and wider, an app opens in one big window over the desktop (`web/src/desk.tsx` `DeskWindow`). Comms
in a 1,800 px window is mostly empty. There are no saved layouts and no workspaces. Opening a second app splits the
screen by a rule. The rule reads each app's own declaration of how much room it can use. Home's widgets are small tiles
in the same arrangement.

This is loom's own design. It borrows the family (automatic dynamic tiling: each new window subdivides the newest) and
no product's look, keys or names.

## Words (to be added to CONTEXT.md)

**Tile**:
one app on a big screen, sharing the screen with others by the tiling rule. It has its own page, its own history and
its own frame.
_Avoid_: window (today's single big frame), pane, panel

**Widget**:
a small tile: one of Home's cards (an agent's card, Needs you, Vitals, Backup, the ticker). It is
live, it never gets a split of its own, and it opens its app beside it.
_Avoid_: gadget, applet

**Fit**:
what an app declares about the room it can use: a minimum, an ideal and a maximum width, a minimum height, and whether
it wants the big slot.
_Avoid_: size hint, constraints

**The big slot**:
the first app tile, which is the large one on the left once there are three or more apps.

**The rail**:
the column the widgets stack in, on the right, while apps are open. **The strip** is the rail folded to one 64 px key
per widget.

## The rule

The layout is a pure function: `layout(apps, widgets, area, screen) → rectangles`. It has no state of its own. Given the
same tiles in the same order, it draws the same screen, whatever it was asked before. Gutters are 10 px.

- `area` is the room the tiles share, in px: the desk between the bars and the dock, inside the desk's own 24 px side
  gutters (`desk.css` `--desk-gutter`).
- `screen` is the viewport's width (`innerWidth`). The caps (rule 4) and the widget column's width read it, never the
  area.
- Each widget brings its height as drawn at the column's width (measured), or, until it's measured, the default height
  in the widget table below.

The rule lives in `web/src/tiling/layout.ts` (`layout`, `place`, `admit`, `promote`, `swap`), its tests in
`src/ui/desk-tiling-layout.test.ts`.

### 1. Widgets first: the desktop, a rail, or a strip

- **No app open:** the widgets *are* the desktop, laid out as Home is today, its headline across the top. Needs you is
  the left column, the agents are the middle (their cards fill it two or three across), and everything else is the right
  column. A fresh device starts here, with today's Home set: Needs you, each agent's card, Vitals and Backup. With apps
  open, the headline isn't drawn.
- **Apps open:** the widgets move to the right edge.
  - A widget column is 280 px wide on a screen under 1440 px, 300 px under 1920, and 340 px from 1920.
  - If the apps' combined **max** leaves room for at least one column and a gutter, the widgets get as many columns as
    fit there, up to 3 and no more than the groups the widgets fall in (Needs you, the agents, the rest: so Needs you,
    Art and Mark make 2 groups). Each group is a column; with fewer columns than groups, the last groups share the last
    column.
  - Else, if the apps' combined **min** leaves room for one column, the widgets stack in a **rail** one column wide.
  - Else the rail folds to the **strip**: one 64 px key per widget, with a face or an icon and a count. A key opens the
    widget's app. The strip always takes its 64 px and a gutter; an app that then falls under its minimum is rule 4's
    (it goes to the dock), never drawn over.
  - "Combined" is the width the apps need split as rule 2 splits them: the first beside the rest, the second over the
    rest, and so on (`need` in `layout.ts`); an app without a max makes the combined max unlimited.
- A rail taller than the screen draws its cards and Needs you compact (a card shows its face, name and status line; Needs
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
  2. Then the maxes: if the first has a max and none of the rest can use more (any of the rest has no max), the first
     stops at its max. If the first has no max and the rest all have one, the first takes at least what the rest can't
     use (`W − their combined max`). When both sides have a max, or neither does, step 1's width stands: a max only
     decides who takes the room when one side can use it and the other can't. (Room past every max goes to widget
     columns, rule 1.) A max applied here can take the first under 34 percent.
  3. Then the minimums: the rest keep their combined minimum, and the first keeps its own as far as that allows.
- **Stacked:** half each (`round((h − gutter) / 2)`), then clamped so the rest keep the largest minimum height among
  them, and the first keeps its own as far as that allows.

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
- A toast says which app went to the dock and why, and the live region (Accessibility) says the same words: "Comms
  went to the dock to make room for Changes: it would have been under its 360 px minimum height", or "…: 3 apps is the
  most this screen holds".

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
| the ticker | 260×44 | 44 | as drawn |

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

  Every key is optional and falls back to the default row. A `min` under 320×240, an `ideal` under the `min`'s width,
  or a `max` under `ideal` makes the manifest refuse with a message, the way a bad `accent` does.
- **Widgets from pieces (designed, not built):** a manifest's `widgets: [{ "id", "label", "page", "fit", "opens" }]`.
  `page` is a piece page drawn small, with the same blocks. `opens` is the page its "Open" goes to. The `tile` Home
  summary a piece already has is its default widget, so every piece with a tile has a widget for free. Building it waits
  until a piece wants more than its tile.

## Widgets: adding, linking, removing

- **Adding:**
  - A **+ key** in the dock (the widget launcher) lists what can go on the desktop: Needs you, each agent's card,
    Vitals, Backup and the ticker. One already on the desktop shows "on the desktop" and focuses it. The ticker
    widget shows the same feed as the bar's ticker (`phone-bar.tsx`); the bar keeps its own.
  - **Find** lists the same as "Add widget: …".
  - An agent's pages have **Pin card to the desktop**, and the dock's agent key menu has it too.
- **Linked:** a widget's actions open its app beside it. On an agent's card, **Chat** opens that agent's latest Comms
  thread and **Open** opens their pages. On Needs you, an ask opens in the Inbox. An app opened this way goes last, next
  to the rail. A widget is live: it draws from the same live data its app does (`/events`), so it never goes stale.
- **Removing:** a widget's × removes it, like any tile. Removing the last widget leaves the ground. With no app and no
  widget, the desktop says "No tiles. Open an app from the dock, or add a widget with the + key."
- **Order:** widgets keep the order they were added in. Drag one onto another to swap them. In the desktop layout (no
  apps) they group by kind, as Home does.

## Interaction

- **Opening, from the dock or Find:**
  - If the app isn't open, a tile is added.
  - If it's open, its tile is focused, and goes to the page asked for when that's another page.
  - If it's minimized, it comes back into the layout where its history stands.
- **The focused app's own dock key** minimizes it, as it does today (`desk.tsx`, #532).
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
  minimizes the tile, as it minimizes today's window.
- **Resizable gutters:** not built (decided 2026-11-06). The split ratios come from fit, and a dragged ratio would need
  saving per pair of apps per screen width. If the owner misses it after use, it's a phase of its own.

### Keys

Tiling keys use **Alt+Shift**. No browser binds it, Option+Shift on a Mac only types characters (and these keys rest
while a field has the keys), and the alone-chord that switches input language on Windows is never pressed with an arrow
or a letter.

| keys | what |
|---|---|
| Alt+Shift+← ↑ → ↓ | focus the tile that way (by position, widgets included) |
| Alt+Shift+Enter | make this the big one |
| Alt+Shift+, / . | swap with the tile before / after |
| Alt+Shift+M | minimize to the dock |
| Alt+Shift+W | close the tile |
| Alt+← / → | Back and Forward in the focused tile, only when it has somewhere to go (as today, #536) |
| Alt+H | Home: apps to the dock, the desktop shows |

Esc never closes a tile: with several on screen, it would close the wrong one too easily. Esc still closes a sheet, a
dialog and Find.

## Per-tile pages and history (reusing #536)

#536 gave each app its own history (`web/src/trail.ts`: `note`, `step`, `keepTop`, `lastAt`, `visited`, `minimize`,
`restore`, `forget`, keyed by app). The window's strip (`DeskWindow`) draws Back, Forward and a trail from it. Tiling
reuses all of it:

- **History key:** a tile's key is its app's key, as `trail.ts` has it. So a tile's Back, Forward, trail, Recent here
  and minimize-where-it-was are #536's, unchanged. (Two tiles of the same app, later, would need a key of their own.)
- **One page loader per tile:** `App.tsx` loads one page for the whole screen today (`url`, `data`, `error`, `waiting`,
  `load()`). Phase 1 moves that into a hook, `usePage(url)`, that each tile runs for its own URL. The phone and the
  shell keep using it once, so nothing visible changes. Redirects, `_flash`, live refresh (`/events`) and the page's own
  refresh rules move with it.
- **The tile's Env:** each tile renders inside its own `EnvContext` (`web/src/blocks.tsx` `Env`). The tile's `go`
  follows the link rules above, and its `send` is its own page's. Blocks need no change: they already link and act
  through `useEnv()`.
- **The frame:** `DeskWindow`'s strip becomes the tile's strip, slimmer: 30 px with the app's key, Back, Forward, the
  trail, then ⤢, _ and ×. The side column (`SIDE_COLUMN`, Recent here) shows in a tile only when the tile is at least
  1,100 px wide.

### Sheets and dialogs stay inside their tile

Radix dialogs and sheets portal to `<body>`, trap focus across the whole page and hide everything else from assistive
tech. In a tile:

- Each tile has its own portal root. A tile's `Dialog`, `Sheet`, `DropdownMenu` and `Select` render into it, through a
  `PortalContainer` context the `components/ui` wrappers read.
- A tile's dialog is modal to its tile only. Its overlay covers the tile, its focus trap is the tile, and the other
  tiles stay usable and readable. The desk's own keys ask `popUpOpen()` (`desk.tsx`) before taking Esc or Alt+←/→;
  that check becomes per tile.
- `Sheet` here is `web/src/panel.tsx`'s (a `components/ui/dialog` when wide); it takes the same container.
- Find, toasts and the boot stay screen-wide.

### Transitions

- **Reflow:** each tile carries `view-transition-name: tile-<id>`, so one document View Transition morphs every tile
  from its old box to its new one when tiles are added, closed, swapped or promoted.
- **A page change inside a tile** names only that tile's body, so the others don't move.
- Only one transition runs at a time. A change during one applies without animation.
- **Reduced motion** (`access.ts`) skips all of it, and the layout simply changes.

## The address, and what each device keeps

- **The path** is the focused tile's own page, so a copied address opens that page anywhere, a phone included.
- **The query** holds the set:
  - `t` is the apps on screen in order, each by its key's name (the last part of its dock key's path: `comms`,
    `inbox`, `tasks` for `/p/tasks`), a `*` before the focused one and a `!` after the pinned one: `*tasks!` is both.
  - `m` is the minimized apps, in the order they went to the dock.
  - `w` is the widgets in order (`needs`, `vitals`, `backup`, `ticker`, and an agent's card by the agent's id).
  - For example, `/comms/th/7f3a?t=tasks!,*comms,inbox&m=boxes&w=art,mark,needs`. Each app's page is its own history's
    (`trail.ts`, this tab's), and the path is the focused one's.
- **On reload**, the address restores the set, minimized apps in the dock.
- **A bare `/`** restores this device's last set from `localStorage` (`loom-tiles`, wrapped in try/catch), and else the
  fresh-device set.
- **Under 1024 px, or with One window at a time,** `t`, `m` and `w` are ignored, and the saved set is neither read nor
  written: the path's page draws as it does today. A window narrowed under 1024 px with tiles open shows the focused
  tile's page as today's phone page; widened again, the set comes back from the address.
- **Inside a tile, a page change** is a `pushState` of the new address, with `{tile}` in its state. So the browser's
  Back and Forward walk the focused tile's history, the way `trail.ts` takes a `pop`.
- **Opening, closing, swapping and promoting** use `replaceState`, so the browser's Back never closes a tile.

## Accessibility

- **Focus order:** the DOM order is the order list (`t`): position 0 (the big slot), then 1, 2 and so on, which is the
  order the rule subdivides them in; then the widgets in their order. Tab order and reading order follow it.
- **Each tile** is a `region` with `aria-roledescription="tile"` and the label "tile 2 of 3, Comms". Moving focus with
  the keys moves it to the tile's title, which announces exactly that.
- **One polite live region** says what changed: "Tasks opened, tile 1 of 3"; "Inbox closed"; and rule 4's toast,
  word for word.
- **The setting:** tiling is a per-person Appearance setting, "Desktop", with two choices: **Tiling** and **One window
  at a time**. It's kept by loom with the rest of Appearance (`/appearance/prefs`, a `tiling` field), with this device's
  copy in `localStorage` (`loom-tiling`) for first paint, the way a look is. One window at a time is today's desktop:
  apps open one at a time in today's big window, and Home is today's Home. It is the default until phase 5 has shipped
  and been checked; then the owner decides whether Tiling becomes the default. Either way it is never forced on anyone:
  One window at a time stays a choice, and it is the plain mode.
- **Reduced motion** skips the reflow animation (above).
- The hover-only parts (the strip's buttons' hover state) also show on focus.

## Budget

First-page JS is about 239 KB of the 250 KB budget (`src/ui/web-app.test.ts`).

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
2. **Dwindle, and every split the same step.** Tasks, Inbox, Comms, Knowledge in 2560×1300: Knowledge sits beside
   Comms, under Inbox; Comms's width is `round(W × 680/(680+760))` of its own region's `W` (the region less a gutter).
   The threshold: Inbox and Comms in 1200×1000 sit side by side, in 1100×1000 they're stacked.
3. **Fit sets the ratio, then the maxes, then the minimums.**
   - In 1538 wide, Tasks then Comms gives Tasks `round(1528 × 1040/1720)` = 924 px and Comms the remaining 604 px.
   - In 3200 wide, Boxes (max 1200) then Tasks (no max) gives Boxes 1,200 px, its max, not the ratio's 1,406.
   - In 3000 wide, Setup (max 680) then Tasks gives Setup 680 px: the max wins over the 34 percent floor.
   - In 1810 wide, Comms (max 820) then Inbox (max 980) gives Comms 850 px and Inbox 950: with both capped, the ratio
     stands.
4. **Where a new app goes.**
   - From the dock: Tasks with Comms open goes first; Comms with Tasks open goes last; with Comms made the big one,
     Tasks goes last.
   - From a link in a tile: with Inbox then Comms open, Tasks opened from the Inbox tile goes between them (position 1),
     not first.
   - From a widget: Tasks with Comms open goes last.
   - Swapping the pinned tile out of position 0 unpins it.
5. **Widgets never split.**
   - With Needs you, Art and Mark, and 1 to 4 apps, on screens of 1280, 1600 and 1920 (areas 48 px narrower, 800
     tall), no widget's rectangle is wider than 340 px.
   - With no apps, Vitals, Art, Needs you, Mark and Backup group into [Needs you] | [Art, Mark] | [Vitals, Backup].
6. **Rail, columns, strip, compact.** The widgets are Needs you, Art and Mark unless named.
   - Comms alone in 1872×890 on 1920 gives the widgets 2 columns (2 groups).
   - Tasks and Comms there give a rail of 340 px.
   - Tasks and Changes in 1232×600 on 1280 give the strip (64 px).
   - Tasks and Comms in 1872×600 on 1920 with Needs you and three agents' cards draw the cards and Needs you compact,
     and don't scroll; with seven cards, the rail scrolls.
7. **Minimum or the dock.**
   - In 1232×597 on 1280, with Tasks and Comms open and Tasks focused after Comms, opening Changes from the dock sends
     Comms to the dock (it would be under its 360 px minimum height), its words "Comms went to the dock to make room for
     Changes: …minimum…", and every remaining app is at or above its minimum.
   - The same, opened from the Comms tile: Tasks goes instead. The same with Comms made the big one: Tasks goes.
   - In 1104×700 on 1152, with Tasks open and the three widgets, opening Changes sends Tasks to the dock, and the strip
     keeps its 64 px.
8. **The cap.** With Inbox and Comms open in 1232×760, opening Knowledge on a 1279 px screen sends one to the dock
   ("2 apps is the most this screen holds"); on 1280 it doesn't.
9. **Deterministic.** Four apps and the three widgets in 1872×890 on 1920 give identical rectangles before and after
   laying out a different set in between.

**The desk (vitest + Chrome, `src/ui/desk-tiling.integration.test.ts`, at 1024×768, 1280×800 and 1920×1080, Tiling
chosen):**

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
    - Pin card to the desktop on Mark's pages adds Mark's card.
    - × removes a widget.
    - Every widget updates from `/events` without a reload: a new ask shows in Needs you.
14. **Reload.** A reload of `/comms?t=tasks!,*comms&m=inbox&w=art,needs` draws Tasks (pinned, first), then Comms,
    focused, the Inbox in the dock, and the two widgets, in that order.
15. **Keys.**
    - With three tiles, Alt+Shift+→ moves focus to the tile on the right, and the live region says "tile 2 of 3, …".
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
    - With 1 to 4 apps (and, from phase 4, Needs you, Art and Mark), no two tiles' boxes overlap.
    - Every tile is inside the area between the bars and the dock, and the page never scrolls sideways.
    - The tiles' DOM order is the `t` order, then the widgets.
18. **The setting.** With no choice made, the desktop is One window at a time: opening a second app replaces the first
    in today's window, and Home is today's Home. With Tiling chosen, the second app gives two tiles. Choosing either in
    Appearance applies at once, without a reload.
19. **Reduced motion.** With reduced motion, opening a second app starts no View Transition.
20. **Budget, and phones untouched.** First-page JS stays under 250 KB gzipped (`src/ui/web-app.test.ts`; it needs the
    built app, which CI builds before it tests, `.github/workflows/ci.yml`; locally, `npm run build` first). A 390 px
    screen fetches no `desk-*` asset, and `/comms?t=tasks,*comms` there draws Comms as today's phone page.

**Pieces (vitest):**

21. A manifest's `tab.fit` reaches the desk's fit table. A `min` of `[200, 100]`, an `ideal` under its `min`'s width,
    or a `max` under its `ideal` is refused with a message naming the field.

## Build, in phases

Each phase is its own PR and leaves loom working, and every one passes criterion 20.

| phase | what | sessions |
|---|---|---|
| 1 | `usePage(url)` out of App.tsx; the phone and the shell use it once. No visible change. | 2–3 |
| 2 | `tiling/layout.ts`, the pure rule, with criteria 1–9 as its tests | 1 |
| 3 | The Appearance setting (off by default), app tiles: the frame, focus, close, minimize and the dock, `?t=`/`&m=` and the device's saved set, history per tile (10–12, 14, 17 for apps, 18) | 3–4 |
| 4 | Widgets as tiles: the rail, the strip, the launcher, pin, Chat beside, live, `&w=` (13, 14's widgets, 17 with widgets) | 2–3 |
| 5 | Scoped dialogs and sheets, per-tile transitions, keys, announcements, reduced motion (15, 16, 19) | 2–3 |
| 6 | `tab.fit` for pieces (21); widgets from pieces stay designed only | 1 |

The total is **about 11 to 15 sessions**. Phase 1 is the risky one: App.tsx is shared with other work in flight, so it
lands alone and early. Phases 1 to 4 are a usable tiling desktop. Phase 5 is what makes it solid for keyboards and
screen readers. It ships before tiling can be the default: One window at a time stays the default until phase 5 has
shipped and been checked, and then the owner decides.

## Decided (the owner, 2026-11-06)

1. **Rail side:** the widget rail goes on the **right**.
2. **Two tiles of the same app** (two Comms threads side by side): **later**, not in this build.
3. **Tiling is opt-in** at first, a per-person Appearance setting: "Tiling" / "One window at a time". It becomes the
   default once phase 5 (tile-scoped dialogs, transitions, keys, plain mode) has shipped and been checked. The build
   says when it's ready to flip and doesn't flip it itself.
4. **No drag-to-resize gutters** for now.
5. **Day-one widgets:** agent cards, Needs you, Vitals, Backup and the ticker. A box's own vitals as a widget is
   allowed: the owner's rule of 2026-10-27 is that Home shows no box's own state (a box's state lives on its page),
   and a widget the person chooses to pin is a view of that page, not Home's. It is a follow-up, not in phases 1 to 6.
   A project's status widget is later too.

## Sources

- The owner's words: the coordinator's relay, 2026-11-05 (t-1884).
- Today's desktop: `web/src/desk.tsx` (`DeskHome`, `DeskWindow`, `deskGo`), `web/src/desk.css`, `web/src/App.tsx`.
- Per-app history: `web/src/trail.ts` (#536, t-1879).
- The first-page budget: `src/ui/web-app.test.ts`.
- The manifest: `docs/extensions.md` ("The manifest", `tab`, `tile`).
- Comms's layout: [comms.md](comms.md) ("The app").

## Review gate

Before this doc merges, a context-stripped reviewer reviews it. Every finding is folded in, accepted as a trade-off, or
rejected with a quote.
