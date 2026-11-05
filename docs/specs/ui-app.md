# loom's page as an app: React, shadcn and 000h

*2026-10-28. Status: **accepted** (Jonathan, terminal, 2026-10-28: "Agreed completely"). Jonathan, terminal, after a shootout of
three builds of Art's Houses tab on real data (plain shadcn, shadcn with
Animate UI, shadcn with 000h, then 000h as an app with a bottom dock and
pop-ups): "this fucks hahaha. I love it so much. Let's do it for real." Earlier
the same day: "what needs to be done to it is organization, structure and
prettiness ... if we can take something off the shelf that works, we save a
lot of brain time", and on 000h: "using it, it immediately is a better mobile
experience". The lab is `~/Code/loom-ui-lab` on loom's machine (not in any repo).*

## Why

loom's page is hand-rolled HTML strings (`src/ui/render.ts`) and one
stylesheet (`src/ui/style.ts`). It works, and every improvement to it is ours
to build from nothing: tab bars that overflow on a phone, menus, dialogs,
sheets, motion, focus. The pieces never see any of it: they send JSON blocks
(`src/ui/vocab.ts`) and loom draws them. So the drawing can be replaced
without touching a piece.

## What stays, what changes

**Stays:**
- The JSON vocabulary pieces send (pages, sections, blocks, manifests, asks,
  act results), and its validation in `vocab.ts`. No piece changes.
- loom's server: routing, auth, sessions, CSRF, owner scoping, the piece calls,
  actions, push, passkeys. Every page is still decided on the server.
- The page data loom already builds before it renders: `Page`, `Chrome` (with
  its `Shell`: agents, marks, scope, asks), `HomeTile`, `HomeAsk`, `Dashboard`,
  `InboxItem`, `HouseHome`, `AgentHead`. These become the JSON views below.

**Changes:**
- The 13 places in `src/ui/handler.ts` that answer `html(renderX(...))`
  answer through one `view(res, kind, data)`: HTML from the old renderer, or
  the same data as JSON when the request asks for it (`Accept:
  application/json`). That's the whole server change.
- A React app (`web/` in this repo) draws those views: React 19, Vite,
  Tailwind 4, shadcn/ui on Radix, and 000h's components (cojeev.com/ui, MIT,
  installed as source through the shadcn CLI: we own and can change the
  copies). It's built into `dist/web/` and served by loom as static files.
- The login pages (link, passkey) stay server HTML: they come before a session,
  and they're small.

## The app

### Navigation

