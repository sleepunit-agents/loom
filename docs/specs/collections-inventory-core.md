# Collections inventory: loom core

*Appendix to [collections.md](collections.md). Raw survey, 2026-11-09, read-only. Line numbers are against main `6ab2a79` and will drift.*


Source: `sleepunit-agents/loom` main @ `6ab2a79` (checkout the loom checkout). Read-only survey for the
live-collections spec (TanStack DB client, versioned piece/core providers, ordered change streams). Paths below are
relative to the repo root; `H:` = `src/ui/handler.ts`, `CR:` = `src/ui/comms-routes.ts`, `W:` = `web/src/`.

Destinations: **t-2025** attention · **t-2027** conversations/Comms · **t-2028** agent status/jobs/ticker/clock/boxes/models ·
**t-2029** tasks/projects/Changes · **t-2030** knowledge/memory/people/profiles/activity/search · **t-2031**
settings/household/grants/pieces/backup/health · **EXCEPTION:<reason>**.

---

## 0. Shape of the system (read this first)

- **One HTTP server**, `src/transport/http-server.ts:917` `createServer(...)`. Routing order:
  1. `isUiRequest` (`H:275`, roots list `H:272`) → `handleUi` (`H:1311`). Everything a browser touches.
  2. `/api/<piece>/<path>` (`http-server.ts:938`) → bearer-only, JSON-only, **refuses any request with an `Origin`
     header** (`http-server.ts:868`). Browsers never call it. Core's own `/api/loom/*` lives here too.
  3. `/cli`, `/mcp` (+ `/agents/<name>/…`) → bearer-only (MCP sessions, CLI remote mode).
- **The page is one SPA** (`web/`, built to `dist/web`). Any GET with `Accept: text/html` returns `index.html`
  (`H:1900-1905`); the app then asks **the same path with `Accept: application/json`** and gets a **view**:
  `{view: kind, ...data, chrome}` (`H:1911-1925`). So "routes" and "views" are 1:1: every page address is also a
  JSON endpoint. Views: `house-home`, `home` (single-agent), `dashboard` (agent Today), `page` (generic block page,
  incl. piece pages, People/Projects/Changes variants), `inbox`, `activity`, `knowledge`, `comms`, `passkeys`
  (Profile), `sheet` (scope/places/find/setup/appearance/accessibility). Dispatcher: `W:App.tsx:497-523`.
- **Every view embeds `chrome`** (`H:1196` `chrome()`): nav, `shell` (agents with badges, pieces/places with tile stats
  and alert counts, Inbox count, Comms unread count, backup glyph, permissions link, icon set), clock, tz, csrf, flash,
  skipped pieces, plus `prefs` (`H:1914`). Chrome is recomputed on **every** view request, including every refetch.
- **Weak ETag over the whole view JSON** (`H:1917`): computed *after* the full server computation, so a 304 saves
  bytes, not CPU or piece runs.
- **Piece data reaches the browser only three ways**: (a) the piece's manifest (`loom-<piece> ui --json`), folded into
  chrome/Home/Inbox/agent cards by core; (b) a piece page (`ui page --json`) proxied as a `page` view; (c) core-mediated
  piece calls (`api --json`, offers argv) whose results core folds into a view (Comms work/refs/asks, project feeds,
  needs-resolve). There is **no** per-piece JSON data endpoint for the browser.
- **Change notification today is "refetch" only**: `/events` SSE sends a bare `change` (no revision/cursor/topic);
  Comms thread SSE sends `{seq}` (a real per-thread cursor). Details §6.

---

## 1. Inventory: browser-facing routes, streams and views

Columns: **id · kind · path/symbol · data · server source/owner · consumers · refresh · payload · duplication · destination**.

### 1A. Static / public / media (no per-user data)

| id | kind | path / symbol | data | source | consumers | refresh | payload | dup notes | dest |
|---|---|---|---|---|---|---|---|---|---|
| fonts | GET route | `/fonts/*.woff2` `H:1362` | 2 font files | `assets/fonts` | CSS | immutable 1y | ~50KB each | — | EXCEPTION:static asset |
| app-icons | GET route | `/icons/loom-*.png` `H:1369` | PWA icons | `assets/icons` | manifest, SW, notifications | 1d | small | — | EXCEPTION:static asset |
| webmanifest | GET route | `/manifest.webmanifest` `H:1375`, `MANIFEST` `src/ui/pwa.ts:25` | PWA manifest | constant | browser | no-cache | <1KB | — | EXCEPTION:static asset |
| sw | GET route / service worker | `/sw.js` `H:1379`, `swJs` `pwa.ts:56`, registered `W:main.tsx:10` | worker code listing built assets | `dist/web/assets` | browser | no-cache; new build → new worker | ~8KB | — | EXCEPTION:static asset (but see §1J for its data caching) |
| app-bundle | GET route | `/app/*` `H:1384` | built JS/CSS/fonts; br/gzip pre-packed `H:525-556` | `dist/web` | browser | `/app/assets/*` immutable | JS ~786KB raw | — | EXCEPTION:static asset |
| signin-js | GET route | `/app.js` `H:1395` (`APP_JS` `src/ui/app.ts`), `/login/passkey.js` `H:1399` | sign-in page scripts; app.js clears SW caches on /login | constant | login pages | no-cache | tiny | — | EXCEPTION:static asset |
| spa-shell | GET route | any page path with HTML accept `H:1900-1905` | `index.html` | `dist/web` | browser navigation | no-cache | small | — | EXCEPTION:static asset |
| faces | GET route | `/faces/<agent>/(manifest.json\|*.png)` `H:1647`; fetched `W:pixel-face.tsx:77` | an agent's pixel sprite sheet + its JSON | `household.ts spriteOf/spriteDir` | AgentAvatar/PixelFace everywhere | `?v=` → immutable private; SW MEDIA cache | sheets KBs | sprite version also in chrome `shell.agents[].face.sprite.v` (`H:691`) | EXCEPTION:raw media (version pointer lives in agent-profile collection, t-2030) |
| pixel-icons | GET route | `/pixel-icons/<app>.png` `H:1661` | household icon set PNGs | `src/icon-set.ts iconFile` | dock/launcher icons | `?v=` immutable; SW MEDIA | small | set version in chrome `shell.icons` (`H:696`) | EXCEPTION:raw media (pointer → t-2031 settings) |
| ui-redirects | GET route | `/ui/*` 308 `H:1318`; old piece names 308 `H:1327`; `/scope/<id>` 303 + clear cookie `H:1886`; `/mind`,`/memory/*` 302 to default agent `H:2236` | redirects only | — | old links | — | — | — | EXCEPTION:routing, no data |

### 1B. Auth / session / passkey / push-subscription exchanges

| id | kind | path / symbol | data | source | consumers | refresh | payload | dup notes | dest |
|---|---|---|---|---|---|---|---|---|---|
| login-token | GET/POST | `/login` `H:1432` | token form → session cookie | `UiAuth.check`, `sessions.ts` store | login page | — | tiny | — | EXCEPTION:auth |
| login-link | GET/POST | `/login/<64hex>` `H:1340` | one-time sign-in link spend | `sessionStore.spendLink` | link recipient | — | tiny | — | EXCEPTION:auth |
| login-passkey | POST | `/login/passkey/options`, `/login/passkey` `H:1403` | WebAuthn challenge/assertion | sessions store, `passkeys.ts` | `PASSKEY_JS` | — | tiny | — | EXCEPTION:auth/passkey |
| logout | POST | `/logout` `H:1469` | revoke session, `clear-site-data` | sessions store | account menu | — | — | — | EXCEPTION:auth |
| passkey-register | POST | `/passkeys/options`, `/passkeys` `H:1568` | WebAuthn registration; mints per-passkey token (`passkey-tokens.ts`) | sessions store, `tokens.json` | `W:passkeys.tsx:12` (AccountView) | — | tiny | — | EXCEPTION:auth/passkey |
| push-key | GET | `/push/key` `H:1549` | VAPID public key | sessions store `pushKeys` | `W:passkeys.tsx:90` | on enable | tiny | — | EXCEPTION:secret/key exchange |
| push-subscribe | POST | `/push/subscribe`, `/push/unsubscribe` `H:1553` | browser PushSubscription (endpoint+keys), `again` re-send each load | `ui-sessions.json` push devices | `W:passkeys.tsx:65-95` (re-sent on every app load if subscribed) | per load | tiny | — | EXCEPTION:secret exchange (the *device list* it creates is read in the Profile view → t-2031) |

