# Building a loom app

> **Archived 2026-11-28 (t-2428).** This guided building the desktop's apps (`web/src/kit`, `components/ui`), which were
> removed with the desktop. The boards page's bricks have their own kit: `web/src/boards/brick-kit.tsx`
> ([docs/specs/boards.md](../specs/boards.md)).

Use `web/src/kit` over the cojeev `components/ui` primitives. Colours come from look tokens; do not add per-look app styles. The kit works in Neon Noir, Low Light and Daylight.

- `AppFrame`: `title`, `actions`, `filters`, `crumb`, `go`, `where`, optional `lead`, `context`, `more`, and `about`. Its header uses AppHeader and the breadcrumb primitives. `about` participates in the desktop's right-click Chat about this hook; the window menu still derives the page from its URL. Never offer chat for a list as though it were an item.
- `List` groups rows under an accessible `label`. `Row` takes `title`, `meta`, `icon` (an icon or avatar), `status`, `trailing`, `actions`, `selected`, `unread`, and standard button attributes/ref. The row itself opens the item; `trailing` is noninteractive text and `actions` holds independently focusable sibling controls. Supply `data-row-menu` and handle `loom-menu` for actions; do not nest buttons. `layout="stack"` is for text-heavy lists. Pass `aboutAttr` for item chat.
- `Split` is a complete list/detail frame: folders, list title/count, search/filters, rows, detail and back navigation. Use it instead of wrapping it in another AppFrame. It measures its tile: three panes from 900px, two from 640px, one below. On a phone, opening pushes the reader over the list; Back/Escape restores focus. Arrow keys move rows. Existing imports from `split.tsx` remain compatible while apps migrate.
- `Empty` says what is absent and optionally how it gets here. Search: “Nothing matches …”. A first use: “No … yet” with a useful next step. `Loading` uses a live status; give a short verb (“Opening contact…”). `Error` says what could not load, a useful explanation and an optional `retry` callback. Never show an error as an empty result.

Keep data derivation and actions in the app. Start by moving its markup, then migrate its remaining read models in the same app pass. Changes and Inbox prove the row/state/Split path; their existing data and answer guards stay in place.

`npm --prefix web run lint` and the web build flag new app row/header/empty CSS outside the kit. `scripts/app-kit-legacy.json` is the frozen debt list, not a place to exempt new app styles; remove entries when migrating their owner. Domain visuals (a transcript, agent face, day histogram) remain app-owned.

## Live data

Registered apps use the generated shared Root through `web/src/data/graphql`. Query only the fields the screen needs, and derive loading, live, offline and denied states from the query result. Offline and denied clear retained rows and disable actions. Keep the one existing GraphQL connection; do not add a route feed, poller or per-app socket.

Send commands from event handlers through the shared command client, retain their operation identity while pending, and verify the receipt before reporting success. Use the registered Changes screen and `src/ui/changes-piece.integration.test.ts` as a current example: the fixture starts `serveShared`, signs in a disposable viewer and serves the actual built app. Production startup never installs fixture records.
