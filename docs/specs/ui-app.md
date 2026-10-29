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
  (with its count), Places, Find, and More.
- **Desktop:** the same dock as its labelled **rail** down the left side,
  every tab in it.
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
We install only the components we use, and trim their CSS.

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
- The JS and CSS stay inside the budget.

## Open questions

- **Server rendering** for the first paint: not at first (loom is behind a
  sign-in, on a LAN or a tailnet, and the app shell is cached by the service
  worker). Revisit if first loads feel slow on a phone.
- **loom's own look inside 000h**: 000h's look, whole. Each agent's pages take
  their own accent from 000h's palette (Jonathan, accepting: "agents could get
  different accents if you guys like the 000h options"): an agent's mark color
  becomes one of 000h's accents, and its pages, its dock and its sheets wear it.
  Which accent goes to which agent is chosen on its Setup, as its color is now.
- **Animate UI**, the shootout's runner-up: not used. Its licence is MIT with
  the Commons Clause, and 000h covers the same components, plain MIT.