### 1C. Live / SSE streams

| id | kind | path / symbol | data | source | consumers | refresh | payload | dup notes | dest |
|---|---|---|---|---|---|---|---|---|---|
| events | SSE | `GET /events` `H:1488` → `openStream` `src/ui/live.ts:127`; client `listen()` `W:page.ts:58-75`, `onLive` `W:page.ts:78` | `event: change` `data: {}` only; `retry: 5000`; `: beat` every 25s | fs.watch on `$LOOM_HOME` (memories/knowledge/people `.db`, `household.json`, `pieces.tick`) `live.ts:144-150`; manifest tick every 15s per open scope `live.ts:96-121`; `changed()` after every `/act` `H:1851`; `changedFor(member)` from comms tick `comms-live.ts:66` | every `usePage` (screen + each desk tile), `useAgentComms` `W:desk-agents.tsx:141`, Comms thread pull `W:comms.tsx:679`, `useAskLive` `W:ask-open.ts:54` | coalesced ≥1.5s apart per client (`GAP_MS`); max 6 streams/session | 0 bytes of data | the **only** global invalidation; every hearer refetches its **whole** view (incl. chrome) | replaced by ordered change stream (all collections); keep transport for t-2025..t-2031 topics |
| comms-thread-events | SSE | `GET /comms/<thread>/events?from=<seq>` `CR:260` → `openThreadStream` `src/ui/comms-live.ts:89`; client `W:comms.tsx:664-676` | `event: message` `data: {seq}` (newest seq) when seq or thread state moved; `retry: 3000`; beat 25s | `comms.db` seqs + `household.db comms_threads` state; triggered by `comms.tick` fs.watch + same-process `onBump` + **2s poll** `comms-live.ts:79-86`; `may()` re-checks membership each event | Comms thread pane | per change; client then GETs `/since/<seq>` | tiny | thread moves are *also* broadcast as bare `change` on `/events` to the member (`changedFor`), so an open thread refetches twice (`W:comms.tsx:668` + `:679`) | t-2027 (this is already a per-thread cursor stream: closest existing thing to the target model) |
| mcp-sse | SSE | MCP GET stream `http-server.ts:1018` | MCP server→client (listChanged, ping) | MCP SDK | agents/clients, MCP-App widgets host | heartbeat 25s | — | — | EXCEPTION:agent protocol, not app data |

### 1D. Page views (GET JSON via `fetchView` / `usePage`; same path serves the SPA HTML)

All share: auth `whoIs` `H:369`, `allowedGet` `H:491`, owner-scope narrowing `H:1454-1459`, chrome `H:1196`, ETag
`H:1917`, SW VIEWS cache `pwa.ts:120`. Client loader: `usePage` `W:page.ts:105` (screen: `W:App.tsx:220`; each
desktop tile: `W:tiling/tiles.tsx:816`), hover/focus prefetch `W:tiling/tiles.tsx:102-118` (any `a[href]`/`[data-prefetch]`).
Refresh (all views unless noted): `/events` change → quiet refetch with ETag; `visibilitychange`; `online`; fallback
timer `refreshEvery` `W:refresh.ts` = **20s without stream / 60s with stream**, never for `sheet` or a page containing a
form; a piece page's own `refresh` seconds wins.

