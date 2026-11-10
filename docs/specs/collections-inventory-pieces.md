# Collections inventory: catalog pieces

*Appendix to [collections.md](collections.md). Raw survey, 2026-11-09, read-only, of the catalog pieces at their repos' HEAD. Line numbers will drift.*


Read-only survey, 2026-11-09. loom core read at `6ab2a79` (the loom checkout). Piece repos were cloned shallowly into `<repo>` and read at HEAD. HEAD is newer than the catalog pin for runtime/loom-box (15de4bd, catalog e0ba495), clock (8a67bfd, catalog 545e2ad) and tasks/taskstore (e9365c6, catalog 5e11755). The others match their pins. Every row cites file:line: core paths are relative to the loom checkout, piece paths to the piece's repo.

## At a glance

| Piece | Role | Store today | loom piece store? | Stable record ids | Emits change events? | Never in a shared browser cache | Main destinations |
|---|---|---|---|---|---|---|---|
| runtime (loom-box) | `runtime`; grants authority; delivery; venues `relay`,`spawn`; MCP `relay`,`comms_trace`,`spawn`; strangers (box join) | `state.json` (boxes, houses, services, logins, joins, model choice), per-conversation delivery JSON, bridge/boxwatch/review files, sealed `.age` session slots | **yes, partly**: `grants`,`gates`,`policy` (owner), `gate-proposals` (piece) | houses `h-NNN`, box names, job ids, logins, joins, `cv-…` | **only piece that can**: `POST /api/loom/pieces/changed` (empty body, ~every 10 s while a body works). Store writes, box polls and login progress send nothing | box credentials/join codes, house claim tokens, secret values handed to houses, model login links/codes, remote-control URLs, body proofs, terminal steering, sealed slots, review token | t-2028 (boxes, houses, cards, jobs, models), t-2025 (asks), t-2027 (delivery, turns, relay, spawn), t-2030 (gates as people), t-2031 (grants, policy, house config) |
| clock (loom-clock) | `clock`; venue `wake: {}` | JSON under `<piece home>/data` (wakes, lanes, schedules, spool, `filed.json`, `wake.log`) | no | wake `w-xxxxxx` is **not** stable (re-minted on retry, resume, defer, each schedule occurrence, every 5 min while parked). Stable: schedule name, lane name, `deliver_place` | no (15 s manifest poll only) | wake prompts, lane text, `filed.json`, delivery token, principal statements, raw `wake.log`/`audit.jsonl` | t-2028 (wakes, schedules, lanes, jobs), t-2027 (deliveries) |
| approvals (loom-approvals) | `approvals` | `approvals.json` (newest 300), `rules.json`, `audit.jsonl` in `<piece home>/data`; no `bundle` verb | no | `a-[0-9a-f]{8}` (stable, but records age out past 300) | no | `for`/`people`/`who.where` need per-member filtering; audit | t-2025 (asks, states), t-2031 (rules, grants metadata) |
| tasks (taskstore) | `tasks` (contract `spec/taskstore-core`); `sections.project` + `sections.thread` | SQLite `.taskstore/store.db` + 8.2 MB JSONL mirror + `store.interactions.jsonl` | no | `t-NNN` stable. Comments have no ids. **No `updatedAt`/version** | no. `interactions.jsonl` is an ordered log with ids and field diffs but has no seq, and nothing reads it | low (household-only; no `owners: 2`) | t-2029 (tasks, backlog jobs → t-2028) |
| changes (loom-changes) | (Changes reader) | GitHub is the source of truth; `snapshot.json` cache (50 open + 8 days closed per repo, ≤500 rows) | no | `github:owner/repo#N` (+`@sha` for approvals) | no (signals only when the tile text moves) | GitHub tokens (in one child process) | t-2029 (PRs), t-2031 (rule verdicts read from approvals) |
| secrets (loom-secrets) | (no `loom` block in package.json; contract `ac-sec-*` in README) | sops+age encrypted store, `policy.json`, `requests.json`, usage JSONL | no | secret names; request ids `q-…` | no | **all values** (add/replace field, `get`, `issue`, `podman`, bundle); names/policy/usage are household-only metadata | t-2025 (requests: Allow/Always/Deny), t-2031 (names, policy, usage), EXCEPTION (values) |
| shuttle | (Bridges page; mostly legacy) | `people.json`/`routes.json`/`shuttle.json` per agent (gates moved to the runtime; tombstones in `moved`) | — | route keys, place keys | no (poll) | platform user ids in gates/routes, body/relay queues holding prompts and text | t-2031 (route map, owner-only, until it migrates to the runtime); the rest is superseded |
| discord (loom-discord) | venue `discord` (no `render`) | local data dir (`state.json`, `shadow-routes.jsonl`, presence/stops/posted) | no | message ids `agent:msgid`; places `channel:`/`thread:<snowflake>` | no; push is `POST /api/loom/deliver` per message (idempotency id, no cursor) | bot token, deliver token file, channel text (strangers' too, via `read`) | t-2027 (via core conversations), t-2031 (`status --json`) |
| slack (loom-slack) | venue `slack` (no `render`) | local data dir (`state.json` holds undelivered text in live mode) | no | `agent:cid:ts`; places `dm:<U…>`,`group:<cid>` | no; `deliver` per message | bot and app tokens, signing secret, undelivered text, Slack user ids in place keys | t-2027, t-2031 |

### Cross-cutting findings
1. **Only the runtime can say "I changed"**, and the signal carries no data. `POST /api/loom/pieces/changed` is restricted to the runtime role (`src/transport/role-routes.ts:41`, `src/transport/http-server.ts:775`) and has no body, ids, revision or piece name. Every other piece is seen only through core's 15 s manifest poll (`src/ui/live.ts`), which compares whole-manifest JSON, or through `changed()` after an action routed through loom. The SSE event is a bare `change` with `{}`.
2. **No piece emits per-record revisions.** The one revision mechanism in the stack is core's piece store (`src/stores.ts`): a per-doc `rev` used for compare-and-swap, plus a store-wide `revisions.id` AUTOINCREMENT. That id is not a full change log: it keeps 20 revisions per doc, and `history:false` collections write no rows. Only the runtime uses the store, and only for 4 collections. Tasks' `store.interactions.jsonl` is the closest thing a piece has to an ordered change stream.
3. **Attention items have no identity.** Manifest asks, notices and answered rows carry no id. Inbox keys are `sha256(source, text, page)` (`src/ui/push.ts:35`), so a reworded ask becomes a new item. Approvals ids sit only in `actions[].fields.id`. The manifest contract's only producer-stable id is `jobs[].id`. t-2025 needs an `id` on asks, notices and answered.
4. **Clock wake ids churn**, so a t-2028 jobs collection keyed by `w-` id would thrash. Key it by schedule, lane or place instead, or make the clock mint a stable job id.
5. **Lists are capped slices, not pages.** Manifest caps are asks ≤10, notices and answered ≤20, `doing` ≤8 and jobs ≤10000. Approvals shows the first 10 pending asks with no "more" signal. Runtime `list` returns the newest 50. Changes is capped at 500. Tasks has no cap and is re-parsed in full (2,088 tasks) on every manifest, page and feed. `run export` exceeds the API answer caps.
6. **Cross-piece reads that the collection design must model:**
   - **Core → approvals `state`:** used by Needs-you auto-clear and Comms asks (`src/needs-resolve.ts:92`, `src/comms-asks.ts`), and after an owner-applied Allow (grant, vouch-wake or principal-reset), which reads `state` and then posts `grant-approved`, `vouch-approved` or `reset-approved` to the runtime or clock (`src/ui/handler.ts:389-458`).
   - **Core → tasks `run show <id>`:** checks Needs-you `waits_on`.
   - **Core → manifests of all pieces:** Inbox, Needs-you counts and Home agent cards. The worst state wins, and jobs are merged with task-only rows absorbed (`handler.ts:966-1244`).
   - **Core → section feeds:** projects (`src/project-feeds.ts`) and Comms thread work (`src/comms-work.ts`), today served by tasks and runtime.
   - **changes → approvals:** `rule merge --for --json`, `grant`, and the approvals page's rule action.
   - **runtime → approvals:** spends grants and resets. **runtime → clock:** parses its preamble to label houses.
   - **discord → shuttle:** reads the route map (`loom shuttle routes --agent A --json`).
   - **packages → discord:** `loom discord read` of the packages channel.
7. **The owner filter must travel with rows.** A member who owns only some agents sees a piece only if it declares `owners: 2`, and then only rows tagged with their agents (`handler.ts:195-205`). Comms rows are per member (`changedFor`). Any shared collection needs an `agent` tag per row, plus member scoping for conversation-linked rows.
8. **Not in the household bundle:** approvals (no `bundle` verb). The bundle status of the others is in their sections.

---

## How core reaches pieces today (the frame every piece section assumes)

loom core at the loom checkout @ `6ab2a79`. Everything below is the transport a piece's data rides on now; the per-piece tables refer back to these channels by name.

| Channel | What it is | Where (core) | Identity / revision | Change signal | Notes for the collections move |
|---|---|---|---|---|---|
| **Manifest** `loom-<p> ui --json` | One JSON blob per piece per scope: `tab`/`agentTab`, `tile`, `asks` (≤10), `notices` (≤20), `answered` (≤20), `agents{state,reason,readings≤4,doing≤8,jobs≤10000}`, `add`, `owners`, `scope` | run: `src/ui/pieces.ts:277` (`fetchManifest`), cache `:296` (45 s `CACHE_MS`, stale ≤10 min, keyed path+`LOOM_SCOPE`+bin mtime); schema `src/ui/vocab.ts` (`parseManifest`, jobs at `:1059`) | none per item. Inbox items are keyed by `askKey` = sha256(source, text, page) (`src/ui/push.ts:35`): a reworded ask is a new item. Notices/answered keyed `fyi:<at>` / `answered:<at>`. `jobs[].id` is the only producer-stable id the contract asks for | whole-manifest fingerprint: `refreshPieceManifests` (`pieces.ts:335`) is polled every 15 s (`WATCH_MS`, `src/ui/live.ts`) per open scope and compared by `JSON.stringify`; a difference nudges SSE | The manifest is the one big attention + agent-status feed: asks/notices/answered -> t-2025; agents/doing/jobs/readings/tile -> t-2028; tab/kind/icon/accent/fit -> t-2031 (catalog). It has no per-row identity or revision today. |
| **Consumers of the manifest in core** | Inbox items `inboxItems` (`src/ui/handler.ts:1019`), Needs-you count (`:1210`, `:1244`, `:2202`), Home tiles/asks (`:2246-2250`), agent cards state/doing/jobs (`:980-990`, `:1157-1192`, `:2059`), agent Today tile (`:662`), owner filtering for partial owners (`:200-203`), jobs conversation-label visibility (`:167-176`), nav stat/tone (`:1202`), lead-card detection for approvals (`:1014`, `:433`) | | | | Core does all cross-piece *merging* of attention (asks+core needs+approvals absorbed: `absorbApprovals`) and of agent state (worst state wins). The collection design has to keep that merge server-side or reproduce it in the client. |
| **Page** `ui page --json` | stdin `{path, query, caller}` -> a page of blocks. Must not change anything (contract) | `pieces.ts:381` (`piecePage`), cached 5 s fresh / 5 min stale, 1 s when the page set `refresh`; key includes caller | none (paths are the piece's own, e.g. `task/t-1482`) | dropped when its piece's manifest fingerprint moves (`clearPiecePages`, `live.ts`) | Pages are presentation, not data: they stay piece-rendered (block vocabulary). What moves to collections is the *records* the pages are drawn from. |
| **Action** `ui act --json` | stdin `{action, path, fields, caller}`; owner's grant (`LOOM_STORE_GRANT`) handed in | `pieces.ts:445` (`pieceAct`), route `POST /act/<piece>` and `/a/<agent>/act/<piece>` (`handler.ts:1684`) | — | clears that piece's manifest cache and calls `changed()` (an SSE nudge to the actor's apps) | Mutations. Field values only on stdin, never logged (secrets). |
| **API** `api --json` | `POST /api/<piece>/<path>` -> `{status, body}`; `run` = the piece's CLI remotely | `pieces.ts:484` (`pieceApi`), route `src/transport/http-server.ts:886`; 15 s, 8 MB, 4 running/8 waiting | piece-defined | none | Programs, not browsers. Core itself uses it as the owner to read across pieces (below). |
| **Offers** (package `loom` block) | `sections.project` / `sections.thread` feeds, `venues` (+`render`/`send`), `mcp_tools`, `grants`, `delivery` | `src/offers.ts`, `src/offers-registry.ts:29` (`piecesOffering`), `src/project-feeds.ts:56`, `src/comms-work.ts:241`, `src/offered-tools.ts:45`; venues copied into `$LOOM_HOME/household.db` (`src/household-store.ts`) | section items carry `ref` (e.g. `t-NNN`); not cached | none (run on each hub/thread view) | Section feeds are the cross-piece seam into projects (t-2029) and Comms threads (t-2027). |
| **Piece store** `loom store <p> …` / `POST /api/loom/store/<p>/<op>` | per piece `commons/stores/<piece>.db`: `docs(collection,key,doc,rev,updated,by)` + `revisions(id AUTOINCREMENT,…)` | `src/stores.ts:108-219` | **the only place in the stack with real revisions**: per-doc `rev` (CAS via `--if-rev`), and a store-wide monotonic `revisions.id`. But history is pruned to the last 20 per doc (`KEEP_REVISIONS`) and a `history:false` collection writes no revision row at all (`:210`) | none: a write to a piece store is deliberately *not* watched (`live.ts` header: "or a piece's store, which its own page load may write") | Natural backing for versioned providers: `rev` is a per-key version; `revisions.id` is close to an ordered change log but is not one (pruning, history:false gaps, deletes of history rows). An append-only change sequence per store would be new. |
| **`POST /api/loom/pieces/changed`** | "my manifest moved", no body | `src/transport/http-server.ts:775`, `src/ui/live.ts:150` (writes `pieces.tick`; watcher calls `tick(true)`) | none: carries no ids, no revision, no piece name | a bare nudge; open apps refetch | **Only the runtime's token may call it** (`src/transport/role-routes.ts:41`). No other piece can say it changed; they wait for the 15 s poll or an action through loom. |
| **SSE `GET /events`** | one `event: change` with `data: {}` | `src/ui/live.ts` | none | "something changed" for what this viewer may see (scope by agent; Comms by member via `changedFor`) | The current live mechanism carries no data, no ids, no cursor. Collections replace it. |
| **Core cross-reads into pieces (as the owner, via their API)** | approvals `state` for ids; tasks `run show <id>` | `src/needs-resolve.ts:81-120` (`pieceWithRole`, `pieceCheckers`) used by Needs-you auto-clear and Comms asks (`src/comms-asks.ts`); owner-applied approvals (`grant`/`vouch-wake`/`principal-reset`) read back `state` then post `grant-approved`/`vouch-approved`/`reset-approved` to runtime/clock (`src/ui/handler.ts:389-458`) | approvals by `a-[0-9a-f]{8}`; tasks by `t-NNN`; wakes by `w-[0-9a-f]{6}`; conversations `cv-[0-9a-f]{12}` | polled on a tick | These are the cross-piece reads the attention collection (t-2025) must model: an ask `waits_on` an approval or a task, resolved by another piece's state. |

Other core facts that matter for every piece:
- Pieces on the page = every `loom-<name>` on the **daemon's** `PATH` (plus managed `$LOOM_HOME/pieces/bin`), less aliases (`shownPieces`, `pieces.ts:326`). A script named `loom-*` that happens to be on the daemon's PATH is listed as a piece.
- Owners filter: a member who owns only some agents sees a piece only with `owners: 2`, and then only asks/notices/answered/agents naming their agents, no tile (`handler.ts:195-205`). Any shared browser collection needs the same per-row agent tag to filter by.

---

## runtime (sleepunit-agents/loom-box)

Inventoried at **HEAD 15de4bd** ("Observe safe current agent activity with expiry", #151). The catalog pins **e0ba495**;
HEAD is 22 commits / +2196 −200 lines in `src/` ahead. What the newer HEAD changes for this inventory:
- the manifest gained `agents[a].jobs` (complete job list: conversation jobs, house jobs, `remote:*` jobs, bridge jobs)
  and `agents[a].idle = {observedAt, expiresAt (+30 s)}` (ui.mjs:240-270), plus `doing[].activity` ticker observations
  (delivery.mjs:910-929, ticker.mjs). Core at the loom checkout 6ab2a79 documents `jobs` (docs/extensions.md "Complete agent
  jobs") but **has no `idle`/`expiresAt`/`activity` in vocab.ts or the docs**: core drops or ignores them today.
- native-history collection, durable launch journals, offline house collection (new on-disk files under the data dir;
  house badge gains a `native` collection phase).
- `tellAtWork`'s fingerprint now includes the 10-second bucket and the activity action (cli.mjs:185-200), so
  `pieces/changed` fires at most every ~10 s while bodies work, not only on start/end.

Paths below are `src/…` in loom-box at HEAD. Program `loom-runtime` (alias bin `loom-box`).

### Store

Four kinds of storage. Only the first is loom's piece store; everything else is the piece's own files.

**1. loom piece store** (`loom store runtime …`, store.mjs:13-55; declared in package.json `loom.store`). All writes are
revisions (piece-storage.md has no `history:false` option; none declared). Reads are "anyone's on loom's machine"; a house
can't reach it (store.mjs:16 refuses under `HOUSE_ID`).

| Collection | writers | Keys / docs | Written by | Read by |
|---|---|---|---|---|
| `grants` | owner | one doc, key `household`: `{pieces: {<piece>: {<agent>\|'*': [paths]}}, relay: {<agent>: [agents]}, seeded}` (grants.mjs:26-27) | ui act `grants-set`/`relay-set`/`relay-pair`/`grant-approved`; CLI `grants seed\|set\|paired` | core's grants offer (`grants ask`, every agent→piece call), Permissions pages, `run grants list`, relay pairing |
| `gates` | owner | one doc per agent (key = agent): people/agents with tiers and platform ids (gates.mjs:24) | ui act `gates-allow`/`gates-merge`; CLI `gates import`, `follow-merge` | delivery (sender tier, gatesOf, cached 30 s), `run gates people`, gates pages |
| `gate-proposals` | piece | key `<agent>.<id>`: one proposed person (gates.mjs:25) | `run gates propose` / `propose-person` (a body) | manifest asks (gates.mjs:331), gates page, Permissions counts |
| `policy` | owner | one doc per agent: what its bodies may use/are told (policy.mjs:15,46) | CLI `policy set` | delivery (body rules at start) |

**2. Control-plane state file** `$LOOM_BOX_HOME|~/.config/loom-box/state.json` (state.mjs:19-21,44), 0600 in a 0700 dir,
single JSON doc rewritten whole under `state.lock` (state.mjs:105-160). Top-level keys: `boxes{<boxId>}` (facts, labels,
mayHost, owner, lentTo, lastSeen, joined, revoked, harnesses{claude,codex: installed/loggedIn/method/plan/unhealthy/expiry},
usage, runtime{commit,piece,upgrade}, sessions.busy, reportOnly, alwaysOn), `primaries{agent:box}`, `agents{agent: repo,
houseFile, branch, repoSecret (store name), secrets {as: store-name}, nested, gpu, ports, tailnets {name, socket}, logins}`,
`houses{h-N}` (agent, box, task text, needs, state, created/started/updated, by, kind/seat, log tail, exit, tokenLabel,
logins, collection, draining, nativeHistory, sessionRuntime …), `services{<agent>/<name>}` (want, box, house, moveTo,
restarts, crashes), `serviceState` (saved-state blob metadata), `remotes{agent}` (box session: box, dir, want, state,
url, error), `joins{j-…}` (pending box join requests incl. `code`, `address`, `proofHash`, and `credential` until polled),
`logins{l-…}` (box sign-ins: box, harness, state, link, userCode, kind, error, detail, method, plan), `builds`,
`modelChoices{agents, conversations}`, `models` (list/allow/prefer), `quotaHolds`, `pendingRevokes`, `seq`.
**Houses are never deleted** (no prune; `nextHouseId` h-<seq> never reused, state.mjs:163-166) — the file grows; `list()`
returns only the newest 50 (control.mjs:416-419).

Beside it in the same dir: `box.json` (a joined box's credential/config, box.mjs:41), `upgrade.json` (version.mjs:143),
`errors.log` (ui.mjs:1454), `session-cpu.json` (busy.mjs), `principal.key` + `wake-for.json` (principal.mjs:194,233,
under the delivery dir), carried settings file (version.mjs:278).

**3. Data dir** `$LOOM_BOX_DATA|~/.local/share/loom-box/` (ui.mjs:165, delivery.mjs:166):
- `delivery/conversations/cv-*.json` — one per conversation: agent, venue, place, label, kind, body, run, runLog
  (RUNS_KEPT), queue (message text **sealed**), paused, control, spawn metadata, actsFor/principal, bodyRules, cardsSent,
  refused… (delivery.mjs:168-194). `delivery/slots/cv-*.age` + `.home.age` — sealed harness session files (age to
  `runtime.key`, sealed.mjs:34-35). `delivery/seen/<hash>.json` (24 h idempotency), `delivery/notices.json` (≤20, 24 h),
  `delivery/fallbacks.json` (model fallback per agent), `delivery/relays.jsonl` (30 days, relay.mjs:40,78),
  `delivery/hosts/…` (body-host seats, houserunner.mjs:116), `delivery/lock`.
- `bodies/<harness>-<id>.json` (body records), launch journals (launch-journal.mjs, house-launch-journal.mjs).
- `now/<agent>-now/<bridge>.json` + `events-YYYY-MM.jsonl` (bridge snapshots, ≤64 KB/16 KB; `LOOM_RUNTIME_NOW_DIR`
  overrides) and `now-watch.json` (bridge outage memory) (nowboard.mjs:57-60,264).
- `box-watch.json` (per-box conditions, failing units with journal tails, boot info, FYI notices) and `health/`
  samples (watch.mjs:181,418).
- `review/` (`schedule.json`, `runs.jsonl`, grader proxy) (review.mjs:72-97,220).
- `houses/h-N/` on each box (`log` incl. Claude remote-control link, `attach.json`, `ending.json`, native files)
  (box.mjs:566-613), `repos/` mirrors, `build-check/`, `logins/<harness>/` (box CLI login homes — model credentials,
  `.credentials.json`/`auth.json`, logins.mjs:61,99), `blobs/` (service saved state, blobs.mjs:27).
- Codex run dirs `~/.local/share/loom-runtime/codex-runs/<id>/events.jsonl` (runners.mjs:426-470); Claude job dirs
  `~/.claude/jobs/<id8>/state.json, timeline.jsonl` read for status/ticker.
- `$XDG_RUNTIME_DIR/loom-runtime-codes/<l-id>` — a pasted login code, transient (control.mjs:1155-1172).

**4. No SQLite.** Bundle part = age-encrypted `state.json` (minus `joins`) + service-state blobs (bundle.mjs:21-40).

### Manifest & offers

**Manifest** (`loom-runtime ui --json` → `manifest()`, ui.mjs:224-297), `v: 2`, `owners: 2`:
- `tab: {label: 'Boxes'}`; `agentTab: {label: 'Houses'}` (per-agent tab, `LOOM_SCOPE`); no `kind`, no `add`.
- `tile`: Boxes — "<n> boxes", detail "<n> houses up or waiting", page `''` (ui.mjs:281-286).
- `asks` (unbounded concatenation, each source capped): box join requests ≤5 (`allow-join`/`block-join`, includes join
  `code` and requester IP `address`, ui.mjs:308-319); gate proposals ≤10 (gates.mjs:331, actions gates-allow/deny);
  now-board bridge alerts ≤10 (dark/looping, kind alert, nowboard.mjs:357-421); loop pauses ≤10 (`loop-resume`/
  `loop-dismiss`, delivery.mjs:1529-1543); box watch alerts ≤20 (watch.mjs:478-494); login-expiry asks
  (login-expiry.mjs:26). Asks have **no ids** — text/at only (core keys pushes by text).
- `notices` (≤20, newest first): delivery give-ups, relay heads-ups ≤5, box joined / task house failed (with the last
  log line, ui.mjs:456-469), bridge back-up FYIs, box watch FYIs.
- `answered`: **none**.
- `agents{agent}`: `readings` (Bridges, Remote, Tasks ≤4), `state` (working/unavailable/broken) + `reason`, `doing` (≤6
  from agentReports, then merged ≤8: task houses, remote sessions, delivered bodies via `convDoing` with
  `conversation` id and `activity`, bridge board talk rows), `jobs` (unbounded per runtime; core caps 10,000), `idle`
  `{observedAt, expiresAt}` (HEAD only).
- Manifest is recomputed on every call from files + shells out to `loom discord|slack status --json` (2 s each,
  nowboard.mjs:185-196); it also *mutates* (checkLoginExpiry, checkDark may raise alerts). Core reads it each WATCH_MS
  (15 s) per open scope and on `pieces/changed`.

**package.json `loom` block** (role contract **`runtime`** — core allows exactly one, offers.ts:288):
- `name: runtime`, `role: runtime`, label/description.
- `settings` (19): LOOM_RUNTIME_LOOM_URL, PUBLIC_URL, ACCOUNTS, **TOKEN_FILE** (path to runtime-role token), BUSY_LIMIT,
  SEAT_HOUSES, WARM_IDLE_S, CONTINUITY, RETRY_S, BODY_ENV, GRADER_IMAGE, REVIEW_LIMIT, REVIEW_INTROSPECT, NOW_DIR,
  BRIDGE_DARK_S, RELAY_HEADS_UP, LOCAL_BODIES, ALERT_COMMAND, STUCK_AFTER, TASK_COMMENT.
- `services`: `run` (`loom-runtime run --local`, the local box runner), `delivery` (`loom-runtime deliver run`, the tick
  loop), both `keepChildren`.
- `delivery`: `["loom-runtime","deliver"]` — the **delivery offer** (core forwards every deliver to it; offers-registry.ts:52).
- `venues`: `relay` (kind agent), `spawn` (kind agent).
- `mcp_tools`: `relay` (`relay tool`), `comms_trace` (`trace tool`), `spawn` (`spawn tool`).
- `strangers`: `join-request`, `join-poll` (no-token API paths, http-server.ts:538-542).
- `grants`: `["loom-runtime","grants","ask"]` — the **grants-authority offer** (one per household, offers.ts:285).
- `store`: grants/gates/policy (owner), gate-proposals (piece).
- No `sections` (project/thread feeds), no `answered`.

### Flows

Change-signal legend: **tick** = core's 15 s manifest/page poll + fingerprint 304; **PC** = runtime's
`POST /api/loom/pieces/changed` with an empty body (core.mjs:77; fired by `tellAtWork`, cli.mjs:185-200, from the
`deliver run` loop each tick when the working-set print changes; core writes `pieces.tick`, live.ts:150, and every SSE
client gets a bare `change`) — carries **no revision, no ids, no scope**. **act** = core's own "changed" after an action.

| Flow | Kind | Where (file:line) | Identity | Bounded/paged | Change signal | Sensitive | Destination |
|---|---|---|---|---|---|---|---|
| Manifest tile (box/house counts) | read | ui.mjs:281-286 | none | n/a | tick | no | t-2028 |
| Agent cards: readings/state/reason | read | ui.mjs:621-685 | agent id | ≤4 readings | tick, PC | reason may name a wake note/task | t-2028 |
| Agent `doing` (task houses, sessions, bodies, bridge talk) | read | ui.mjs:248,666-672,693-698; nowboard.mjs:404-418 | none (array rows); body rows carry `conversation` cv-… | ≤8 | PC (start/end + 10 s activity bucket) | bridge rows include `who` (people names) for DMs; core strips conv labels per viewer | t-2028 |
| Agent `jobs` | read | ui.mjs:249-270; delivery.mjs:943-955; nowboard.mjs:388-402 | stable: `h-N`, `cv-…`, `remote:<name>`, `remote:h-N`, `bridge:<sha24>` | unbounded here (core caps 10k) | PC | no text beyond fixed words; `tasks` refs | t-2028 |
| Agent `idle {observedAt, expiresAt}` (HEAD) | read | ui.mjs:240-247 | agent | n/a | tick only (expires 30 s; PC print includes 10 s bucket) | no | t-2028 (core not yet consuming) |
| Body activity ticker (`doing[].activity`) | read | delivery.mjs:910-929; ticker.mjs:1-40 | conversation | 1 per body | PC | fixed action words only | t-2028 |
| Manifest asks: box join | read+actions | ui.mjs:291,308-319; enroll.mjs:117 | join id `j-xxxxxxxx` (in action fields only) | ≤5 | tick | **join code + requester IP** | t-2025 (code is a pairing check, see Sensitive) |
| Manifest asks: gate proposals | read+actions | ui.mjs:325-329; gates.mjs:331-345 | `<agent>.<id>` in fields | ≤10 | tick (store write → no PC) | person ids/platform ids | t-2025 |
| Manifest asks: bridge dark/looping | read | nowboard.mjs:367-381 | none (text fixed per outage) | ≤10 | tick | no | t-2025 |
| Manifest asks: loop pauses | read+actions | delivery.mjs:1529-1543 | cv-… | ≤10 | tick | reason text | t-2025 |
| Manifest asks: box watch alerts | read | watch.mjs:478-494 | none | ≤20 | tick | unit journal last line | t-2025 |
| Manifest asks: login expiry | read | login-expiry.mjs:26 | none | small | tick | no | t-2025 |
| Manifest notices (give-ups, relay heads-up, box joined, house failed, bridge back, watch FYI) | read | ui.mjs:295,456-469; delivery.mjs:283-310; relay.mjs:317-333; watch.mjs:496 | none (text+at) | ≤20 | tick | failed house's last log line; relay `why` | t-2025 |
| ui page `''` Boxes summary | read | ui.mjs:886-969 | box ids in `page: box/<id>` | boxes all; agents all | tick/304 | disk, health | t-2028 |
| ui page `box/<id>` | read | ui.mjs:976-1008 | box id (`xxxxxx-xxxxxx-xxxxxx-xxxxxx`, control.mjs:47) | houses ≤30 | tick | harness login method/plan; unit logs; upgrade install output | t-2028 (owner-only) |
| ui page `login/l-<12hex>` | read (auto-refresh 2-10 s) | ui.mjs:1128-1186 | login id | 1 | page `refresh` polling | **OAuth link, device userCode, CLI output** | EXCEPTION (login flow) |
| ui page `agents` | read | ui.mjs:1326-1333 | agent | all | tick | repo URLs | t-2031 (agent config) |
| ui page agent tab (`LOOM_SCOPE`, path `''`) Houses | read | ui.mjs:1238-1312 | `h-N`, service `<agent>/<name>` | live ≤30, recent ≤20 | tick | **house task text (≤1900 chars)**, secret names, tailnet sockets, ports | t-2028 (houses/services); house config → t-2031 |
| ui page agent-owner view | read | ui.mjs:1370-1385 | `h-N` | ≤30 / ≤20 | tick | no | t-2028 |
| Sessions section (box/house remote-control links) | read | ui.mjs:167-210,1188-1198 | agent | n/a | tick | **claude.ai/code?environment=env_… session URL** | EXCEPTION (session handle) |
| ui page `permissions` | read | ui.mjs:344-415 | store rev in hidden fields | all pieces/agents | tick | no | t-2031 (grants/rules metadata) |
| ui page `permissions/<agent>` | read | ui.mjs:418-436 | agent | all | tick | no | t-2031 |
| ui page `gates/<agent>` | read | gates.mjs:350 | proposal keys | all | tick | people + platform ids, tiers | t-2030 (people) / t-2025 for the pending asks |
| ui page `now` (bridges, quota, agents) | read | nowboard.mjs:423-505; accounts usage | agent | all | tick | quota % per account | t-2028 |
| ui page `now/<agent>` | read | nowboard.mjs:506 | agent/bridge | all | tick | who is talking (names), channels | t-2028 (bridge status) / t-2027 for talk rows |
| ui page `trace/cv-…` | read | ui.mjs:1398,1425-1451; trace.mjs:117 | cv, run ids | 5 runs | tick | refusal reasons; "no words" by design | t-2027 |
| Model logins section (accounts + usage meters) | read | ui.mjs:1103-1121; accounts.mjs | account name (hash of CLI identity) | ≤ boxes | tick | account labels; no creds | t-2028 |
| ui act: add-box | action | ui.mjs:1500-1504; control.mjs:189 | box id minted | — | act | **box credential returned in message (`keep: true`)** | EXCEPTION (credential) |
| ui act: allow-join / block-join / block-all-joins | action | ui.mjs:1505-1507; enroll.mjs:122-158 | j-… | — | act | allow mints credential held in state.joins | t-2025 (the decision); credential EXCEPTION |
| ui act: revoke-box, box-watch, may-host, box-owner, box-lend | action | ui.mjs:1508-1512 | box id | — | act | no | t-2028 |
| ui act: login-start / login-code / login-cancel | action | ui.mjs:1513-1519; control.mjs:1343-1390 | l-… | — | act + page refresh | **login code (secret field)** | EXCEPTION |
| ui act: box-update-now | action | ui.mjs:1518 | box | — | act | no | t-2031 (packages/health) |
| ui act: model-choice | action | ui.mjs:1520-1523; delivery.mjs:2184 | agent (+cv) | — | act | no | t-2028 (models) |
| ui act: set-primary, set-agent, agent-flag | action | ui.mjs:1524-1525,1546-1559; control.mjs:274 | agent | — | act | secret **names** & repo-secret name | t-2031 |
| ui act: up / down | action | ui.mjs:1526-1530; control.mjs:349 | h-N | — | act | task text | t-2028 |
| ui act: remote-up / remote-down | action | ui.mjs:1531-1535; control.mjs:1094 | agent | — | act | dir path | t-2028 |
| ui act: service-up/down/restart/move | action | ui.mjs:1536-1545; control.mjs:910+ | `<agent>/<name>` | — | act | no | t-2028 |
| ui act: grants-set, relay-set, relay-pair (optimistic `rev`) | action | ui.mjs:1561-1605; grants.mjs:173,225 | store rev | — | act | no | t-2031 |
| ui act: grant-approved (core posts after owner's Allow; spends approval) | action | ui.mjs:64-95,1564 | approval a-… | — | act | no | t-2025 (approval) → t-2031 (grant) |
| ui act: reset-approved (principal reset after Allow) | action | ui.mjs:121-144,1560 | a-…, cv | — | act | no | t-2025 / t-2027 |
| ui act: gates-allow / gates-deny / gates-merge | action | ui.mjs:1606; gates.mjs:466,525 | proposal key, slug | — | act | people data → core people/ensure | t-2025 / t-2030 |
| ui act: loop-resume / loop-dismiss | action | ui.mjs:1609-1614; delivery.mjs:1546 | cv | — | act | no | t-2025 / t-2027 |
| api `list` / `''` (owner, agent owner, agent) | read | control.mjs:1573,413-438 | `h-N`, box id, service key | **houses ≤50 newest**; boxes/services all | none (poll) | box facts; agent sees only own | t-2028 |
| api `join-request`, `join-poll` (stranger) | action | control.mjs:1496-1497; enroll.mjs:73-115 | j-… + proof | MAX_PENDING | poll | **returns box credential once** | EXCEPTION (enrollment) |
| api box-only: hello, poll, claim, report, native-collection, collection-status, build-check, build-report, save-state, state-part, remote-report, login-report | action/read | control.mjs:1488,1502-1505,448-640,792,1121,1400 | box id (caller.subject), h-N | poll returns full work list | box polls every few s | **claim returns house loom token + secret values + repo auth**; state-part = service state blobs; login-report carries OAuth link/userCode | EXCEPTION (box↔control-plane protocol) |
| api `body-sync` (body host in house) | action | control.mjs:1507-1510; houserunner.mjs | house/seat | — | poll | conversation dispatch, sealed material | EXCEPTION (runtime-internal) |
| api `conversation-origins` (core → runtime) | read | control.mjs:1511-1513; delivery.mjs:3515-3533 | cv → root cv | ≤128 per call | none | no | t-2027 |
| api `model-choice` (core Comms thread model) | read/action | control.mjs:1514-1516; delivery.mjs:2184 | agent, cv | — | none | no | t-2028 (models) / t-2027 thread pref |
| api `conversation-control` interrupt/resume (core Comms) | action | control.mjs:1517-1520; delivery.mjs:2198 | cv, control id | — | PC via tick | no | t-2027 |
| api `send`, `send-status`, `principal`, `spawn` (a body, proving LOOM_BODY_KEY) | action | control.mjs:1522-1543; delivery.mjs:2932,3341,3024; spawn.mjs:26 | cv, ref, run | text ≤40k | none (poll send-status) | **body key/session proof**; outbound text; signed principal statement | EXCEPTION (body credentials) for proofs; message content → t-2027 via core turns |
| api `trace` (agent's own) | read | control.mjs:1544-1551; trace.mjs:117 | thread/run/cv | small | none | no words | t-2027 |
| api `now/snapshot`, `now/event` (bridge posts) | action | control.mjs:1552-1555; nowboard.mjs:108-133 | agent+bridge | 64 KB / 16 KB | written files; seen at next tick | who's talking (no message text) | t-2028 (bridge status) |
| api `run` (remote CLI for bodies) | read/action | control.mjs:1557-1560; gates-api.mjs:12-64 | — | relays ≤50 lines | none | proofs in body | see run verbs below |
| run `now talking` | read | nowboard.mjs:134 | agent bridges | small | none | names | t-2028 |
| run `relay …` / `relays [--thread]` | action/read | gates-api.mjs:18-33; relay.mjs:186,306 | r-… relay id, thread | 50 lines, 30 days | none (delivers into relay venue) | relay text (≤8000) | t-2027 |
| run `grants list` | read | gates-api.mjs:34-37 | agent | small | none | no | t-2031 |
| run `gates people` | read | gates-api.mjs:38 | agent | one doc | none | people/platform ids | t-2030 |
| run `place --conversation cv-…` | read | gates-api.mjs:43-48,71 | cv | members list | none | members (people) | t-2027 |
| run `gates propose` / `propose-person` | action | gates-api.mjs:49-56; gates.mjs:238 | `<agent>.<id>` | — | none (asks on next tick) | person entry | t-2025 |
| api `up` / `down` (owner, agent, body task) | action | control.mjs:1561-1572; taskhost.mjs | h-N | — | PC (house set in print) | task text | t-2028 |
| api `session-bootstrap`, `session-command` (terminal controller), `task-bootstrap`, `task-status`, `task-cancel`, `script-bootstrap` | action/read (polled) | control.mjs:1565-1568; sessionhost.mjs:33-47; taskhost.mjs; terminal.mjs:1-30 | h-N, cv, message id (16-64 hex) | — | **CLI polls `session-command status` ~1 s** | interactive terminal steering text; status snapshot | EXCEPTION (terminal stream) |
| api `usage` (house reports quota) | action | control.mjs:1574,1449-1465 | box/harness | — | none | no | t-2028 |
| api `service-up/down/move` | action | control.mjs:1575-1577 | service key | — | PC | no | t-2028 |
| api BOX_OWNER_ONLY: login-start/code/cancel, box-update-now | action | control.mjs:1479,1578-1581 | l-…, box | — | none | **login code** | EXCEPTION (login) / t-2031 (update) |
| api OWNER_ONLY: add-box, revoke-box, may-host, set-primary, set-agent, seed-state, saved-state, remote-up/down, box-lend, box-owner, box-watch | action | control.mjs:1471-1475,1582-1585 | box/agent/service | — | none | add-box returns credential; seed/saved-state = service state blobs | t-2028 / t-2031; credential & blobs EXCEPTION |
| delivery offer `deliver` (core → runtime, stdin) | action | cli.mjs:794-802; delivery.mjs:624-645,661 | (source,id) → deliveryKey; returns `{conversation, seq, body}` | text ≤40k | writes turn to core; PC when body starts | message text (sealed at rest) | t-2027 |
| grants offer `grants ask` (core → runtime per agent→piece call) | read | grants.mjs:92-97; package.json `grants` | {agent, piece, path} | 1 doc | store rev (not signalled) | no | t-2031 (rules metadata; decision stays server-side) |
| mcp_tool `relay` | action | relay.mjs:290; package.json | r-… | ≤8000 chars; same words/hour refused | none | message text | t-2027 |
| mcp_tool `comms_trace` | read | trace.mjs:163 | th:/run-/cv- | small | none | no words | t-2027 |
| mcp_tool `spawn` (start/say/result) | action/read | spawn.mjs:26-80 | handle = cv | brief ≤40k | none | brief text | t-2027 (+ jobs in t-2028) |
| venues `relay`, `spawn` | offer | package.json venues; relay.mjs:249; spawn.mjs:55 | place = from-agent / spawn id | — | core venues registry | — | t-2027 |
| strangers `join-request`, `join-poll` | offer | package.json strangers | j-… | — | poll | enrollment | EXCEPTION |
| Runtime → core `conversations/turn`, `audit` | stream (push) | core.mjs:50-55; delivery.mjs (giveUp 296-312, post) | key `<source>:<id>`; returns cv+seq | per turn | core's own SSE | raw turn text (audit) | t-2027 |
| Runtime → core `comms/activity` tool cards | stream (push) | delivery.mjs:1395-1412; activity.mjs:283 | {conversation, run, cards[] with ids}; delta via `cardsSent` | ≤50 cards, ≤120 chars | core's own SSE | redacted labels only | t-2027 |
| Runtime → core `comms/adapter` (post/describe/status for venue loom) | action (push) | core.mjs:73; delivery.mjs:608-614 | place, run | 15 s | — | reply text | t-2027 |
| Runtime → core `pieces/changed` | stream signal | core.mjs:77; cli.mjs:185-200,822 | **none** (empty body) | — | — | no | replace with versioned t-2028 change stream |
| Presence to venue adapters (`<send> --status working|done`) | stream (push) | delivery.mjs header 37-41 | place, message id | every 15 s | — | no | t-2027 (adapter side) |
| Review job (core review/config, token, audit/take, scores, findings) | action | core.mjs:56-104; review.mjs:104-466 | ref | REVIEW_LIMIT ≤2000 | — | **review token in memory only**; audit text | EXCEPTION for token; scores → t-2030/t-2031 |
| CLI-only reads on loom's machine: `models`, `accounts [usage]`, `logins`, `health`, `deliver list`, `stale-runs`, `body list`, `review status`, `secrets-map`, `policy`, `gates status/export`, `slot/service state` | read | cli.mjs (dispatch 272-744) | various | mostly unbounded | none | secrets-map = secret **names**; slot/service state = blobs | t-2028 (models/accounts/health/bodies), t-2031 (policy/secrets-map metadata); blobs EXCEPTION |
| Bundle part export/import | action | bundle.mjs:21-110 | — | whole state | — | age-encrypted; contains everything | EXCEPTION (backup payload; metadata → t-2031) |

### Cross-piece reads

What the runtime reads/calls **from others**:
- **core**: `GET /api/loom/venues` (venue registry), `conversations/turn`, `audit`, `people/ensure|merge`, `deliver`,
  `comms/adapter`, `comms/activity`, `pieces/changed`, `review/*` (core.mjs:1-23) with its runtime-role token
  (`LOOM_RUNTIME_TOKEN_FILE`). Reads `$LOOM_HOME/household.json` directly (default agent, members/owners, relay seed,
  tz) (owners.mjs:18, grants.mjs:150,241, nowboard.mjs:65, cli.mjs:242). Mints/revokes tokens via `loom token create|
  revoke` (effects.mjs:24-31). `loom store runtime …` for its own collections only.
- **other pieces' files**: `pieces/<owner>/piece.json` + `settings.json` for grants seeding (grants.mjs:125-126);
  `pieces/discord|slack/piece.json` existence (nowboard.mjs:189); version/upgrade reads its own and the old `box`
  piece's records (version.mjs:227,273).
- **secrets piece**: `loom-secrets issue <name> --agent a --house h` per house claim (effects.mjs:33-40) — values
  returned on a pipe straight into `claim`'s response to the box.
- **approvals piece**: `approvals use … --as …` to spend grant/principal-reset/relay approvals (ui.mjs:102-112,
  approvals-call.mjs; relay.mjs:100), and files reset asks (delivery.mjs:3097).
- **discord / slack pieces**: `loom discord|slack status --json` on every manifest (nowboard.mjs:185-196), and venue
  `send` argv for posts/presence (from core's venues answer).
- **clock**: calls in, not read — `deliver` with `local: true` from `clock` only (delivery.mjs:233-250, 675-680) and
  `principal --wake` (cli.mjs usage; handOverWake delivery.mjs:216). The runtime never reads clock's store.
- **taskstore**: `taskstore comment` on a stuck body (LOOM_RUNTIME_TASK_COMMENT, stuck.mjs).
- **shuttle (bridges)**: posts `now/snapshot|event`; legacy send fallback (LEGACY_SEND, delivery.mjs:2840).

What **others read from the runtime**:
- **core Home / agent cards / bar** read manifest `agents{readings,state,reason,doing,jobs}` and apply `atWorkFor`
  (handler.ts:166-180, 990, 1159, 1192) to add conversation labels/links only for viewers who may see them.
- **core Inbox** reads manifest `asks`/`notices` (no ids; push keyed by ask text).
- **core Comms** calls `model-choice`, `conversation-control`, `conversation-origins` as the member's owner caller
  (comms-routes.ts:80-100,188), and finds the runtime by `role: runtime`.
- **core delivery** (`/api/loom/deliver`) forwards every source's message (clock wakes, discord/slack, Comms, relay,
  spawn) to the `delivery` offer; **core grants** runs `grants ask` before each agent→piece call (offers-registry.ts:42).
- **core MCP** exposes `relay`, `comms_trace`, `spawn` to sessions; venues `relay`/`spawn` in core's registry.
- **secrets piece**: `secrets-map --json` output feeds `loom secrets policy houses-import` (cli.mjs:681).
- **boxes** (other machines running this same program) are the main API client: `poll`/`claim`/`report`… .
- **bodies in houses**: `run`, `send`, `principal`, `place`, `trace`, `relay(s)`, `usage`, `up`, `spawn`.

### Sensitive fields (must never enter a shared browser cache)

- **Box credentials**: `add-box` action message (ui.mjs:1503, `keep: true`), `state.joins[*].credential` until
  `join-poll` collects it (enroll.mjs:109-114, 134-135), `box.json` on each box.
- **Enrollment**: join `code` (a short pairing code the owner compares with the box's terminal) and `proofHash`, plus
  requester IP `address` — the code is shown in the ask on purpose (owner-only), but should not be cached broadly.
- **House loom tokens + secret values + repoAuth** in `claim`'s response (control.mjs:574-626); `tokenLabel`.
- **Model login flows**: `logins[l-…].link` (claude.com/auth.openai.com OAuth URL), `userCode`, pasted `code`
  (XDG_RUNTIME_DIR file), CLI `detail` output; and the box login homes `logins/<harness>/.credentials.json|auth.json`.
- **Remote-control session URLs** (`claude.ai/code?environment=env_…`) from house logs and `remotes[agent].url`
  (ui.mjs:167-175,190,199).
- **Body proofs**: `LOOM_BODY_KEY`, harness session ids, signed principal statements, `principal.key`,
  `runtime.key` (age identity for slots), review token (memory only).
- **Sealed content**: slots `*.age`, queue texts, service saved-state blobs (`state-part`, `saved-state`, bundle).
- **Terminal steering**: `session-command` send/status (interactive house conversation).
- **Semi-sensitive (owner-scoped, OK in owner-only collection, not agent-owner/shared)**: house `task` text (full wake
  prompts, ≤1900 chars shown), house `log` tail, unit journal tails, secret *names* / repo-secret name / tailnet socket
  paths, upgrade install output, relay `why`/text, bridge `who` names in DMs, gate people records.

### Notes / gaps

- **Change signal is content-free.** `pieces/changed` has no body, no piece name, no revision, no scope; core turns it
  into a bare SSE `change` and every open app refetches every manifest. HEAD fires it up to every ~10 s while any body
  works (activity bucket in the print). Nothing else (store writes, box polls, joins, login progress, now-board posts)
  signals at all — those wait for the 15 s tick, and the login page self-polls via `refresh`. A t-2028 provider needs a
  per-collection ordered change stream from the `deliver run` loop (it already computes the working set every tick).
- **Manifest is a computed view, not a store.** Every field is rebuilt from files per call (with two 2 s subprocesses
  and side-effecting alert checks). Moving to collections means materialising: `agents`(cards), `jobs`, `boxes`,
  `houses`, `services`, `remotes`, `accounts/usage`, `bridges`, `asks`, `notices` as keyed docs with revisions.
- **Identities**: stable — box id (24-hex dashed), house `h-N` (never reused), service `<agent>/<name>`, login `l-…`,
  join `j-…`, conversation `cv-…` (core-minted), relay `r-…`, proposal `<agent>.<id>`, job ids (`h-N`, `cv-…`,
  `remote:<name>`, `remote:h-N`, `bridge:<sha24>` — the bridge hash is stable per agent/bridge/place). **Unstable**:
  `doing` rows, asks, notices, readings (no ids; asks keyed by text in core push). Need ids for t-2025.
- **Unbounded lists**: `state.houses` (never pruned; `list` truncates to newest 50 without a cursor), `jobs` per agent,
  `listConvs` reads every conversation file on every manifest/tick, store `list` capped at 1000 with no paging
  (store.mjs:49). No API path is paged.
- **Core lag vs HEAD**: `agents[a].idle`, `doing[].activity`/`jobs` activity fields are emitted at HEAD but not in core's
  vocab (6ab2a79); verify before relying on them in t-2028.
- **Store reads are anyone's on loom's machine** and the piece shells out per read (`loom store`, 20 s timeout); the
  Permissions page reads proposals in one list for the 3 s page budget (ui.mjs:408-409).
- **Agent-tab scope**: `LOOM_SCOPE` filters the Houses tab; agent owners (`caller.agents`) get a reduced view and a
  whitelist of actions (ui.mjs:1478-1489); `box/` and `login/` pages 403 for them. A shared collection must keep these
  per-viewer cuts (household owner vs agent owner vs agent), plus box-owner-only for logins/Update now.
- **Destinations summary**: t-2028 gets boxes, houses, services, remotes/sessions (minus URLs), agent cards/jobs/doing/
  idle/ticker, accounts+usage, models/model-choice, bridges/now board, health/watch. t-2025 gets all asks (joins, gate
  proposals, loop pauses, bridge/box alerts, login expiry) and notices, and approval-applying actions. t-2027 gets
  delivery/turns/activity cards/trace/relay/spawn/conversation control & origins. t-2030 gets gates (people).
  t-2031 gets grants/relay pairs/policy, agent house config (secret names only), settings, upgrade/version, bundle
  metadata. EXCEPTION: credentials, enrollment, login flows, house claim payloads, session URLs, terminal control,
  sealed slots/state blobs, body proofs, review token.

---

**Clock and approvals: shared facts.** Applies to both pieces:
- Neither piece uses loom's piece store (`store` collections, docs/specs/piece-storage.md). Both keep their own JSON
  files under `<piece home>/data`, as the spec's own table says (core docs/specs/piece-storage.md:14-21). The spec's
  "Moving there" step 3 (piece-storage.md:101-103) lists "approvals, ... clock lanes and schedules" as later migrations.
  No revisions, no compare-and-swap, no writer history. Each piece's own `fcntl` lock is the only concurrency control.
- Neither piece emits a change signal. `POST /api/loom/pieces/changed` is allowed only for the runtime role
  (core src/transport/role-routes.ts:41, http-server.ts:775). Core sees a change in two ways. (1) It re-polls each
  piece's `ui --json` every `WATCH_MS` = 15 s while an app is open and compares fingerprints (core src/ui/live.ts:12,30,142).
  (2) Any page action routed through loom calls `changed(scope)` (core src/ui/handler.ts:1851). A change is only a bare
  "change" event, with no ids and no revisions. Calls to `/api/<piece>/run` from bodies, and systemd timer fires, do not
  signal; the 15 s poll picks them up.
- Neither piece pages its lists. All lists are capped slices, listed below.

---

## clock (sleepunit-agents/loom-clock)

**Version note.** The inventory is of HEAD `8a67bfd` ("Route legacy local wakes through the shared runtime #25"). The
catalog pins `545e2ad`. Between them are two commits:
- `bb7d48a` (#23) adds `agents.<id>.jobs` to the manifest, one row per scheduled or parked wake (bin/wake:3118-3131).
  This is new data exposed to core: wake ids, status, brief text, task refs, ISO `at`, and the provenance `conversation`
  (`for_in`).
- `8a67bfd` (#25) removes the `WAKE_LOCAL_RUN` setting and the `claude --bg` session launcher. Every local wake now goes
  through `POST /api/loom/deliver`. `dispatch()` only does `loom box up` for house/slot wakes (bin/wake:1986).
  `WAKE_SESSION_COMMAND` is kept only so the legacy reaper can watch old sessions. package.json drops
  `WAKE_LOCAL_RUN` and rewords the description.

On the pinned build, the Home cards would have no clock `jobs` rows.

### Store

Plain files under `CLOCKS` = `WAKE_DATA`, default `${LOOM_PIECE_HOME}/data` (bin/wake:178). Each agent has its own
directory `CLOCKS/<agent>/` (bin/wake:179-184, `configure()` :201). None of this is in loom's piece store.

| File | Content | Writers | History |
|---|---|---|---|
| `<agent>/spool.jsonl` | Pending entries, one JSON per line. Kinds: `wake`, `parked`, `schedule` (one occurrence), `deadman`, `watch`. Fields: `id`, `at`, `note`, `prompt` / `prompt_file` / `lane`, `model`, `created`, `origin`, `for`, `for_in`, `for_why`, `for_people`, `place`, `slot`, `held`, `fails`, `on`, `until`, `approval{kind,target}`, `local_approval`, `deliver_place`, `deliver_label`, `delivery` (the full cached deliver body, including text), `vouched{}`, `house`, `wake` (a nested wake, on watch entries) | `Spool` context manager, under an exclusive flock on `spool.lock` (bin/wake:514-542), rewritten whole each time. Called from set/park (:757), cancel (:1715), schedule (:1460), fire (:2184), retry (:2351), resume (:1845), now (:1863), vouch (:1119/:1168), rearm/keep_armed (:1735/:3754), deadman (:642) | None. The only trace is `wake.log` lines |
| `<agent>/schedules.json` | `{name: {at, days, note, model, created, origin, for, for_in, prompt / prompt_file / lane, slot, loom_lane, lane_file}}` | `save_schedules` (:690), written by `cmd_schedule set/rm` and `cmd_lane` | None |
| `<agent>/wake.log` | Append-only text: `ts \| event \| detail`. Events include set, fire, fire-fail, fire-refused, unpark, vouch*, principal-none, alert, stuck, ... Detail can hold notes, error text and alert text | `log()` (:508) | Grows without bound; no rotation found |
| `<agent>/paused` | `{since, by}` | pause/resume (:1835/:1845), bundle import | None |
| `<agent>/filed.json` (mode 0600) | `{a-id: {target, prompt, note, at}}`: the exact words of a local wake the owner was asked about. Kept 8 days (`FILED_KEEP`) | `remember_filed` (:932) | None |
| `<agent>/vouch.json` | `{card:{aid, ids, unread}, asked:[w-ids], denied:[w-ids]}` | `save_vouch_state` (:1232), from `_vouch_pass` (:1322) and `cmd_ask_vouch` (:1398) | None |
| `<agent>/sessions.json` | Legacy: sessions started by `claude --bg`, keyed by job id `{wake, note, kind, ...}` | `Sessions` (:2466). Since #25 nothing new is recorded; the reaper only reads it | None |
| `<agent>/alerted-<key>` | Timestamp, used to rate-limit alerts | `alert_daily` (:2026) | None |
| `lanes.json` (household) | `{name: {agent, at, days, text (the lane prompt, up to many KB), note, model, slot, local, source (an absolute host path), updated}}` | `save_lanes` (:1588), from `cmd_lane` (:1606), which only runs on loom's machine | None |
| `fire` (household) | One word: local, house or mixed | By hand, or bundle import | None |
| systemd transient units `wake-<id>.timer/.service` | The schedule of record for when each entry fires | `arm_timer` (:614), `disarm_timer` (:636) | None |
| `${PIECE_HOME}/settings.json` | Owner settings, read as a fallback to the environment (:135) | Core's settings UI | None |

Bundle: `bundle export|import` (bin/wake:1761) packs every agent's `spool.jsonl`, `schedules.json`, `paused`,
`filed.json` and `vouch.json` (`CLOCK_FILES`, :1754), plus `lanes.json` and `fire`. It is age-encrypted to
`LOOM_EXPORT_RECIPIENTS`. Logs stay behind. Import pauses every clock it restores.

### Manifest & offers

package.json `loom` block:
- `name: clock`, `role: clock`, `label: Clock`.
- `venues: {"wake": {}}`. This is a permission, not an offer. Core sets `delivers_wake` from it (core src/offers.ts:239,266),
  and `POST /api/loom/deliver` accepts venue `wake` only from such a piece, with `from.kind = schedule`
  (core src/delivery.ts:176-178).
- `services: [{name: run, argv: [loom-clock, run]}]`: the long-running supervisor (`cmd_run`, :3772).
- 16 `settings`, including `WAKE_DELIVER_TOKEN_FILE`, a path to a piece token, which is a secret.
- No `mcp_tools`, `grants`, `strangers`, `store`, `sections` or `delivery` offers.

Role contract `clock`: core finds it with `pieceWithRole(env,'clock')` (core src/needs-resolve.ts:82) and calls it for
exactly one thing, posting `ui act` `vouch-approved` (core src/ui/handler.ts:407). Contract row: core docs/extensions.md:906.

`ui --json` manifest (`ui_manifest`, bin/wake:3077-3100; built from `ui_view` :3042):
- `{v:2, tab:{label:Clock, kind:setting}, agentTab:{label:Clock}, scope:true, owners:2, tile, asks:[], agents, notices:[]}`.
- `tile`: the next wake across every visible clock, or "Paused" / "Nothing". Its `page` is `agent:<id>`.
- `agents.<id>` (`agent_reports`, :3103):
  - `state: unavailable` when the clock is paused.
  - `readings`: one "Next" reading.
  - `jobs[]` (new in #23): `{id: w-id, wake: w-id, status: scheduled|waiting, text (≤300), page: agent:<id>, tasks: [t-N from note], at (ISO), conversation? (for_in)}`.
    There is one row per spool entry that is not a `watch`, including the deadman.
- The clock files no asks of its own. Its vouch card is filed through approvals (below).
- `LOOM_SCOPE` narrows the view to one agent (:3044). The caller's `agents` list narrows it for agent-owners (`owned_by`, :3527).

### Flows

| Flow | Kind | Where (file:line) | Identity | Bounded/paged | Change signal | Sensitive | Destination |
|---|---|---|---|---|---|---|---|
| Manifest tile ("Clock: next wake") | read (offer) | bin/wake:3077-3092 | none (derived) | 1 item | 15 s manifest poll | low (brief text ≤120) | t-2028 |
| Agent report: state + "Next" reading | read | bin/wake:3103-3116 | agent id | one per agent | poll | low | t-2028 |
| Agent `jobs[]` (scheduled/parked wakes) **[HEAD only]** | read | bin/wake:3117-3131; core validates vocab.ts:1059 | `w-xxxxxx` (**unstable**: see Notes) | every non-watch spool entry, uncapped (≤50 one-off + schedules + deadman); core caps at 10000 | poll | `conversation` is a visibility restriction (cv-id); text comes from the note | t-2028 |
| Agent clock page (`ui page`, scope=agent): hero, Schedules, Coming up, Recent, its lanes | read | ui_page :3249-3286; schedule_blocks :3177; oneoff_blocks :3224 (rows[:100]); recent_blocks :3234 | per-row page paths `wake/<agent>/<w-id>`, `schedule/<agent>/<name>` | ≤3 clocks, ≤10 sections, ≤100 wakes, 8 recent fires | poll + `changed()` after an act | notes | t-2028 |
| Household Clock page (no scope): loom lanes + each agent's clock row | read | household_clock_page :3289; lane_blocks :3318 | lane name, agent id | unbounded lanes | poll | lane notes | t-2028 (lane schedule metadata) |
| Lane page `lane/<name>` | read | lane_page :3355-3417 | lane name (stable) | text shown ≤19000 chars | poll | **lane text** (full prompt, up to 19 KB on the page), `source` host path | metadata t-2028; text **EXCEPTION** (on demand, not cached) |
| Schedule page `schedule/<agent>/<name>` | read | schedule_page :3433-3478 | (agent, schedule name) (stable) | prompt or lane shown ≤1900 chars | poll | **inline prompt** in a sheet | metadata t-2028; prompt **EXCEPTION** |
| Wake page `wake/<agent>/<w-id>` | read | wake_page :3482-3524 | w-id (unstable) | prompt ≤1900 chars | poll | **prompt**, note as written, slot | metadata t-2028; prompt **EXCEPTION** |
| Recent fires (from wake.log) | read | recent_fires :2992; ui_view reads the last 3000 log lines :3049-3054 | (time, w-id, event) | last 8 | none (log append) | notes, error detail | t-2028 (ticker/activity) |
| `ui act` lane-new / lane-edit / lane-text / lane-rm / lane-run / lane-assign | action | ui_act :3566-3621 → `lane set/rm/assign`, `schedule run` | lane name | n/a | `changed()` (core handler.ts:1851) | lane text in fields | t-2028 (mutation via piece act) |
| `ui act` now / clock(on/off) / pause / resume / run / cancel / schedule-rm (with undo) / schedule-set | action | ui_act :3643-3684 | agent, w-id, schedule name | n/a | `changed()` | low | t-2028 |
| `ui act` **vouch-approved** (core → clock after the owner's Allow) | action (cross-piece) | ui_act :3622-3642 → `vouch --approval` :1119/:1168; core caller handler.ts:404-460 | `a-xxxxxxxx` + `<agent>:<w-ids>` | ≤12 ids | `changed()` | none | t-2025 (the trigger) / t-2028 (effect) |
| Piece API `POST /api/clock/run` `{argv}` | action + read | api_answer :2727-2769; cmd_api :2772; REMOTE_VERBS :243 = at, in, park, list, cancel, log, schedule, relay, relays, lane, ask-vouch | caller = owner or agent in `WAKE_AGENTS`; argv ≤32 items | `log` prints ≤2000 lines; `list` prints the whole spool | none (picked up by the poll) | the argv carries prompts; the `--principal` statement is stripped at the door (:2780-2785) | t-2028 (commands stay server-side; not a collection) |
| run `at`/`in` (set a wake) | action | cmd_set :757-902 | new w-id; for a local wake, an approval `a-` + target `agent:sha256[:16]` | ≤50 one-off per agent (`MAX_PENDING` :195) | none | prompt | t-2028 |
| run `park --on q-…/a-…` | action | cmd_park :905; cmd_set park branch :880-886; re-check in cmd_fire :2214-2224 | w-id, re-minted every 5 min while waiting | counts toward 50 | none (polls approvals/secrets every 5 min, ≤24 h) | prompt | t-2028 job (status waiting); link to t-2025 approval |
| run `list` | read | cmd_list :1043 | w-ids | whole spool | n/a | notes, 50-char prompt head | t-2028 |
| run `log [--since --grep]` | read | cmd_log :1440 | log lines | ≤2000 lines | n/a | raw log (notes, errors, alerts) | **EXCEPTION** (or t-2028 summarized; the raw log stays server-side) |
| run `schedule set/rm/list/run` | action/read | cmd_schedule :1460-1578 | schedule name; occurrence w-id | unbounded schedules | none | prompt | t-2028 |
| run `lane list/text` (remote: text only for the assigned agent; set/assign/rm owner-only, refused with an origin :1628) | read/action | cmd_lane :1606-1705 | lane name | unbounded | none | lane text | metadata t-2028; text EXCEPTION |
| run `cancel` | action | cmd_cancel :1715 | w-id | n/a | none | – | t-2028 |
| run `ask-vouch` | action | cmd_ask_vouch :1398 (a body only records `asked`; the service files the card) | w-ids | ≤12 per card | none | – | t-2025 (via approvals) |
| `relay`/`relays` | stub | :1896/:1939 exit with RELAY_MOVED | – | – | – | – | t-2027 (runtime owns relays) |
| Local-only verbs (not remote): `fire`, `rearm`, `run`, `reap`, `vouch`, `now`, `pause`, `resume`, `bundle`, `ui` | action | main :3804-3920 | – | – | – | `bundle` = encrypted household part | bundle **EXCEPTION** (encrypted backup); rest t-2028 |
| Fire → `POST /api/loom/deliver` (venue wake, from schedule, place `lane:<n>` / `local-lane:<n>` / `wake:<first id>` / `--place`) | stream out (to runtime) | deliver_wake :2135-2181; post_delivery :2103; wake_place :2081 | delivery `id` = w-id (kept across retries via `entry.delivery`); place stable per lane | text ≤40000 (`DELIVER_TEXT_MAX`) | the runtime records the turn in a conversation (core, t-2027) | **full prompt + preamble**; bearer token from `WAKE_DELIVER_TOKEN_FILE` | t-2027 (the turn), t-2028 (fire status) |
| Fire → `loom runtime principal --wake --agent --place --id --for` | action (to runtime) | hand_over_principal :449 | delivery id | – | – | for/origin conversation | t-2028 (runtime-internal) |
| Fire (spawn/slot path) → `loom box up --task -` then watch `loom box list --json` | action/read (to box) | dispatch :1986; arm_watch :2373; house_record :2382; watch_house :2393 | house `h-N`; watch w-id | – | none | prompt in the task JSON | t-2028 (houses) |
| Alerts → `WAKE_ALERT_COMMAND` | stream out | alert :2013; alert_daily :2026 | – | rate-limited daily | – | message text | t-2025 (an alert ask, ideally) / t-2031 (setting) |
| Legacy reap → `claude agents --json`, `claude stop`, `taskstore comment` | action | reap_stuck :2650; task_comment :2578 | session job id, t-N | – | – | redacted command excerpt (redact :2445) | t-2028 (legacy; going away) |
| Settings (16) | read | package.json `loom.settings`; setting() :146 | – | – | core settings UI | `WAKE_DELIVER_TOKEN_FILE` path (a secret pointer), alert command | t-2031; token **EXCEPTION** |
| Service `run` loop: keep_armed + vouch_pass every 600 s, reap every 120 s | background | cmd_run :3772; keep_armed :3754; vouch_pass :1312 | – | – | none | – | t-2028 |

### Cross-piece reads

The clock reads or calls:
- **approvals.** Everything goes through `loom approvals` (`approvals_argv` :269), never over HTTP.
  - `check <a-id>` (plain) for park and vouch state: request_state :998.
  - `check --json --as <caller>` for the parked card's kind/target: approval_card :948.
  - `request` for local-wake asks with `--as/--on-behalf`: file_approval :1900.
  - `request --kind vouch-wake --as clock --on-behalf owner --details`: file_owner_approval :1284.
  - `use`: spend_approval :1919 and spend_owner_approval :1307.
  - `withdraw`: owner_approval_cmd :1297.
- **secrets.** `loom secrets state q-…` (request_state :999).
- **runtime / box.**
  - `loom runtime principal --verify|--conversation|--wake`: :317, :333, :449.
  - `POST /api/loom/deliver`: :2103.
  - `loom box up` / `loom box list --json`: :1986, :2382.
- **core household file.** `household.json` agents list (household_agents :1708), used to validate lane assignees.
- **tasks.** `taskstore comment` (legacy reaper, :2578).
- **Local repo.** Lane files under `WAKE_REPO/<WAKE_LANE_DIRS>` (lanes() :3135, lane_file :2718). The page's lane picker lists them.

Who reads or calls the clock:
- **core**:
  - `ui`, `ui page`, `ui act` (manifest poll; page renders).
  - `/api/clock/run` from houses.
  - The `vouch-approved` act after the owner allows a `vouch-wake`: core src/ui/handler.ts:404-460 (it reads the
    approval back from approvals first, :427).
  - Contract row: docs/extensions.md:906.
- **houses** (box `house/piece-call`): `wake …` is forwarded to `/api/clock/run`, with `--principal <statement>`
  appended (box house/piece-call:57-106; install-tools:82). In a house the script forwards itself too (`forward`,
  bin/wake:3715; main :3809).
- **tasks piece / runtime**: they run `loom-clock in 1m …` on loom's machine (owner comments, runtime alerts with
  `--place alert:…`). This is documented in foreign_piece's docstring (:110-116).
- **box UI** parses the clock's preamble text inside a task house's prompt to label houses: `wakeOf` regex
  `(wake id w-…, kind …, note: …)` (box src/ui.mjs:503-533). It also strips the clock's "Resumed after your OK" prefix
  (ui.mjs:486-499). This is an implicit, text-format contract on `PREAMBLE` (bin/wake:333-347).

### Sensitive fields (never in a shared browser cache)

- **Wake `prompt` / lane `text` / the spool's cached `delivery.text`.** These are arbitrary instructions. They can name
  hosts or paths, and a body can write anything into them. For a local wake, the words are exactly what the owner
  approved; that binding is held server-side in `filed.json`. Today the page already shows them only in a folded
  sheet, on demand.
- **`filed.json`** (0600). Approval-bound exact words. Never expose it.
- **`prompt_file` / lane `source`.** Absolute host paths.
- **`WAKE_DELIVER_TOKEN_FILE` content.** A bearer piece token. The path itself is in settings.
- **Principal statements.** The clock never stores or logs them (:183-193). Keep them out.
- **`for_in` (cv-id) and `for_people` (people slugs).** Provenance used to restrict visibility (the jobs comment at
  :3127 says "solely a visibility restriction"). They must be filtered per member, never broadcast.
- **`wake.log`.** Raw notes, error strings and alert text. Redaction applies only to stuck-session excerpts.
- **`sessions.json`.** Session ids of legacy `claude --bg` runs.
- **Alert command / fire gate argv** (settings).
- **Bundle output.** It is encrypted. Plaintext is only ever on pipes.

### Notes/gaps

1. **Wake ids are not stable record identities.** `w-` + 6 hex (24 bits) is re-minted:
   - on every retry (:2362);
   - on pause→resume (:1855);
   - on the fire-gate defer (:2192);
   - every 5 minutes while parked (:2218);
   - per schedule occurrence (:730).

   A live `jobs` collection keyed by w-id would see a delete plus an insert every 5 minutes for each parked wake.
   Candidate stable keys:
   - `(agent, schedule name)` for schedules;
   - `(lane name)` for lanes;
   - `deliver_place` (`wake:<first id>`, preserved across retries) for one-offs once fired;
   - the parked entry's `on` (the a-/q- id) while parked.

   A one-off that has not fired has no stable key except its current id. The provider would need to mint a durable
   key (e.g. store `key` = the first id and keep it across re-mints).
2. **No change notifications.** Timer fires, API sets and parks all change state silently. Core sees them only through
   the 15 s fingerprint poll. A versioned provider needs a revision counter (e.g. a spool generation in the lock file)
   or permission to call `pieces/changed`, which is runtime-only today.
3. **No paging, and some lists are unbounded.** Schedules and lanes have no cap. The spool is ≤50 one-off wakes per
   agent plus occurrences. `wake.log` has no rotation. The page caps rows at 100.
4. **Pinned vs HEAD.** On the catalog-pinned 545e2ad there are no `jobs`, and `WAKE_LOCAL_RUN=session` can still
   launch `claude --bg` sessions locally. The t-2028 design should assume HEAD.
5. **Owner scoping lives inside the piece**: `owned_by(caller)` (:3527), `LOOM_SCOPE` (:3044), and lanes hidden from
   agent-owners (:3698). A shared collection must replicate these rules: lane documents only for household owners; a
   clock only for its agent's owners.
6. **The clock's vouch card is an approvals record.** On the attention side (t-2025) it appears as an approvals ask
   (kind vouch-wake). The clock's `vouch.json` (card/asked/denied) is internal bookkeeping and should not be exposed.
7. **The preamble text is a de facto API**, used by box's `wakeOf`. Moving runtime UI onto collections should replace
   it with structured fields (wake id, kind, note) on the delivery or job.

---

## approvals (sleepunit-agents/loom-approvals)

HEAD `27eec65` ("Repair missing provenance on a reused pending approval #15").

### Store

Plain files under `STATE` = `APPROVALS_DIR`, default `${LOOM_PIECE_HOME}/data` (bin/approvals:112). The directory is
0700 and the files 0600 (Store :295-375). The piece store is not used, and there is no `bundle` verb.

| File | Content | Writers | History |
|---|---|---|---|
| `approvals.json` | `{v:1, approvals:{a-id: {id, kind, target, what, why, ask?, if_yes?, if_no?, details?, conversation?, who:{agent, where}, for, people?, minutes, at, state, decided?, by?, expires?, used?, withdrawn?, granted?, superseded_by?}}, notices:[{at, agent, kind, target, what, for?}]}` | `Store.save` under the flock on `approvals.lock` (:311). Called from request :542, use :686, withdraw :735, answer :754, always :1082, grant :1111, tell :1148 | Trimmed to the newest `KEEP`=300 by `at`. Denied vouch-wake / principal-reset rows are kept beyond that (:311-316). Notices are trimmed to 50 (:1166) |
| `audit.jsonl` | Append-only: `{at, event, id, kind, target, who, ...extra}`. Events include request, use, refused-use, allow, deny, deny-superseded, withdraw, grant, grant-deny | `Store.log` :372 | Full history; never read by the piece; no rotation |
| `rules.json` | `{v:1, rules:[{kind:merge, scope, tier, by, at}], grants:[{person, kind, scope, tier, by, at}]}` | `replace_rules` (:353), from set_rule :1074, set_grant :905, always :1082. Seeded once from `APPROVALS_SEED_RULES` (:854) | None. A file it can't read is marked broken and refuses edits (:337-344) |

States: pending, allowed, used, denied, withdrawn, plus derived `expired` (an allowed one past `expires`, state_of :400).

### Manifest & offers

package.json `loom` block:
- `name: approvals`, `role: approvals`, `label: Approvals`.
- 7 `settings` (APPROVALS_DIR, _LOCAL_AGENT, _KINDS, _SEED_RULES, _PRINCIPAL, _LOCAL_PRINCIPAL, _PROJECTS).
- No `venues`, `services`, `mcp_tools`, `grants`, `strangers`, `store` or `delivery`.

Role contract `approvals`: core docs/extensions.md:907, "core reads `state` and applies owner-applied kinds (`grant`,
`vouch-wake`, `principal-reset`)". Core finds it with `pieceWithRole(env,'approvals')` (core src/needs-resolve.ts:82).

`ui --json` manifest (`ui_manifest`, bin/approvals:1293-1320):
- `tab: {label: Approvals, kind: setting, icon: stamp}`.
- `asks[]`: the first 10 pending. Each has:
  - `text` (headline), `meta`, `why`/`if_yes`/`if_no` (with `--ask`);
  - `lead: true` plus the piece's own if-lines for owner-applied kinds;
  - `details`, `for` (non-owner), `fine` (≤400);
  - `tone: warn`, `at`, `agent`, `page: ""`, `kind: permission`, `conversation?`;
  - `actions: [allow{id}, deny{id}]`.

  **There is no `id`, `expires` or `attention` field on the ask.** The approval id appears only in `actions[].fields.id`,
  and core derives identity from that (core handler.ts:944, :1011-1013; comms-asks.ts:75).
- `answered[]`: ≤20 of the decided states, `{text, outcome, at, kind: permission, agent, page}`. No id.
- `notices[]`: ≤20 tell-notices, `{text, meta, at, agent, page}`. No id.
- No `agents`, `tile` or `agentTab`.

### Flows

| Flow | Kind | Where (file:line) | Identity | Bounded/paged | Change signal | Sensitive | Destination |
|---|---|---|---|---|---|---|---|
| Pending asks (Inbox "Your call" / Needs you) | read (offer) | ui_manifest :1293-1316; headline :1247; fine_print :1268 | `a-xxxxxxxx` (stable, 32-bit random), only via actions[].fields.id | first 10 pending, **no overflow signal** | 15 s poll; `changed()` after an answer | body words (ask/why/details), who.where, for/people | t-2025 |
| Answered history | read | ui_manifest :1316-1319 | none exposed (text+at) | 20 | poll | headline, `by` member slug | t-2025 |
| Tell-notices (FYI after a merge under do/tell) | read | notices :1225; notice_of :1230; written by tell :1148-1170 | none (at+target) | store 50, manifest 20 | poll | low | t-2025 (FYI) / t-2029 (PR merged) |
| Approvals page: Waiting on you (sheets with Allow / Always / Deny) | read | ui_page :1430-1478 (pending[:20]) | a-id in button fields | 20 | poll | body words, details, fine print | t-2025 |
| Approvals page: Standing rules + grants for other people (household owner only) | read | rules_section :1498; grants_panel :1522; gated by is_owner :1548 | (kind, scope); (person, kind, scope) | ≤100 rules, ≤100 grants | poll | grant `person` slugs; `by` | t-2031 (rules/grants metadata) |
| Approvals page: Answered list | read | ui_page :1463-1469 (past[:60]) | none | 60 | poll | words | t-2025 |
| Approvals page: "The record" (ids, kind, exact target, who@where, for) | read | record_text :1417 | a-ids | ~1900 chars, then "… N older" | poll | exact targets, house ids, principals | t-2025 (owner-only detail) |
| Project cards for project-scope rules | read (cross) | projects :952 via `APPROVALS_PROJECTS` (`loom project list --json`) | project slug | – | – | – | t-2029 consumer |
| `ui act` allow / deny | action | ui_act :1602-1617 → answer :754 (deny supersedes siblings, deny_siblings :387); owner-applied kinds gated to the household owner :1604-1610 | a-id | – | core: applyOwnerApproval, resolveNeeds, recordAnswer, recordApprovalAnswer, then `changed()` (core handler.ts:1838-1851) | – | t-2025 |
| `ui act` always (allow + set rule/grant atomically) | action | ui_act :1587-1600 → always :1082 | a-id → scope | – | `changed()` | – | t-2025 + t-2031 |
| `ui act` rule / rule-add / grant / grant-add (tier `none` removes) | action | ui_act :1566-1586 → set_rule :1074 / set_grant :905 | (kind, scope[, person]) | 100 each | `changed()` | – | t-2031 |
| Piece API `state` `{ids}` (owner caller only) | read | api_answer :1639-1647; states :1624 | a-id → `{state, agent, kind, target? (owner-applied only)}` | ≤50 ids per call (`STATE_MAX` :1621); unknown ids omitted | none (pull) | no words, by design | t-2025 (the canonical attention-state feed) |
| Piece API `run` (agent caller only; argv ≤26 × ≤1100 chars) | action/read | api_answer :1648-1662 → run :1681 | – | – | none | argv carries the body's words | t-2025 |
| run `request` (with `--ask/--why/--if-yes/--if-no/--details/--minutes/--conversation`) | action | request :542-663; plain-word lint check_plain :843; local `--conversation` from LOOM_BODY_CONVERSATION (main :1843-1847) | new a-id, or **returns the existing card** for the same kind+target+agent+principal (:625-645) | – | none until the poll | body words; conversation | t-2025 |
| run `check ID` / `check ID --json` | read | run :1768-1771; get :666; spend_card :674 (only the asking agent sees kind/target) | a-id | – | – | kind/target only to the spender | t-2025 |
| run `use ID --kind --target` | action | use :686-732 (PIECE_KINDS/PIECE_SPENT refused from bodies :692) | a-id | – | none | – | t-2025 |
| run `rule merge TARGET… [--json]` (`--for` only on loom's machine) | read | rule_answer :1040; rules_for :1013; resolve :973 | per target: `{tier, for, scope?, note?, approval?{id, state}}` | ≤200 targets | – | – | t-2029 (Changes) reads t-2031 rules |
| run `tell --kind merge --target --what` | action | tell :1148 | notice (no id) | 50 | none | – | t-2025 |
| run `withdraw ID --as` (loom's machine, piece kinds only) | action | withdraw :735; gates :1726-1741, :1766 | a-id | – | none | – | t-2025 |
| run `grant --kind merge --target --for --by [--person] [--deny]` (loom's machine only) | action | grant :1111; gate :1786-1794 | answers a pending a-id, or creates a `granted` a-id | – | none | – | t-2025 (+ t-2029 trigger) |
| run `list` (loom's machine only) | read | :1795-1797 | a-ids | 30 | – | words, targets | t-2025 |
| Principal verification (`APPROVALS_PRINCIPAL --verify`, `--conversation`) | read (to runtime) | verify_statement :438; fetch_statement :473; principal_of :449 | – | – | – | **statement** (signed, opaque) | EXCEPTION (never stored) |
| House forwarding to `/api/approvals/run` with `--principal` | action | in_a_house :1804; forward :1810; main :1851-1857; box house/piece-call:57-106 | – | – | – | house token at /run/secrets/loom-token | EXCEPTION (token) |
| `audit.jsonl` | stream (local append) | Store.log :372 | event per a-id | unbounded | none | who/where, targets | t-2030 (activity) or EXCEPTION as raw audit; not exposed today |
| Settings | read | package.json; setting :103 | – | – | – | `APPROVALS_PRINCIPAL` / `PROJECTS` are commands | t-2031 |

### Cross-piece reads

Who reads approvals:
- **core Inbox / Needs you resolver.** `pieceCheckers().approvals(ids)` calls `/api/approvals/state` as `{kind:owner, agents:'*'}`
  (core src/needs-resolve.ts:92-101). It runs every `NEEDS_TICK_MS` and at start (core src/transport/http-server.ts:897-908),
  and right after each answer (handler.ts:1842). `approvalCleared` maps state to words (needs-resolve.ts:34-37).
- **core absorb.** A Needs you with `waits_on.approval` absorbs that agent's own approvals card, matched by
  actions[].fields.id (core src/ui/handler.ts:936-955; waitsOnApproval set at :840). `leadIds` reads the manifest's
  `lead` asks (handler.ts:1011-1015).
- **core owner-applied apply.** `applyOwnerApproval` (handler.ts:426-460):
  1. reads `state` (with target) for the id;
  2. checks it is the household owner, and checks the target grammar (`ownWakes` :389-395; reset regex :409);
  3. for a reset, checks that the conversation is on record for that agent;
  4. posts `grant-approved` (grants authority), `vouch-approved` (clock) or `reset-approved` (delivery piece).

  The OWNER_APPLIED table is at handler.ts:404-410. It is also called from agent-page acts (:1726-1728).
- **core Comms threads.**
  - `threadAsks` shows asks whose `conversation` belongs to the thread (core src/comms-asks.ts:173-215).
  - For non-household-owner readers it reads approvals `state` to learn each card's kind (:192-205).
  - `OWNER_KINDS` = grant, vouch-wake, principal-reset (:149).
  - `recordAnswer` / `recordApprovalAnswer` keep the answer on kept thread asks (:268-290; handler.ts:1846-1848).
  - The inbox source id of approvals is passed to Comms (handler.ts:1538-1542).
- **core digest validation.** `needs_owner.refs` with exactly one `a-` id becomes `waits_on.approval`
  (core src/backends/needs.ts:144-145, :183-184).
- **Changes piece.** It runs approvals as a subprocess (`approvals_bin` changes lib/loom_changes/app.py:220-239):
  - `rule merge <targets…> --for <agent> --json`, batched by 200 per agent, on every draw (app.py:241-262);
  - Yes / Not yet → `grant --kind merge --target … --for <agent> --by <member> [--deny]` (app.py:729-741);
  - Always → `approvals ui act --json` with action `rule` (project scope, tier do), passing the owner's caller through
    (app.py:735-739), then the grant.
- **clock.** check / check --json / request / use / withdraw (see the clock section), via `loom approvals`.
- **runtime (loom-box).** `loom approvals use <id> --kind grant|principal-reset --target … --as … [--on-behalf owner]` to
  spend owner-applied cards it applies (box src/ui.mjs:99-111; approvals-call.mjs:1-25). Relays spend `relay`
  approvals (box src/relay.mjs).
- **Bodies.** Over `/api/approvals/run` (houses) or locally. `gh-guard` and similar use the CLI.

What approvals reads:
- the runtime's principal command (verify / conversation);
- `loom project list --json` (projects :952) for project-scoped rules and the Always label;
- nothing from the clock.

### Sensitive fields (never in a shared browser cache)

- **Principal statements** (`--principal`, runtime-signed). Never persisted.
- **House token / LOOM_TOKEN_FILE** (forwarding). Secret.
- **`who.where`.** House id and service name (e.g. "h-12 (discord-bodies)"). Shows where steerable bodies run; owner-only.
- **`for` / `people`.** Whom a body acts for (person slugs of Slack/Discord users). Privacy: visible to household
  owners, or to the agent's owners per owners.md, never to others.
- **`what` / `why` / `ask` / `details`.** Body-supplied text from possibly steered bodies. It is untrusted content, but
  it is exactly what the owner must read. It can go to the owner-scoped attention collection; it must be rendered as
  text, and must not be shared with agent-scoped or member caches beyond what the Inbox already shows.
  vouch-wake `details` include redacted prompt excerpts (clock vouch_listing :1251-1276, ≤400 chars each).
- **`target` for local-wake** (`agent:<sha256 prefix>`). This is a binding key, not secret, but meaningless to show
  (the page already hides it, meta_of :1216).
- **`audit.jsonl`.** The full who/where/target trail, including refused-use attempts.
- **`rules.json` grants.** People slugs plus repo scopes. Household-owner-only on the page (is_owner :1548).

### Notes/gaps

1. **Asks carry no id.** The ask's identity has to be dug out of `actions[].fields.id`. `answered` and `notices` have
   no id at all. A t-2025 attention collection needs explicit keys: `approval:<a-id>`, plus a notice id, which would
   have to be minted.
2. **No `expires` on asks.** Allowed approvals carry `expires` in the store, but pending ones do not expire. There is
   no `attention` flag either.
3. **The manifest cap of 10 pending asks has no overflow signal.** An 11th pending approval is invisible on the
   Inbox; it appears only on the Approvals page, which shows 20. `absorbApprovals` can then fail to find a card for a
   Needs you that waits on it.
4. **Retention.** KEEP=300 trims by `at`. Core reads a missing id as "gone", which clears the ask
   (needs-resolve.ts:100). A busy store could age out a still-pending approval, which would then silently resolve its
   Needs you as "gone".
5. **No change notifications.** A body's request via `/api/approvals/run` reaches the Inbox only on the next 15 s
   poll. Allow/Deny through loom triggers `changed()` plus `resolveNeeds`. A provider needs a revision (e.g. a store
   generation number) or a changed-callback.
6. **Two parallel "state" readers.** The manifest (words) and the API `state` (no words) are read separately, so core
   holds two views of one record. A single versioned t-2025 provider could replace both: a projection of
   `approvals.json` rows, owner-scoped, with `kind`, `state`, `agent`, `target` (owner-applied only), `expires`,
   `conversation`, and words.
7. **Not in the household bundle.** bin/approvals has no `bundle` verb, so `approvals.json`, `rules.json` and
   `audit.jsonl` are not exported (unless core backs up piece homes some other way; not verified). Rules and grants
   are durable owner decisions, so this is a real gap for t-2031 "packages/backup".
8. **Rules are per-call.** Changes recomputes `rule merge` per draw, as a subprocess with a 2.5 s timeout (app.py:229).
   t-2029 could read rules/grants from a t-2031 collection and resolve client-side. `resolve()` (approvals :973) is
   pure apart from project cards, so it is portable. Authority must still stay server-side: `grant`/`use` re-check
   everything.
9. **Owner-only checks are tripled by design**: approvals is_owner, core applyOwnerApproval, and the applying piece
   (core handler.ts:414-416). A browser cache must not become a fourth, weaker source of truth for "may answer". The
   `lead` flag and kind should be in the collection only for display.

---

**Tasks, changes, secrets: shared facts.** Read-only inventory, 2026-11-09. Repos read at:

| piece | repo | inventoried at | catalog pin (`loom/assets/pieces.json`) |
|---|---|---|---|
| tasks | sleepunit-agents/taskstore | **e9365c6** (HEAD) | 5e11755 (`assets/pieces.json:31`; catalog says version 0.6.1, package.json at the pin already says 0.7.0) |
| changes | sleepunit-agents/loom-changes | 6bc4bfc (HEAD) | 6bc4bfc (same) |
| secrets | sleepunit-agents/loom-secrets | bc8d211 (HEAD) | bc8d211 (same) |

loom core read at 6ab2a79 (the loom checkout).

Facts that hold for all three pieces:
- **None of them uses loom's piece store** (`docs/specs/piece-storage.md`). There's no `store` collections block in any manifest or package.json. Each keeps its own files: SQLite for tasks, a JSON snapshot for changes, sops/JSON/JSONL for secrets. piece-storage.md:18 lists secrets' files as "to move". The spec (`:90`) also says secrets' *values* stay outside loom's store: "what isn't in its store, like secrets' values, which loom-secrets encrypts itself".
- **None of them calls `POST /api/loom/pieces/changed`.** That route is open only to the `runtime` role (`src/transport/role-routes.ts:41`). loom finds out about changes in only two ways (`src/ui/live.ts:8-15`):
  1. **The manifest poll.** While an app is open, loom re-runs `ui --json` every `WATCH_MS` = 15 s (`live.ts:29`) and compares fingerprints.
  2. **`changed()` after any action that passes through loom** (`ui act`).
  
  The SSE `change` event carries **no data** (`live.ts:3-5`). The client then re-fetches the page with its fingerprint. Page cache: `PAGE_FRESH_MS` 5 s, `PAGE_STALE_MS` 5 min, `PAGES_MAX` 500 (`src/ui/pieces.ts:108-115`).
- **None of them declares `owners: 2`.** So all three are household-only surfaces. The one exception is secrets' `agentTab`, which is called with `LOOM_SCOPE=<agent>`. Thread feeds are asked only of owners-aware pieces when the member owns some but not all agents (`src/comms-work.ts:243-247`).

---

## tasks (sleepunit-agents/taskstore)

### Store

- **SQLite (better-sqlite3, WAL)** at `$TASKSTORE_DB`. The piece's default is `${LOOM_PIECE_HOME}/data/store.db` (`package.json:36-41`); the bare CLI defaults to `./.taskstore/store.db` (`src/cli.ts:90`). Schema (`src/sqlite-store.ts:143-157`):
  - `tasks(ord INTEGER PK, id TEXT UNIQUE, record TEXT)`: the whole Task as a JSON blob.
  - `links(ord, record)`.
  - `meta(key,value)`, holding only `seq` (the id counter).
- **Every mutation rewrites the whole store.** `persist()` runs `DELETE FROM tasks; DELETE FROM links;` and then reinserts every row (`sqlite-store.ts:172-181`), inside `BEGIN IMMEDIATE` (`:223-236`; the t-1831 lost-write fix). There are no row-level updates and no row version.
- **Passive JSONL mirror** `store.export.jsonl`. After every successful mutation the whole file is rewritten (temp file plus rename) inside the same transaction (`sqlite-store.ts:197-206`). Each line is `{"record":"task",...}` or `{"record":"link",...}`. Measured on one real household store: about 2,100 tasks, 3,000 lines, 8 MB.
- **Append-only interactions log** `store.interactions.jsonl` (`sqlite-store.ts:184-188`). Each line is `{at, actor, op, task_id, diff:{field:{old,new}}}`, built by `buildInteractions` (`:49-124`):
  - The diff covers status, title, description, priority, type, assignee, startedAt, closedAt, closeReason, goal, why, doneWhen, ask, ifYes, ifNo, answers, askedBy, source, plus a `comment` entry holding the new comment, and a `link` entry.
  - It has **no sequence number** and **no line id**. Order is commit order, because the line is written under the write lock.
  - No-ops write nothing: an idempotent create, a duplicate link, an unlink that removed nothing.
  - This is the nearest thing to a change stream, but **nothing reads it today**: no verb exposes it.
- **Bundle:** `taskstore bundle export|import` (`src/cli.ts:314-355`). It does `VACUUM INTO` and then `age -e` to `LOOM_EXPORT_RECIPIENTS`. Import refuses an existing store unless `--force`.

### Record identity and revision fields (`src/core.ts:10-57`)

- **Task id:** `t-<seq>`, from `freshId` (`core.ts:250-257`). It is stable and never reused (an import moves `seq` past the imported ids, `core.ts:761-765`). Imported ids may be any string, and the UI path grammar can reject odd ones.
- **Task fields:** `id, title, type, status, priority, createdAt, createdBy, comments[], description?, assignee?, startedAt?, closedAt?, closeReason?, legacyRef?, specItemRef?, criterionId?, goal?, why?, doneWhen?, ask?, ifYes?, ifNo?, answers?, askedBy?, source?`.
- **No `updatedAt`, no `version`, no `revision`.**
  - `update` (title, priority, assignee, description, plain fields) changes no timestamp.
  - The UI fakes "last touched" with `touchedAt()` = max(createdAt, startedAt, closedAt, last comment.at) (`src/loom-ui.ts:312-321`). That misses updates.
  - So **records have no field usable as a revision**. A provider would have to derive one: a content hash of the record JSON; a store-wide counter added to `meta`; or the line count / byte offset of `interactions.jsonl` as a global ordered cursor.
- **Comment:** `{actor, at, text}`. It has **no id**. Its identity is (task id, array index). Comments are append-only through core ops (there's no edit or delete verb), so the index is stable unless the whole task is deleted.
- **Link:** `{id, dependsOn, type}`, identified by that triple. It has no id or timestamp.
- **Delete** (`delete` op) is a hard delete. It leaves no tombstone, apart from an `op:"delete"` interactions line with an empty diff.

### Manifest and offers

**package.json `loom` block (`package.json:31-63`):**
- `role: "tasks"`.
- Settings:
  - `TASKSTORE_DB`.
  - `TASKSTORE_OWNER` (required; whose call a task is).
  - `TASKSTORE_AGENTS` (fallback API allow-list).
  - `TASKSTORE_ON_OWNER_COMMENT` (an argv to wake an agent).
- `sections.project` → `loom-tasks project-feed --json`.
- `sections.thread` → `loom-tasks thread-feed --json`.
- It has no venues, mcp_tools, grants, delivery, strangers, store or services.
- Bins are `taskstore` and `loom-tasks`, the same `dist/cli.js`.

**Role contracts:**
- `spec/taskstore-core/spec.jsonl` plus `fixtures.jsonl`, with items `it-ts-model`, `-query`, `-links`, `-portability`, `-plain`, `-create`, `-lifecycle`, `-source`, `-ready`, `-annotate`, `-durable` and about 30 `ac-ts-*` criteria. `ac-ts-loom-boundary` says the store holds work tracking only, never memory or knowledge.
- `spec/loom-work-boundary`.
- felag `c-tasks` WorkLayer (`src/work-layer.ts`).

**`ui --json` manifest (`src/loom-ui.ts:163-197`, built in `cli.ts:416`):**
- **`tab`:** `{label:"Tasks"}`.
- **`tile`:** "Work". Value is `N in progress`; detail is `N ready, urgent or high`; tone is warn.
- **`asks`:** the owner's open tasks (`ownersCall`, `:101`), **at most 10** (`MAX_ASKS`, `:64`). Each ask has:
  - `text` = ask or title; `meta` = why, goal or priority.
  - `page: task/<id>`; `label: "Open"`; `at` = startedAt or createdAt.
  - `kind: "todo"`; `attention:false` unless priority ≤ 1.
  - **No `actions`.** Yes/No live on the task page, not on the card.
- **`agents`** (NEW at HEAD, ea95123/#43 "Report open agent task backlog for complete cards"; `:169-173`): for each agent in `TASKSTORE_AGENTS`, `{readings:[], jobs:[...]}`.
  - The jobs are every open, non-epic task that the agent is assigned, or that it created and nobody is assigned, or that it asked the owner.
  - Each job is `{id, tasks:[id], status:"waiting"|"backlog", text, page, conversation?}`.
  - **The list is unbounded.** The core validator caps it at 1000 task refs per job (`loom src/ui/vocab.ts:1063`).
  - Not at the 5e11755 pin.
- **No `notices`, no `answered`.**

**`api --json` (`src/loom-api.ts`, `cli.ts:285-306`):**
- One path: `run`, with body `{argv}` (1-32 strings, each ≤ 64 KB).
- Refused verbs: `import`, `api`, `ui`. Everything else runs, including `export`, `delete` and `bundle`.
- **`bundle` isn't in REFUSED.** `bundle export` needs `LOOM_EXPORT_RECIPIENTS` in the env, and the spawned child inherits the env. Worth checking.
- Actor:
  - The owner gets `TASKSTORE_OWNER`.
  - An agent gets its own name when `caller.granted === true` (loom's grants authority), or when it's listed in `TASKSTORE_AGENTS`.
  - Everyone else gets 403 (`loom-api.ts:57-67`).
- Output larger than 256 KB comes back as gzipped base64 in `stdoutGz` (`:84`).
  - The comment there says "`list` on a real store is ~350KB". That is out of date.
  - Today's export is 8.2 MB raw and **2.77 MB gzip / 3.70 MB base64**. That's above the 512 KB-per-answer cap loom's comment cites. So `run export` (and probably `run list`) over the API **can't fit in one answer** on Art's store.

### Flows

| Flow | Kind | Where (file:line) | Identity | Bounded/paged | Change signal | Sensitive | Destination |
|---|---|---|---|---|---|---|---|
| Manifest: tab, tile counts | read | `src/loom-ui.ts:163-180`; `cli.ts:388-395,416` (`read()` = full `export` + `ready` each call) | none (counts) | n/a; but **every** manifest poll (15 s while any app is open) loads and parses the whole store | Manifest fingerprint diff, 15 s poll | no | t-2029 (tile counts derived client-side from the tasks collection) |
| Manifest: `asks` (owner's open tasks) | read | `loom-ui.ts:183-195`, `ownersCall :101` | task id → `page task/<id>` | top 10 | Manifest poll | no | **t-2025** attention (Inbox "To do", badges). Source rows can come from the t-2029 tasks collection. |
| Manifest: `agents.*.jobs` (open agent backlog) | read | `loom-ui.ts:169-173` (HEAD only) | job id = task id; `tasks:[id]`; `conversation` cv-… | **unbounded** (all open matching tasks) | Manifest poll | `conversation` id: core checks visibility before it shows the job (`extensions.md` "Complete agent jobs") | **t-2028** agent jobs (derived from the t-2029 tasks collection plus `TASKSTORE_AGENTS`) |
| Page `""` (work page: groups, find, sort, chips, opened/done chart, recently updated) | read | `loom-ui.ts:334-416` (query: `q` `:340`, `sort` `:342`, `show` `:375`, per-group page `?<groupId>=<n>`) | rows → `task/<id>` | groups paged 15 a page (`GROUP_SHOWN :229`), "Recently updated" 8 (`RECENT_SHOWN :309`), Done = last 7 days (`DONE_DAYS :226`), chart 8 weeks (`WEEKS :246`) | Page refetch on SSE `change` (manifest moved or action) | no | t-2029. Replace with a client query over the tasks + links collections: grouping, search and sort move into the browser. |
| Page `task/<id>` (summary, facts, waits-on, parent, mentioned, comments, answer/reply forms, changes citing it) | read | `loom-ui.ts:427-582`; changes side column via `cli.ts:399-415` (`loom-changes cited-by <id> --json`, 1.5 s timeout) | task id; comments as (task, index); `HISTORY_SHOWN` 100 latest comments (`:65`); waits-on ≤ 20 (`:456`); mentioned ≤ 50 (`:529`); changes ≤ 20 (`CHANGES_SHOWN :43`) | bounded as listed | Page refetch | descriptions/comments are free text (may cite secrets by name; no values by design) | t-2029 (task + comments + links collections; "Changes citing" = a join against the changes collection) |
| Page `new` (new task form) | read | `loom-ui.ts:584-599` | n/a | n/a | n/a | no | t-2029 (static form) |
| act `create` | action | check `loom-ui.ts:614-621`; write `cli.ts:428-435` (create, then `update assignee=owner` if "Mine") | new `t-N` returned → `page task/<id>` | n/a | loom `changed()` after the act; mirror rewritten | no | t-2029 mutation (optimistic insert, server-assigned id) |
| act `comment` | action | `loom-ui.ts:646-652`; `cli.ts:436-449`. Side effects: reassigns to `TASKSTORE_AGENTS[0]` if the task was the owner's; spawns `TASKSTORE_ON_OWNER_COMMENT` detached (`cli.ts:547-560`, e.g. `loom-clock in 1m`; loom-clock `bin/wake:111`) | (task, new index) | n/a | `changed()` | no | t-2029 mutation (the side-effect wake stays server-side) |
| act `answer` (Yes/No/words to an ask) | action | `loom-ui.ts:635-647`; `cli.ts:450-461` (comment `Yes, to: …` plus reassign to `askedBy`/agent plus wake) | task id | n/a | `changed()` | no | **t-2025** (answering an ask) writing through t-2029 |
| act `priority` | action | `loom-ui.ts:628-632`; `cli.ts:462-467` | task id | n/a | `changed()` (no timestamp changes on the record) | no | t-2029 |
| act `close` / `reopen` (Mark done plus Undo) | action | `loom-ui.ts:627,633`; `cli.ts:468-476` (`undo:{action:"reopen"}`) | task id | n/a | `changed()`; closedAt set or cleared | no | t-2029 |
| `api` `run <argv>` (remote CLI for houses/boxes/agents) | read + action | `src/loom-api.ts:69-87`; `cli.ts:285-306` | as CLI | stdout gz over 256 KB; **export/list exceed loom's 512 KB on the live store** | none (caller polls) | actor resolution only; no secrets | stays a piece API (agent/house writes). Reads for the browser move to t-2029. A house's `taskstore ready/show` stays API. |
| CLI verbs (local): `create claim unclaim close reopen delete update comment link unlink show list search ready report export import bundle` | read + action | `cli.ts:151-264` (build), `:562-711` (run); `list`/`search`/`ready` in `core.ts:567-608` | t-N; link triple | **`list`, `search`, `export` are unbounded** (no limit or offset; `list` filters only `--status`) | mirror plus interactions line per mutation | no | t-2029 (the browser provider's server side would read the store directly) |
| `sections.project` feed (`project-feed --json --project --since [--epic --name --venue --repo --conversation]`) | read / offer | `src/project-feed.ts:161-205` (`MAX_ITEMS` 50, ≤ 8 groups `:50`); `cli.ts:515-535`; core runner `loom src/project-feeds.ts:55-75`, args `:43-51` | item `ref` = task id | 50 items, 8 groups | hub refetch | no | t-2029 (projects) |
| `sections.thread` feed (`thread-feed --json --conversation cv --ref …`) | read / offer | `src/thread-feed.ts:45-68` (`MAX_ITEMS` 50, ≤ 200 refs); `cli.ts:487-509` (reads `{caller}` on stdin only to say "you"); core `loom src/comms-work.ts:237-265` | `ref` = task id, `made:true` when `source = conversation:<cv>` | 50 | thread work refetch | `source` conversation id ties a task to a member's private thread: the feed is per-thread and core-gated | t-2029 (tasks) joined with t-2027 (thread). The "made here" join key is `task.source`. |
| `bundle export/import` | action | `cli.ts:314-355` | whole store | n/a | n/a | age-encrypted | t-2031 (packages/backup). Stays a piece verb. |
| Interactions log `store.interactions.jsonl` | stream (passive, unexposed) | `sqlite-store.ts:184-188, 49-124` | `task_id` plus op plus diff; no seq | append-only, unbounded | **This is the latent ordered change stream**: commit-ordered, carries ids and field diffs, but has no cursor or seq and no reader | contains full comment text and description diffs | t-2029 provider's change stream (add a monotonic seq to each line, or a `seq` in `meta` per mutation) |
| JSONL mirror `store.export.jsonl` | stream-ish (whole-file rewrite) | `sqlite-store.ts:197-206` | full records | whole store each write | "something changed" only (mtime) | no | not a feed. The exit door stays. |

### Cross-piece reads

**tasks reads others:**
- **changes:** `loom-changes cited-by <t-N> --json` on the task page. The binary comes from `TASKSTORE_CHANGES` or `$LOOM_HOME/pieces/bin/loom-changes`, has a 1.5 s timeout, and runs with `LOOM_PIECE_*` and `TASKSTORE_*` stripped (`cli.ts:399-415`). The result is validated by `changeRefs` (`loom-ui.ts:49-54`).
- **clock (indirect):** `TASKSTORE_ON_OWNER_COMMENT` spawns the configured argv (typically `loom-clock in 1m …`, see loom-clock `bin/wake:111`).

**Others read tasks:**
- **changes:**
  - Every sync runs `CHANGES_TASKS export` (default `loom tasks export`, the whole store). Done in `loom-changes app.py:411-419`, called from `sync_once :160-163`.
  - From that export it builds `citing` (`:465-478`), `sources` (`:422-431`) and `trusted` (`:442-455`). These read task description, comment text, comment actor and `source`.
- **loom core:**
  - `needs-resolve.ts:103-115`: when an ask's `waits_on.task` is set, it runs `pieceApi(run show <id>)` as OWNER and reads `task.status`.
  - `comms-refs.ts:101-106, 171-183`: chips for `t-N` in a thread, `run show` as household owner, at most 20 a read (`SHOWS_MAX :42`). Returns title and status.
  - `comms-work.ts:237-265`: thread feed.
  - `project-feeds.ts:55-75`: hub feed.
  - `ui/activity.ts:139`: links `loom:p/tasks/task/<id>` from digests.
  - `ui/agent-jobs.ts:13-18`: dedupes task-only backlog jobs against other producers' `tasks` refs.
  - `ui/handler.ts:1098`: `tasks` is a STARTER piece.
  - `web/src/inbox.tsx:68`: Inbox finds the tasks source base `/p/tasks/`.
- **loom-box:** `src/stuck.mjs:86-95` runs `taskstore comment {task} {text}` for a stuck body (a write via the local CLI).
- **loom-approvals:** `bin/approvals:790` copies taskstore's plain-words lint (code, not data). Grant targets look like `tasks:<agent>[:run]` (`:234`).

### Sensitive fields

- Not secret: no values or tokens.
- Free text (description, comments, ask) may name secrets, people and private context. It is household-only today (no `owners:2`). A shared browser cache must keep it **household-scoped**: agent-owner members must not receive the tasks collection unless the visibility rule is defined.
- `source: conversation:cv-…` links a task to a member's Comms thread. Showing the thread title needs core's `from` / membership check. The bare id is OK to ship, but don't resolve it client-side without the check.
- `createdBy`, `askedBy` and `assignee` are agent or person slugs.

### Notes and gaps

- **No updatedAt or revision.** Adding `updatedAt` plus a store-wide `rev` (bumped in `persist`) would be the minimal change for a versioned provider. The interactions log could carry `rev` per line and serve as the ordered stream with resume.
- **Full-store reads everywhere.** `ui`, `page`, `act`, `project-feed` and `thread-feed` each parse the whole store per call (8 MB on Art's). `ui` runs every 15 s per open app. Moving to a browser collection with deltas removes most of that.
- **The live-update gap is real.** The SSE nudge fires only when the *manifest* changes or on an action through loom. An agent's CLI `comment`, `update title` or `link` on a task that's in neither the asks nor the agent jobs leaves the manifest unchanged, so open pages don't refresh until the next manifest-visible change or the page goes stale (5 s fresh / 5 min stale cache).
- The API size problem: `run export` gzipped is about 3.7 MB base64, above the 512 KB loom answer cap. The `loom-api.ts:23-24` comment is stale.
- `bundle` is reachable over `api run`, so it's worth confirming `LOOM_EXPORT_RECIPIENTS` isn't in the API child's env.
- Catalog pin 5e11755 lacks the `agents.jobs` report. Pin HEAD before t-2028 relies on it.

---

## changes (sleepunit-agents/loom-changes)

### Store

- **The source of truth is the forge (GitHub).** Read-only, through `gh api graphql` behind a read-only gate (`forges/github.py:34-69`; it refuses mutations, non-GET, `--input` and `@file` fields).
- **Snapshot cache:** `$CHANGES_DIR/snapshot.json`. The default is `${LOOM_PIECE_HOME}/data` (`package.json:24`, `app.py:64-65`). The directory is 0700 and the file 0600 (`write_private :122-126`). It is replaced whole on every sync (`sync_once :137-166`, under `flock sync.lock`). Shape `v:1`:
  - `{v, at, projects:[{slug,name,repos}], repos:{rid:{at,error?}}, changes:[Change], citing:{changeId:[{id,title,status}]}, sources:{taskId:cv}, trusted:{changeId:[taskId]}}`.
- **Change shape** (`forges/github.py:183-224`):
  - `id` = `github:<owner/repo lowercased>#<n>`, `repo`, `number`, `page` = `c/github/<owner/repo>/<n>`, `title` (≤ 300), `url`.
  - `state` open, merged or closed; `draft`; `author{login,name?}`; `created`, `updated`, `closed`.
  - `head{ref,id(sha)}`, `base{ref}`, `body` (≤ 4000).
  - `checks{state,failing≤10,running≤10,total}`, `review{state,by≤8}`, `mergeable`, `conflicts`, `people≤20` with roles.
- **Per repo, a sync keeps** the open PRs (first 50 by updatedAt) plus PRs closed or merged within 8 days (first 20) (`github.py:130-133, 232-244`). If a repo read fails, the old changes are kept with an `error` (`app.py:155-159`).
- **Refresh request file:** `refresh.request`, a timestamp (`app.py:169-172`). The service polls for it every 2 s (`:175-193`).
- **No piece-store collections, no SQLite, no history.** The only writes are the snapshot, plus approvals-piece calls on the owner's buttons.

### Record identity

- **Change:** `github:<owner>/<repo>#<n>`. Stable and lowercase-normalized (`forges/__init__.py:44-50`, `github.py:111-114`).
- **Page path:** `c/github/<owner>/<repo>/<n>`, used as the row id in `changes.rows`.
- **Approval target:** `<changeId>@<40-hex head sha>` (`target_of`, `app.py:216-217`). It changes on every push.
- **Revision-like fields:**
  - `updated` (GitHub `updatedAt`) per change.
  - `head.id` sha.
  - `snap.at` (sync time) for the whole snapshot.
  - There's no snapshot sequence number. A change that drops out of the window (older than 8 days closed, or past the first 50 open) just disappears, with no tombstone.

### Manifest and offers

**package.json `loom` block (`package.json:19-41`):**
- `name: "changes"` (no `role`).
- Settings:
  - `CHANGES_DIR`, `CHANGES_INTERVAL` (180 s; clamped to 60-3600).
  - `CHANGES_IDENTITIES` (owner → GitHub login whose `gh` token reads it).
  - `CHANGES_AGENTS` (agent → logins and branch prefixes), `CHANGES_OWNER_LOGINS`.
  - `CHANGES_PROJECTS` (default `loom project list --json`).
  - `CHANGES_TASKS` (default `loom tasks`), `CHANGES_TASK_OWNER`, `CHANGES_GH`.
  - Also read but not declared: `CHANGES_APPROVALS` (`app.py:220-226`).
- `services: [{name:"sync", argv:["loom-changes","sync"]}]`.
- `sections.project` → `loom-changes project-feed --json`; `sections.thread` → `loom-changes thread-feed --json`.

**Contract docs:** loom `docs/specs/changes.md`, and `docs/extensions.md` "Changes list and reader" (`:912-924`). The core validator is `src/ui/vocab.ts:1087-1101` (`changesData`): groups ≤ 12, rows ≤ 500, nested readers refused.

**`ui --json` manifest (`app.py:524-536`):**
- `tab {label:"Changes", icon:"git-pull-request", accent:"blue"}`.
- `tile`: value is "N waiting on you" or "N open"; detail is "N open across R repos"; tone is warn.
- **No `asks`, `notices`, `answered` or `agents`.**
- "Waiting on you" is not an Inbox ask. Inbox cards for merges come from the approvals piece when an agent files `approvals request --kind merge`.
- Each manifest call runs `rules_for(open)`, which spawns `approvals rule merge … --for <agent> --json` once per agent, in chunks of 200, with a 2.5 s timeout (`:243-273`). That happens on every 15 s poll.

**`api --json`:** always 404, "Changes has no API" (`app.py:904-908`).

### Flows

| Flow | Kind | Where (file:line) | Identity | Bounded/paged | Change signal | Sensitive | Destination |
|---|---|---|---|---|---|---|---|
| Sync service: projects, then per-repo GitHub read, then tasks export, then snapshot | read (ingest) | `app.py:137-166` (`sync`/`serve :175-193`); `projects() :92-115`; `forges/github.py:232-244` | change id | per repo: 50 open plus 20 recent done (8-day window); `people` 20; body 4000 chars | snapshot rewritten whole every `CHANGES_INTERVAL` (180 s) or on Refresh. **No notification to loom** (doesn't call pieces/changed). The UI finds out only via the manifest tile diff. | GitHub token in the child env only (`github.py:72-108`), redacted from output | t-2029 provider source (server side). The snapshot becomes the provider's backing; emit per-change upserts and deletes keyed by change id, versioned by `updated`/`head.id`. |
| GitHub token lookup `gh auth token --user <identity>` | read (credential) | `forges/github.py:72-83, 86-108` | login | n/a | n/a | **GitHub token**: never printed, logged, written or returned; `TOKENISH` redaction `:27,101` | **EXCEPTION**: tokens never leave the piece process. |
| Manifest tile | read | `app.py:524-536` | none | counts | 15 s manifest poll | no | t-2029 (tile derived from the changes collection plus rule verdicts) |
| Page `""`: split view: summary (stale note, repo errors, stats, project filter, Refresh), `changes.groups/rows` | read | `index_page :539-587`; `split_page :659-685` (`rows[:500] :680`; only `sections[:1]` kept `:684`); query `project` | row id = page path `c/github/<o>/<r>/<n>` | rows ≤ 500; projects ≤ 8 (`:565`); filters ≤ 12; legacy list rest ≤ 100, done ≤ 60 | page refetch | repo error text (≤ 300 chars, token-redacted); PR titles from private repos | **t-2029** (changes collection; grouping via `waits_on` needs rule verdicts from approvals = t-2025/t-2031 metadata) |
| Page `c/github/<o>/<r>/<n>`: same split, plus `reader` = `change_page` | read | `ui_page :688-700`, `change_page :590-656` | change id; buttons carry `{id, head}` | tasks ≤ 20, people ≤ 20, CI names ≤ 5, body ≤ 1990 | page refetch | PR body text; people logins and names; `from` block resolved by core (`comms-work.ts:292-303`) | t-2029 (reader composed client-side from the change row plus citing tasks; `from` stays core-resolved) |
| Rule verdicts per change (`approvals rule merge <target>… --for <agent> --json`) | read (cross-piece) | `rules_for :243-273`; used by manifest, index, change page (`include_closed` for Lately `:617`), project feed, thread feed | target `<id>@<sha>` → `{tier, approval?{state}}` | 200 targets per call | none; recomputed on every draw | no | **t-2031** (rules metadata) / **t-2025** (approval state). The browser should join instead of the piece shelling out on every poll. |
| act `refresh` | action | `ui_act :714-716` → `request_sync :169-172` | n/a | n/a | writes `refresh.request`; the service wakes within 2 s; loom `changed()` fires after the act but the snapshot lands later. **No signal when the sync finishes.** | no | t-2029 (command) |
| act `yes` / `not-yet` | action | `ui_act :709-750` (owner-only `is_owner :488-493`; head must match `:723-724`) → `approvals grant --kind merge --target <id>@<sha> --for <agent> [--by who] [--deny]` | returns approval id `a-…` | n/a | `changed()` | no | **t-2025** (approvals) |
| act `always` | action | `ui_act :731-739` → approvals `ui act` `{action:"rule", fields:{kind:merge, scope:project:<slug>, tier:do}}` with the caller passed through, then a grant | rule scope `project:<slug>` | n/a | `changed()` | no | **t-2031** (rules) plus t-2025 (grant) |
| `sections.project` feed | read / offer | `project_feed :753-786`; core runner `project-feeds.ts:55-75`; core gist `ui/projects-pages.ts:77-124` (counts open/failing/running from status words) | `ref` = change id | 50 items, 8 groups | hub refetch | no | t-2029 |
| `sections.thread` feed | read / offer | `thread_feed :809-843` (`made` via `conversation_of :458-462`; untracked refs get a GitHub href); args `:846-860` (≤ 200 refs) | `ref` = change id | 50 | thread work refetch | conversation linkage only through trusted task citations | t-2029 joined with t-2027 |
| `cited-by t-N --json` | read (offered to tasks) | `cited_by :384-395`; CLI `:918-923` | change id, page | unbounded in the piece (tasks caps at 20) | none | no | t-2029 (a join: tasks ↔ changes) |
| CLI `list` | read | `:935-940` | change id | all open | none | no | local only |
| CLI `sync [--once]`, `refresh` | action | `:924-934` | n/a | n/a | n/a | no | stays a service |
| `api` | n/a | `:904-908` always 404 | n/a | n/a | n/a | n/a | none |

### Cross-piece reads

**changes reads others:**
- **projects** (core): `loom project list --json` each sync, reading `links.repos` (`app.py:92-115`).
- **tasks:**
  - Each sync runs `CHANGES_TASKS export` (`app.py:411-419`): the whole store, about 8 MB on Art's.
  - It reads description, comments (`actor`, `text`) and `source`.
  - It builds `citing` (`:465-478`; any author), `trusted` (`:442-455`; only agent or `CHANGES_TASK_OWNER` comments plus description) and `sources` (`:422-431`).
  - Pages also link `loom:p/tasks/task/<id>` (`:649`).
- **approvals:**
  - Reads: `rule merge … --json` (`:243-273`).
  - Writes: `grant` and `ui act rule` (`:740-743`).
  - The bin comes from `CHANGES_APPROVALS`, else `$LOOM_HOME/pieces/bin/approvals`, else `approvals` on PATH. It runs with `LOOM_PIECE_*` and `CHANGES_*` stripped (`:220-240`).
- **GitHub:** via `gh` with per-owner identities (`CHANGES_IDENTITIES`).

**Others read changes:**
- **tasks:** `cited-by` (`taskstore cli.ts:399-415`).
- **loom core:**
  - Validates and draws the `changes` page block (`vocab.ts:1087-1101`, `web/src/changes.tsx`).
  - `resolveFrom` walks `changes.reader` for `from` blocks (`comms-work.ts:292-303`).
  - Project gist reads the `piece:changes` hub section (`ui/projects-pages.ts:77-124, 188-191`).
  - Thread work (`comms-work.ts:237-265`).
  - `needs-resolve.ts:10` explicitly refuses PRs as `waits_on`: "loom has no sanctioned way to read GitHub". The changes collection could become that sanctioned read.

### Sensitive fields

- **GitHub tokens:** `gh auth token` output lives only in the child env. Redacted in errors (`github.py:98-101`). Never in the snapshot. **EXCEPTION**: never to the browser.
- **`CHANGES_IDENTITIES`** maps GitHub owners to logins. Configuration metadata (t-2031), not secret, but it reveals account names.
- **PR bodies, titles, people from private repos (onterris).** Today any household member who sees the Changes tab sees them (household-only piece). A shared browser collection must keep household scope. If agent-owner members ever get access, scope by project or repo.
- Repo read errors are capped at 300 chars and token-redacted, but may echo GitHub error text.

### Notes and gaps

- **No change notification at all.** The sync writes the snapshot every 180 s, and loom learns about it only if the manifest tile string changes. Many changes don't move the tile (a CI state flip, a new commit on a PR that's already open), so an open Changes page can sit stale until the user acts or the page goes stale.
- **Rule verdicts are computed on every draw** by shelling out to approvals: once per manifest poll and once per page. In the new model, verdicts belong in the approvals/rules collection and the browser joins them.
- **The snapshot has no per-change revision beyond GitHub `updated` and `head.id`.** It has no tombstones: a change that ages out of the 8-day window just vanishes. A provider should diff successive snapshots and emit deletes.
- **Windows:** 50 open per repo, so a repo with more than 50 open PRs is silently truncated. Rows ≤ 500 across all repos.
- The catalog pin equals HEAD (6bc4bfc).

---

## secrets (sleepunit-agents/loom-secrets)

### Store

All files are under `$LOOM_SECRETS_DIR`, default `~/.config/loom-secrets` (`src/cli.mjs:83-94`):

- **`store.sops.json`:** a sops + age encrypted JSON map `{name: value}`.
  - Key **names are plaintext** in the file (sops leaves keys readable; `names()` `:114-118` reads them without decrypting, per ac-sec-list-blind).
  - Values are encrypted. Each write decrypts and re-encrypts the whole map (`put :157-169`, `remove :171-181`), under an O_EXCL lock `store.sops.json.lock` (`:143-151`).
  - A value is at most 64 KB (`MAX_VALUE :215`).
- **`age.key`:** the age identity (or `SOPS_AGE_KEY_FILE`). This is the actual security boundary (README "Threat model").
- **`policy.json`** (`src/requests.mjs:11-12, 41-47, 181-193`):
  - `{v:1, default:"ask"|"auto"|"never", secrets:{NAME:{grant, agents[], minutes, houses[]}}}`.
  - Plaintext, 0600, written whole.
- **`requests.json`** (`requests.mjs:60-79`):
  - `{v:1, requests:{q-xxxxxxxx: {id, secret, agent, house, service?, why, minutes, at, state, by?, who?, decided?, expires?, always?, carriedFrom?, claimedBy?}}}`.
  - Keeps pending requests, live grants, and the 200 newest (`KEEP :26`). Written whole, under `requests.lock`.
- **`audit.jsonl`** (`requests.mjs:93-95, 321-328`): append-only `{at, event, ...}`.
  - Events: `request`, `grant`, `always`, `deny`, `revoke`, `read`, `refused-read`, `issue`, `host-read`, `set`, `removed`, `stop-always`, `always-on`, `houses-allow`, `houses-stop`.
  - Names and times only, **never a value**. **Unbounded** (no rotation).
- **No piece-store collections.** `ac-sec-loom-boundary` says "the piece never reads or writes loom's stores".
- **Bundle:** `bundle export` produces the decrypted map as canonical JSON `{"format":"loom-secrets/1", secrets}` and `age -e -a` encrypts it to `LOOM_EXPORT_RECIPIENTS` (`:805-864`). Import re-keys to this machine (`:865-888`). Plaintext moves only via pipes (ac-sec-bundle-no-disk).

### Record identity

- **Secret name:** `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (`NAME :31`). Stable. Removing a name clears its audit "past" (`usage :345`) and its standing `auto` grants (`forgetStanding`, `requests.mjs:215-223`).
- **Request id:** `q-` plus 8 hex (`requests.mjs:124`). Random and stable. A pending or live request is reused for the same caller and secret (`:121-123`). Older decided ones fall off after 200.
- **Agent:** `^[a-z][a-z0-9-]{0,39}$`.
- **House:** `h-<digits>`.
- **Revisions:** none. Records carry `at`, `decided` and `expires`; the files have only mtime.

### Manifest and offers

- **package.json has no `loom` block.** It declares no role, settings, sections, services or store. loom finds it by name (`secrets`). It's a STARTER piece (`loom src/ui/handler.ts:1098`). Catalog: `assets/pieces.json:12-19`.
- **Role contract:** README "The contract" (`README.md:25-75`):
  - `ac-sec-no-argv`, `ac-sec-at-rest`, `ac-sec-list-blind`, `ac-sec-no-body-read`, `ac-sec-inject`.
  - `ac-sec-loom-boundary`.
  - `ac-sec-ui-write-only`, `ac-sec-ui-no-value-out`, `ac-sec-ui-stdin-only`.
  - `ac-sec-export-encrypted`, `ac-sec-import-rekeys`, `ac-sec-import-no-clobber`, `ac-sec-bundle-no-disk`.
  - Exit codes: 0 ok, 1 tool failed, 2 usage, 3 no such / exists, 4 refused.
- **`ui --json` manifest (`cli.mjs:235-255`):**
  - `tab {label:"Secrets", kind:"setting"}` (under Setup); `agentTab {label:"Secrets"}`.
  - `tile`: value is the count of names; detail is "Key on this host" or "No key"; tone ok or bad.
  - **`asks`:** pending requests, top 10 (`pendingAsks :301-308`). Each is `kind:"permission"` with `text` "<Agent> asks for <NAME>", `meta` (minutes plus the house's `why`), `agent`, `page secret?name=…`, and **`actions`**: grant, always (with confirm) and deny, each with `fields:{id:q-…}`.
  - **`answered`:** decided requests, top 20 (`answeredRequests :286-291`): `text` ≤ 300, `outcome`, `at`, `kind:"permission"`, `agent`, `page`.
  - No `notices`, no `agents`.

### Flows

| Flow | Kind | Where (file:line) | Identity | Bounded/paged | Change signal | Sensitive | Destination |
|---|---|---|---|---|---|---|---|
| Manifest tile (count, key present) | read | `cli.mjs:235-248` | none | n/a | 15 s manifest poll | name count; key presence | t-2031 |
| Manifest `asks` (pending secret requests, with Allow / Always / Deny actions) | read | `cli.mjs:250, 294-308` | `q-…` | 10 | manifest poll (requests.json changes → asks change) | secret **name**, agent, house's `why` text | **t-2025** attention (asks/approvals). Metadata only. |
| Manifest `answered` | read | `cli.mjs:252, 279-291` | `q-…` | 20 | manifest poll | name, agent, why, who decided | **t-2025** (Inbox Answered) |
| Page `""` household index: what needs a look (pending, missing, unused, old), groups by agent, live grants, history, policy | read | `uiPage :644-654` → `indexPage :555-608`, `storeView :495-520` (reads names, `policy.json`, `requests.json`, `audit.jsonl` usage) | names; `q-…` | `PER_PART` 200 rows a list (`:217`); requests 200 kept | page refetch | **names, who gets each, last used per agent/host, policy rules, file path of policy.json (`:459`)**; never values | t-2031 (secret *metadata*: names, policy, usage). Household-only. |
| Page `list?of=<group>&q=&who=` | read | `listPage :610-642`, `groupOf :537-549` (groups: agent:<a>, never, ask, host, unused, old, missing) | names | 200 | page refetch | names plus usage | t-2031 |
| Page `secret?name=<NAME>` | read | `secretPage :667-716` (where used, switches houses/auto per agent, set history, its rule JSON, grants, Replace/Remove sheets) | name | requests per name | page refetch | name, rule JSON, usage, grants; **never the value** (ac-sec-ui-no-value-out) | t-2031 (metadata); its Replace sheet's value field is EXCEPTION |
| Agent tab (`LOOM_SCOPE=<agent>`, path `""`) | read | `uiPage :646-653` → `agentPage :465-476` | agent | n/a | page refetch | that agent's names, requests, grants | t-2031 (scoped per agent) / t-2025 for its pending asks |
| act `grant` / `always` / `deny` / `revoke` (answer a request) | action | `uiAct :738-746` → `requests.mjs answer :245-286` (always also does `setAuto` into policy.json) | `q-…` | n/a | `changed()`; requests.json, policy.json and audit rewritten | no values | **t-2025** (approvals/asks) |
| act `stop-always` | action | `uiAct :748-755` → `stopAlways :225-232` | (name, agent) | n/a | `changed()` | no values | t-2031 (grants/rules metadata) |
| act `houses` / `auto` (panel switches) | action | `uiAct :757-771` → `setHouses :304-319` / `setAlways :234-242` | (name, agent) | n/a | `changed()` | no values | t-2031 |
| act `add` / `replace` (**value in `fields.value`**) | action | `uiAct :772-803` → `put :157-169` → sops on stdin | name | value ≤ 64 KB | `changed()`; store re-encrypted; audit `set` | **SECRET VALUE**: travels browser → loom HTTP → `ui act` stdin (`pieces.ts:12-13`: "a secret typed into a form stays out of ps"; field kind `secret`, `vocab.ts:23,284`) | **EXCEPTION**: a write-only command. Never into a collection, never in optimistic local state, never echoed. |
| act `remove` | action | `uiAct :772-803` → `remove :171-181` plus `forgetStanding` | name | n/a | `changed()` | name | t-2031 (command; the metadata row is deleted) |
| `api run request <NAME> --why … [--minutes N]` (a house asks) | action | `apiAnswer :1098-1118` → `requests.mjs request :111-145` (house token only: `houseOf :103-109`) | new `q-…` | why ≤ 300, minutes ≤ 480 | creates a pending ask; loom sees it on the next manifest poll | name, why | t-2025 (creates an attention item). The API itself stays piece API. |
| `api run get <NAME>` (a house reads with a live grant) | read | `apiAnswer :1119-1124` → `mayRead :155-170` → `decrypt` | name | n/a | audit `read` / `refused-read` | **SECRET VALUE** to a house over loom's API | **EXCEPTION**: house-only credential path, never browser |
| `api run status` (the house's own requests) | read | `apiAnswer :1125`, `mine :172-175` | `q-…` | ≤ 200 | none | names, states | EXCEPTION-adjacent: house API, not a browser flow (could be t-2031 metadata if a browser ever needed it) |
| CLI `issue <NAME> --agent A [--house H]` (the runtime starting a house) | read | `cli.mjs:988-1008` (only when `LOOM_PIECE_NAME` ∈ {runtime, box}); `may :295-302`; `auditIssue :326-328` | name, agent, house | n/a | audit `issue` | **SECRET VALUE** to the runtime process (podman secret) | **EXCEPTION** |
| CLI `may <agent> <name> [--json]` | read | `cli.mjs:977-986` | (agent, name) | n/a | none | policy verdict only | t-2031 (policy metadata) |
| CLI `get <NAME> --reveal` (TTY or `LOOM_SECRETS_ALLOW_GET=1`) | read | `cli.mjs:1058-1072`; audit `host-read` | name | n/a | audit | **SECRET VALUE** | **EXCEPTION** |
| CLI `podman <NAME> <podman-name>` | action | `cli.mjs:1074-1092` | name | n/a | audit `host-read` | **SECRET VALUE** into a podman secret | **EXCEPTION** |
| CLI `list [--json]` | read | `cli.mjs:1043-1048` | names | all | none | names | t-2031 |
| CLI `state <q-…>` (the clock parked on a request) | read | `cli.mjs:1035-1041` → `stateOf :148-152` | `q-…` | n/a | none (the clock polls) | state only | t-2025 (approval/ask state); also t-2028 (clock park) |
| CLI `add`, `rm`, `init`, `policy houses …`, `policy houses-import` | action | `cli.mjs:904-929, 1050-1056, 1010-1033` (policy refused to other pieces and houses `:1012`) | name | n/a | files rewritten; no loom signal | `add` takes the value on stdin | add: EXCEPTION. rm / policy: t-2031 commands. |
| `bundle export` / `import` | action | `cli.mjs:943-964, 805-888` | whole store | n/a | n/a | **all values**, age-encrypted | **EXCEPTION** (backup stream; t-2031 shows only its health) |
| audit.jsonl usage ("last given to X's house N ago") | read (derived) | `usage :335-356`, `RECORD_EVENTS :328` | (name, agent) | file read whole, unbounded | none | names, agents, houses, times | t-2031 (usage metadata) / t-2030 (activity) if surfaced |

### Cross-piece reads

**secrets reads others:** nothing. By contract it never touches loom's stores (ac-sec-loom-boundary). It does read `caller` from loom on `ui` and `api` stdin, and `LOOM_SCOPE` / `LOOM_PIECE_NAME` / `HOUSE_ID` from the env.

**Others read secrets:**
- **runtime (loom-box):** `src/effects.mjs:32-39` calls `loom-secrets issue <name> --agent A [--house H]` while starting a house (with `LOOM_SECRETS_ALLOW_GET` stripped). `src/cli.mjs:687` and `ui.mjs:1306,1354` map house secret names to store names (`secrets` in the house config, plus `repoSecret`).
- **Venue bridges (loom-discord, loom-slack):** `lib/loomvenue/common.py:105-133` runs `loom secrets may <agent> <name> --json`; if allowed, it runs `get --reveal` with `LOOM_SECRETS_ALLOW_GET=1` and caches the bot token in process memory.
- **Clock (loom-clock):** `bin/wake:999-1000` runs `loom secrets state q-…` for `wake park --on q-…`.
- **Houses:** `secret request` and `secret get` reach `POST /api/secrets/run` with the house token (`agent:<a>@<house>`). The house-side helper isn't in loom core (no hit in `src/`); it's in the house image.
- **loom core:**
  - Dispatches the `ui` and `api` verbs (`src/ui/pieces.ts`).
  - Treats a form field of kind `secret` specially (`vocab.ts:23,284,540`).
  - Lists `secrets` as a STARTER (`handler.ts:1098`).
  - Web chrome (Setup placement, icon, tint): `web/src/App.tsx:80`, `launch-list.ts:31`, `tint.ts:33`.
  - `cli/pieces-managed.ts:349` refuses a `secret` setting kind for pieces ("a piece keeps its own secrets").

### Sensitive fields

- **Values:** never to the browser cache, and never in any shared collection or change stream (EXCEPTION). That covers the `add`/`replace` form field, `get`, `issue`, `podman` and bundle.
- **`age.key`** (and the sops store bytes): never.
- **Secret metadata** (names, who gets each, policy rules, usage times, house ids, request `why` text) isn't a value, but it is **authority metadata**. It reveals which credentials exist (e.g. `onterris-github-token`) and which agents hold them.
  - Today it's household-only (the Setup tab), and an agent tab is scoped by `LOOM_SCOPE`.
  - In a shared collection (t-2031) it must stay **household-owner-scoped**, filtered per agent for agent tabs. It must never reach agent-owner members for agents they don't own, nor stranger or bridge-driven houses.
  - The `why` text is free text written by a house, so treat it as untrusted (requests.mjs `plain()` strips control characters and markup, `:36-39`).
- The policy file path is shown on the page (`cli.mjs:459`). That's minor host-path disclosure.

### Notes and gaps

- **No loom block in package.json**, so there are no settings, offers or role in the manifest machinery. Moving to versioned providers would mean adding one. Also consider declaring `store` collections for `policy` (writers: owner) and `requests` (writers: piece). piece-storage.md's plan already lists secrets.
- **Change signals:**
  - **Request creation via `api run request` is noticed only by the 15 s manifest poll.** `asks` change, so it is noticed, but nothing pushes. A pending secret ask is a t-2025 attention item and would want a push.
  - **Grant expiry has no event at all.** State is computed at read time (`live()`, `requests.mjs:99`).
- **requests.json is pruned to 200, and audit.jsonl is never pruned.** Neither carries a sequence number.
- `issue` is gated by `LOOM_PIECE_NAME`, which is a guardrail, not a boundary (README "Threat model"). That isn't a browser concern, but it confirms EXCEPTION is the right call for every value path.

---

**Bridges: shared facts.** Sources read (HEADs): shuttle `f68370e`, loom-discord `5d197ba`, loom-slack `549550c`, loom core `6ab2a79`,
loom-box (runtime) in `loom-box`. Paths below are relative to each repo root.
`lib/loomvenue/common.py` is a copied file in both venue pieces (the slack copy adds `compare(..., gone=)` /
`--check-gone`; otherwise identical).

**Headline findings**

1. **None of the three pieces emits any change signal.** No `POST /api/loom/pieces/changed` (that route is the
   runtime role's only, `src/transport/role-routes.ts:41`), no socket/SSE to core. Shuttle's UI is pure poll-the-manifest;
   discord/slack have **no `ui` verb at all** (no manifest, tab, tile, page or act). Their only push into core is
   `POST /api/loom/deliver` (one message at a time, carrying an idempotency id but no revision/stream cursor).
2. **Discord/slack hold no loom store collections** — only a local data dir (`state.json`, `shadow-routes.jsonl`,
   `presence/ stops/ posted/`). Everything a browser would want from them is either already a core record
   (conversations/turns via deliver → t-2027) or ops status (`status --json`, 4 numbers → t-2031).
3. **Shuttle is mostly legacy.** Its gates (`people`) moved to the runtime (`loom runtime gates`, tombstones in
   `moved`); its tile/asks/doing moved to the runtime's now board (loom-box `src/nowboard.mjs`, t-1731); its body host
   and relay were ported into loom-box (`bodyhost.mjs`, `delivery.mjs`, `gates-api.mjs relay`); Slack went live on
   loom-slack 2026-11-08 and `LEGACY_SEND` is now `{}` (loom-box `src/delivery.mjs:2840`). What shuttle still
   uniquely owns and that live adapters depend on: **the route map** (`routes` household part + `channels` per agent),
   read by loom-discord through `loom shuttle routes --agent A --json`. The Bridges page (now-board snapshots, 24h
   conversations, `conv/<cid>` pages, house rules) reads the *old bridges'* files and is superseded by core
   Conversations for anything the adapters deliver.
4. **People/ensure:** the venue adapters do **not** call `POST /api/loom/people/ensure` (grep finds no such call).
   Only shuttle ensures person cards, via the CLI `loom person ensure --json` (`shuttle/cards.py:80-86`), inside an
   owner's page action (owner grant) or as an owner-piped backfill.
5. **Sensitive material flows through these pieces**: Discord bot tokens, Slack bot+app tokens (env-file secret), the
   piece's own deliver token file, platform user ids (Slack `U…`, Discord snowflakes) inside gates/route docs, and
   **message text** (delivered text; Slack live `state.json.waiting[*].ev.text` holds undelivered text on disk;
   `read` returns channel message text including strangers'). None of the venue pieces' data is suitable for a shared
   browser cache except their 4-field status.

---

## shuttle

### Store

Loom piece store `shuttle` (core `stores/shuttle.db`, `docs/specs/piece-storage.md`: every write is a revision naming
its writer, `--if-rev` CAS). Declared in `package.json` `loom.store`:

| Collection | Writers | History | Key | Doc shape | Who writes in practice | Code |
|---|---|---|---|---|---|---|
| `people` | owner | yes | `<agent>` | `{people:{slug:entry}, agents:{slug:entry}, _notes}` (tiers, platform ids, grants, restricts, venues, projects, field) | owner page actions (`people-accept`, `people-allow`, `people-merge`); **frozen once moved to runtime** | `shuttle/gates.py:29-30`, `put` 210-219 |
| `offers` | piece | yes | `<agent>` | `{doc: people.json, at, from}` | a bridge's `offer-people` via API | `gates.py:650-659` |
| `proposals` | piece | yes | `<agent>.p-<6hex>` | `{agent,id,slug,entry,before,rev,at,why,from,relay?{via,say}}` ≤10 per agent | a body's `propose-person` (pre-runtime-move only) | `gates.py:544-588` |
| `routes` | owner | yes | `household` | `{guild, webhook_peers, peer_turns_each, guests, channel_names, notify}` | owner `channels-accept` | `gates.py:34-36`, `gates_page.py:812-815` |
| `channels` | owner | yes | `<agent>` | `{bot, bot_role, answers:{cid:name}, threads, notify, extra, flags:{cid:{peer,pair,guest_venue,readers}}}` | owner `channels-accept` / `channels-rules-accept` | `gates.py:33`, `split` 322-349 |
| `route-offers` | piece | yes | `<agent>` | `{doc: routes.json, at, from}` | a bridge service's `offer-routes` | `gates.py:621-633` |
| `bodies` | agent | **false** | `<agent>/<profile>/{host,req/<rid16hex>,stop/<aid>,inbox/<aid8>}` | host snapshot; start requests `{prompt, model, deny, env, at}`; inbox `{meta, pending:[...]}` (message text in flight) | bridge service + its `-bodies` host service | `shuttle/bodies.py:1-17,31,55-122` |
| `moved` | piece | yes | `<agent>` | tombstone `{agent, at, by}` | `loom shuttle gates moved <a>` / first runtime sighting | `gates.py:70,98-104`; `tools/loom-shuttle:263-274` |

Files (not in loom's store):

- `$SHUTTLE_INSTANCE` → `shuttle.json` (per-agent instance: agent slug/name, owner name, workdir, `state_root`,
  `now_dir`, `inbox_dir`, `secrets` dir or `secret_cmd`, `commands`, `runner`, `preferred_model`, `always_deny`,
  `guest_deny`, per-bridge sections) — `shuttle/instance.py:1-80`. Beside it: `people.json`, `routes.json`, `briefs/`,
  `ext/*.py` (README "Running an instance").
- Now board: `<now_dir>/<bridge>.json` (snapshot, `{v:1, bridge, at, interval_s, socket, slots, talking:[{cid, venue,
  who, active_s, stalled, queued, body_since}]}`) and `<now_dir>/events-YYYY-MM.jsonl` (`picked|delivered|finished|
  socket|did` records with `t, bridge, venue, who, members, cid, body, wait_s, outcome, n`; `did` carries tasks, PRs,
  knowledge slugs, asks, cost/usd/models/tools) — written by the old bridges (`shuttle/nowlog.py`), read by
  `loomui.py:120-166, 743-770`. Note loom-box's `nowboard.mjs` now also receives these from houses
  (`$SHUTTLE_NOW_REMOTE=runtime/now`).
- Relay queues: `$LOOM_PIECE_HOME/relays/<via>.jsonl` and `relays/sent.jsonl` (last 200 digests, 1h loop window) —
  `shuttle/relay.py:40-51, 77-123`. Entries hold `say` (message text ≤4000) and the person's name/slug.

### Manifest & offers

- `package.json` `loom`: `name: shuttle`, **`role: "bridges"`** (label "Shuttle"); one setting `SHUTTLE_INSTANCE`; the
  `store` block above. No `venues`, no `mcp_tools`, no `services`, no `grants`, no `delivery`, no `strangers`.
- `ui --json` manifest (`shuttle/loomui.py:327-339`, `tools/loom-shuttle:343-351`):
  `{v:2, owners:2, tab:{label:"Bridges", kind:"setting"}, agentTab:{label:"Bridges"}, tile:{label:"Bridges",
  value:"N live", detail:<last activity>, tone, page:""}, asks:[…≤10]}`. No `agents`, `notices`, `answered`.
  `_doing()` (`loomui.py:342-363`) is dead code: the "doing"/dark-bridge alerts moved to loom-box nowboard (comment at
  332-334).
- Asks come from the store (`gates_page.asks`, `gates_page.py:570-606`): proposed people (`proposal_asks` 390-408),
  "Check <a>'s people" (offer without people), "Check <a>'s channels", "Check <a>'s channel rules", "<a> and <b> both
  answer in a channel". Ask identity = `page` path (`people/<a>`, `channels/<a>`) + text; no stable id.
- Role contract: `role: "bridges"` is a label only — core grep finds no consumer of `'bridges'`; core's token roles
  name `runtime:shuttle` / `review:shuttle` in tests only.

### Flows

| Flow | Kind | Where (file:line) | Identity | Bounded/paged | Change signal | Sensitive | Destination |
|---|---|---|---|---|---|---|---|
| Manifest (tab, agentTab, tile, asks) | read | `tools/loom-shuttle:343-351`; `loomui.py:327-339`; asks `gates_page.py:570-606` | asks keyed by page path; tile singleton | asks ≤10 | none (core polls manifest) | agent names; ask text | tile → t-2028 (bridge health, already on runtime nowboard); asks → t-2025 (attention) — but the people/proposal asks are dead once gates moved; only channel/route asks remain live |
| Page `""` Bridges (household) | read | `tools/loom-shuttle:316-341`; `loomui.page` 399-423 | bridge name | conversations ≤200 (`LIST_ROWS`), 24h window, dark sections ≤7 | none | display names of people talking, venues, counts; house rules (tool deny lists, model) | bridge rows → t-2028 (status); conversations list → **superseded by t-2027** (core conversations); house rules → t-2031 (settings) |
| Page `""` with `LOOM_SCOPE=<agent>` (agent's Bridges tab) | read | `tools/loom-shuttle:310-315`, `agent_bridges_page` 131-153 | agent slug | proposals ≤10, people table ≤150 rows | none | as above + proposals | t-2031 (bridges config per agent) |
| Page `bridge/<name>` | read | `loomui.py:403-405`, `_bridge_page` 539+ | bridge name (`discord`/`slack`) | 24h | none | socket state, counts | t-2028 |
| Page `conv/<cid>` (one old-bridge conversation: turns, what came of it, cost, who) | read | `loomui.py:406-408`, `_conv_page` 847-946, `_conv_records` 743-770 | `cid` = `c-<12hex>` (digest; stable) or legacy `c-NNNN` (`CID` 29) | 45 days (`CONV_DAYS`), rows ≤200, people ≤20+10 | none | display names, cost $, models, tools, task/PR/knowledge refs (no message text) | **t-2027 legacy** — core conversations (`cv-…`) replace it for adapter-delivered traffic; keep read-only until old bridges are gone, then retire |
| Page `people/<agent>` (gates doc table, proposals, merge form) | read | `tools/loom-shuttle:298-309`; `gates_page.people_page` 467-493; `people_blocks` 82-104 | agent slug; person slug | table ≤150 rows (`ROWS` 27), cells ≤300 | none | tiers, grants/restricts, project scopes; platform ids on merge/proposal views | **legacy**: when `held_by_runtime` it renders a "Kept by the runtime now" callout (298-303). Gates belong to runtime → t-2028/t-2031 on the runtime's side, not shuttle |
| Page `channels/<agent>` (route part, conflicts, rules to check) | read | `tools/loom-shuttle:304-307`; `gates_page.channels_page` 495-568 | agent slug; Discord channel id | rows ≤150 | none | Discord channel ids, bot ids/role ids, readers (person slugs) | t-2031 (bridges/route config metadata) |
| `ui act` `people-accept` / `people-allow` / `people-deny` / `people-merge` | action | `tools/loom-shuttle:51-61` → `gates_page.act` 757-821, `_answer` 611-660, `_merge` 707-738 | `(agent, offer_rev / proposal key / seen-hash)` CAS | — | store revision (if_rev); no notify | writes owner `people`; ensures person cards via `loom person ensure` (`cards.py:80-160`); allow may queue a relay | **legacy** (refused with `MOVED` once runtime holds gates, 56-57). Destination if kept: t-2031 actions; but should be retired |
| `ui act` `channels-accept` / `channels-rules-accept` | action | `gates_page.py:783-821` | `(agent, from, offer_rev, saved_rev, flags_hash)` CAS | — | store revision | writes owner `routes`/`channels` | t-2031 (route-map settings) — still live (discord reads routes) |
| API `run people` (bridge reads its agent's gates) | read | `tools/loom-shuttle:69-75` → `gates.api_answer` 647-649; `get` 186-195 proxies to runtime when held | agent; `rev` int (store) | whole doc | `rev` returned; bridge re-polls every 60s (`People` 665-730, `REFRESH_S`) | full gates doc (platform ids, tiers) | EXCEPTION-ish: service-to-service, never browser; owned by runtime now (t-2028/t-2031 runtime side) |
| API `run offer-people --doc` | action | `gates.py:650-659` | agent | — | none | full people.json | legacy; retire |
| API `run routes` (assembled route map) | read | `gates.py:615-620`; `routes_for` 387-408; `assemble` 361-384 | agent; `rev` = sha256[:12] of doc | whole doc | content hash only; consumers poll 60s | Discord ids, notify channel ids, readers' slugs | service-to-service; config metadata → t-2031 (owner view), not a browser data feed |
| API `run offer-routes --doc` (bridge service only) | action | `gates.py:621-633` | agent | — | none | full routes.json | t-2031 (offer surfaced as ask) |
| API `run propose-person` | action | `gates.py:634-646` → runtime `gates propose` when held (`runtime_propose` 158-183) else `propose` 544-588 | `p-<6hex>` | ≤10 pending/agent | none | person entry incl. platform ids, relay text ≤600 | legacy forwarder; attention lands in runtime's Inbox (t-2025) |
| API `run bodies get/put/del/sync` | action/read | `tools/loom-shuttle:76-81`; `bodies.api_answer` 55-122 | `<agent>/<profile>/…` keys; rid 16-hex; aid | `docs(prefix)` ≤1000 | host polls every 2s (`SYNC_S`); no revision used | **prompts, env, message text in flight** (history:false) | EXCEPTION (in-flight body control plane; superseded by loom-box bodyhost.mjs — likely dead) |
| API `run relay --via slack …` / `relay-take --via slack` | action | `tools/loom-shuttle:82-87` → `relay.api_answer` 148-197; `queue` 77-109; `take` 112-123 | `r-<8hex>`; digest | sent.jsonl last 200 | file append; bridge drains | `say` text ≤4000, person name | legacy (runtime has own `relay --to`, loom-box `gates-api.mjs:58`; `LEGACY_SEND={}`); retire. If kept: EXCEPTION (message text) |
| CLI `loom shuttle routes --agent A --json` | read (cross-piece) | `tools/loom-shuttle:239-255` | agent; `rev` sha[:12] | whole doc | content hash | Discord ids | consumed by loom-discord (`DISCORD_ROUTES_COMMAND` default, `bin/loom-discord:50-51`); service-only |
| CLI `gates export --json` | read | `tools/loom-shuttle:221-232` | agent → {doc,rev} | list ≤1000 | — | full gates | one-off migration (owner pipe to `loom runtime gates import`) |
| CLI `gates moved <agent>…` | action | `tools/loom-shuttle:263-274`; `gates.mark_moved` 98-104 | agent | — | — | — | migration |
| CLI `cards-backfill --dry-run/--bodies` | read/action | `tools/loom-shuttle:181-218` | person slug | ≤1000 | — | names, platform ids → person cards | one-off (t-2030 people, via core's ensure) |
| Adapter status probe (shuttle → discord/slack) | read (cross-piece) | `loomui.adapter_statuses` 216-230 (`loom discord status --json`, `loom slack status --json`, 2s timeout) | venue | — | — | none (mode, agents, counts) | t-2031 / t-2028 |
| Runtime gates probe (shuttle → runtime) | read (cross-piece) | `gates._runtime` 77-95, `runtime_people` 115-150 (`loom runtime gates people --agent A --json`), `held_by_runtime` 145-156 | agent | — | rev from runtime | full gates | n/a (proxy) |
| Old-bridge now board files | stream (file) | `loomui._snapshots` 120-131, `_events` 148-166; writer `shuttle/nowlog.py` | bridge; `cid` c-12hex; body id[:8] | 24h for page, 45d for conv | file mtime / append only; no ids for change | display names, cost | t-2028 (now board already in loom-box `nowboard.mjs`) |

### Cross-piece reads

- **Into shuttle**: loom-discord's poller and `send --describe` / `read` read the route map via `loom shuttle routes
  --agent A --json` (`loom-discord/bin/loom-discord:50-51,123,231,273`). Old bridges (shuttle `adapters/discord.py`,
  `adapters/slack.py`) read `people`/`routes` through `POST /api/shuttle/run` (`gates._remote_call` 732-756), take
  relays, and drive `bodies`. loom-box: `gates import` consumes `gates export`; nowboard reads shuttle's now files; UI
  hint text names the command (`loom-box/src/ui.mjs:413`). Core: generic piece page/act/api dispatch only; project
  hub can show a `piece:shuttle` feed section (test only).
- **Out of shuttle**: `loom runtime gates people|propose` (gates), `loom discord|slack status --json`, `loom person
  ensure --json` (core people, owner grant), `$LOOM_HOME/household.json` agents list (`tools/loom-shuttle:90-98`),
  the instance's `people.json` (display name → slug map, `loomui._people` 169-193).

### Sensitive fields

- Gates docs (`people`, `offers`, `proposals`): Slack/Discord **user ids**, tiers, grants/restricts, project/field
  scopes — owner-only, never a shared cache.
- `routes`/`channels`/`route-offers`: Discord guild/channel/role/bot ids, webhook peers, readers' slugs — low-sensitivity
  config but internal; fine for owner-only settings view, not for agent/guest viewers.
- `bodies`: prompts, env pass-through (`SHUTTLE_*`/`BRIDGE_*`), inbox pending message text — EXCEPTION.
- Relay queue: `say` text — EXCEPTION.
- `shuttle.json`: `secrets` dir path / `secret_cmd`, command paths — never surfaced (page shows only rules).
- Conversation pages: names, cost $, model and tool counts — owner/household-viewer scoped (`owners:2` narrowing in
  `tools/loom-shuttle:290-296`).

### Notes / gaps

- **Shuttle is legacy except for the route map.** Gates → runtime (tombstones; act refuses, page shows MOVED);
  tile/asks/doing → loom-box nowboard; bodies → loom-box bodyhost/houserunner; relay → runtime relay; Slack DMs →
  loom-slack (live 2026-11-08, `LEGACY_SEND` emptied). The Bridges page's `""`/`bridge/`/`conv/` views read the old
  bridges' now board; with Slack on loom-slack, Slack traffic now lives in core conversations and the Bridges page
  will show it only if the old Slack bridge still writes the board. Discord's adapter mode wasn't determinable here
  (`loom discord status` couldn't run in this sandbox); if Discord is still shadow, the old shuttle Discord bridge is
  still the live one and its page is still the only view of channel traffic.
- Remaining ownership to migrate before retiring shuttle: `routes` + `channels` (+ `route-offers`, flags/readers)
  and the owner actions on them. loom-discord's README already says "until the runtime holds the routes too".
- No pagination anywhere: store reads are `--limit 1000` single shots (`Snapshot` 243-268, `docs` 228-233); asks cap
  10; tables cap 150; lists cap 200.
- Revisions exist (store `rev`, CAS on every owner write) but nothing exposes them to the UI as a change feed; the
  route map's `rev` is a content hash.
- `role: "bridges"` has no core contract behind it.

---

## discord (loom-discord)

### Store

No loom piece store collections (no `store` block). Local data dir `DISCORD_DATA` (default
`${LOOM_PIECE_HOME}/data`):

| File | Contents | Writer | Code |
|---|---|---|---|
| `state.json` | `cursors{agent:{channel:msgid}}`, `handled{"<agent>:<id>"…}`, `guest_count`, `parents{thread:channel}`, `peer_stopped{agent:{place:true}}`, `acked`, `held{"<agent>:<id>":{at,place}}` | `run` poller | `lib/loomdiscord/adapter.py:107-120` |
| `shadow-routes.jsonl` | `{at, platform, id, agent, place, contract}` (metadata only, 8 MB cap, halved) | shadow mode | `lib/loomvenue/common.py:232-266` |
| `presence/<agent>/<kind>-<id>.json` | `{place, working, at, since, acks:[{id,at}]≤20}` | `send --status` (runtime) | `common.py:654-705` |
| `stops/<agent>/…`, `posted/<agent>/…` | `{at, msg}`, `{at}` | run loop / send | `common.py:714-727` |

No text is persisted (text only in-process and in the deliver body). Tokens are held in-process only (`Secrets`,
`common.py:108-141`).

### Manifest & offers

- `package.json` `loom`: `name: discord`, **`role: "venue"`**, label "Discord".
- `venues.discord = {label: "Discord", kind: "live", send: ["loom-discord","send"]}` — **no `render`**, so core's
  conversation view uses its generic render (`loom/src/conversations.ts:157-185`; venue keys parsed
  `src/offers.ts:164-197`).
- `services: [{name: "run", argv: ["loom-discord","run"]}]`.
- `settings`: `DISCORD_MODE` (shadow|live), `DISCORD_BOTS` (agent → secret name; required), `DISCORD_DATA`,
  `DISCORD_POLL_S`, `DISCORD_TOKEN_FILE`, `DISCORD_LOOM_URL`, `DISCORD_ALERT_COMMAND`, `DISCORD_ROUTES_COMMAND`,
  `DISCORD_GATES_COMMAND` (plus undeclared `DISCORD_SECRETS_MAY`/`_GET`, `bin/loom-discord:54-55`).
- **No `ui` verb** (no manifest/tab/tile/asks/agents), no `api`, no `mcp_tools`, no `grants`, no `delivery`, no
  `strangers`, no `store`.
- Verbs: `run`, `send` (+`--describe`, `--status`), `read`, `compare`, `status` (`bin/loom-discord:321-345`).

### Flows

| Flow | Kind | Where (file:line) | Identity | Bounded/paged | Change signal | Sensitive | Destination |
|---|---|---|---|---|---|---|---|
| Poll channels + active threads, per agent bot (Discord REST) | stream (inbound, poll) | `bin/loom-discord:114-151`; `adapter.channels` 123-140; `agent_pass` 194-269 | Discord snowflake msg ids; per-channel cursor | `after=cursor&limit=100` per channel per tick; every `DISCORD_POLL_S` (30s) | cursor in `state.json` | message text, author ids | ingress only (no destination; it feeds deliver) |
| Deliver a routed message to core | action (push) | `make_sink` 84-111 → `common.Deliverer.deliver` `common.py:269-294` → `POST /api/loom/deliver`; body `adapter.body_of` 320-323 / `common.delivery` 316-329 | deliver id `"<agent>:<msgid>"` (stable, idempotent 24h in core); place `channel:<id>` / `thread:<id>` (`routing.place_of` 179-182); answer carries `conversation` (cv-…) + `seq` | one message per call; 40,000 UTF-16 cap | core writes a turn & conversation; the answer's `{conversation, seq}` is the only id/revision; no `pieces/changed` | **message text**, `from` (person slug or `{kind:unknown}`), label (channel name) | t-2027 (core conversations/messages; text goes to audit log, turn is metadata) |
| Venue `send` (runtime posts a reply as agent's bot) | action | `bin/loom-discord:173-223` | place `channel:<id>`/`thread:<id>`; answer `{ok, id}` (Discord msg id of first chunk) | chunks of 2000 | writes `posted/` presence file | bot token (in-process), reply text | runtime-owned outbound; outcome visible via t-2027 turns |
| `send --describe` (place rules for a body's start) | read | `bin/loom-discord:226-240`; `routing.View.describe` (routing.py ~129-150) | place | — | — | readers (slugs), guest/peer flags, notes | runtime-internal policy read; not browser (t-2028 if surfaced as body context) |
| `send --status working|done --message ID` (presence) | action | `bin/loom-discord:191-195`; `common.Presence.status` 677-704 | `(agent, place)`; ack msg ids ≤20 | — | file write; run loop shows typing/👀; answers `stop:true` | ids/times only | t-2028 (agent "working in place" state) — but the runtime already owns this; the file is a local mailbox |
| `read --place P --agent A [--after ID] [--limit N]` (packages piece, t-1965) | read (cross-piece) | `bin/loom-discord:243-304` | Discord msg ids; `after` cursor | `limit` 1..100 (default 1 without `--after`) — **paged by id cursor** | none (caller polls) | **message text of anyone in the channel, including strangers** (`person`/`may_wake` flags only label them), `from` slug | EXCEPTION for browser (raw third-party text; service-to-service read for the packages piece) |
| `status --json` | read | `bin/loom-discord:307-318` | singleton | — | none | none (`{mode, agents, shadow_lines, held}`) | t-2031 (piece health) / t-2028 |
| `compare` (shadow vs old bridge) | read (ops) | `common.compare_main` (`common.py:571-640`) | msg id | window `--hours` | — | ids only | ops-only; no destination |
| Alert command | action (out) | `common.Alerter` `common.py:496-527`; uses at `bin/loom-discord:104-107`, `adapter.contract_check` 271-280 | key per condition | once per condition | — | msg id, agent | t-2025 if alerts become notices (today: owner's alert argv) |
| Stop word in a channel | action (side effect) | `adapter.stopped` 142-155; `Presence.stop` 714-715 | `(agent, place)` | — | file | — | t-2028 (body stop) |
| Reactions/typing (presence display) | action (out) | `adapter.react` 78-90, `typing` 92-99; `Presence.show` 741+ | msg id | — | — | — | none (platform UX) |

### Cross-piece reads

- **discord reads**: shuttle's route map (`loom shuttle routes --agent A --json`, default `bin/loom-discord:50-51`);
  runtime gates (`loom runtime gates people --agent A --json`, 52-53); secrets policy and value (`loom secrets may
  <agent> <name> --json`, then `loom secrets get <name> --reveal` with `LOOM_SECRETS_ALLOW_GET=1`,
  `common.Secrets` 108-141). Both docs fail closed (`common.Doc` 144-173, 60s refresh, no revision tracking — the
  shuttle `rev` is ignored).
- **read by**: the runtime (loom-box) runs the declared `send` argv for posts, `--describe`, `--status`; the packages
  piece runs `loom discord read` (t-1965); shuttle's `loomui.adapter_statuses` and loom-box `nowboard.adapterStatuses`
  (`loom-box/src/nowboard.mjs:185-196`) run `loom discord status --json`; core lists the venue (label/kind/send) in
  `GET /api/loom/venues` for the runtime (`src/transport/http-server.ts:515-530`) and labels conversations
  (`venueLabel`).
- **people/ensure**: not called.

### Sensitive fields

- Bot tokens (`DISCORD_BOTS` → secret names → values via `secrets get --reveal`): EXCEPTION, never leave the process.
- `DISCORD_TOKEN_FILE` (piece token to deliver with): EXCEPTION.
- Message text (deliver body, `read` output) — incl. strangers' text from `read` and from messages it doesn't route.
  Delivered text belongs in core's audit/conversation store (t-2027 rules); `read` output is EXCEPTION for browser.
- Discord user ids / bot ids (in gates & route map consumed, `state.json` keys): internal.
- `DISCORD_BOTS` value itself (agent → secret name) is metadata, not a secret; OK for t-2031 settings display.

### Notes / gaps

- No manifest means nothing to put on a shared live collection except `status`; the user-visible data is the core
  conversation it creates.
- Change signal into core is "a deliver happened" (core records turn `seq`); the piece never tells the UI that its
  own status (mode, held count) changed.
- Place keys `channel:<snowflake>` / `thread:<snowflake>` are stable; a thread is its own conversation; label is the
  channel's name (never a thread's, `routing.label_of` 184-190).
- `read` is the only bounded/paged list (`--after` id cursor, ≤100).

---

## slack (loom-slack)

### Store

No loom piece store collections. Local data dir `SLACK_DATA` (default `${LOOM_PIECE_HOME}/data`):

| File | Contents | Writer | Code |
|---|---|---|---|
| `state.json` | `handled{"<cid>:<ts>":{at,agents}}` (kept 2 days), `waiting{"<agent>|<cid>:<ts>":{since, agent, cid, group, ev, held?}}`, `cache{agent:{users:{uid:{ok,reason,at}}, members:{cid:{at,uids}}}}`, `cursors`, `convs{agent:{at,list,next}}`, `threads{agent:{…}}` | intake | `lib/loomslack/adapter.py:72-95`, `offer` 145-157, `routing.Gate` 98-124 |
| — `waiting[*].ev` | `type, subtype, user, ts, bot_id`; **in live also `text` and file names** (the message's only copy until loom takes it) | live intake | `adapter.slim` 183-190 |
| `shadow-routes.jsonl` | `{at, platform, id, agent, place, contract}` | shadow | `common.py:232-266` |
| `presence/ stops/ posted/` | as discord | `send --status`, run loop | `common.py:654-727` |

### Manifest & offers

- `package.json` `loom`: `name: slack`, **`role: "venue"`**, label "Slack".
- `venues.slack = {label: "Slack", kind: "live", send: ["loom-slack","send"]}`, **no `render`** (core generic render).
- `services: [{name: "run", argv: ["loom-slack","run"]}]`.
- `settings`: `SLACK_MODE`, `SLACK_BOTS` (agent → secret holding env file `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`,
  `SLACK_TEAM_ID`, `SLACK_BOT_USER_ID`; required), `SLACK_DATA`, `SLACK_POLL_S`, `SLACK_THREAD_LOOKBACK_S`,
  `SLACK_TOKEN_FILE`, `SLACK_LOOM_URL`, `SLACK_ALERT_COMMAND`, `SLACK_GATES_COMMAND` (+ undeclared
  `SLACK_SECRETS_MAY`/`_GET`, `bin/loom-slack:60-61`). No routes command (Slack routes DMs/group DMs by gates only).
- **No `ui` verb**, no `api`, no `mcp_tools`, no `grants`, no `delivery`, no `strangers`, no `store`, no `read` verb.
- Verbs: `run`, `send` (+`--describe`, `--status`), `compare [--check-gone]`, `status` (`bin/loom-slack:433-457`).

### Flows

| Flow | Kind | Where (file:line) | Identity | Bounded/paged | Change signal | Sensitive | Destination |
|---|---|---|---|---|---|---|---|
| Live intake: Socket Mode per agent app (`apps.connections.open` → websocket; `message.im`/`message.mpim`) | stream (inbound push) | `adapter.Socket` 336-417; `bin/loom-slack:150-160` | envelope_id (acked at once); msg id `<channel>:<ts>` (`routing.msg_id` 204-206) | queue drained each 5s tick | Slack push; no revision | message text, user ids; **app token** | ingress only |
| Shadow intake: `conversations.list` (≤200/page, cursor-paged, every 600s) + `conversations.history`/`replies` | stream (inbound, poll) | `adapter.Poller` 193-335 | as above; cursors per conversation/thread | `HISTORY_LIMIT` 15 per read; 1 read/agent/65s; thread lookback 30d | cursor in state | ids only kept (no text in shadow) | ingress only |
| Gate checks against Slack (`users.info`, `conversations.members`) | read (platform) | `routing.Gate` 105-185 | Slack `U…` / `D…`/`G…`/`C…` ids | cached (`USER_CACHE_S`, `GROUP_MEMBERS_TTL_S`) | — | user flags (stranger, guest, team) | internal |
| Deliver a routed DM / group DM to core | action (push) | `make_sink` 98-126 → `Deliverer` `common.py:269-294`; body built `adapter.route` 96-132 | deliver id `"<agent>:<cid>:<ts>"`; place **`dm:<Uxxxx>`** (1:1, keyed by the person's user id) or **`group:<cid>`** (`routing.place_of` 199-201); answer `{conversation, seq, body}` | one per call | core turn `seq`; no `pieces/changed` | **message text** (mentions rewritten to names, `routing.clean_text` 233-247), `from` slug, label "DM with <name>" / "group DM with A, B and N more" | t-2027 |
| Wait/retry/held queue | stream (local) | `offer` 145-157, `retry_waiting` 159-176 | `<agent>|<msg id>` | wait ≤1h (`WAIT_TTL_S`); held forever until restart | — | **live: undelivered text on disk** | internal (EXCEPTION if ever surfaced) |
| Venue `send` | action | `bin/loom-slack:208-258`; `place_bot` 329-341; group re-check `group_still_admitted` 311-326 | place `dm:<U>` (opens IM via `conversations.open`) or `group:<cid>`; answer `{ok, id:"<channel>:<ts>"}` | chunked | `posted/` file | bot token, reply text | runtime outbound; t-2027 turns |
| `send --describe` | read | `bin/loom-slack:261-309` | place | — | — | members (slugs), notes (`project-<p>`, `field-<p>`, `group-tier-N`, `group-owner-present`) | runtime-internal (t-2028 body context) |
| `send --status` | action | `bin/loom-slack:220-224`; `Presence.status` | `(agent, place)` | acks ≤20 | file | ids only | t-2028 (runtime-owned) |
| 👀 reactions (`reactions.add/remove`) | action (out) | `react` 344-356; `Presence.show` via `run` 168-172 | `<channel>:<ts>` | — | — | — | none |
| `status --json` | read | `bin/loom-slack:419-431` | singleton | — | none | none (`{mode, agents, shadow_lines, held}`) | t-2031 / t-2028 |
| `compare --check-gone` (asks Slack if a message still exists; metadata only) | read (ops) | `still_there` 358-386, `gone_checker` 388-417; `common.compare` (slack copy) | msg id | window | — | bot token use | ops-only |
| Alerts | action | `common.Alerter`; `make_sink` 117-121; `contract_check` 134-143 | per condition | once | — | msg id | t-2025 if turned into notices |

### Cross-piece reads

- **slack reads**: runtime gates (`loom runtime gates people --agent A --json`, `bin/loom-slack:58-59`); secrets
  (`loom secrets may` / `get --reveal`, 60-61, `credentials` 80-86). No shuttle read (no routes).
- **read by**: runtime (`send`, `--describe`, `--status`); shuttle `adapter_statuses` and loom-box nowboard (`status
  --json`); core venue directory/labels. `LEGACY_SEND` (runtime handing shadow-refused DMs to shuttle's relay) is now
  empty — Slack is live on loom-slack since 2026-11-08 (`loom-box/src/delivery.mjs:2831-2840`).
- **people/ensure**: not called.

### Sensitive fields

- Secret env file per agent: `SLACK_BOT_TOKEN` (xoxb), `SLACK_APP_TOKEN` (xapp, opens Socket Mode) — EXCEPTION.
  (`SLACK_TEAM_ID`, `SLACK_BOT_USER_ID` ride in the same secret; not secret per se but come only from it.)
- `SLACK_TOKEN_FILE` piece token — EXCEPTION.
- **Place keys contain Slack user ids** (`dm:U…`): these are core conversation `place` values and would land in any
  conversation collection (t-2027) — acceptable as opaque keys for household viewers, but don't expose to guests;
  display should use `label`.
- Message text (deliver; live `state.json.waiting` text). `cache.users` holds per-user Slack verdicts (stranger /
  guest / other workspace) — internal.
- Strangers: Slack drops anyone below tier 2 before deliver; no stranger text reaches core, but it is seen in-process
  and (live, if waiting on a Slack check) may sit in `waiting` until dropped after 1h.

### Notes / gaps

- Same shape as discord: no UI surface, no store, push only through deliver; status is the only browser-safe read.
- Identity is stable: deliver id `agent:channel:ts`; place `dm:<user>` (stable per person, not per DM channel) and
  `group:<cid>`.
- No `read` verb (unlike discord); `compare --check-gone` is the only metadata lookback.
- The live socket is a single dial-out per agent app; reconnects are logged only (no status field for socket health;
  the old shuttle board's `socket` events have no equivalent in `status --json`).

---

## Proposed destinations, summarized

| Data | Destination | Rationale |
|---|---|---|
| Adapter status (`mode, agents, shadow_lines, held`) for discord & slack | t-2031 (piece health) — also feeds t-2028 bridge tile | small, no ids/text; today polled by shuttle and nowboard via subprocess |
| Delivered messages / conversations (both venues) | t-2027 | already core records; venues have no render, core renders |
| Presence (working/stop) | t-2028 | runtime already owns body state; venue files are a mailbox |
| Alerts (held delivery, contract mismatch) | t-2025 (as notices) | today only the owner's alert argv |
| Shuttle route map (`routes`, `channels`, `route-offers`) + its asks/actions | t-2031 (settings/grants-rules metadata), owner-only | the one live piece of shuttle; migrate to runtime eventually |
| Shuttle people/proposals/offers/moved | retire (runtime gates own it; t-2031/t-2025 on the runtime side) | tombstoned |
| Shuttle Bridges page (now board, 24h list, `conv/<cid>`) | t-2028 (status) / retire `conv/` in favour of t-2027 | reads old bridges' files |
| Shuttle bodies, relay queue | EXCEPTION / retire | message text & prompts in flight; ported to loom-box |
| Bot/app tokens, piece token files, secrets env files | EXCEPTION | credentials |
| `loom discord read` output | EXCEPTION (service-to-service) | raw channel text incl. strangers |
| Slack live `waiting` text, discord/slack `state.json` | EXCEPTION (local only) | undelivered text, platform ids |