- **Phone:** a compact top bar (the scope's mark, the page's title, the agent's
  state as 000h's `AgentState`, the light/dark toggle) and **000h's dock fixed
  at the bottom**, above the home indicator (safe-area insets). On an agent's
  pages the dock holds Today and three of its tabs, and **More** (a drawer with
  the rest and the switch to another agent). On the household's: Home, Inbox
  (with its count), Places, Find, and More. A member who owns an agent also has
  **Comms** ([comms.md](comms.md)), with its count of unread threads.
- **Desktop:** the same dock as its labelled **rail** down the left side,
  every tab in it.
- **Inside an app** (Jonathan, 2026-11-05: "back/breadcrumbs/etc first … menus is
  something we can do but I don't know if we need to"; no menu bar): each app keeps
  its own history in the tab (`web/src/trail.ts`). A desktop window's title strip
  has **Back ‹** and **Forward ›** through it, and a **trail** (the app, the page
  this one is under, this one) whose crumbs go up, each to that page as it was last
  left (the list with its query). Back from a task is the list you came from, at
  its query and its scroll. **Alt+←** and **Alt+→** are the window's Back and
  Forward while the window has the keys and has somewhere to go that way; in a
  field, a sheet or a menu, from the dock or Find, or at the start of the app's
  history, the keys stay the browser's own. The window's Back is a new page in the
  browser's history, so the browser's Back undoes it, and the browser's Back and
  Forward that land on the app's page before or after this one move its history
  too. A long trail folds its middle into "…" before the page's own name is cut
  short, and the strip never scrolls. A minimized window opens again where its
  history stands; Close forgets it. On a phone, a page under another has the bar's
  **back chevron**: it goes to the page before this one in the same app, as it was
  left, and to the page it's under only when there's none (a page opened from a
  link, Find or the Inbox).
- **The side column**: a page's `"place": "side"` sections
  ([extensions.md](../extensions.md), "Pages"). From 1280 px wide (the common laptop
  widths get it; narrower, the page itself would drop under about 700 px), a desktop
  window's own right-hand column, 300 px, scrolling down by itself; a page with none
  gets **Recent here** (this app's pages opened lately on the device), never the
  whole household's. Narrower, and on a phone, they fold together at the top of the
  page, closed. Nothing in it scrolls sideways.
- **Installable:** loom's existing manifest and service worker (`src/ui/pwa.ts`)
  get the app's icons and `display: standalone`; added to a home screen it opens
  without the browser's chrome. Push stays as it is.

### Blocks to components

The renderer decides how a block is presented from what it holds; no piece is
asked to say. The rules that the shootout settled:

| Block | Drawn as |
|---|---|
| `list` | rows; a row's `act` is its button (a danger one asks first, `alert-dialog`); a row with `page` opens it |
| `details` holding a `form` | a button that opens the form as a focused editor (`dialog`, `appearance="editor"`) |
| `details` holding a list or a table | a button with its count that opens a bottom `drawer` |
| `details` holding other details (a service's Move and Take down) | the row opens an action sheet (`drawer`) |
| `form` at the top level | inline, as today, unless the section is a side section: then a button and an editor |
| `table` | a table on a desktop; on a phone, rows of label and value (no sideways scroll) |
| `panel` | a card of rows, each its label, its value in words and one control: a `switch`, a segmented `toggle-group`, or a row that opens a sheet (`drawer` on a phone, `dialog` on a desktop) |
| `health` | a big tone icon and the state in plain words; `stats` tiles under it may carry a spark line or a `progress` bar |
| `kv`, `stats`, `meter`, `status`, `callout`, `text`, `prose`, `code`, `link`, `filters`, `buttons` | their 000h counterparts (`item`, `progress`, `badge`, `alert`, `typography`, `code-block`, `living-link`, `toggle-group`, `button`) |
| an action's result | 000h's toast, with Undo when the result carries one; a `page` result navigates |

A block a version of the app doesn't know is drawn as plain text with a note, never
dropped, so an old app and a new piece can't lose data between them.

### Motion

000h's own motion, and its rules: reduced motion respected everywhere (things
still appear, nothing moves), hover effects only on fine pointers, 44px touch
targets, nothing important only in a tooltip.

### Weight

The shootout's 000h build was heavy: 242 KB of JS and 341 KB of CSS gzipped,
because each component brings its whole stylesheet. Budget for the real app:
under 250 KB of JS and 120 KB of CSS gzipped for the first page, enforced in CI.
We install only the components we use, and trim their CSS. The looks
(`web/src/looks/looks.css`, in the app's stylesheet) count toward the CSS, and
the script that puts the look on before first paint (`web/src/looks/boot.js`)
stays under 1 KB gzipped (`src/ui/look-boot.test.ts`).

## Live, and fast

Jonathan, 2026-10-29: "this site is sloooow. are we doing anything smart here? websocket to send own
information as it updates, limited page refresh based on what needs to change, anything?" Then, of the push:
"anything new coming in should look magical as fuck as it happens".

- **Pieces never hold a page up.** A piece's manifest past its 45s window, and a piece's page past 5s, are
  served from the last answer while a fresh one runs behind it (`src/ui/pieces.ts`). An action on a piece
  drops its kept pages.
- **Small on the wire.** The app's files go out br or gzip, packed once at start; a page's data is compressed
  and carries a fingerprint (`ETag`): asked again with it, an unchanged page is a 304.
- **Instant back and forth.** The app keeps the last copy of each page it showed and opens it at once on a tap,
  asking loom behind it.
- **Live.** One stream per open app (`GET /events`, server-sent events, `src/ui/live.ts`) says `change` when an
  agent's memory, knowledge or people, or the household file, is written; when a piece's manifest answers
  differently (asked every 15s while an app is open); and after any action. The app asks again for the page it
  shows. While the stream is open, the old timer is a 60s fallback.
  - A Comms thread has its own stream while it's on screen (`GET /comms/<thread>/events`, [comms.md](comms.md)),
    owner-checked like its other routes. The shared stream's `change` for a thread goes only to that thread's member.
  - Comms is its own chunk, loaded only when it opens, so it adds nothing to the first page's budget.
  - The face states gain `talking`, for a reply landing. A manifest without it plays `done`'s animation, then
    `working`'s.
- **What's new arrives** (`web/src/arrive.tsx`): a row, a thread line, an Inbox item, an ask, a tile or a
  reading that wasn't there at this page's last answer resolves out of glyph noise (000h's decode), comes into
  focus out of a blur, and glows once. A page you open draws still. Reduced motion: it simply appears.

## Moving there

Each step ships on its own; nothing is taken away until its replacement has
been used.

1. **JSON views.** `view()` in the handler; every page loom serves as HTML can be
   asked for as JSON. Tests: each view's JSON matches what the HTML was drawn
   from, and the auth, scoping and CSRF rules are the same for both.
2. **The app, beside the old page.** `web/` scaffolded with shadcn and the 000h
   components; built in CI; served at every page path when the browser carries
   `loom_view=app` (a toggle in Setup, and `?ui=app` to try it). Everyone else
   keeps today's page.
3. **Pages and blocks.** The shell (dock, rail, top bar, sheets), the `Page`
   view, every block per the table, actions and toasts. Then Home, the Inbox, an
   agent's Today (`Dashboard`), the house home, Places and Find.
4. **The phone.** Installable, safe areas, the dock's More, swipe to dismiss
   sheets, checked on an iPhone and an Android.
5. **The default.** Done 2026-10-29, ahead of the week (Jonathan: "the Ui switch
   is kind of making me nuts because it's easy for me to do shit on the pwa and
   just lose the cookie. Let's go ahead and swap to this thing full time for now.
   You can remove all back to classic stuff too"). Every browser opening a page
   (`Sec-Fetch-Dest: document`, or `Accept` naming `text/html`, which is what a
   service worker's re-sent page load carries) gets the app; the `loom_view` cookie and `?ui=`
   are gone. (Superseded by step 6 below: every page is the app.)
6. **The old renderer goes.** Done 2026-10-29, the same day (Jonathan: "Oh let's
   just remove classic entirely"). Every page GET without `Accept:
   application/json` answers the app's page; Passkeys moved into the app (its
   WebAuthn control and push switch, `web/src/passkeys.tsx`). `render.ts` keeps
   the page data's types, the links rule and the sign-in pages; `style.ts` is
   their stylesheet and `/app.js` their few lines of script.

## What the tests must pin

- Every view's JSON is exactly the data its HTML is drawn from, under the same
  auth, owner scoping and CSRF.
- Every block type in `vocab.ts` renders in the app, from a fixture per type
  (a new block type fails the build until it has one).
- On a phone and a desktop viewport (Playwright), the main pages load with no
  console errors and no sideways scroll, the dock and rail reach every tab, and
  each pop-up opens and closes.
- With reduced motion, nothing moves.
- Reduced motion and more contrast are the person's (the Accessibility app: Follow the
  phone, On, Off), worn as `<html data-motion>` and `<html data-contrast>`; the build
  rewrites every `prefers-reduced-motion` and `prefers-contrast: more` query onto them
  (`web/vite.config.ts` accessMedia), and JS asks `web/src/access.ts`, never the query.
- The JS and CSS stay inside the budget.

## Open questions

- **Server rendering** for the first paint: not at first (loom is behind a
  sign-in, on a LAN or a tailnet, and the app shell is cached by the service
  worker). Revisit if first loads feel slow on a phone.
- **loom's looks** (Jonathan, 2026-11-04: "neon noir with a few things borrowed
  from terminal hud"; 2026-11-05: "give them a less severe version of neon instead
  where we can just swap colors"): one structure, Neon Noir's, and a look is only
  a set of tokens over 000h's (`web/src/looks/looks.css`): Neon Noir (the
  default, dark), Low Light (dark, calm: 000h's soft dark colours) and Daylight
  (light). A look kept as 000h before then is Daylight if it was light, else Low
  Light. The look, the ground and sound are the person's, kept by
  loom per member and carried on every page's chrome (`POST /appearance/prefs`);
  so is Accessibility's (Allow zoom, Reduce motion, Higher contrast).
- **loom's own look inside 000h's components**: Each agent's pages take
  their own accent from 000h's palette (Jonathan, accepting: "agents could get
  different accents if you guys like the 000h options"): an agent's mark color
  becomes one of 000h's accents, and its pages, its dock and its sheets wear it.
  Which accent goes to which agent is chosen on its Setup, as its color is now.
- **Animate UI**, the shootout's runner-up: not used. Its licence is MIT with
  the Commons Clause, and 000h covers the same components, plain MIT.