| id | kind | path / symbol | data | source | consumers | refresh | payload | dup notes | dest |
|---|---|---|---|---|---|---|---|---|---|
| v-house-home | view `house-home` | `GET /` (household) `H:2047-2070` | `home`: headline (worst agent state), `needs` = count of attention Inbox items, `need` = first, `stack` = first 4 with `unread` from opened keys, `cards` (per agent: state, reason, doing, jobs, problems, readings, last seen, 3 recent tape steps), `moving` (pieces' working agents), `firstRun` | `inboxItems()` `H:1019` (all asks: core proposals/needs/backup + every piece manifest's asks/notices/answered); `agentCards()` `H:978` (piece manifests `agents` reports + each agent's tape `data.ts:224`); `ui-sessions.json` opened keys | `W:views.tsx:191` HouseHomeView; `W:desk-agents.tsx:457` PhoneHome; desktop `HomeDesk`/`AgentRail`/`NeedsBand` via `homeData` `W:App.tsx:666` → `W:tiling/tiles.tsx:735` | standard (+ desktop glow `tiles.tsx:747`) | full Inbox computed, 4 items + all agent cards shipped | `needs` here is formula **C1** (§4); agent `state` here (`agentCards`) duplicated by `agentStateOf` `H:1156` (chrome `working`, Profile) and `onOf` `H:1191` | split: needs/stack → **t-2025**; cards/moving/doing/jobs/readings → **t-2028**; tape steps → t-2030 activity |
| v-home-single | view `home` | `GET /` (single agent) `H:2242` | core Home page + tiles (core + each piece tile) + asks (pieces only) | `core.ts:133 homePage`, manifests | `W:App.tsx:512` | standard | small | asks here: no proposals/needs | t-2025 asks; tiles → t-2028/t-2031 |
| v-dashboard | view `dashboard` | `GET /a/<agent>` `H:2192-2212` | agent Today: head (marks, tabs, bio, about, permissions link, working/on), `waiting` count, asks (proposals + needs + piece asks for agent or scoped pieces, approvals absorbed), tiles (Memories count + scoped pieces' `agentTile` w/ "Next" wake + last wake), `thread` (30 tape items/24h) | `householdThread` `household-pages.ts:139`, proposals, `openNeeds`, manifests (`agents[a].readings`), tape | `W:views.tsx:337` DashboardView; agent window `W:agent-window.tsx:47` (`head.waiting`) | standard | bounded (30 rows) | `waiting` = formula **C3** (same as per-agent badge, differs from Inbox From-folder count); asks list re-derives `absorbApprovals` per agent | asks → t-2025; head/profile → t-2030; tiles/next-wake → t-2028; thread → t-2030 |
| v-agent-piece | view `page` | `GET /a/<agent>/p/<piece>/<path>` `H:2216-2228` | a piece's agent tab page (`LOOM_SCOPE=<agent>`) | `piecePage` `src/ui/pieces.ts:375` subprocess `ui page --json`, caller passed | `W:App.tsx:505` PageView (Changes variant `:504`) | standard + piece `refresh` | ≤512KB | page cache 5s/5min SWR keyed by caller+scope (`pieces.ts:395`) | per piece: clock/wakes → t-2028; tasks → t-2029; else t-2031 "remaining pieces" |
| v-agent-setup | view `page` | `GET /a/<agent>/setup` `H:2229` | agent setup: identity, tokens, face/mark, backup row, about | `household-pages.ts:440 agentSetup` | PageView | standard | medium | backup row also in chrome `shell.backup` (`H:1146`) and backup ask/FYI | t-2031 (identity/profile bits → t-2030) |
| v-agent-mind | view `page` | `GET /a/<agent>/mind`, `/memory/<ref>`, `/people[/<slug>]` `H:2232` → `corePage` `core.ts:458` | memory heat list, proposals, memory detail+history, agent-scoped people | agent `memories.db`, proposals, `people.db` | PageView | standard | heat list bounded | proposals also counted in chrome and Home | t-2030 |
| v-conversation | view `page` | `GET /conversation/<cv>` `H:2168`, `/a/<agent>/conversation/<cv>` `H:2230` → `conversationPage` `core.ts:507` | a conversation's turns, digests, needs | `backends/conversations.ts` per agent | PageView; links from asks, jobs (`H:181`), activity | standard | per conversation | `/conversation` searches every agent dir (`H:2170`) | t-2027 |
| v-p-piece | view `page` | `GET /p/<piece>/<path>` `H:2256-2273` | a piece's household page; `unscoped` note | `piecePage` (subprocess) + `resolveFrom` per member (`H:1463`) | PageView / ChangesView `W:changes.tsx:7` (when `page.changes`) | standard + piece `refresh` (e.g. installs/sign-ins) | ≤512KB; Changes rows ≤500 | page cache shared with v-agent-piece; Changes groups counted client-side `W:changes.tsx:20` | per piece: tasks/changes(PRs) → t-2029; approvals → t-2025 (+grants rule metadata t-2031); runtime/boxes/houses/models → t-2028; clock → t-2028; others → t-2031 |
| v-inbox | view `inbox` | `GET /inbox[?f=&i=]` `H:2095-2131` | **all** Inbox items (asks, notices, answered, answered Needs history 7d, backup FYI, the member's own action toasts as FYI), folders, `open`, `inline` (a piece page drawn for the open item), `now`, `github` | `inboxItems` + `store.doneItems(reader)` + `openedAt(reader)`; inline via `piecePage` | `W:inbox.tsx:47` InboxView (folder counts computed client-side `:75-76`) | standard (refresh 20/60s) | full list (≤10 asks/piece + 20 notices + 20 answered per piece + done toasts) | **GET with side effect**: `?i=<key>` marks opened `H:2103`; folder counts = formula **C4** | **t-2025** |
| v-activity | view `activity` | `GET /activity[?to=&who=&where=&what=&day=&e=]` `H:2073` → `activityView` `src/ui/activity.ts:333` | entries over a window of days (digests, conversations, episodes), filters, venues, open entry w/ steps from Comms cards | agents' conversations/digests/episodes; `comms` messages for open entry | `W:activity.tsx:58`; paging `fetchView('/activity?to=')` `W:activity.tsx:106` | standard | window-bounded | — | t-2030 |
| v-knowledge | view `knowledge` | `GET /knowledge[/<slug>\|?p=]` `H:2134` → `knowledgeView` `household-pages.ts:192` | every page's line + freshness + topics, and the open page whole | commons `knowledge.db` | `W:knowledge.tsx:25`; side reader `fetchView('/knowledge?p=')` `W:knowledge.tsx:40` | standard | full index each time (client filters/searches) | the opening of one page re-ships the whole index | t-2030 |
| v-people | view `page` + `people` | `GET /people`, `/people/<slug>` `H:2147,2162` | page + `people` app data (`householdPeopleApp` `household-pages.ts:304`): contacts, selected person, member's Comms threads with them (5), permissions link | `people.db` (household), `threadsOf` | `W:people.tsx:13`; side fetch `fetchView('/people?p=')` `W:people.tsx:26` | standard | full list | person detail also via `/a/<agent>/people/<slug>`; Find suggestions (§1E) re-read people | t-2030 (threads strip → t-2027) |
| v-projects | view `page` + `projects` | `GET /projects` `H:2154` → `projectsApp` `projects-pages.ts:211`; hub `/projects/[<agent>/]<slug>` `H:2155-2159` → `projectHubPage` `:324` | cards: status, summary, **waiting count per project**, spark, open changes+CI, repos, people; hub sections | agents' project cards (`backends/projects.ts`), **section feeds** from every piece offering `sections.project` (`project-feeds.ts`, subprocess per piece per project), open `needs_owner` | `W:projects.tsx:101` | standard; index counts cached 60s, wait ≤5s; hub always runs feeds fresh | N projects × M feed pieces subprocesses | per-project waiting = formula **C6**; Changes section counted again here | **t-2029** |
| v-pieces | view `page` | `GET /pieces` `H:2161` → `piecesPage` `pieces-page.ts:114` | installed pieces, catalog, install jobs (`jobs.json`), settings | `pieces-managed`, catalog, `jobs.json` | PageView | standard + jobs | medium | `piecesAsks` (missing settings) also injected into every Inbox/count | t-2031 |
| v-members | view `page` | `GET /members` `H:2166` → `householdMembers` `household-pages.ts:659` | members, their agents | `household.json`, tokens | PageView | standard | small | — | t-2031 |
| v-new-forms | view `page` | `/new-agent`, `/new-person`, `/new-fact` `H:2174-2176` | static forms | — | PageView | never (form) | tiny | — | EXCEPTION:local-only form scaffold (submit → actions) |
| v-profile | view `passkeys` | `GET /account`, `/passkeys` `H:1945-2031` | Profile: passkeys (per member), sessions ("Signed in"), push devices, sign-in link button, `me` (`profileOf` `H:1167`: name, since, owned agents with marks + state) | `ui-sessions.json`, `tokens.json`, manifests (agent states) | `W:account.tsx:91` AccountView (lazy) | standard | small | agent state again via `agentStateOf` | sessions/passkeys/devices → t-2031 (or EXCEPTION:auth for credential material); `me` → t-2030 |
| v-sheets | view `sheet` | `GET /scope,/places,/find,/setup,/appearance,/accessibility` `H:1929-1941` | chrome + `which`, Find results/suggestions, Accessibility intro | chrome; Find = `findAll` `H:1052` | `W:sheets.tsx:21` SheetView; `W:find.tsx` | **never** auto-refresh (`refresh.ts`) | chrome-sized | places/setup are pure chrome re-projections | places/setup → t-2031 (piece catalog/nav); find → t-2030 search; appearance/accessibility → t-2031 prefs |
| v-comms-list | view `comms` (which=list) | `GET /comms[?archived=1&background=1]` `CR:218` | member's threads (row view + unread + last_seq), unread count, owned agents, chrome | `household.db comms_threads`, `comms.db` seqs, `threadsOf` `src/comms.ts:525` | `W:comms.tsx:923` CommsView; reloads `getJson('/comms')` `W:comms.tsx:930`, archived/background `:335` | standard view refresh + manual reload after acts `:343` | all threads | thread unread count = formula **C7**; `/comms` also served as JSON for list reload (same route) | **t-2027** |
| v-comms-thread | view `comms` (which=thread) | `GET /comms/<thread>` `CR:285-294` | thread row+state, newest messages, `asks` (thread's Inbox items), `earlier` digests, chrome | `comms.db` (age-encrypted words), `household.db`, **full `inboxItems`** via `inbox()` `H:1537`, runtime `conversation-origins` piece API `CR:184` | CommsView thread pane | per thread SSE + `/events` + 30s read loop | newest page of messages | asks recompute full Inbox per request (memoized per request only) | **t-2027** (asks → t-2025 projection) |

### 1E. Direct JSON fetches (not views)

| id | kind | path / symbol | data | source | consumers | refresh | payload | dup notes | dest |
|---|---|---|---|---|---|---|---|---|---|
| comms-since | direct fetch | `GET /comms/<thread>/since/<seq>` `CR:285`; `W:comms.tsx:630` (`pull`), `:734` | messages after seq + thread + asks (+earlier if swept) | as v-comms-thread | thread pane | on thread SSE `message`, on `/events` change, every 30s (`read` loop `W:comms.tsx:685-688`), on open | delta | recomputes asks (full Inbox) each pull; SW never caches (`pwa.ts:173`) | t-2027 |
| comms-before | direct fetch | `GET /comms/<thread>/before/<seq>` `CR:285` | 100 older messages | comms.db | thread scrollback | on scroll | ≤100 msgs | — | t-2027 |
| comms-agents | direct fetch + poller | `GET /comms/agents` `CR:231` → `agentsComms` `src/comms.ts:580`; `useAgentComms` `W:desk-agents.tsx:121-150` | per owned agent: unread **reply-message count**, first unread reply's first line (decrypted), last thread | comms.db/household.db | desktop rail/cards `W:tiling/tiles.tsx:734`, `W:desk-agents.tsx:459` PhoneHome | `/events` change (debounced 200ms), `loom-comms-read` DOM event, visibility, **every 60s** | per agent | unread here = formula **C8** (messages) vs dock C7 (threads); SW never keeps it (`pwa.ts:83`) | t-2027 |
| comms-work | direct fetch + poller | `GET /comms/<thread>/work` `CR:270` → `threadWork` `src/comms-work.ts:237`; `W:comms-work.tsx:55` | work items the thread names/made (tasks, PRs, notes) | `comms_refs` + every piece offering `sections.thread` (subprocess `runOffer` per piece) | WorkPanel `W:comms-work.tsx:49` | on reply seq change, **every 60s when visible** `:62` | ≤ feed cap | same task/PR objects also in tasks piece pages, Projects hub, refs chips | t-2029 (tasks/PRs) keyed by thread → join in t-2027 |
| comms-refs | direct fetch | `GET /comms/<thread>/refs?r=…` `CR:272` → `resolveRefs` `src/comms-refs.ts:78`; `W:comms-refs.tsx:87` | chip cards for t-N, owner/repo#N, a-…, cv-…, note:, knowledge:, project:, person:, agent: | threadWork, tasks piece `api run show` (`comms-refs.ts:174`), Inbox pending, asks, stores | ThreadRefs `W:comms-refs.tsx:70` | per `refresh` prop (reply seq) | ≤REFS_MAX | re-runs threadWork **and** full Inbox per call | resolvers per kind: t-2029/t-2025/t-2027/t-2030 (should become client-side joins over collections) |
| comms-model | direct fetch | `GET/POST /comms/<thread>/model` `CR:266,298` → runtime `api model-choice` | thread harness choice (auto/claude/codex) | runtime piece API | `W:comms.tsx:430,439` | on open | tiny | — | t-2028 (models/accounts) |
| inbox-open | direct fetch | `GET /inbox/open?k=\|a=` `H:2085`; `stillOpen` `W:ask-open.ts:16`, `useAskLive` `:33` | `{open: bool}` for one ask | **full `inboxItems` recompute** | every visible ask card: Inbox reader, Comms ThreadAskCard, desktop NeedsBand/NeedChip | on mount, on **every `/events` change**, right before each send | tiny response, heavy server | N visible cards × each change = N full Inbox builds; `no-store`, SW bypass `pwa.ts:176` | t-2025 (becomes a local lookup in the attention collection + server-side precondition on act) |
| find | direct fetch | `GET /find[?q=]` (sheet JSON) `H:1929`; `W:find.tsx:40,52`; `W:desk.tsx:61` (DeskBoot, only to read the owner's full name) | Do (matching asks ≤5), knowledge, people, memories; suggestions (people) | `findAll` `H:1052` (rebuilds all asks) + `householdFind` `household-pages.ts:933` | Find overlay; DeskBoot | per keystroke (debounced) | full chrome + results | DeskBoot pulls a whole sheet+chrome for one name already in `me.full` (Profile) | t-2030 (search/launcher); its Do group reads t-2025 |
| pieces-json | GET route | `GET /pieces.json` `H:1877` | every visible piece's full manifest (atWorkFor/forOwner applied) | `pieceManifests` | scripts (no web consumer found) | — | all manifests | raw form of what chrome/Home/Inbox derive | t-2031 (piece catalog) / t-2028 |

### 1F. Actions (POST)

All: `sameOrigin` `H:502`; session needs `_csrf` = HMAC(session) `H:324` (form field or JSON `_csrf`); bearer needs none.
`/act` result is either JSON (`x-loom-fetch: 1`, from `act()` `W:loom.ts:146`) or 303 + flash. Every `/act` ends
with `changed(ownerScope ?? '*')` `H:1851` and, unless quiet/keep, `noteDone` → Inbox FYI `H:1857`.

| id | kind | path / symbol | data | source/owner | consumers | refresh after | dup notes | dest |
|---|---|---|---|---|---|---|---|---|
| act-piece | POST action | `/act/<piece>` `H:1820-1849` → `pieceAct` `pieces.ts:446` (`ui act --json`, caller + store grant) | any piece action (approvals allow/deny, tasks, runtime, clock…) | the piece | `act()` from blocks, Inbox, asks | clears that piece's manifest+page caches `pieces.ts:455`; `changed('*')`; approvals: `applyOwnerApproval` `H:425` + `resolveNeeds` `H:1842` + `recordAnswer` to Comms `H:1847` | `askBefore` recomputes full Inbox pre-act `H:1833` | per piece (approvals → t-2025, tasks → t-2029, …) |
| act-agent-piece | POST action | `/a/<agent>/act/<piece>` `H:1716` | same, `LOOM_SCOPE` | piece | agent tabs | same | — | per piece |
| act-needs | POST action | `/a/<agent>/act/loom` `needs-reply/answer/done/dismiss` `H:1729` → `needsAct` `H:884` | answer a Needs you (deliver as owner via runtime) | agent `conversations` store; `deliverAsOwner` | Inbox reader, Home band, Comms ask cards | `changed`; `recordAnswer` | `askBefore` full Inbox | **t-2025** |
| act-agent-core | POST action | `/a/<agent>/act/loom` `archive/ratify/reject/restore` `H:1742` → `coreAct` `core.ts:469` | memory archive, proposal ratify/reject | agent memory store | Mind, Home proposal card | `changed` (+ fs watch on memories.db) | — | t-2030 |
| act-household | POST action | `/act/loom` → `householdAct` `household-pages.ts:743` | `add-agent, about-ask, about-set, face-set, mark-set, identity-*, create-token, revoke-token, member-set, member-remove, person-add, fact-add, knowledge-verify, knowledge-recheck, backup-set` | `household.json`, tokens, agent identity, people/knowledge db | Setup, Members, People, Knowledge forms | `changed` + fs watch | — | members/tokens/backup/marks → t-2031; identity/about/face → t-2030 (agent profiles); person/fact/verify → t-2030 |
| act-pieces | POST action | `/act/loom` `piece-install/preview/update/rollback/remove/set` `H:1809` → `piecesAct` `pieces-page.ts:219` | piece lifecycle + settings | `pieces-managed`, `jobs.json` | Pieces page | page `refresh` polling while job runs | — | t-2031 |
| act-account | POST action | `/act/loom` `passkey-remove, session-revoke, push-test, push-remove, signin-link, member-link` `H:1750-1808` | credentials/devices | sessions store, tokens | Profile, Members | `changed` | — | EXCEPTION:auth (results shown in t-2031 device/session lists) |
| inbox-read | POST | `/inbox/read` `H:1672`; `markRead` `W:loom.ts:165` from `W:inbox.tsx:87`, `W:views.tsx:245` | Inbox item opened (key, time) per reader | `ui-sessions.json` opened map (`sessions.ts:531`) | Inbox, useOpenItem | **does not call `changed()`** → other tabs/devices learn only on next refetch | second read-path: `GET /inbox?i=` also marks | **t-2025** (read state) |
| prefs | POST | `/appearance/prefs` `H:1632`; `W:look.ts:73` | look/light-dark/ground/sound/zoom/motion/contrast… | `ui-sessions.json` prefs per member (`sessions.ts:558`) | every view carries `chrome.prefs` (`H:1914`); `W:App.tsx:301` | no `changed()`; other devices pick up on next view fetch | prefs shipped on every view | **t-2031** (local mirror stays EXCEPTION:local-only) |
| comms-writes | POST | `/comms/new` `CR:238`; `/comms/<t>/send,title,project,pin,unpin,archive,unarchive,delete,stop,resume,read,model` `CR:296-336` | thread/messages lifecycle; `read {seq}`; stop/resume/archive → runtime `conversation-control` | `comms.ts` (household.db + comms.db) + runtime piece API | `W:comms.tsx` (706,715,725,731,740,884), `W:desk-agents.tsx:265`, `W:agent-window.tsx:113` | every write `bump()` → `comms.tick` → thread SSE + member `changedFor` | `read` also feeds push "in front" suppression | **t-2027** |

### 1G. Data embedded in every view: `chrome` / `shell` (`H:1196-1289`)

| id | field | computed from | consumers | dup notes | dest |
|---|---|---|---|---|---|
| ch-nav | `nav`, `shell.core`, `shell.pieces` (places: label, href, kind, icon, accent, fit, tile `tone`/`stat`, `alerts`) | manifests (`householdTab`), `catalogKinds()` | dock `W:components/ui/dock.tsx`, sidebar `W:sidebar.tsx:42-56`, launcher `W:launcher.tsx`, more-menu, places sheet, phone ticker `W:phone-bar.tsx:34`, system bar boxes glyph `W:system-bar.tsx:100-115` | tile stats double as ticker text and Boxes glyph count (regex on `stat`) | piece catalog/nav → t-2031; tile stat/tone/alerts → t-2028 (boxes/health) |
| ch-asks | `shell.asks` (Inbox badge) | formula **C2** `H:1210,1216` | Inbox tab badge `W:App.tsx:110`, sidebar `W:sidebar.tsx:54`, phone bar `W:phone-bar.tsx:156`, DeskBoot "needs you" `W:desk.tsx:43`, inbox subtitle `W:App.tsx:462` | ≠ C1 in edge cases (§4) | **t-2025** |
| ch-agent-asks | `shell.agents[].asks` | formula **C3** `H:1244` | sidebar/more-menu/launcher/sheets badges, avatar "needs-input", desk "ASKS YOU" `W:desk-agents.tsx:96` | counts n proposals, Inbox shows 1 | **t-2025** |
| ch-agents | `shell.agents[]`: label, marks, face/sprite, href, `sub` (last active from tape), `working` | `agentMarks` `H:681` (household.json `marks`), `agentName`, `lastActive` `H:1116`, `workingOf` (manifests) | everywhere an agent is drawn; ticker; system bar agents-at-work | `working` re-derived from manifests separately from Home cards | marks/labels/faces → t-2030 (agent profiles); working/sub → t-2028 |
| ch-comms | `shell.core` Comms entry `count` | `commsUnread` `H:476` (threads with unread) | dock Comms key, sidebar | formula **C7** vs desk cards C8 | **t-2027** |
| ch-backup | `shell.backup` {tone,text,href} | `backupRow` `src/backup.ts` | system bar backup glyph `W:system-bar.tsx:118` | same status also an Inbox alert (`backupAsks` `H:809`) + FYI (`backupFyi`) + Setup row | **t-2031** (health) |
| ch-permissions | `shell.permissions` link | grants authority piece | People/agent windows | — | t-2031 |
| ch-icons | `shell.icons` {v, apps} | `iconSetOf` | pixel icons | — | t-2031 |
| ch-clock | `clock`, `tz` | server clock | SysClock `W:system-bar.tsx:145` + `loomNow` skew from `Date` header `W:loom.ts:119` | — | EXCEPTION:derived per-response (or t-2028 clock) |
| ch-csrf/flash | `csrf`, `flash`, `skipped` | session HMAC; flash map (60s, in-memory) `H:617` | all forms; toasts | — | EXCEPTION:auth token / ephemeral UI message |
| ch-prefs | `chrome.prefs` | sessions store | App look sync `W:App.tsx:301` | shipped with every view | t-2031 |

### 1H. Client pollers / timers (web/src)

| id | where | interval | what it does | dest |
|---|---|---|---|---|
| poll-page | `W:page.ts:181` (`refreshEvery` `W:refresh.ts`) | 20s (no stream) / 60s (stream) / piece `refresh` s; per `usePage` instance (screen + every desktop tile) | quiet refetch of the whole view | removed by collections; piece-requested `refresh` → piece provider push |
| poll-page-retry | `W:page.ts:138` | 3s once | retry after network miss | — |
| poll-comms-agents | `W:desk-agents.tsx:142` | 60s | `/comms/agents` | t-2027 |
| poll-comms-read | `W:comms.tsx:687` | 30s while visible | POST `/read` + `pull()` (also "in front" signal for push suppression, and the only path that notices new asks on a thread) | t-2027 (read cursor) / t-2025 (asks) |
| poll-comms-work | `W:comms-work.tsx:62` | 60s while visible | `/comms/<t>/work` | t-2029 |
| tick-working | `W:comms.tsx:702` | 1s | local "working for Ns" clock | EXCEPTION:local-only |
| tick-minute | `useLoomMinute` `W:system-bar.tsx:38` | 1min | clock redraw | EXCEPTION:local-only |
| ticker-anim | `W:phone-bar.tsx` | animation | ticker scroll | EXCEPTION:local-only |

### 1I. Client local-only state

| id | where | data | dest |
|---|---|---|---|
| ls-look | `W:App.tsx:145-187`, `W:look.ts:55-65`, `W:ground.tsx:10`, `W:access.ts:70`, `W:main.tsx:17` | `loom-ground, -sound, -pixel, -icons, -haptics, -zoom, -contour-zoom, -one-window, -tiling`, motion/contrast follow | EXCEPTION:local-only (server-synced subset is `chrome.prefs` → t-2031) |
| ls-drafts | `W:drafts.ts` | composer/reply drafts | EXCEPTION:drafts |
| ls-recent | `W:recent.ts` | recently opened places (launcher) | EXCEPTION:local-only |
| ls-tiles | `W:tiling/tiles.tsx:63-82` | tile layout, rail hide mode | EXCEPTION:layout |
| ss-trail | `W:trail.ts` | per-tile back stacks | EXCEPTION:local-only |
| ss-boot | `W:desk.tsx:102`, `W:arrive.tsx:45` | boot/arrive shown once per session | EXCEPTION:local-only |
| ls-fold | `W:fold.tsx:14-21` | folded sections | EXCEPTION:local-only |
| ls-push-asked | `W:passkeys.tsx:116` | "ask later" for push prompt | EXCEPTION:local-only |
| mem-kept | `W:page.ts:38` `kept` map, `ahead` map | per-tab copy of every page view + ETag; prefetch promises | replaced by collection store (persisted collections could replace SW VIEWS) |
| inbox-local | `W:inbox.tsx:66` `answered`/`read` sets | optimistic answered/read overlay | becomes optimistic mutation on t-2025 collection |

### 1J. Service worker, prefetch, preload

| id | kind | where | behaviour | dest |
|---|---|---|---|---|
| sw-pages | service worker | `pwa.ts:96-114` | network-first navigation; keeps the app HTML as `__app` for offline | EXCEPTION:static asset |
| sw-views | service worker | `pwa.ts:120-138` | **caches every JSON view** (Accept: application/json) network-first, 8s timeout, stamped `x-loom-saved-at`; per-session tag `x-loom-who` (`H:259`) — copies dropped when tag changes; excludes `/comms/agents`, `/comms/*/since|before`, `/inbox/open`, `_flash` | replaced by persisted collections (needs same per-session partitioning) |
| sw-built/media/static | service worker | `pwa.ts:140-152, 177-179` | precache built assets; versioned faces/icons; shell files | EXCEPTION:static asset/media |
| sw-forget | message | `pwa.ts:94`, `app.ts` | drop session copies on /login | EXCEPTION:auth |
| prefetch | hover/focus prefetch | `W:tiling/tiles.tsx:97-118`; `data-prefetch` `W:comms.tsx:312`, `W:components/ui/dock.tsx:347` | `fetchView` 70ms after pointer rests on any link; result goes to `ahead`/`kept` | becomes collection preloading (`preload` a live query) |
| preload | — | no `<link rel=preload/prefetch>` and no `modulepreload` usage found in `web/src` (only `lazy()` chunks) | — | — |

### 1K. Notifications

| id | kind | where | data | refresh | dest |
|---|---|---|---|---|---|
| push-watch | server poller | `pushWatch` `H:734`, timer `http-server.ts:893` (60s, `WATCH_S` `push.ts:22`), `watch()` `push.ts:87` | announces each new ask (key = `askKey` `push.ts:35` sha(source,text,page)) from `yourCall` `H:721` (= absorbApprovals(core+piece asks).filter(attention)) + `commsAnnouncements` `H:759` (unread replies not "in front" in last 2 min) | 60s; one listener takes the watch (`takePushWatch`) | **t-2025** (notification metadata = attention items + per-device delivery record); payload transport EXCEPTION (Web Push) |
| push-display | service worker | `pwa.ts:155-172` | `showNotification(title, body, tag, url)`; click navigates/opens | — | EXCEPTION:Web Push |
| push-test | action | `push-test` `H:1778` | test send | — | EXCEPTION |
| no-Notification-API | — | `new Notification(...)` not used in page; only `Notification.requestPermission` `W:passkeys.tsx:89` | — | — |

### 1L. Server-side background producers (they mutate what the views show)

| id | where | interval | effect | dest |
|---|---|---|---|---|
| live-tick | `live.ts:96` | 15s (≥5s apart) per open scope, only while a stream is open | re-runs **every piece's** `ui --json`, fingerprints, nudges scope on change, drops that piece's page cache | piece providers (t-2028/2029/2031/2025) |
| pieces-changed | `POST /api/loom/pieces/changed` (runtime only) `http-server.ts:775` → `piecesMoved` `live.ts:157` | event | writes `pieces.tick`; all listeners expire manifests and re-tick now | piece provider "moved" signal |
| needs-resolve | `http-server.ts:902` (60s + 2s after start), also after approvals act `H:1842` | 60s | asks approvals piece `state` and tasks piece `run show` via `pieceApi` (`needs-resolve.ts:97,106`); marks Needs `resolved` | t-2025 |
| comms-sweep | `http-server.ts:402` | 60s | `sweepComms` (14-day word sweep, stale deliveries) | t-2027 |
| comms-watch | `watchComms` `comms-live.ts:73` | 2s poll + fs watch | thread SSE + member `changedFor` | t-2027 |
| backup-tick | `http-server.ts:915` | 10 min | spawn `loom backup tick` | t-2031 |
| fold/sweep | `http-server.ts:384,398` | 24h / 1h | conversation fold, audit sweep | t-2030 (audit) |
| piece-install | `pieces-page.ts` jobs | while running | `jobs.json` read by Pieces page | t-2031 |

### 1M. Piece proxying (how core forwards piece pages/APIs and where piece data reaches the UI)

| id | kind | symbol | invocation | caching | auth passed | consumers | dest |
|---|---|---|---|---|---|---|---|
| pm-manifest | manifest | `pieceManifests` `pieces.ts:351`, `fetchManifest` `:282`, `manifestFor` `:303` | subprocess `loom-<piece> ui --json`, 3s, 512KB, page pool (6) | 45s fresh, SWR to 10 min, key = path+`LOOM_SCOPE`+realpath/mtime; in-flight promise shared | **no caller**; env `LOOM_SCOPE`, `LOOM_OWNER_SCOPE` (not in cache key — see §8) | chrome, Home, dashboard, Inbox, Find, push, comms asks, `/pieces.json` | split by manifest section: `asks/notices/answered` → t-2025; `agents{}` (state/doing/jobs/readings) → t-2028; `tile` → t-2028/2031; `tab` → t-2031 |
| pm-filter | manifest post-processing | `forOwner` `H:192`, `atWorkFor` `H:166` | core filters per viewer: `owners: 2` pieces only, items with matching `agent`, tile dropped; jobs/doing rewritten with Comms titles/links per member | per request | member | as above | the per-viewer filter must move into the provider/collection auth layer |
| pm-page | page proxy | `piecePage` `pieces.ts:375` | subprocess `ui page --json` with `{path, query, caller}` on stdin, 15s | 5s fresh, 5min SWR, 1s if `refresh`; key includes caller; ≤500 entries | caller (owner, who, agents); **no store grant** | v-p-piece, v-agent-piece, Inbox `inline` | per piece |
| pm-act | action proxy | `pieceAct` `pieces.ts:446` | subprocess `ui act --json`, 15s; store grant minted (`withGrant` `pieces.ts:56`) | clears caches | caller + `LOOM_STORE_GRANT` | `/act/*` | per piece |
| pm-api | core→piece API | `pieceApi` `pieces.ts:479` | subprocess `api --json` `{caller, path, body}`, 15s, 8MB, api pool 4 + 8 waiting | none | caller kind owner/agent/piece/stranger | Comms model/control/origins (`CR:96-111,184`), refs `comms-refs.ts:174`, needs-resolve | per piece |
| pm-offers | offers runner | `runOffer` (`offers-registry.ts`), `runPieceBin` `pieces.ts:259` | subprocess per declared argv; pools tools 4+16, delivery 8+32, grants 8+32; feeds share 6 | project index counts 60s | caller on stdin for thread feeds | project feeds (`project-feeds.ts:66`), thread work (`comms-work.ts:254`), delivery, grants | t-2029 / t-2027 |
| pm-external-api | piece API (machine) | `/api/<piece>/<path>` `http-server.ts:938,867` | bearer only, no browser | none | resolved role → ApiCaller; agent calls ask grants authority first (`grants.ts`) | boxes, bodies, houses | EXCEPTION:machine API |

### 1N. Custom widgets (`widgets/`)

These are **MCP-App** widgets (iframes rendered by an MCP host), registered in `src/transport/mcp-app-hello.ts:64`
(only when probing, `src/server.ts:1620`). They are not part of the web app and never call the HTTP UI.

| id | file | data | transport | dest |
|---|---|---|---|---|
| w-hello | `widgets/hello.widget.ts` | version/time | `ontoolresult` + `callServerTool('loom_hello')` | EXCEPTION:MCP-App probe |
| w-display-modes | `widgets/display-modes.widget.tsx` | none | MCP-App | EXCEPTION:MCP-App probe |
| w-top-of-mind | `widgets/top-of-mind.widget.tsx` | `digestData(contextDir)` salience digest | tool result + `callServerTool` refresh | t-2030 (memory) if ever bridged; today EXCEPTION:MCP transport |
| w-proposals | `widgets/proposals.widget.tsx` | `listProposals(contextDir)`; ratify/reject via `callServerTool` | MCP | t-2030 (memory proposals) — duplicate of Mind/Home proposal asks |

No piece-defined widgets exist; "piece data reaching widgets" in the web app means manifest `tile`/`agents.readings`
drawn by core components (dock tiles, ticker, agent cards).

### 1O. Machine APIs (not browser; listed for completeness)

| id | path | role | data | dest |
|---|---|---|---|---|
| api-deliver | `POST /api/loom/deliver` | piece/runtime | message delivery to a body | EXCEPTION:machine API (producer into t-2027) |
| api-turn/audit | `POST /api/loom/conversations/turn`, `audit` | runtime/agent | conversation turns, audit entries | producer into t-2027 / t-2030 |
| api-comms-adapter | `POST /api/loom/comms/adapter`, `comms/activity` | runtime | replies, tool-activity cards into threads | producer into t-2027 |
| api-pieces-changed | `POST /api/loom/pieces/changed` | runtime | manifest moved | producer signal |
| api-review | `review/token, scorecards, review/config, audit/take, audit/done, scores, findings` | runtime/review | review pipeline | EXCEPTION:machine API (t-2030 audit/digests) |
| api-venues | `GET /api/loom/venues` | runtime | venue directory | EXCEPTION:machine API |
| api-people | `POST /api/loom/people/ensure`, `people/merge` | runtime/owner/piece+grant | person cards | producer into t-2030 |
| api-store | `/api/loom/<store path>` `storeApi` | piece credential / owner | piece storage | EXCEPTION:machine API |
| cli, mcp | `/cli`, `/mcp` | bearer | agent memory/knowledge tools | EXCEPTION:agent protocol |

---

## 2. Duplication and the counting formulas (call-outs)

### 2.1 "What needs you" is counted at least eight different ways

| # | Where | Formula | Notes |
|---|---|---|---|
| **C1** | Home `needs` `H:2050,2062` | `inboxItems(h, pieces, env, [], householdOwner).filter(it => it.attention).length` | The canonical set: `absorbApprovals([...coreAsks, ...pieceAsks])` mapped to items. |
| **C2** | `shell.asks` (Inbox badge, phone bar, sidebar, DeskBoot) `H:1210,1216-1217` | Σ piece asks with `attention !== false` + `piecesAsks(env).length` + **#agents with ≥1 pending proposal** + Σ `openNeeds(agent).length` − `absorbedCount(h)` + `backupAsks` (household owner only) | Re-derived arithmetic, not a filter of C1. Diverges when: an absorbed approval card had `attention:false` (subtracted though never added); `openNeeds` failure modes differ from `conversationAsks`; single-agent loom (`H:1279`) counts piece asks only. |
| **C3** | per-agent badge `shell.agents[].asks` `H:1244` and Today `waiting` `H:2202` | `pendingProposals(a)` (**n proposals**) + `needsCount(a)` + piece asks with `agent===a && attention` − `absorbedCount(h,…,a)` | Proposals count n here but 1 in C1/C2/Inbox. `absorbedCount` is called **once per agent** (each call rebuilds `conversationAsks` + `pieceAsks`). Doesn't count scoped-piece asks without `agent`, though Today's asks list shows them (`H:2204`). |
| **C4** | Inbox folder counts (client) `W:inbox.tsx:75` | `items.filter(i => inF(folder, i)).length` over the Inbox view, after local `answered`/`read` overlay | Needs folder ≈ C1 but includes optimistic local answers. |
| **C5** | Inbox "From <agent>" counts (client) `W:inbox.tsx:76` | `items.filter(i => i.agent === a && i.attention).length` | ≠ C3 (proposals 1 vs n). |
| **C6** | Projects index per-project "waiting" `projects-pages.ts` (header) | open `needs_owner` in the project's conversations + items in feed groups marked `waiting` | Independent of Inbox; cached 60s. |
| **C7** | Comms dock count `H:476`, `/comms` `unread` `CR:225` | number of member's threads with `last_reply_seq > read_seq` | Threads. |
| **C8** | desktop agent card unread `src/comms.ts:580` | number of unread **reply messages** across the agent's threads | Messages; dock and card disagree ("1" vs "3 new"). |
| **Cp** | push `yourCall` `H:721` | `absorbApprovals(coreAsks + pieceAsks).filter(attention)`; per-device `hears` filter | Same set as C1 minus done items, recomputed every 60s. |
| **Ca** | system bar Boxes alerts `alertsOf` `H:1139` | piece asks of kind `alert` with attention | Per piece. |

**Read state is split three ways**: Inbox opened-keys per reader in `ui-sessions.json` (`markOpened`; written by
`POST /inbox/read` **and** by `GET /inbox?i=`), Comms `read_seq` per thread in `household.db`, and the client's
optimistic `read` set (`W:inbox.tsx:66`). `/inbox/read` and `/appearance/prefs` don't call `changed()`, so other
devices/tabs only converge on their next unrelated refetch.

### 2.2 The Inbox item set is rebuilt many times per interaction

`inboxItems()` (`H:1019`) — which walks every agent's proposals and open needs, every piece manifest, answered needs (7
days) — is called by: Home (`H:2050`), Inbox (`H:2099`), `/inbox/open` (`H:2091`, once **per visible ask card per
`change`**), Comms thread GET/since (`H:1541`, per pull, memoized per request), Comms refs `pending` (`CR:280`),
`askBefore` before every answer/allow/deny (`H:1007`). In addition `findAll` (`H:1055`) and `yourCall` (`H:726`)
rebuild `absorbApprovals(coreAsks+pieceAsks)`, and `chrome()` rebuilds `conversationAsks+pieceAsks` (1 + #agents
times via `absorbedCount`) on **every** view, including every 304 refetch.

### 2.3 Agent status derived in parallel

- `agentCards` `H:978` (Home cards: worst state, doing, jobs, problems, readings, last seen, steps)
- `agentStateOf` `H:1156` (chrome `working`, Profile agents) — documented as "the same as" agentCards but separate code
- `onOf` `H:1191` (agent window pill), `workingOf` `H:1186`
- `moving` `H:2059` (Home "what's moving") from manifest `state==='working'` only
- `atWorkFor` `H:166` rewrites jobs/doing per member before all of the above
- Client: `deskAgents` `W:desk-agents.tsx:92` merges shell + Home cards + Comms summary; `statusItems` and `tickerParts`
  re-derive working counts and place words from shell.
- `lastActive` (`H:1116`) and `agentCards.seen` each read the tape (`tapeRows`) separately; Today reads it a third time.

### 2.4 Other duplicates

- **Backup** status in four places: `shell.backup` glyph, `backupAsks` alert, `backupFyi` FYI, agent Setup row.
- **Proposals**: Home/Inbox ask (`proposalAsks` `H:780`), C2/C3 counts, Mind page, Today tile "Memories", MCP widget.
- **People**: `/people` app, per-agent people, Find suggestions, DeskBoot's `/find` fetch for one name, Profile `me.full`.
- **Tasks/PRs**: tasks piece pages, Changes piece page, Projects feeds and Changes counts, Comms work panel, Comms refs
  chips (`tasks run show`), needs-resolve (`tasks run show`), Inbox `Ref` chips client-side.
- **Comms thread list**: view `comms` list, `getJson('/comms')` reload, archived/background fetch, `/comms/agents`,
  People strip (`threadsOf` in `contacts()` `H:2042`), `atWorkFor` thread lookup.
- **Piece pages**: an Inbox item's `inline` page duplicates `/p/<piece>/<path>`.
- **Prefs**: localStorage mirror + server prefs on every view.

---

## 3. Authorization on reads today

- **Identity** (`whoIs` `H:369`): browser session cookie `loom_ui` (64 hex) validated against `ui-sessions.json` (hash of
  id), expiry (`sessionEnded`), and **token liveness** (`auth.live(secret)`: revoke/rotate kills sessions) — `H:333`;
  else `Authorization: Bearer`. `member` resolved from the token digest (`tokens.json` roles) (`UiAuth.member`).
  Agent sessions (t-1936, `session.agent`) are short-lived screenshot sessions and get no push.
- **Household owner vs agent owner**: a member with `agents !== '*'` is an agent owner. Then (`H:1454-1459`):
  `scopedPathOk` allowlist (`H:136`, else 403); household narrowed to their agents (`narrowed` `H:228`); env gains
  `LOOM_OWNER_SCOPE`; pieces filtered by `forOwner` (`H:192`: only `owners: 2` pieces; asks/notices/answered/agents
  cut to their agents; tile dropped); household-only core actions refused (`H:1746`); Knowledge/People/Projects
  refused or emptied.
- **Per-member data**: `readerFor` (`H:209`) picks whose read-state/prefs/done-toasts (first owner = household record).
  Comms: every thread route calls `threadFor` (member must own the agent **and** be the thread's member; `comms.ts:423`);
  thread SSE re-checks `stillSees` on every event. `atWorkFor` hides another member's Comms thread titles in jobs.
  `resolveFrom` draws a piece page's "from" block per member. Activity applies the same visibility (`activity.ts` header).
- **Cross-site**: GET only same-origin/none or top-level navigation (`allowedGet` `H:491`); POST requires
  `sameOrigin` (`H:502`) **and** CSRF = `HMAC(ui-cookie.key, session id)` (`csrfFor` `H:324`) as `_csrf` (form or JSON).
  Bearer callers need no CSRF. Cookie `HttpOnly; SameSite=Strict`. CSP forbids inline script/framing (`H:95-105`).
- **SSE scoping**: `/events` client carries `sees` (`'*'` or owned agents) and `member`; `changed(about)` only nudges
  clients whose `sees` intersects; fs changes are placed by agent folder (`H:1493-1499`); comms changes go only to that
  member (`changedFor`). Max 6 streams/session (`live.ts:31`), 4 per thread per session (`comms-live.ts:20`).
- **Offline copies**: SW keys every view copy to `x-loom-who` (hash of the session) and drops them on change/logout.
- **Pieces**: pieces are trusted same-user subprocesses. Manifest calls get **no caller** (only `LOOM_SCOPE`/
  `LOOM_OWNER_SCOPE` env) — viewer filtering of manifests happens in core (`forOwner`). Page calls get `caller`
  `{kind:'owner', who, agents}` on stdin; actions also get a minted **store grant** (`LOOM_STORE_GRANT`, `pieces.ts:56`)
  scoped to owner collections or an agent's keys. Agent calls to pieces (`/api/<piece>`, offered MCP tools, delivery)
  ask the **grants authority** (runtime) first, fail-closed (`src/grants.ts`). Browser can never reach `/api/*`
  (Origin refused, `http-server.ts:868`).
- **Where piece data is proxied**: manifests → `pieceManifests` (`pieces.ts:351`) folded by `H:chrome/inboxItems/
  agentCards`; pages → `/p/<piece>/…` and `/a/<agent>/p/<piece>/…` (`H:2256`, `H:2216`) via `piecePage`; actions →
  `/act/<piece>` (`H:1820`) via `pieceAct`; Comms → `pieceApi` to the runtime (`CR:96,105,184`); feeds → offers.

## 4. Change-notification mechanisms today

| mechanism | events | carries | triggers | revision/cursor? |
|---|---|---|---|---|
| `/events` (`live.ts`) | `change` only (+ `: beat`) | `{}` | fs.watch of `$LOOM_HOME` for `memories|knowledge|people.db(-wal)`, `household.json`; `pieces.tick`; 15s manifest fingerprint diff per scope; `changed()` after any `/act`; `changedFor(member)` on Comms moves | **No**: pure "refetch everything you show". Coalesced to ≥1.5s. No topic, no entity, no version. Client refetches the full view with ETag. |
| `/comms/<t>/events` (`comms-live.ts`) | `message` | `{seq}` newest seq | `comms.tick` fs.watch, same-process `bump()` listeners, 2s poll of `comms_threads.updated` / seqs / state | **Yes, per thread**: monotonic `seq`; `?from=` resumes; client fetches `/since/<seq>`. State changes (delivered/failed/working) re-send the same seq. |
| `pieces.tick` file | — | time | `POST /api/loom/pieces/changed` (runtime) | No; expires all manifest caches |
| `comms.tick` file | — | time | every Comms write (`bump` `comms.ts:630`) | No; readers diff `comms_threads.updated > seen` (ms timestamps) |
| ETag/304 | — | sha256 of view JSON minus `now` | every view | Per-view content hash, not a revision; computed after full rebuild |
| Piece `refresh` | — | seconds | piece page asks to be polled | No |
| Push watch | Web Push | title/body/url | 60s diff of ask keys (`askKey`) | Key set diff stored in sessions file (`~seeded`) |

Gaps relevant to the spec: no event for Inbox read-state, prefs, or piece *page* changes (only manifest moves);
manifest moves are detected by polling subprocesses every 15s; multiple loom-http listeners (LAN/tailnet/localhost)
coordinate only through tick files in `$LOOM_HOME`.

## 5. How pieces are invoked (batching implications)

- **Subprocess per call, always.** `spawn(path, args, {detached:true})`, request JSON on stdin, answer on stdout,
  process group SIGKILLed after every run (`pieces.ts:205-255`). No long-lived piece processes, no HTTP to pieces.
  - `ui --json` (manifest): 3s timeout, 512KB.
  - `ui page --json` (`{path, query, caller}`): 15s, 512KB.
  - `ui act --json` (`{action, path, fields, caller}` + store grant): 15s.
  - `api --json` (`{caller, path, body}`): 15s, 8MB.
  - offers: arbitrary argv from `piece.json` `loom` block (`sections.project`, `sections.thread`, `venues.send`,
    `delivery`, `grants`, `mcp_tools`).
- **Pools** (`pieces.ts:139-196`): page/manifest/feeds 6 concurrent (unbounded queue); api 4 + 8 waiting (else 503
  busy); tools 4+16; delivery 8+32; grants 8+32.
- **Caching**: manifests 45s fresh / SWR to 10 min, in-flight promise shared, keyed by path + `LOOM_SCOPE` + realpath
  mtime (an install is a new key); pages 5s / SWR 5 min, keyed by caller; any `act` on a piece clears that piece's
  manifest + page caches. Project index feed counts 60s.
- **Load shape**: with P pieces, every open scope costs P process spawns every 15s (live tick) plus P per cache expiry
  on page loads; a Projects index costs (projects × feed pieces) spawns (bounded by pool and 5s wait); each Comms work
  panel costs one spawn per thread-feed piece every 60s per open thread. There is no batch verb (e.g. "manifest for
  scopes A,B,C" or "since revision R"), so a provider model will want a per-piece **long-lived or batched** entry
  point, or a piece-side change feed (`pieces/changed` is the only push from a piece today, and only the runtime may
  call it).

## 6. Counts per destination (rows in §1, excluding §1O machine APIs)

| destination | rows |
|---|---|
| t-2025 attention | ~12: v-house-home(needs part), v-inbox, inbox-open, inbox-read, act-needs, ch-asks, ch-agent-asks, push-watch, needs-resolve, approvals act/pages, dashboard asks, find "Do" |
| t-2027 conversations/Comms | ~13: comms-thread-events, v-comms-list, v-comms-thread, comms-since, comms-before, comms-agents, comms-writes, ch-comms, v-conversation, poll-comms-agents, poll-comms-read, comms-sweep, comms-watch |
| t-2028 agent status/jobs/ticker/clock/boxes/models | ~9: Home cards/moving, dashboard tiles/next-wake, ch-agents.working/sub, ch-nav tile stats (ticker, Boxes glyph), live-tick (agents reports), comms-model, runtime/clock piece pages, pm-manifest `agents{}` |
| t-2029 tasks/projects/Changes | ~6: v-projects (index + hub), v-p-piece (tasks, Changes), comms-work, poll-comms-work, project feeds offers, comms-refs task/PR chips |
| t-2030 knowledge/memory/people/profiles/activity/search | ~12: v-knowledge, v-people, v-agent-mind, v-activity, dashboard head/thread, act-agent-core, act-household (identity/person/fact), find, v-profile `me`, ch-agents marks/faces, w-proposals, w-top-of-mind, fold/audit |
| t-2031 settings/household/grants/pieces/backup/health | ~12: v-pieces, act-pieces, v-members, v-agent-setup, act-household (members/tokens/backup/marks), prefs, ch-prefs, ch-backup, ch-permissions, ch-icons, ch-nav catalog, v-sheets (places/setup/appearance), Profile sessions/devices, backup-tick, pieces-json, piece-install jobs |
| EXCEPTION | ~35: static assets (8), media faces/icons (2), auth/passkey/session/CSRF/flash (9), push key/subscription/display (4), local-only UI state (10 + timers), new-* form scaffolds, MCP-App probes, MCP SSE, machine APIs |

(Several rows split across two destinations; counts are approximate by primary destination.)

## 7. Observations that matter for the spec

1. **Every view is "page + chrome"**; chrome holds most cross-cutting counts. Moving to collections means chrome
   disappears as a transport and becomes ~6 small live queries (attention count, per-agent attention, comms unread,
   agent status, places/nav, backup/health, prefs).
2. **Pick one attention formula** (C1, the item set) and derive every badge from it client-side; decide whether a
   proposal is 1 item per agent or n. Same for Comms: threads vs messages.
3. **Read state must become a collection** (per member, keyed by item key / thread) with change events; today
   `/inbox/read` and prefs writes are silent.
4. `/inbox/open` exists only because copies may be stale; with a versioned attention collection the client can check
   locally and the server enforces the precondition on `/act` (it already re-checks open needs in `needsAct`).
5. **Manifests are household-wide, filtered in core.** The manifest cache key omits `LOOM_OWNER_SCOPE`
   (`pieces.ts:306`), so pieces that *do* read it could have one scope's answer served to another; core's
   `forOwner` is the real boundary. A piece provider needs an explicit per-viewer filter (or per-scope subscription)
   rather than relying on env.
6. **The only real cursor today is Comms `seq`**; everything else is "refetch". Manifest changes are found by polling
   subprocesses (15s), which is the main cost to replace with a piece-pushed change stream.
7. Side-effecting GET: `/inbox?i=<key>` marks read (`H:2103`). Hover prefetch (`tiles.tsx:116`) deliberately skips
   `?i=`, `/activity` (looking moves its "new since") and `/find` for that reason, which shows the cost of reads that
   write. In the collection model, "opened" should be an explicit mutation only.
8. Multi-listener topology (several loom-http processes share `$LOOM_HOME`) means any new change stream needs a
   cross-process fan-out (today: tick files + fs.watch + polling).
