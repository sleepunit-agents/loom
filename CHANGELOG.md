# Changelog

All notable changes to loom are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

> **Publish status:** `@jbarket/loomai@0.5.0` is the first version published to
> npm. `0.4.1` and everything before it exists only as a git tag — those versions
> were never on the registry, so the four months of work between `0.4.1`
> (2026-04-23) and this release ship together as `0.5.0`.

## [Unreleased]

- Add unregistered one-use Secrets handoff tickets with durable claims, exact grant/Runtime fences and staging holds; real worker delivery remains disabled.

- Add member-private Inbox read facts without answering asks or copying draft words.

- Reconcile public Attention waits without an open member page, using explicit public Tasks/Approvals read grants and the daemon clock.
- Clear private Comms working state from committed terminal Runtime jobs and recover missed completion notifications at startup.

- Show live new-side piece counts and a Boxes enrollment glyph in the desk bar, with unavailable sources and unknown health stated explicitly.

- Keep ordinary one-off Clock work filed by authenticated private bodies member-private, with original steering evidence and acknowledgements that omit words.
- Clock schedules retain original steering across replacement and run-now; private schedule receipts keep their window check after removal.
- Add a pinned metadata-only holder handoff channel with fresh destination checks, buffer erasure and drained shutdown; runner ticket admission and production activation remain separate.
- Add a trusted Runtime destination metadata binding for future Secrets tickets, with fresh job, runner, box and claim checks.
- Bind authenticated HOUSE request/status metadata in the typed Secrets client, with exact-job assertions, stable retries and value-free JSON acknowledgements.
- Add worker-local Claude turns with exact tool denies and original-binding native history isolation; daemon policy execution remains held.

- Reserve one-off Clock capacity: at most forty API-created wakes per agent and twenty per proven conversation, with unbound bodies sharing one bucket.
- Add an internal Runtime role for current authenticated Clock conversation provenance, retaining private scope and sender history.
- Match imported private spawn bindings to Comms by conversation ownership, preserving job and spawn handles independently of thread ids.

- Preserve authoritative shuttle and Runtime store documents and revisions as bounded offline Bridges import evidence; do not select or apply authority.
- Import Bridges setup from explicit completed snapshots with authoritative source resolution, disabled connections, private evidence and independent verification.
- Import local bridge setup from household snapshots without inventing off-machine connections or Slack credentials; retain incomplete Slack and unprojectable audiences as private evidence.

- Limit newly created agent API schedules to twenty per target agent, preserving owner schedules and existing-schedule replacements.
- Prepare required Runtime policy files on Linux workers with descriptor-pinned reads and resolved-content history keys; configured-policy execution remains held.

- Add an offline Bridges configuration source inventory prerequisite with explicit files, source checksums, bounded reads and no credential acquisition; database import and migration registration remain pending.
- Preserve deleted private Comms bindings only in the Runtime import archive, report their skipped ids, and validate spawned thread ownership.

- Add a daemon-owned Secrets receipt reconciliation job that recovers confirmed writes without caller plaintext, retaining locks on uncertain writes and rechecking current authority.
- Bind Secrets house request and status to current central body credentials and exact Runtime job/service scope.
- Compose explicit authenticated Secrets mutations, retained retry keys and automatic recovery in next startup, with per-write staging holds.
- Bridges: bind household DMs to real runtime jobs and central body credentials, with private durable transcripts, stable reply outbox receipts, staging and stop/revocation checks.
- Persist Runtime owner gates and policy with revision-bound edits and exact archived proposal adoption, refusing unreconciled source restrictions.

- Retain encrypted-holder age identities and receipt keys across explicit key rotation without rewriting values or retry receipts.

- Prepare Runtime body policy rules for trusted external delivery, with complete guest rosters, standing restrictions and effective session keys.

- Secrets: allow explicit daemon retry-key rotation while retaining all historical keys and preserving old write identities across restart and receipt expiry.

### Added

- Show live Inbox read indicators and retain member-scoped device reply drafts through navigation, reload and failed sends.

- Clock links local-work requests to private chat; its browser proof now files through a real Runtime-bound body before owner review and scheduling.

- Clock’s owning local-request reader now reviews explicit timing and schedules saved private words with one-time or existing every-time authority; Runtime delivery remains held.

- Add an authenticated owner-window recovery operation for saved private Clock local requests, retaining their exact scope and durable retry acknowledgement. App scheduling controls and Runtime delivery remain unfinished.
- Next Runtime retries definitively unstarted nonconversation manual/spawn jobs at most three times, retaining original intent, deadlines and current-policy checks across restarts.

- Import explicit Runtime snapshots with complete private source retention, scoped metadata, held old work and independent migration verification.
- Exclude source-owned Runtime repository mirrors under a named cache rule while retaining durable delivery and house working data.

### Fixed

- Stream offline migration files and Runtime archives in bounded chunks, including independent physical-byte verification of files larger than 600 MiB.

- Accept legacy Secrets timestamps at arbitrary fractional precision during offline import, retain validated audit text exactly, and report value-free source check names.
- Next Clock files local approval requests and recovers their exact saved words through authenticated Runtime body proof; `wake --approval` no longer requires retyping private words.

### Added

- Compose next Bridges from the explicit secret holder with scoped HTTP inspection/sends, policy-checked People labels and a durable engine that never receives raw credentials.
- Load the daemon Secrets retry key from an explicit private file and pin its identity before async value operations are registered; changed keys and unbound old journals fail closed.
- Next bridge credential lifetimes now follow asynchronous public holder generation, retiring both transports on rotation or holder failure without reading credential values.
- Persistent secret holder public generation for bridge credential lifetimes, atomically rotated with committed mutations and available through its authenticated read transport.

- Compose Discord Gateway intake with authenticated service credentials, durable receipts and staging-gated lifecycle in the opt-in next-mode bridge root.
### Added

- Add durable admission and retry reconciliation for explicitly composed async Secrets writes; normal Settings value edits remain disabled pending daemon key and reconciliation composition.

- Apply next-mode Runtime owner reset and silent-work write-off cards against durable original snapshots, with atomic body/session fencing and central credential revocation.

- Fit the Comms composer to its actual next-mode tile and fold Work when the reader is narrow. Exercise ordinary, filed and attached Comms delivery through real next-mode page sessions, Runner claims and bound-body replies in the two-window browser proof.
- Comms thread rows pin on a stationary touch or pen long press, without opening the thread; scrolling and cancelled holds leave it unchanged.
- Reduce first-page JavaScript while keeping app screens loaded on demand.

- Add keyboard-accessible Pin and Archive actions to Comms list rows, including right-click entry.

- Add a private Discord raw receipt drain with fresh metadata, bounded retries and durable normalized handoff; production activation remains pending.
- Show Stop only for active joined Comms threads, disabling it while disconnected or saving.
- Next mode retires per-agent piece/path grant approvals in favour of record scope and withdraws pending legacy grant imports.

- Add unregistered Discord service authentication and fresh channel, thread-parent and DM-recipient metadata reads for durable intake normalization.
- Show each Comms thread’s agent letter beside its title in the list.

- Add private Discord Gateway receipt/session storage with atomic checkpoints and credential-generation isolation; daemon registration remains pending.
- Show Comms thread activity times in CT and live working state in the thread list.
- Resolve next-mode Approvals callers from central authenticated body proof and current private Runtime/Comms membership, preserving service-house identity.

- Add an unregistered Discord Gateway transport with committed-sequence resume, service-scoped credentials, heartbeat recovery and awaited shutdown. Production receipt storage and daemon wiring remain required.
- Capture an explicit external Secrets source with `migrate snapshot --secrets`, using the same private inventory and confinement rules as other roots.
- Reconcile authoritative runner-fenced start failures into generation-matched private Comms notices, enabling member retry without automatically repeating an uncertain execution.

- Add explicit next-mode Slack lifecycle composition with service credentials, staged connection release, startup receipt recovery and awaited shutdown.

- Bridges: add a serialized Slack raw receipt normalizer with fresh metadata, bounded retries and commit-before-consume ordering.
- Connect next-mode private Comms messages to runtime jobs and authenticated body reads, replies and status, keeping private words out of runner inputs and retry receipts.

- Comms now shows work made in the thread, with live task/change statuses and links to their apps.

- Review local machine requests in Clock with the existing exact-word approval controls; private decisions use the owning signed-in window and start no work.

- Start conversations from Home with the shared Comms composer, retained drafts and recent/unread-thread navigation.

- Next desk: show loom's server minute/timezone and live connection/working-agent status glyphs on desktop; retain compact phone chrome.

- Restore the new desk's compact phone bar and centered ticker using live owned-agent status and Needs you counts.

- Keep long Home agent details scrollable within desktop cards, with a keyboard focus target and natural page scrolling on phones.

- Import registered agents’ pixel sheets with the household, serve them from the new database with current agent visibility, and honor Pixel faces on Home and the rail.

- Give next-mode Home desk-coloured cut cards and the member’s saved Depth, Contours or Wash ground.

- Give next Home and rail cards their agents’ database-backed colours and drawn faces, with expressions for reported work and asks.

- Keep a neighboring next-mode app's narrow reader from taking focus away from the chosen tile.

- Bridges: authenticate Slack workspace/bot/app evidence through service-scoped Web API calls for future receipt composition.
- Fold eligible private conversation metadata as the signed-in member while Home or Inbox is open, using the existing retention operation.
- Clock local requests from an authenticated owner conversation retain member-private approval, wake and standing scope; signed windows alone read the words, and exports omit private copies.
- Next runtime accepts stable body-start intents and connects Clock dispatch to runner-confirmed starts, preserving staging holds and uncertain outcomes.

- Bridges: add private, connection-bound Slack raw receipts that commit before Socket Mode ACK and retain restart deduplication.
- Add next-mode Household Setup for owner-managed members, agent ownership, project access, existing agent registration and GitHub attribution.

- Bridges: add unregistered Slack Socket Mode transport with durable-receiver-before-ACK ordering, fresh service credentials, reconnect and heartbeat bounds.
- Apply member appearance choices live in the next shell, with controls for look, reduced motion, contrast and zoom.

- Next-mode runtime releases claimed input once through the staging gate; HTTP supports asynchronous operations with authentication revalidation.
- Derive the private-app window capability from validated next-mode page sessions, while keeping bearer callers denied.
- Add an unregistered async holder mutation channel with trusted current-member authorization and durable-store acknowledgements.
- Add authenticated, value-free committed holder receipt lookup for uncertain write recovery; durable registry admission and metadata reconciliation remain required before enabling Settings values.
- Connect the persistent Secrets holder executable to authenticated current household authority over a dedicated private socket.

- Bridges: add service-credential Slack API inspection with fresh paginated membership and staging read gates.
- Add atomic offline Secrets metadata import, source-owned pending asks, migration-all discovery and independent destination verification.
- Add holder-owned age ciphertext storage with atomic, member-bound full-input retry receipts, ready for authenticated mutation composition.
- Add `loom-secrets-client`, a remote names/startup/request-state and stdin-only value command client with stable write retries and legacy metadata output fixtures.
- Require an explicit independent daemon key for secret value retry fingerprints; database backups no longer expose plain input hashes for new value writes.
- Add the new runtime runner's bounded, commit-pinned Git snapshot reader for house build inspection.
- Add next-mode member-private Appearance and Accessibility preference operations and Live records, preserving imported choices across owner changes.

- Reject asynchronous secret-holder mutation and handoff acknowledgements before reporting saved values or confirmed use.

- Preserve imported Comms attachment matching with a keyed fingerprint, omitting legacy raw pointers from thread metadata.
- Connect next-mode Secrets requests to managed household Attention asks, including restart and atomic owner answers.

- Add an explicit next-mode mutual-TLS Unix socket holder source and separate age decryption process for owner-granted service use.
- Keep bounded runtime job diagnostics outside live metadata, with scoped result reads and atomic completion.

- Discover visible reported runtime builds for the current house configuration without treating later progress as a newer image.

- Add confirmed dismissal of held and uncertain sends in the next-mode Bridges preview, with pending and error feedback across navigation.
- Retry runtime-held Bridges intake after daemon restart with the original receipt and fresh admission, while preserving administrative holds.
- Bound transient Bridges intake retries to a durable one-hour budget across restarts and duplicate receipts, erasing expired payloads while retaining deduplication.
- Let the owner review and count eligible unknown imported wakes as their work in the Clock app, retaining saved words, due times and current authority checks.
- Request owner review of an eligible imported wake in the Clock app, preserving saved words and due time while leaving work held.
- Show executable prompt or file excerpts alongside saved notes on Clock owner-vouch request cards, preserving every id and due time within the details limit.
- Automatically group eligible unsteered unknown Clock imports on one owner-vouch card, atomically refresh unanswered groups, retain Deny suppression and hold overflow.
- Clock: schedule exact filed local work through trusted standing authority, with a single outstanding target, durable atomic receipt and private binding checked against live authority before dispatch; public/runtime host composition remains unfinished.
- Clock: add a trusted owning standing-local approval use/check seam with exact receipt, full-digest, principal, service and project checks; Clock scheduling and fire-time composition remain pending.
- Clock: recover exact filed local words and notes through a trusted one-shot scheduling role, with current receipt checks and atomic capacity-before-spend scheduling; public runtime/client wiring remains uncomposed.
- Clock: add trusted owner-principal local-wake filing with full executable card words, exact saved prompt/note and project-preserving atomic approval filing; runtime/client recovery remains uncomposed.
- Preserve project scope on explicit Clock owner-vouch cards, reject mixed scopes and recheck the card scope before applying owner Allow.
- Clock can file an exact owner-vouch request for eligible held imports through `ask-vouch`; owner Allow applies it, and Deny prevents re-asking.
- Expose owner vouch for eligible unknown imported wakes through the opt-in wake API client, retaining owner policy and retry deduplication.
- Add owner vouch adoption for explicitly unknown plain imported Clock wakes, with atomic next-mode approval application.
- Add opt-in fixed 24-hour Clock safety wakes under explicitly configured agent authority, retaining restart deadlines and staging holds.
- Clock rejects continuation requests combined with a lane file, slot, place, approval or local-wake marker before saving work.
- Compose parked Clock wakes with current scoped Approvals and Secrets answers in next mode, without spending receipts or carrying grants.
- Add owner-controlled runtime house grant configuration with preserved secret scopes and repository-secret build provenance.

- Start the next-mode Changes daemon with durable refresh and explicit, owner-granted Secrets composition.
- Bind runtime job claims to configured house identity and record validated, immutable per-job build tags.

- Include Comms in offline migration plans, imports and independent private-content verification.
- Migration snapshots collect registered importer data and keys only, skip legacy aliases and live/program entries safely, explain refusals, and support a no-write `--dry-run` inventory.
- Prepare offline migration plans with snapshot-bound inputs, strict options and explicit audience/attribution defaults (CLI runner follows).
- Add read-only `migrate verify` that independently compares imported IDs, counts, metadata and content against the snapshot and full plan on every invocation.
- Add offline `migrate plan` and resumable `migrate all` with snapshot-bound receipts and stopped-home destination checks.
- Add centrally authorized runtime house build configuration in next mode, preserving box and model preferences without granting execution capabilities.

- Compose next-mode Changes with authenticated owner Approvals for exact-head answers and lasting project rules.
- Next runtime: atomically queue scoped body requests and private inputs with canonical box placement, without releasing executable work.

- Add explicit `loom mcp --next` stdio composition for row-backed household metadata and offline per-agent continuity.

- Add route creation, editing and confirmed removal to the next-mode Bridges preview, with pending-write and stale-draft guards.
- Add person-link creation, editing and confirmed removal to the next-mode Bridges preview with shared pending and stale-draft guards.
- Add owner-only terminal Bridges send dismissal through the registry and typed CLI, without replaying held or uncertain replies.
- Add connection creation, editing and confirmed removal to the Bridges preview, with secret-name references and shared pending setup guards.
- Add assigned runner completion acknowledgements with atomic, exact job credential revocation in next mode.
- Add next-mode assigned runner job claims and progress reports, with atomic retries and no input or credential delivery.
- Add the Projects preview app with private agent cards, Tasks-first computed hubs, independent role sections and live outside-write updates.
- Run next-mode Attention metadata retention daily as its registered service, respecting private scope and daemon shutdown.
- Add explicit Attention wait checks through visible Approvals and Tasks roles, preserving the caller and central ask history.
- Resolve Attention digest filing through visible private Comms thread metadata without reading message words.
- Attention wait checks recognize matching owner-attributed task answers through the Tasks role, preserving caller visibility and keeping reply words out of Attention.
- Activity preview on the new desk: live episode timeline, three-day windows, filters and full readers, with a synchronous seam for the new Conversations owner.

- Add an opt-in `loom-bridges` JSON setup client for next-mode connection, route and person-link operations.

- Add a Bridges preview for next mode with connection status, daily counts, routes and individually released staging sends; uncertain sends require review.
- Route explicitly selected project tools and hub memories to the context-local private store, ignoring legacy database and actor overrides.

- Add private, checksummed migration snapshots using SQLite online backups for rehearsal and the final move.

- Add the new Clock preview for live wakes, schedules, household lanes and pause/run/cancel actions; next-mode dispatch remains safely held pending runtime composition.

- Home shows each owned agent's Clock Next and live jobs, including paused and held work.
- Clock exposes scoped next-wake and complete scheduled/waiting/running job reads for the new desk.
- Add next-mode People with policy-scoped directory/relationships, evidence, agent filters and resumable person creation.

- Add explicit Attention project lookup roles for digest aliases, thread filing and unambiguous venue fallback; production wiring remains separate.
- Attention next-mode digests now resolve project aliases and venue filing through visible Projects cards for the conversation’s agent.

- Add next-mode Home with owned cards including idle agents, a central Needs you count/top three and the shared full question reader. Delivery and the remaining desk panels stay pending.
- Name owned Home cards from live shared-directory People entries and open their exact contact pages.
- Attention: public yes/no asks also accept a words answer in Inbox and Home; unsent drafts guard other answers, and private reply words are refused before central storage.
- Show the latest visible report's complete jobs and watched items on Home, with new-app and HTTP(S) source links; absent or unavailable reports never claim there are no jobs.

- Add an opt-in central Inbox preview with agent folders, answer history and daemon-confirmed answer controls. Source-owned decisions open their apps; private replies stay in Comms. Delivery remains pending.

- Add an opt-in Attention API client generated from operation command metadata, with authenticated JSON calls and safe write retries.
- Add next-mode Knowledge on live records: topics, page reader and durable check actions, with source socket lifecycle owned by the daemon.

- Next-mode Approvals uses current household project repositories for standing merge rules, asking safely when metadata cannot be read.
- Add the opt-in `loom-wake-client` API command for the new clock, with daemon-side command metadata, legacy scheduling text and bounded idempotent retries.
- Accept the new clock's UUID wake ids in approval vouch targets, preserving imported compact ids, exact matching and overlapping denials.

- Add an explicit offline Attention importer for copied conversation databases, with audience maps, atomic verification and repeat protection.
- Next mode signs in through database sessions, one-time links and passkeys, with bearer authentication for agents, runners and services.

- On the new clock side, count lane run-now against the one-off budget and wait for model quota reset without consuming job retries.
- Avoid redundant file-lane self-rearms within six hours of an authorized owner schedule on the new clock side.
- Preserve clock parked-work continuation instructions and readable answer notes; distinguish an unanswered wait from an expired Allow.
- Stop retrying a clock continuation after a definite non-quota runtime failure, retaining quota deferrals and uncertain dispatch holds.

- Keep long approval details and exact targets within the phone reader, with wrapping answer buttons.

- Register Approvals in `serve --next` so its app uses the new database and live feed without a fixture installer; runtime and clock action roles remain a separate integration.

- Add `loom migrate household --home <new-home> --from <old-home>`: a verified offline import of household, sign-in and piece settings into the new database, preserving credentials and leaving the old home untouched.
- Add `loom serve --next --staging`: the separate new shell, registered app tiles and phone pane, one address router, and individually released outside work. Existing serve behavior is unchanged.

- Keep agent-created unscoped foundation tasks in their own queue; let the offline tasks importer assign projectless tasks with `--agent`.

- Next-mode local operators can create audited, single-use sign-in links without a bearer token; first start prints an owner link once.

- Add a Tasks app preview at `/p/tasks-preview`, with live folders, task reading and actions through the foundation socket; the current Tasks entry stays unchanged until the import.

- Add an in-repo tasks piece, opt-in `loom-taskstore` API client, and offline verified tasks importer; existing taskstore and Tasks screens stay on their current path until cutover.

- Add the first web foundation slice: an app database, operation registry, central permission rule, live feed and
  in-process fixture harness beside the present page. Caller-owned operation ids replay stored results for 30 days;
  a failed live read closes its subscriber. No existing app data or screens move in this slice.

- A request that meets another process's lock waits for it without freezing the server (t-2130, t-2141): Comms posts
  and pages, live updates, turns, audit entries, deliveries, piece stores, household changes and sign-ins wait in a
  line, asynchronously, until the database (a held write lock, or a WAL recovery) or the lock file is free, then run.
  /login answers in about 100 ms meanwhile, where it waited 2 to 20 s behind the lock. Nothing fails sooner than
  before: a wait past its budget (5 s; 8 s for a Comms post, inside the runtime's 15 s; 2.5 s for a turn, inside its 5 s) goes on to the old synchronous wait, and only a lock still held
  after that is a 503 with retry-after. Replaces the fail-fast change (#776, #783) that refused Comms posts on deploy.
  `scripts/lock-smoke.ts` posts 50 Comms messages under a concurrent writer on a scratch copy of a household.

- Ask a piece's own service for its manifest over a local socket when it has one (`<piece home>/run/ui.sock`, this
  user's alone), instead of starting `ui --json`: the runtime's delivery service answers from memory in under a
  millisecond, where each run was a node start that re-read its state (t-2114). No socket, another version's or a
  failing one: `ui --json` as before.
- Pull a piece's shared records less often while they don't move: the Tasks and Changes pieces have no change log, so
  every pull is a full snapshot (a process per 500 records), and an open Tasks page made one per piece every 15 s
  (t-2110). A piece whose pulls find nothing is pulled at 15, 30, then every 60 s; its word that it wrote, or an action
  on it, pulls it at once and puts it back on 15 s. A burst of its writes is one snapshot per 3 s, not per 1.5 s, and an
  action's pull isn't followed by a second one for its own nudge.
- Run each piece's manifest once for every window that sees the same answer, and less often while it doesn't
  move: the runtime's ran once per open agent window on every round and every word (t-2110). A manifest that runs
  past a page's 3 s wait shows its last good answer instead of dropping off the page, and its late answer is kept
  (t-2064).
- Keep runtime job threads in Comms' Background work until their owner writes in them,
  exclude them from personal unread counts and notifications, and attribute agent job briefs correctly.


### Fixed

- **A device's notifications stopped without anyone turning them off** (t-1978). A subscription was kept under the
  session it was turned on in, and dropped when that session went. Agents' screenshot sign-ins filled the 50-session cap
  every two or three days, each evicting the oldest session, so a person's phone lost its notifications within days
  while it still said On. A subscription is now its person's and the device's: housekeeping (the cap, a session past
  its time, signing out and in again on the device, a plain token revoke) keeps it, and the app sends it again on each
  load. It goes when turned off there, removed on Profile, that device signed out on purpose (Profile's Sign out on its
  row, `loom sessions revoke`), its token revoked as compromised (`loom token revoke --with-devices`, or
  `--with-passkeys`), gone at the push service (404/410), or its person leaves the household. An agent's session can't
  turn notifications on. A push no longer carries the ask's words or a thread's title: only what it is, who it's from,
  and where a tap opens. Profile lists the devices that get notifications, each with **Send a test notification**.
  Agent owners can turn notifications on (`/push/*` was refused for them).
- **Agents' screenshot sign-ins pushed people's own sessions out** (t-1936). `loom token link --agent --label <text>`
  marks the session it opens as an agent's (a headless browser's counts too): listed as `(agent)`, ended six hours
  after it signed in, and first to go at the cap, after sessions already ended. `loom sessions revoke --label <text>`
  ends an agent's own sessions when it's done.

### Added

- Home shows current visible Runtime jobs from their live records, including concurrent work, actual states and boxes, with unavailable states that clear stale titles.
- Home and Inbox automatically reconcile visible approval/task waits as the signed-in member on arrival and every minute, keeping their counts current without a service grant.


- **A passkey signs its person in with a token of its own** (t-1969). Revoking the page sign-in links token (or any
  other) no longer stops the passkeys added from it, as it did Jonathan's on 2026-11-07. The passkey's token is an owner
  token naming its member, labeled `Passkey: <name> · <person> · …`, and says what it was made from. `loom token revoke
  <label> --with-passkeys` (Setup: "Revoke a token with its passkeys") takes the passkeys made from it too; plain revoke
  keeps them. Profile's "Remove a passkey with the ones added from it" does the same for a passkey. A passkey is added
  only within 10 minutes of signing in. Passkeys made before move onto their own token when loom-http starts if their
  token is live; one whose token was revoked stays stopped and is replaced by adding a new one. Agent owners can add
  passkeys (`/passkeys/options` was refused for them).

- **Needs you is the Inbox shrunk** (t-1925). On the desktop, Needs you's **Expand** grows it into the Inbox's tile on
  its Needs you folder, as an agent's card grows into its window (the same code: `tiling/widgets.ts` `pairOf`); an ask in
  it opens in the Inbox with that ask picked. While an Inbox tile is open, Needs you stands aside and the other widgets
  fill its room; the Inbox's **Shrink to widget** folds it back. Reduced motion: instant. Phones are unchanged.

- **A Comms thread says when an agent couldn't start, even after "queued"** (t-1946). The runtime can now tell core
  `status: start-retry` (with its attempt and next try) or `start-failed` on the adapter route, for a start that failed
  after it had already answered `queued`. The thread keeps one line per message, updated as attempts go by ("couldn't
  start (2 tries so far); retrying. Next try at 14:32."), the busy line no longer follows, and a late or repeated
  notice never brings a settled line back.
- **Sign one browser out alone** (t-1871). Profile's **Signed in** lists each browser session you may see (a household
  owner, all of them; an agent owner, their own): what it is (from its User-Agent), its sign-in link's label, how and
  when it signed in, when it was last used, and its token. **Sign out** on a row ends that session and its
  notifications only; other sessions of the same "page sign-in links" token stay. On loom's machine, `loom sessions
  list` and `loom sessions revoke <ref>`; `loom token link --label` names the session a link opens.
- **Asks answered only while open, everywhere** (t-1925). The asks inside a Comms thread and the desktop's Needs you
  now use the Inbox's rule (`web/src/ask-open.ts`): no buttons until loom confirms the ask is open now, checked again
  right before a send, and none when loom can't be reached or the copy came from this device's cache.
- **Comms' band** (Jonathan, 2026-11-07; `docs/specs/comms.md`, "Desktop"). A desktop thread has a band of fixed
  height over the chat: the comm screen at its own 2× size on the left, who's in the conversation and the thread's
  work on the right, scrolling inside the band. The chat takes the rest. The list sits beside the thread only where
  Comms is 1100 px or wider; narrower, it's the drawer from the thread's header. The comm screen never stretches.
- **An agent's window** (t-1925 D; `docs/specs/desk-tiling.md`, "An agent's window"). An agent's pages wear one header:
  its face in a Neon frame (no 000h shapes, no clock element), its name with a working pill, and a plain description
  of what it does (household.json `about`, never its creed) that a household owner edits in place or asks the agent to
  rewrite (the new `describe_self` MCP tool, refused unless asked). Its sections are a sidebar inside its window (an
  icon rail when narrow), so the desktop's dock no longer swaps; its window's corner wears its letter. Its desk card
  and its window are one app: Expand grows the card into the window, Shrink to widget folds it back. Phones keep the
  dock's swap, with the new header.
- **The Inbox is a mail client** (t-1925; `docs/specs/ui-app.md`, "Master/detail"). Folders (Needs you, Questions,
  Approvals, Alerts, Memory reviews, Done, and who it's from), the list, and the open ask beside it whole: why, if yes /
  if no, its buttons, a reply, where it lives and its trail. Answering moves it to Done and opens the next. In a narrow
  tile or on a phone the folders are chips and the ask slides over the list. Its buttons are live only once loom says
  the ask is still open (`GET /inbox/open`), and loom is asked again before any is sent. Old `?f=` folder addresses land
  on the new folders. The master/detail layout (`web/src/split.tsx`) is generic.
- **Comms polish** (t-1918, t-1925 C; `docs/specs/comms.md`). A thread's address has no colon (`/comms/<id>`), so a
  reload works; old `comms/th:…` links redirect. The comm screen's channel line says what the agent is doing
  (THINKING, WORKING, TALKING, WAITING ON YOU, DONE, NO CARRIER, plus ON CODEX), and the separate thinking blob is
  gone. A body that couldn't start says "couldn't start; retrying" with What happened, not "busy". The thread follows
  the bottom only while you're there; scrolled up, a New messages pill counts what's new, and a working line shows the
  step the agent is on. The Enter hint is faint and only on focus; in a narrow tile the threads are a drawer; the list
  wears the agents' letters.
- **The launcher** (t-1925 G; `docs/specs/desk-tiling.md`, "The launcher"). On a desktop the dock's last key, All apps, or
  Ctrl+Shift+Space opens every app in one grid, grouped as Work, People & agents, Library, System, Look & feel and
  Pieces, each tile with its live state. Search is focused at once and filters as you type; Enter opens the first match
  as a tile, Esc closes, the arrow keys move. It replaces Setup's dock key and the account key on the desktop; Setup and
  More are no longer tiles there (an old link opens the launcher), and Appearance, Accessibility, Members and Pieces each
  open in a tile of their own. Phones keep More and Places.
- **Tiling is the only desktop** (t-1884; `docs/specs/desk-tiling.md`, "A fresh desktop", "One window at a time"). At
  1024 px and wider, apps share the screen as tiles for everyone: Appearance's Desktop choice and the old single window
  are gone. A device with no saved layout starts with Needs you, each agent's card, Vitals, Backup and the ticker
  (`web/src/tiling/widgets.ts` `SEED`). One window at a time is now an Accessibility choice inside tiling, off unless
  turned on: one app tile at most, and opening another sends the one there to the dock, said in a toast. Whoever had
  One window at a time saved under Appearance has it on; the old `tiling` field is still taken, so an older app gets
  no error.
  A tile now does what the old window did: its page wears its app's colour, its pages reach Find's Recent, the bar's ⓘ
  is its page's, and the dock lights its key. Comms in a tile under 760 px keeps its comm screen to a strip's height,
  so the messages always have room.
- **Desk tiling: widgets are tiles** (t-1884, phase 4 of `docs/specs/desk-tiling.md`). With Tiling chosen
  (Appearance → Desktop), Home's widgets (Needs you, each agent's card, Vitals, Backup, the ticker) are the desktop
  with no app open, and move to the right edge beside the apps: in columns, a rail, or a strip of keys. Chat on an
  agent's card opens its latest Comms thread beside them; an agent's tile pins its card; the dock's + key and Find add
  widgets; × removes one. The set rides in the address (`w=`). A wide tile has Recent here.
- **Comms: asks inline** (t-1876). A thread shows its agent's pending approvals that were asked from it (the approvals
  piece's `--conversation`, kept beside the agent loom authenticated), with the ask, why, If you allow, If you deny
  and the fine print, and Allow once and Deny right there; while one waits, the comm screen's face is waiting on you.
  An ask naming a thread but from another agent never shows there.

- **Pixel icons** (t-1880). A household can install its own pixel icon set (`loom household icons install <dir>`, kept
  at `icons/<set>/`, served only to someone signed in), and a member can wear it with Appearance's "Pixel icons" (off
  unless turned on; not offered without a set). Each icon keeps its light and shade, recoloured to its key's ramp in
  each look, normal and lit, stronger with Higher contrast, by an SVG filter the page builds once from the look's own
  colours. The dock, the launcher's tiles, an app's tile in its header and in Find, and a window's title strip wear
  them; a 16 px row keeps its line icon, as does an app the set has none for.
- **Comms: a push when your agent replies** (t-1876). A reply in a thread you haven't read, with no app of yours on that
  thread for 2 minutes, pushes to your own devices only: "Art replied" and the thread's title (or "Art replied in a new
  thread"), never the reply's words. A tap opens the thread.

- **Comms, the app** (t-1876). A Comms key in the dock (for a member who owns an agent, with their unread threads),
  the thread list leading to a thread on a phone and the two side by side on a desktop, and each thread's comm screen:
  the agent's pixel portrait at 2x in a Neon OS frame (`NAME · CH nn · LINK OK`, a signal meter, a YOU panel on a
  desktop), its face following the thread (thinking, working, talking, done, waiting, error), a burst of static
  when a reply lands, and talking as a bounded run of 1-4 beats with a breath between. Pixel faces gain `talking`,
  which a manifest without it plays as `done`, then `working`. Activity cards fold to one line per run.
- **Comms: `comms_title`, and threads in their project's hub** (t-1876). A body names its Comms thread with
  `comms_title` (60 characters, one line, never over the owner's own name for it), and a thread's title is its
  conversation's label. A thread filed under a project is its digests' project when they name none, ahead of
  `links.venues`, and the hub's `conversations` section lists it from its first message.
- **Comms, core: talk with your own agents in loom, in threads** (t-1876, docs/specs/comms.md). A new core venue,
  `loom`, which core adapts itself (`adapter: "core"` in `GET /api/loom/venues`). Its threads live in
  `household.db`, and their words in `comms.db`, each age-encrypted to `comms.key`, kept `comms_days` (household.json,
  1-14, default 14) and never in a bundle. The page's `/comms` routes reach only a member's own threads with agents
  they own: anyone else, and a thread that never existed, gets the same 403. There's a live stream per thread
  (`/comms/<thread>/events`, `{seq}` only), and the runtime's `POST /api/loom/comms/adapter` and `/comms/activity`.
  The app comes in a later change.

- **One structure, three looks: Neon Noir, Low Light, Daylight** (t-1875).
  000h is no longer a look of its own: Neon Noir's structure (the phone bar
  and system bar, the dock's keys, cut-corner cards, the desktop at 1024 px
  and wider, Find as a command bar, the sheet's title bar, the power-on) is
  every look's, and a look is only tokens (colours, a few corners, glow,
  type) in `web/src/looks/looks.css`, part of the app's own stylesheet. Low
  Light is dark and calm (000h's soft dark colours, no glow but a face's,
  Figtree titles); Daylight is light (ink on warm paper, the tints deepened).
  A saved `look: '000h'` is worn as Daylight if its light or dark was light,
  else as Low Light; it stays on disk as it was until the person chooses, and
  an app from before may still save it. Appearance's Light/Dark/Auto row is
  gone. Every look meets the contrast floors with and without Higher
  contrast; no exception is named any more.
- **Pixel faces wherever an agent's face shows.** Under 36 px (Inbox rows, the
  desktop's widgets, a window's title, the side panel), an agent with a sprite
  sheet now wears a still pixel avatar: a crop of its rest frame, 24 sheet
  pixels square over the top of what's drawn (or the manifest's own
  `"avatar": {"x", "y", "w", "h"}`), at a whole-pixel scale, never smoothed,
  never moving. Agents without a sheet, and everyone with Pixel faces off, keep
  the drawn face; letter badges stay.
- **Neon on a big screen boots** (t-1868). With the app's arrival, once a
  session and never under reduced motion, a desktop shows a second or two of
  LOOM//OS™ coming up, licensed to the household owner by name, with chatter
  that is what loom has (the link, the agents and how each is, the pieces,
  what needs you) and the one joke: "validating LOOM//OS™ license …
  compliant". Any key or tap skips it; it never takes focus, and a screen
  reader doesn't hear it.
- **Neon on a big screen: apps open in a window** (t-1868). Every page but
  Home opens in one big framed window over the ground: a title strip in the
  app's colour with its key, its name and where it is, cut corners, a ruled
  edge, and Close. Close or Esc goes back to the desktop (not while a sheet,
  a dialog or a field has Esc), the window grows out of its dock key and
  shrinks back into it (View Transitions; never under reduced motion), focus
  lands on the window's title and goes back to the key it came from. The page
  inside reads at up to 72rem and scrolls inside the window; sheets and
  dialogs stay above it. From 1600 px, where you've been lately beside it.
- **Neon on a big screen: Home is a desktop** (t-1868). Under Neon at 1024 px
  and wider, Home is widgets on the ground instead of a scrolling page: what
  needs you (the first four, each answered where it stands: Yes and No for a
  yes/no ask, Allow and Deny under the approval's own words, else its own
  buttons; one asked in words opens its sheet), a card per agent with its face
  big and the one thing it's on, box vitals (the Boxes place's count and open
  alerts, and any place in trouble, from the shell every page has) and the
  nightly backup. One screen's height: a column with more than fits scrolls
  inside itself. The dock moves to the bottom centre (the phone's keys, the
  rail gone), and every other page scrolls in the space between the bars and
  the dock. Home's answer carries the first few waiting items whole
  (`stack`). Its own chunk, fetched only
  at that width under Neon. Phones, 000h and screens under 1024 px are
  unchanged.
- **A phone's Home with many agents is a row each** (t-1869). Up to four
  agents keep their big cards. Past four, a phone's Home lists them one row
  each (face, name, how it is in words, its last line), something wrong
  first, each a tap to that agent's page. Wider screens keep their cards.
- **Neon on a desktop wears the phone's bar** (t-1865). Wider than a phone,
  Neon's top is the phone's bar (the page's name and its ⓘ, the ticker,
  LOOM//OS and the count) in place of the old status line and big header,
  under a thin system bar where a phone's own would be: loom's clock (loom's
  time, from its answers' Date, in loom's time zone) on the left, and on the
  right a signal (live or offline), the agents at work, the boxes (how many,
  dimmed while one has an alert) and the nightly backup (its last good one, or
  what's wrong: a household owner's only), each with its words on hover and as
  its accessible name. Both span the page's column. The shell now carries
  loom's time zone, each piece's open alerts, which agents a piece reports at
  work, and the backup's state. A name with its ⓘ is no longer cut short on a phone
  ("Boxes", not "Bo…"). 000h is unchanged.
- **A long panel pages like a list.** A piece's panel of more than 15 rows
  shows 15 at a time, with numbered pages and its action under them. The
  Secrets page's 61-row store had been one 6,500 px wall; it's now 2,500 px
  and the sections under it can be reached.
- **An Accessibility app, beside Appearance** (t-1867). Its own tile in More
  and in Find, its own page and intro. **Allow zoom** moves there from
  Appearance (a choice already made carries over). **Reduce motion** (Follow
  the phone, On, Off) is one switch for everything that moves: On crossfades
  pages, stills the ticker, skips the opening animation, holds faces on their
  rest frame, fades the dock swap and drops the follow-the-finger swipes, even
  where the phone allows motion; Off runs them all, even where the phone asks
  for less. **Higher contrast** (Follow the phone, On, Off) raises Neon's and
  000h's light and dark tokens to 7:1 for text and 4.5:1 for the quieter texts
  and control edges, unfades hint text, thickens focus rings, puts solid
  ground behind words that sat on see-through surfaces, and turns Neon's glows
  off. Both are the person's, kept by loom on every device, and worn before
  the first paint. Under the hood every `prefers-reduced-motion` and
  `prefers-contrast: more` query, 000h's own included, is rewritten at build
  onto `<html data-motion>` and `<html data-contrast>`, and scripts ask
  `web/src/access.ts`.
- **Neon on a phone: a page's info is behind its name** (t-1863). The line
  under the phone bar is gone; when a page has a line or an intro, its name
  in the bar wears a small ⓘ and opens a sheet with both (with a haptic tick).
  A page without either has a plain name. 000h and wide screens are as they
  were.
- **loom on a phone holds still like an app** (t-1862). No pinch or
  double-tap zoom, no zoom-in when a field takes focus (every field is 16 px
  or more on a touch screen), no long-press menu or link preview on the bars,
  the dock, buttons, links and images, no selecting the app's own chrome (a
  message's or a note's words still select), no grey flash on a tap, and no
  rubber band or pull to refresh past the page's ends. Appearance gains
  **Allow zoom** (off by default) for anyone who needs to zoom to read. The
  browser's bar wears the look as it's worn (000h's light or dark as chosen),
  and the installed app holds portrait.
- **A phone's gestures, page moves and haptics** (t-1855). Swipe sideways to
  move between Home, Inbox, Places and More in the dock's order; swipe up from
  the dock for Find. A page change slides by the dock's order (a push into a
  page, a pop back out), with the bar and the dock left still, and a swipe
  drives the same move under the finger; reduced motion crossfades. The dock's
  keys slide down and up when they swap for an agent's own. Appearance gains
  **Haptics** (on by default): a tick on Android, and on iOS a real tap on a
  dock key or an ask's Yes and No.
- **Neon on a phone: one bar under the phone's own** (t-1849). At a phone's
  width the page's name sits small under the phone's clock, LOOM//OS and the
  needs-you count under its status icons, and between them a ticker (live, the
  agents and what each is up to, each place's tile). The ticker moves only when
  its words don't fit, at 24 px/s, stops while touched or hidden, and stands
  still under reduced motion; the count never moves. The big header stays on
  wider screens and in 000h.
- **Neon's dock, as the mockup**: no tray, a thin magenta rule over the row,
  dark keys with a neon edge and the current one lit, no names under them (a
  key's name shows on hover, keyboard focus, or held a moment).
- **A pixel face's own `scale` and `offset`** in its manifest (worn under
  Neon), so a face that reads bigger than the others is tuned without a
  deploy; Neon's agent card
  keeps a minimum gap between the face and its words.

- **Pixel faces.** An agent can have a pixel face (Jonathan's PixelLab
  portraits for Art): a manifest and its sprite sheets kept with the
  household's marks (`faces/<agent>/`, set with `loom household sprite`),
  drawn at whole pixels (1x, 2x on a card) in its own lazily loaded chunk.
  Each state plays as a beat, then rests, with a random gap per face; several
  weighted animations per state and facing (one picked per beat, a rare one
  never twice running); a glance to the south-east or south-west now and then
  while resting, waiting on you always facing you. Nothing moves off screen,
  in a hidden tab or under reduced motion. Appearance's "Pixel faces" (on by
  default where a face exists) is the person's, on every device. An agent
  without one keeps its drawn face.
- **Neon Noir's status bar, sheets, Find, power-on and sound.** Under Neon a
  status bar heads every page: LOOM//OS, live or offline (in words), how many
  agents and how many things need you, and loom's clock. The Inbox's sheet
  gets a title bar (what it is, who asks, its task) and a lit top edge, and
  Find is a command bar with a prompt and the current row's cyan edge. Under
  Neon the once-a-session arrival becomes a power-on (a line opens into the
  screen and the page flickers on, about a second, cut short by any tap or
  key, never under reduced motion); 000h's arrival is as it was. Appearance has Sound, off unless the person turns it on:
  a WebAudio chime (0.5 KB, loaded only when on) when loom opens and when
  something they did lands (once per outcome); no opening chime when the
  opening animation is skipped, and a browser that won't play sound before a
  tap stays quiet.
- **Neon Noir's faces, type, corners and glow.** An agent's face keeps its
  body and its expression and becomes dark glass rim-lit in its mark's neon
  (six marks re-pointed per look, `--mark-*`), with a soft glow that is the same
  in every state: the expression says the state. Titles are Oxanium, reading
  is Figtree, and numbers, ids and times are IBM Plex Mono (self-hosted Latin
  subsets, fetched only when Neon is worn). The app's hard-coded tile corners
  are tokens, Neon's radii step down, an agent's card has a 45° cut corner lit
  in its colour, and the dock, the launcher and an app's tile are dark keys
  with a neon edge (the current one lit solid). The depth background's lines
  glow. Glow sits on edges and what's current only, never on a state or a
  status, and goes under `prefers-contrast: more` (checked in a test).
- **Neon Noir, the page's new look, and the default.** Appearance has a
  Look: Neon Noir (dark only: a night-city control room, light from edges and
  states) or 000h (light or dark, as before). Neon is what a person who hasn't
  chosen sees, so everyone's page changes on update; 000h is one tap away and
  draws exactly as it did (until the same week's one structure, above). Its stylesheet is its own file, put on before first
  paint by a 0.5 KB script in the page's head (loom's CSP allows no inline
  script), so a page never flashes the other look. A person's Appearance (the
  look, light or dark, the background) is theirs on every device: kept by loom
  per member like the Inbox's read state (`ui-sessions.json`, a preference,
  never what they browsed), saved from any device (`POST /appearance/prefs`),
  and carried on every page's chrome; a device keeps a copy only for its first
  paint. Every look's colours are measured in a test (text 4.5:1 on every
  surface, control edges 3:1, ink on the tints 4.5:1; one exception is named
  there: 000h's count badge, 3.91:1, left as it was so 000h doesn't change), and the page's last hard-coded colours
  (status dots, warning rings, counts, the unread dot, how far the dark dims the
  ground) are tokens a look re-points.
- **The nightly backup is loom's own.** `loom backup set --target git:<url>|path:<dir>
  --recipient age1…` (docs/specs/keeping-watch.md): each night at `--at`, one of
  the listeners exports the household, drills a restore of it with the
  machine's own drill key, and writes it to the target (a git repo as one
  force-pushed commit, or a directory). The default agent's Setup has a Backup
  row; a failed or missed run is an Inbox alert for household owners, and
  `LOOM_ALERT_COMMAND` hears it. `loom backup run`, `status`, `off`.

- **Two cards that turn out to be one person become one.** `person_merge`
  (an agent of the household that holds both), `loom person merge <from>
  <into> [--dry-run]` (the owner) and `POST /api/loom/people/merge` (a
  household owner, the runtime) fold `from` into `into`: `where` is the union
  of both cards' values, `how` and `may` the union with `into` winning, `into`'s
  name and summary kept with a "Merged <from> (<name>) <date>" line, in the
  directory and every agent's copy. Every memory, proposal, conversation and
  turn tagged `from` is re-tagged, and `how.via`/`how.loop_in` relinked. `from`
  is left an archived redirect (`person_merges`): reading it answers `into`'s
  card with a note, and a later write, verify, ensure or reach lands on `into`.
  A dry run says what would change; the answer's `not_done` says to rename the
  slug in every agent's gates.

- **A person is one card, however they were added.** `POST
  /api/loom/people/ensure` and `loom person ensure` make sure someone has a
  person card: with none, a minimal one (the name, `<role>. From <source>.`,
  the `where` values); with one, only the `where` values it lacks, as `reach`
  adds an id. Name, summary, how and may are never changed, and a value
  already on another card is refused (409). A household owner, the runtime,
  and a piece's process in an owner's action (the grant loom minted for it,
  checked as `loom store` checks it) may call it; agents keep `person_write`,
  and `person ensure` never runs over `POST /cli`. `--dry-run` writes nothing.

- **Old piece names.** `box` is now `runtime`: the catalog lists loom-box's
  repo as `runtime` (37cc43d), and core's alias table (`PIECE_ALIASES`)
  maps `box` to `runtime` for `/api/box/…`, `/p/box/…` (a 308), `piece:box/…`
  credentials, a house's `loom box …` and the starters, while no `box` piece
  is installed. `loom pieces update box` says how to switch instead of
  failing.

- **Turn keys.** `POST /api/loom/conversations/turn` takes an optional `key`
  (the runtime's `<source>:<id>`, runtime role only): a repeat within 24
  hours answers the first `{conversation, seq}` and writes nothing, and the
  same key on a different turn is a 409. Kept in `household.db` (`turn_keys`).

- **Delivery, core's half.** `POST /api/loom/deliver`: the one core route every
  piece token reaches (and the runtime's token). Core checks the body and who
  may deliver what (the venue is the caller's, the agent the household's and
  granted, a person only from a venue adapter, an agent only from the
  runtime), each refused with a 403 that writes nothing; then forwards it to
  the one piece offering the new `delivery` offer key (a runtime-role piece
  only, one per household) under 120 s and 64 KB, and passes its answer
  back (a runtime's own `{status: 5xx, error}` passes through). Idempotent on
  (calling piece, id) for 24 hours, kept in `household.db`; a failed forward
  isn't kept. `GET /api/loom/venues` gives the runtime every venue with its
  `send` argv. Offer lookups by name use own keys only. A piece delivers on
  core's `wake` only if it declares `"wake": {}` in its venues. Replays are
  keyed on (calling piece, id) with a hash of the body (a changed body is a
  409), and one piece gets at most 2 running and 4 waiting forwards and
  10,000 kept answers a day (t-1744).
- **The audit log and review's records** (docs/specs/conversations.md, slices 2-3).
  `$LOOM_HOME/audit.db` holds raw turn text, age-encrypted to a review key made
  at first use (`review.key`/`review.pub`, 0600), written by the turn's writer
  (`POST /api/loom/audit`) and deleted on `audit/done` or 7 days after its
  turn (an hourly sweep, also at start). A review token takes entries
  (`audit/take`), redacted (people P…, agents A…, models M…, harnesses H…),
  posts `scores` by ref and at most one `findings` line per conversation per
  UTC day. Core aggregates `scorecards` (graded, plus the metadata measures),
  which the runtime reads with `GET /api/loom/scorecards`. household.json gains
  `families` (model → family). Bundles and exports never carry the audit log
  or its key.

- **Offers.** A managed piece's `loom` block may declare what it offers through
  core: `sections` (a project section feed), `venues`, `mcp_tools` and
  `grants`. Each is checked at install (a bad one rejects the whole block; a
  venue or tool name another piece has, or a second grants authority, is
  refused), kept in piece.json, listed by `src/offers-registry.ts`, and run
  through the manifest's runner: 3 s, process group killed, 6 at once, the
  answer checked against a schema (t-1738).

- **Local pieces.** `loom pieces install --from path:/abs/dir` manages a piece
  that will never be public (an agent's homelab wrappers) like any other: a
  snapshot of the directory (`npm pack`), versioned by its sha256, so
  `update` notices a change and `rollback` and `remove` work. `loom pieces`
  lists it as `managed <version> (local)` (t-1728).
- **`harness_patch`: a safe small edit to a harness manifest.** A harness
  manifest is normally read back through `identity()`, which bundles it into
  a combined payload capped by the transport — past that cap a read silently
  truncates mid-sentence, so a `harness_describe` overwrite built from that
  truncated read risks dropping everything past the cut. `harness_patch`
  applies an exact find/replace against the server's own on-disk copy
  instead, so the caller only ever has to hold the text of the edit itself,
  never the full manifest (t-1674).

- **A door for strangers, where a piece opens one.** A tokenless call reaches a
  managed piece's API only on a path its `loom` block lists in `strangers`, as
  `{kind:'stranger', address}`, 8 KB at most: so a new box can ask to join and
  the owner lets it in on the page, with nobody handling a credential (t-1617).

- **House tokens name their house.** Role `agent:<a>[/<service>][@<house>]`
  (`loom token create --agent art --house h-104`), and a piece's API sees
  `"house"` in the caller, so a piece can grant one house something: the
  secrets piece's requests.

- **A bundle brings the household back whole.** `household.json` travels whole
  (its own settings, like the relay pairs, came back stripped), and so do the
  managed pieces: which ones, at which commit, with the owner's settings.
  `loom restore` installs them (from this loom's catalog, at its commits: a
  bundle isn't signed, so it names pieces and never brings code) before it
  hands each piece its part, so a fresh
  machine gets working pieces, not parts left in `pieces-pending/`
  (`--no-install` skips it).

- **Service tokens.** `loom token create --agent art --service slack` mints
  role `agent:art/slack`: a service house's token. It's the agent in every
  way, and a piece's API sees `{"kind":"agent","agent":"art","service":"slack"}`,
  so a piece can tell the agent's bridge from its other bodies (t-1591,
  shuttle's `relay-take`).

- **`knowledge_list`** and **`person_evidence`** MCP tools: the CLI's
  `knowledge list` and `person evidence`, so an agent in a house has them as
  tools (t-1598). `knowledge_list` is on the full server only, not the
  commons-only peer scope.

- **`relay`** MCP tool, for a household served over HTTP: ask another agent
  something. It runs the clock piece's `wake relay` as the session's own
  agent, so it wakes a body of theirs in their house, and their answer comes
  back as a wake of yours (t-1597). Only between agents `household.json`'s
  `relay` list pairs.

- **`memory_recompute_salience`** MCP tool, and `loom memory recompute-salience`
  now runs over the remote CLI. A consolidation lane in a house (Mark's
  continuity, 2026-10-27) was refused it: "has no MCP tool, so it doesn't run
  remotely" (t-1544). `recall-stats` stays local.

### Changed

- **A Comms thread opens without an age process per message** (t-1926). Reading a thread decrypts its words in
  loom's own process with the age library (`age-encryption`, BSD-3-Clause), not one `age` process per message, so
  GET /comms/<thread> for 40 messages drops from over a second to well under 300 ms. The `age` program stays the
  fallback for a message the library can't read, and is logged without its words. Nothing decrypted is cached.
  `scripts/nav-bench.ts --server-only` times it, and fails at a median of 300 ms or more (`docs/specs/comms.md`,
  "The rules for the kept words").

- **Desktop right-click** (t-1925 E; `docs/specs/desk-tiling.md`, "Context menus"). Adding a widget moves from the
  dock's + key (gone) to a right-click on the desktop, or the Menu key or Shift+F10. Short menus on a tile's strip
  (Minimize, Make it the big one, Pin its card on an agent's, Close), an agent's card (Chat, Open, Unpin), a dock key (Open, Minimize, Close) and
  an Inbox row (Open, Mark done). Keyboard-operable, Esc and Tab close, focus never trapped.

- **Desktop tiles: strip, room, loader, moves** (t-1925 B; `docs/specs/desk-tiling.md`, "The frame", "Transitions"). A tile's strip never says its
  app's name twice ("COMMS › COMMS" is "COMMS", the way up to the app's start). The only app tile on the desktop, with no
  side of its own, has no Recent here: its page takes the room. One loader replaces every spinner: four neon segments
  lit in turn, 16, 24 or 40 px, never sized by the text around it. Opening, closing, minimizing, making a tile the
  big one and bringing it back from the dock each have their own short effect (a CRT's power-on and -off, a scanline
  wipe, a glitch); reduced motion has none.

- **The desktop's bar is one line** (t-1925 A; `docs/specs/desk-tiling.md`, "The bar"). At 1024 px and wider: loom's
  clock and the page's name on the left, LOOM//OS and the status glyphs on the right, the ticker scrolling between, 34
  px tall, where there were two bars. The ticker widget is gone (the bar has the same feed): a layout or an address
  that has it loads without it, and the device's copy is written again without it. The desktop draws no headline
  ("Everyone's fine"): just widgets and tiles. Phones and screens under 1024 px keep their bars.

- **Desktop Home: the three columns line up, and no Moving strip** (t-1884). How everyone is ("Everyone's fine")
  reads across the top, above all three columns, so Needs you, the first agent card and Vitals share a top edge; it
  used to sit in the middle column and push the agents down. The Moving strip under the agent cards is gone: each
  card already says what its agent is on.

- **Catalog: shuttle at bb5e92b.** A relay's words are quoted under a one-line
  header that says it carries none of the person's authority.
- **Catalog: shuttle at df79324.** Relay: a body asks the body that owns
  another conversation to say something (`piece-call shuttle relay --via slack
  --person <slug> --say …`), through loom's piece API; the Slack bridge hands
  it to that person's DM.
- **Catalog: tasks at da669f3.** The owner's comment from the page hands the
  task back to the agents and runs a command (a wake), set by
  TASKSTORE_ON_OWNER_COMMENT; the owner's comments carry their initial.
- **loom's mark on the page is the v7 icon,** not the four squares: the
  32px export beside "loom" in the rail and the phone header, the 192px one
  on the sign-in page.
- **The boards' "+".** A page may name where adding one goes (`add`: a page
  and a label), and loom draws it as a "+" beside the title. People adds a
  person (name, who they are, where to reach them) and Knowledge adds a fact
  (title, topic, what it says, where it came from: a link, or empty to keep it
  provisional), both as the owner, and an add never overwrites one that's
  there. Catalog: tasks at 44da8ae, whose Tasks page adds a task.
- **Catalog: shuttle at 05c4033.** An expired login's card on Home carries
  Renew login (the ask's own action).
- **An ask may carry its own buttons** (`actions`, up to two `buttons` items),
  drawn on its Home card in place of the link, as the board's Ratify and
  Reject. When one memory waits on an agent, Home's card quotes it and ratifies
  or rejects it right there.
- **Thread rows on a wide screen put where and when at the right edge** (the
  row's link, not its text, takes the room).
- **Catalog: shuttle at 21c35b6.** The Subscriptions tile on Home is the
  fullest usage window ("48%, Jonathan's Claude · 7 days, resets Mon").
- **Desktop per the Desktop board.** The rail stays put while the page scrolls,
  so its foot (owner, Passkeys, Sign out) is always there. Thread rows are one
  line on a wide screen, where and when at the right. Home's head carries a
  live dot. A long tile value is set smaller and a tile's detail is two lines
  at most. An agent's Today: its glance tiles two up in the side column, and
  its Thread says where in words.
- **Catalog: box at 4ab3b64.** Boxes per its board: the box card first (how long
  it's been up, its disk, its houses, the machine's facts folded), services
  with Restart at the row, sessions with Up/Down at the row.
- **Scope sheet and Manage pieces per their boards.** Each agent on the Scope
  sheet says how long since it was last active ("active 42m ago"), beside
  what waits on it. On Manage pieces the catalog is a row a piece with Install
  at its right, and pieces loom didn't install get their own "Managed by
  hand" section.
- **A page's title slides into the phone's header** once it scrolls under it,
  as iOS's large titles do (where the header has a way back; Home keeps its
  wordmark). A named back link gives up its word to make room.
- **Catalog: secrets at f6f1ee2.** Secrets per its board: what's stored
  first, each name a row to its own page (`secret?name=…`: names may have
  capitals, page paths may not), then Add a secret.
- **Catalog: secrets at 75e6cb4.** Secrets per its board: what's stored
  first, each name a row to its own page (Replace, and a Remove that asks
  first), then Add a secret.
- **Header touches from the boards.** A piece's page says "updated just now"
  under its title, and the script counts it up ("updated 40s ago", "offline ·
  updated 3m ago"). Search fields carry a magnifier. Places tiles are filled.
- **Mind, a memory, a person and a knowledge entry per their boards.** Mind
  leads with Your call (each drafted memory quoted, with Ratify and Reject),
  then Top of mind as a ranked list and "All N memories"; the filters and the
  heat detail are on that page. A memory shows its facts card first (with
  "Top of mind #N" when it's there), then what it says, History and Forget. A
  person's rows give each agent's summary in a line or two. A knowledge entry
  says when it was verified under its title, and Still true comes after its
  sources.
- **A list may be numbered** (`numbered: true`): a rank before each row.
- **Sign in, Passkeys and New agent per their boards.** Sign in: loom's mark
  in the middle, and at the bottom a passkey button, "or", a token and Go.
  Passkeys: each a row with an inline Remove, then Add a passkey, then Another
  device (a one-time sign-in link, what `loom token link` makes). New agent:
  name, a color (swatches from the mark palette), what it's for, a voice word
  (Dry, Warm, Terse); the short name comes from its name.
- **A choice field's options may be colors** (`swatch`, a hex): drawn as a
  row of swatches.

### Fixed

- **The desktop's boot tests failed whenever the machine was busy** (t-1949): 732 ms against a 600 ms limit on CI, 3491
  against 3200 locally, and with the merge queue each failure ejected a PR. They now hold the page's own clock
  (Playwright's) and move it on by hand, so they check what the boot does, and in what order, with no time limits left:
  it stands until 2.2 s on its clock, leaves then, is gone after its 0.25 s fade, and a key or tap ends it with no time
  passing at all. A fresh session is now cleared from a page that isn't the app, so an arrival still running can't mark
  it again. `expect.poll` waits up to 10 s (vitest's default gave up after 1 s, a limit no test meant to set).
- **`loom token link --help` minted a live sign-in link** (t-1950). `token`, `sessions` and `household` found
  their flags by looking for the ones they knew, so `--help` was ignored and `link` went ahead and printed a working
  link. They, and `backup`, `export`, `restore`, `store` and `pieces`, now parse every flag first (`src/cli/args.ts`,
  `parseVerb`): `-h`/`--help` prints usage and exits 0, and a flag the verb doesn't know is refused with 2, before
  anything is minted, revoked, written or installed. `harness init` checks `--help` before stamping a fresh context
  dir, and `knowledge`/`memory` honour `--help` anywhere after the verb. `src/cli/help-no-side-effects.test.ts` runs
  every verb that changes something with `--help` and with an unknown flag, and checks the household's files are
  unchanged.
- **A window's page ran over its frame** (t-1925; Jonathan, 2026-11-06). A tile's ring was a shadow under its page, and
  the page reached the tile's edge, so a page with a background (Activity's feed) covered the bottom edge, and every
  page sat a pixel over the sides. The ring is drawn over the page and its sheets now (the cut corner's diagonal too),
  and the page sits inside it; `src/ui/desk-window-overflow.integration.test.ts` holds every app to it.
- **The desktop's bar** (Jonathan, 2026-11-06): a quiet dot between the clock and the page's name, and between LOOM//OS
  and the status glyphs; the ticker's words stand in the middle of the room between them when they fit.
- **A reply's signal on the comm screen played for less than its 250 ms** (t-1925). The 250 ms counted from when the
  static was asked for, not from when it showed, so a busy render ate into it: 190-240 ms on a loaded machine, as
  little as 33 ms on CI, where the Comms test failed on main and on loom#589. They count from the screen now.
  Two backup tick tests no longer fail when run in a ten-minute window each day (02:45-02:55 or 20:45-20:55 in
  Chicago): they pin when the backup was set instead of taking it from the wall clock.
- **A restore could write into the live machine's piece stores** (t-1846). The backup drill (loom#488) restored
  into a throwaway home and handed taskstore its part with the caller's environment, which named the live store;
  it didn't write there only by luck. A restore now hands a part only to a piece it installed into the home it
  restores to, with that piece's settings from the restored household or its defaults, never the caller's
  environment, and refuses a piece whose setting names a path outside that home (its part waits in
  `pieces-pending/`, its services don't start). `loom restore --allow-outside`, for the owner's own restore onto a
  new machine, lets one name a path that isn't there yet; one that is, a live store, is refused even then. A piece found on PATH keeps its part pending too.
  And a restore starts services only into this machine's own household: a piece's units are named for it in the
  caller's systemd dir, so a restore into a throwaway `--to` would have repointed the live household's units.
- **Adding an agent kept only `agents`, `default` and `owner`** in
  household.json, dropping `marks` and anything else. It now keeps them.
- **An agent's Setup per its board.** Health first (Memory, Last active, Tokens
  as status rows), then Identity (Voice, Born, Harnesses, the bio, and the
  whole creed folded), then Tokens: each live one a row with an inline Revoke
  that asks first, the revoked folded, Create token folded.
- **A list row may carry one action** (`act`, a `buttons` item), drawn at its
  right as a text button: Revoke on a token, Remove on a passkey.
- **Thread: no "?" pill.** A row with no where is under All only, and its
  meta is just its age.
- **Catalog: tasks at be57bea.** Its asks carry when they were started (else
  filed), so Home's task cards show their age.
- **Home per its board: Your call and Thread.** Ask cards lead with a bold
  title (up to three lines), and past four the rest fold under "N more", so
  Home stays a glance. Thread rows say where in words ("Slack DM · Patrick
  Kells", "Discord #pond", "Wake", not `slack:dm:patrick-kells`). Its pills
  are each agent when there's more than one, then each place things happened.
  The tape and the household pages say where the same way.
- **Catalog: shuttle at 3893774.** Bridges and Subscriptions per their
  boards: a status row a bridge, Talking now, conversations with initials;
  usage meters, logins with how long each is good for and Renew when one
  runs out, accounts as cards with their credentials under Machine details.
  Also carries shuttle#4: a body that never shows is retried or held and
  paged, never dropped.
- **One stat alone is a hero.** A `stats` block with a single item renders
  full width at the boards' top size (the Clock's "Art wakes next 9:30"), with
  its detail line under it. Two or more are the grid, as before.
- **Catalog: box at 7fbba5d.** Boxes per its board, with Sessions first: each
  agent's box session and house session, their claude.ai links (talk to them
  from the Claude app) and one-tap up/down; a card per box with its houses;
  services with Restart. The agent form keeps tailnet grants.

- **Catalog: tasks at 0be3242.** The Tasks piece per its boards: Open · Blocked ·
  Done counts and pills, the owner's tasks first ("waiting on you"), agent
  marks, the description as prose, Mark done (with Undo) and a Reply box.
  Three stats sit in one row on a phone.

- **A table on a phone is compact rows, like the boards.** Column 1 is the
  title, a short column 2 sits on the right, the next two make one "label
  value · label value" line, and the rest is under "more" — instead of a grey
  card of label/value pairs per row. Every piece's tables (Clock's schedules,
  Boxes' services, Subscriptions' logins, Bridges' conversations) get it.
  A long stat value wraps at a smaller size instead of being cut off.

- **The scope moves to a pinned header.** On a phone the top bar now stays at
  the top of every page: the wordmark (or the way back) on the left, and on
  the right a pill with who you're looking at (Household, or an agent), which
  opens the scope sheet. The bottom bar is Home · Places · Find · Setup.

- **A person's page, per the Person board.** Under their name, their summary
  (or role); then how each agent knows them, one row per agent with its mark
  (every agent, "Hasn't met them" included); then Reach, a value per channel,
  with where each came from a tap away. Household pages now hand their agents
  to the renderer, so marks show wherever a row names one.

- **A memory's page, per the Memory board.** Under the memory: where it was
  learned, when it was first written, how often it's been recalled, and who
  it's about. Then its history, newest first: what it says now and each
  earlier body back to the first, as a timeline. The raw record moves behind
  "Machine details".

- **Knowledge pages and memories read as written.** A new `prose` block
  renders markdown (markdown-it, raw HTML off: HTML in a body is shown as
  text, never run; links only to `http(s)`; no images). A knowledge page's body is one prose
  block, not 1900-character slices.

- **Closer to the design, page by page.** A page below the top says where its
  back link goes ("‹ Knowledge", "‹ Mind"); an agent's own tabs carry the way
  around instead. Knowledge has a search field (a new optional `search` on the
  `filters` block, `?q=`), a "Needs a check · N" pill, and rows that say how
  fresh they are ("verified today", "unchecked for 41 days" in the warn tone).
  A knowledge page's body breaks between paragraphs, never mid-word. The
  Pieces page lists hand-installed pieces as one quiet list and counts what's
  installed. Places ends in Knowledge and People side by side and a Manage
  pieces link; the scope sheet counts what waits on each agent. A list row's
  meta is in the body font (mono is for machine text).

### Fixed

- **Catalog: box at c0a3751.** A tailnet grant must name a `tailscaled.sock`, with
  no `.` or `..` in its path.
- **Catalog: box at cce6357.** A house can use a box's tailnet when the owner
  grants it (`loom box agent … --tailnet fleet=/run/…/tailscaled.sock`).
- **Catalog: box at a3c7341.** Every house now runs with `--init`, so orphaned
  processes are reaped. Without it the bridges' houses filled their 2048-pid
  limit with zombie `git` and could no longer start a reply (2026-10-26).

### Added

- **"Still true" on a knowledge page.** One tap verifies it (knowledge_verify,
  outcome confirmed, as the owner): the verified date moves, which is the
  clock the nightly freshness pass reads.
- **Initials on the People list.** A list item may carry `avatar` (one or two
  letters), drawn in a plain circle; the household's People list gives each
  person theirs.

- **Setup, apart from Places.** A piece's tab can say `"kind": "setting"`
  (rarely visited: adding a box, a subscription, a secret); it goes under a
  new Setup tab in the bottom bar (a sheet, with Manage pieces and Passkeys)
  and a Setup group in the desktop rail. Places keeps the everyday ones beside
  Knowledge and People. Pieces that don't say get the catalog's default
  (`kinds` in assets/pieces.json: box, secrets, subscriptions).

- **Push for Your call.** Turn it on per device on the Passkeys page (https;
  on an iPhone, loom added to the Home Screen first). Each minute one of
  loom's listeners checks Your call and announces what's new, once; a tap
  opens Home at that ask. Subscriptions live with their session and go when
  it does; loom only sends to https endpoints on known push services, and the
  payload is encrypted to the browser. New dependency: web-push.

- **Undo on a message.** An action result may carry `"undo": {"action",
  "label"?, "fields"?}`: the message gets an Undo that posts that action back
  to the same piece, with the same anti-forgery token (it's an ordinary form,
  so it works without script too). loom's own: archiving a memory is undone by
  a new `restore` action.

- **Details open as a sheet on a phone.** Tapping a details row brings its
  blocks up in a bottom sheet (moved there, not copied, and back on close);
  an action taken in it closes the sheet. A desktop expands it in place.

- **First run and empty pages say something.** A household with no pieces
  yet says who's listening ("Art E Fish and Mark are here and listening. Add
  pieces to give them hands.") and offers two catalog pieces to install
  right there. A page with nothing on it says whose it is: "Tasks has nothing
  yet.", under its intro.

- **Find is a palette.** ⌘K (or the Find tab, or "Find anything") opens it
  over the page; results follow the typing, grouped **Do** (asks that
  match), **Go to** (places, knowledge pages, people) and **Memories** (the
  scope's agents), the match in bold. Arrows walk them, Enter takes the first.
  `/find?q=` is the same, as a page.

- **An agent's Mind, People and Setup wear its head.** Its mark and name and
  the Today · Mind · People · Setup tabs, the current one marked, in place of
  the page title (the tabs cap their width on a desktop).

- **loom's page installs as an app.** A manifest, icons and a service worker
  (on https, or localhost). Each page loom shows is kept; when loom can't be
  reached the last copy opens under "Offline · from 7:42 AM — what you see
  is 2 hours old", statuses go hollow, and actions read "needs connection"
  until it's back. A live page that loses the network says the same. A page
  that was never opened here says so, and never shows another page in its
  place. Nothing is kept from the sign-in pages or a page carrying a
  one-time message (a token), and signing out — or the session ending —
  drops every copy (`Clear-Site-Data` too).

- **The page acts in place.** With script, a form or button posts with
  `fetch` and the answer is a toast above the bottom bar (labeled with its
  piece; `"keep": true` on an action result holds it, for a token shown
  once), the page refreshing under it without moving. A `danger` button asks
  first in a sheet that names it and says what happens (a new optional
  `confirm` sentence on a button). Live pages re-fetch themselves every 20s
  instead of reloading: new asks go in at once, new Thread rows wait behind
  an "↑ N new" pill, and the footer says "live · checked 4s ago". A live
  check doesn't count as a new look. Without script, it's the old full-page
  post and meta refresh.

- **Home, redesigned.** The household Home leads with "N need you" and the
  count new since you last looked (a look within 15 minutes of the last one
  doesn't move the line). Your call cards, At a glance tiles (a swipeable
  strip on a phone, a 2-up grid beside the Thread on a desktop), the Thread
  of the last day with agent marks, an All/agent filter and a "seen up to"
  divider, and Shared (knowledge and people). An agent's `/a/<agent>` is now
  its Today: its mark, Today · Mind · People · Setup tabs, its own asks,
  tiles and thread.

- **Scope reaches pieces.** With an agent selected, loom runs pieces with
  `LOOM_SCOPE=<agent>` (manifest, page and action alike, the manifest cached
  per scope). A manifest may declare `"scope": true`; a piece that doesn't is
  shown under one line: "Showing the whole household — this piece can't
  narrow to <agent>."
- **Agent marks on rows:** a list item may name an `agent`; it carries that
  agent's mark in place of its tone glyph.
- **Asks may carry `tone`, `at` and `agent`** (for the redesigned Your call
  cards).

### Changed

- **The app shell** (the redesign's phase 2a). On a phone: a bottom bar, the
  scope chip, Home, Places and Find, with the active tab a pill. On a wide
  screen: a left rail, with the wordmark, the scope selector, Find (⌘K), Home
  with its count of asks, Knowledge, People, the Pieces group with a tone
  glyph beside any piece in trouble, Manage pieces, and the owner, Passkeys and
  Sign out at its foot.
- **Scope:** a sheet (`/scope`) lists Household and each agent with its mark,
  plus New agent. Choosing one sets it (a cookie) and goes to its home; Home
  follows the scope. **Places** (`/places`): every piece's tab with its tile
  value or tone, then Knowledge, People and Manage pieces. **Find** (`/find`):
  go to any place by name. Sheets open in place with script and work as pages
  without it.
- **Agent marks:** an initial on a color that differs in lightness, from a
  palette in order, or from `marks` in household.json. The household's mark is
  a woven 2x2 of ink and the agents' colors. Account controls moved out of the
  page header into the scope sheet and the rail's foot.

### Changed

- **The page's new look, phase 1** (Claude Design's handoff, 2026-10-26):
  Instrument Sans and JetBrains Mono, served by loom itself (OFL, `/fonts/`;
  CSP `font-src 'self'`), the warm ground and lime "thread" accent, light and
  dark. Tone is a shape and a word as well as a color (● ▲ ◆ ○, named for
  screen readers). Every block re-rendered to the design: a toned section tints
  only its header band; stats as tiles; rows, not cards; tables stack into
  cards on a phone; long kv values drop below their label; long text clamps
  with More; external links show their domain; choices of four or fewer are a
  segmented control; buttons lime / raised / danger-outlined; meters, code and
  status as drawn. Home leads with Your call, before the tiles, at every width.

### Added

- **Three blocks: `meter`, `code`, `status`** (docs/extensions.md). A usage
  bar with its percent; monospace text with a Copy button; a row per thing
  that's up, down or stale, with a colored dot.
- **A page's own `refresh`** (2 to 300 seconds), honored even with a form on
  the page. The Pieces page uses it while an install runs, so it shows the
  install finish without a manual reload.
- **loom's own script on every page** (`/app.js`, CSP `script-src 'self'`,
  never inline). Today it's the Copy button; it's where the page's app
  behavior goes. Pieces still can't put script on the page: theirs is data.

### Changed

- **The header on a phone:** the brand with Passkeys and Sign out on one row,
  the tabs in one scrolling row under them, and no clock.

### Added

- **Passkeys for loom's page** (docs/specs/passkeys.md). Sign in once with a
  token or a link, add a passkey on the new Passkeys page, and after that
  *Sign in with a passkey* is one tap and Face ID, a fingerprint or a PIN.
  Discoverable credentials with user verification, ES256/EdDSA/RS256,
  verified with node:crypto (no new dependencies). A passkey signs in as the
  token whose session added it, only while that token is live; its counter
  must go up; it can be removed from the page. Passkeys work at
  `LOOM_PUBLIC_URL` (https, or http://localhost). Only the sign-in and
  Passkeys pages allow a script, loom's own `/login/passkey.js`.

### Fixed

- The page's integration tests no longer see the host's own managed pieces
  (they run under their own `LOOM_HOME` and `XDG_CONFIG_HOME`).

### Changed

- **The catalog's shuttle is d8f5a8a** (shuttle#2, #3): its subscriptions broker
  names its client on every call, and its check fails when a refresh does. Cloudflare blocks Python's default
  User-Agent, so before this, a Claude session login was never refreshed.

### Fixed

- **A managed piece runs on the node it was installed with.** npm builds a
  piece's native modules (taskstore's better-sqlite3) for the node it runs on;
  the daemon's `PATH` may find another (`/usr/bin/node` 20 beside mise's 24).
  `piece.json` records that node, and loom puts its directory first on the
  piece's `PATH`, for its services too.

### Added

- **The pieces catalog has box, secrets, shuttle and tasks**, each pinned to its
  merged commit, so a fresh loom installs all three from the Pieces page.
- **A package with several `loom-<name>` bins** (shuttle's `loom-shuttle` and
  `loom-subscriptions`) names its piece with `loom.name`; the other bins are
  part of it and run with its environment.

### Added

- **Managed pieces: `loom pieces install | update | rollback | remove | set | catalog`**
  (docs/specs/pieces-install.md). loom installs a piece itself, from its
  catalog (`assets/pieces.json`, each pinned to a commit) or with
  `--from github:<owner>/<repo>#<commit> --yes`, as an npm package into
  `$LOOM_HOME/pieces/<name>/`. Managed pieces are found before `PATH`, run with
  their own `LOOM_PIECE_NAME`, `LOOM_PIECE_HOME` and declared settings, keep the
  version before for `rollback`, and leave what was current untouched when an
  install fails. Unmanaged pieces on `PATH` work as before.
- **The Pieces page** (`/pieces`, in the nav): installed pieces with their
  settings form, *Update*, *Roll back* and *Remove*; the catalog with
  *Install*; and *From GitHub*, a repo and a commit behind a preview and a
  plain warning. Installs run in the background. A managed piece missing a
  required setting is listed under "Your call" on Home.
- **Piece services.** A service a managed piece declares becomes a systemd
  user unit, `loom-piece-<name>-<service>.service`, run with the piece's own
  environment (`service.env`), restarted on failure, and on an update, a
  rollback or new settings, and removed with the piece. `keepChildren: true`
  is `KillMode=process`. Without a user systemd, install says how to start it
  by hand.

- Add an owner-only next-mode operation to change scoped member agent ownership, refreshing open windows immediately.

- Add the owner-only `household.setMemberProjects` operation to replace one member's project assignments atomically and refresh open windows.

- Add owner-only next-mode registration of existing agent contexts with atomic retries and live household updates.

- Add next-mode household member management with atomic first-owner credential bindings and immediate access refresh.

- Add the opt-in generated `loom-household` API client for next-mode member, agent and project administration.

- Add owner-only next-mode `household.show` and generated `loom-household show` JSON summary.

### Settings

- Add the new Settings app for secrets, pending requests, grants and household piece configuration links.

- New-side household token/session administration and generated `loom-token`/`loom-sessions` clients: safe lists, one-time minting, scoped session revocation and atomic passkey/device compromise cascades.
- Give the next desk app-tinted cut frames, the icon dock, a searchable launcher and a live owned-agent rail.

- Household Setup now manages tokens and sessions, with single-send browser token creation and private one-time bearer display.

- Record token and session last use on the new side, including activity in open windows.

- Add owner-controlled agent creation in next Setup, with portable creed/rules, recoverable context publication, first-token selection and an explicit next-mode harness snippet.

- Fresh next-mode households publish a complete default assistant context before first sign-in, with exclusive filesystem recovery on failed initialization.

- Add a private Your account app for named passkey registration, confirmed passkey/cascade removal and signing out individual browsers, with Live records and a generated `loom-account` client.

- Add row-backed agent profile descriptions to Setup, with owner edits/requests, scoped Live records and once-only authenticated agent replies.

- Add Account and Setup device sign-in links that inherit the source browser’s original sign-in time.

- Let the next-side service worker show content-free push notifications and open their signed-in destinations.

## [0.16.1] - 2026-10-25

### Fixed

- **`loom token link --page-url <url>`** (was `--url`, which is loom's own
  global flag for remote mode, so the documented command refused to run).

## [0.16.0] - 2026-10-25

### Added

- **One-time sign-in links for the page: `loom token link`.** The CLI on
  loom's machine prints a link that signs a browser in once, within 10
  minutes (`--minutes`, up to a day), with no token to paste. Opening it shows
  a button; only the button's POST signs in, so a chat's link preview can't
  spend it. Its sessions belong to one owner token, "page sign-in links":
  revoke that and they all end.

### Fixed

- **A restart no longer signs everyone out of the page.** Browser sessions
  were kept in memory, so every daemon restart (a deploy, a reboot) ended
  them. They're on disk now (`ui-sessions.json`, 0600, beside
  household.json, ids kept only as hashes) and shared by every loom-http
  process on the machine, and the anti-forgery key is persisted too, so a
  form opened before a restart still posts after it.

## [0.15.0] - 2026-10-25

### Added

- **`loom person evidence <slug> [--since <iso>]`**: the memories a person
  card condenses (active, unexpired `user` and `feedback` memories tagged
  `metadata.person`, oldest first), with `--json`. It runs over the network
  like the other store verbs, so a synthesis lane no longer has to open the
  memory database file itself.
- **`loom knowledge list [--domain d]`**: every active page's freshness
  fields (slug, title, domain, created, `verified_at`, `freshness_anchor`,
  `sla_class`), no bodies, with `--json`. A listing, not a read: it doesn't
  count as an access. What a verification sweep picks from, over the network.

## [0.14.1] - 2026-10-25

### Changed

- **A piece's API answer may be up to 8 MB** (was the page's 512 KB).
  An API answer is data for a program, not a page for a person: a work
  store's whole export (taskstore's is 2.7 MB gzipped) has to fit. Pages keep
  512 KB.

## [0.14.0] - 2026-10-25

### Added

- **The piece API** (docs/extensions.md, "The API"). In a household,
  `POST /api/<piece>/<path>` runs `loom-<piece> api --json` with
  `{caller, path, body}` and passes the piece's `{status, body}` back. It's for
  callers that aren't a browser: a box calling home to the runtime piece, a
  body asking for a house. POST, JSON and no Origin, like `/cli`. It has its
  own pool (four running, eight waiting, then 503), so a flood can't starve
  the page.
- **Piece credentials:** a token role `piece:<piece>/<subject>`
  (`loom token create --piece box/thor`). It reaches only its own piece's
  API, as its subject: no MCP, no `/cli`, no page, no other piece.

### Security

- The household daemon's caller resolution now handles every role kind by
  name, and refuses anything that isn't one of them. Before this, a role
  kind it didn't know would have been served as the owner.

## [0.13.1] - 2026-10-24

### Changed

- **Bundles are gzipped** before they're encrypted, which makes a real
  household about a third of the size (40 MB down to about 13 MB). `loom restore`
  still reads the uncompressed bundles that 0.12 and 0.13 wrote.

## [0.13.0] - 2026-10-24

### Added

- **The household page** (docs/specs/household.md, phase 4). In a
  household, the page is the owner's view of all of it:
  - **Home:** every agent (what it's doing, from its tape), the tape across
    all of them, and the commons.
  - **Knowledge:** the commons' pages, by domain.
  - **People:** the directory, with every agent's relationship to each
    person, and who changed the shared entry.
  - **`/a/<agent>`:** that agent's view, plus **Setup**: its identity
    (read-only), its tokens (make one, shown once; revoke) and health.
  - **Add an agent:** creates its stack and its first token.

  A daemon now re-reads household.json as it changes, so a new agent is
  served at once. The old single-agent addresses (`/mind`, `/memory/…`)
  land on the default agent's view. A plain context dir keeps the
  single-agent page.

## [0.12.0] - 2026-10-24

### Added

- **The bundle: the household on a USB stick** (docs/specs/household.md,
  phase 3).
  - **`loom export --to <file> --recipient <age1…>`** writes the whole
    household into one file, encrypted with age to the owner's key: its
    files and tokens, the commons, every agent's directory (SQLite through
    the backup API), and each piece's own part (`loom-<piece> bundle export`,
    encrypted by the piece).
  - **`loom restore <file> --identity <key>`** lays it down in an empty
    LOOM_HOME and hands each piece its part (`bundle import`). A piece that isn't
    installed keeps its part in `pieces-pending/`.
  - **`--drill`** restores into a throwaway directory and compares it with
    the live household, touching nothing live.
  - **A plain context dir** exports as a household of one, and restores as
    one with its cards split.

## [0.11.0] - 2026-10-24

### Changed

- **The household, phase 2b: one directory entry per person, a relationship
  per agent.** In a household a person card is kept in two places:
  - **The directory** (`commons/people.db`): name, handles (`where`), and
    the facts in `how` (`tz`, `timezone`, `pronouns`, `languages`), shared
    by every agent.
  - **Each agent's relationship** (its own `memories.db`): the summary, the
    rest of `how` (how *this* agent talks to them) and `may`.

  How it behaves:
  - A read merges the two halves into one card, rendered exactly as before.
  - A write splits by field. Both halves are rehearsed in memory first, so
    a write either half would refuse changes neither.
  - Revisions record the agent that made them (`person_revisions.actor`),
    and `person_history` says which half each revision came from.
  - "Memories newer than the card" counts each agent's own memories.

  Moving in:
  - `loom household commons` and `init` split an existing agent's cards,
    checking first that every card still renders the same text. Running it
    again is safe.
  - A household daemon refuses to start with cards that haven't been split.
- **The household, phase 2a: knowledge is the commons.**
  - In a household, every agent reads and writes `commons/knowledge.db`.
  - `loom household init` moves the first agent's knowledge there.
  - `loom household commons` moves it for a household made before this
    release. It checkpoints the WAL first, and must run with every daemon
    stopped.
  - A household daemon refuses to start while an agent still has its own
    `knowledge.db`, so the knowledge base can't quietly fork.
  - A plain context dir keeps its own knowledge, as before.

## [0.10.0] - 2026-10-24

### Security

- **`harness_init` could write any file the daemon's user can.** Its
  `target` was a free path and the harness name could carry newlines, so any
  MCP caller could append to another agent's `IDENTITY.md` or plant a command
  in a shell rc file. Over HTTP the target is now refused: it names a file on
  the server, never the caller's. Locally it must be a harness instruction
  file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, …), judged at its real path.
  Names refuse control characters, and managed-block writes use a random,
  exclusive temp file. Found by the security review of the household work.

### Added

- **The household, phase 1: one loom, several agents**
  (docs/specs/household.md).
  - `$LOOM_HOME/household.json` lists the agents and the default, and
    `tokens.json` holds every token by sha256 with a label and a role.
  - **Roles:** `agent:<name>` is MCP and `/cli` as that agent's stack only.
    `owner` gets the default agent, another at `/agents/<name>/`, and the
    page. `peer:<name>` gets knowledge tools only.
  - **On every request** the daemon resolves the role and builds the
    session's server over that agent's context dir. A session stays pinned
    to the role and agent it opened with, and a revoke takes effect on the
    next request.
  - **New commands:** `loom household init|add|show` and
    `loom token create|list|revoke`.
  - **Nothing changes for one agent:** a plain context dir is a household of
    one and behaves exactly as before.

## [0.9.2] - 2026-10-24

### Fixed

- **Logging in to the page (and every form on it) failed in a browser with
  "forbidden: cross-site request".** The page was served with
  `Referrer-Policy: no-referrer`, under which browsers send `Origin: null` on
  the page's own form posts, and the cross-site guard refuses that. It's
  `same-origin` now, which still sends nothing to links that leave the page.

## [0.9.1] - 2026-10-24

### Changed

- **loom's page is at the root.** `/`, `/mind`, `/people`, `/memory/<ref>`,
  `/p/<piece>/…`, `/act/<source>`, `/login`, `/logout` and `/pieces.json`.
  The old `/ui/…` addresses redirect (308) to the same page. MCP still
  answers everywhere else, and at `/` for a POST, a request with an MCP
  session, or an event-stream GET. The session cookie's path is `/`.

## [0.9.0] - 2026-10-24

### Changed

- **loom's page, v2.** Home is now the tape: the last day's episodes grouped
  by hour and filterable by where they happened, with tiles across the top
  and top of mind and the people who need a look beside it. **Mind** lists
  every memory by heat, marks exactly what the boot digest carries, and says
  why each one has its heat. Pending proposals moved there, with ratify and
  reject. One memory and People (each card, with what's newer than it) are
  their own pages.
- **The page contract, v2 (docs/extensions.md, "The page").** A piece answers
  `ui --json` with a manifest (a tab, a Home tile, "Your call" asks),
  `ui page --json` with pages, and `ui act --json` to run actions. New blocks:
  `kv`, `callout`, `filters`, `details`, `form`, `buttons`. Links can stay in
  the piece, go to loom's pages, or carry a query. A first-version
  `{sections}` answer still renders, as the piece's page.
  - **Actions:** a form posts to `/ui/act/<source>` with an anti-forgery token
    bound to the session cookie. Cross-site posts are refused. Fields go to
    the piece on stdin only, and the result shows once without touching the
    URL. A `secret` field never carries a value.
  - **Sessions:** the cookie is now a random session id held in memory, and
    signing out revokes it. Another site (or another port on the host) can
    link to the page but not embed or fetch it. At most 6 pieces run at
    once, and nothing a piece starts outlives its answer.
  - **`/ui/sections.json` is gone;** `/ui/pieces.json` lists the installed
    pieces' manifests, for scripts.
- **Top of mind reads heat live.** The boot digest and the page compute each
  memory's heat from its timestamps when read, instead of trusting the stored
  field the consolidation lane refreshes. Between passes the stored field went
  stale, and Top of Mind fell back to write order.
- **Recall adds heat by rank instead of resetting every result to full heat.**
  One vague query used to put ten unrelated memories at the top of mind. Now
  the top result gets 0.5, the next 0.3 and 0.2, and the rest 0.1, decaying
  on the memory's half-life and capped at 1. A write, an update or a repeat
  remember still makes a memory fully hot. `last_accessed` still records
  every look, for pruning. New columns `recall_heat` and `recall_heat_at`
  (migration `add_recall_heat`) start at 0.

## [0.8.0] - 2026-10-24

### Added

- **loom's page: `/ui` on the HTTP daemon.** A read-only web page with loom's
  own sections: top of mind, the last 24h of episodes, proposals waiting, and
  people. It also gets a group for each installed piece that answers
  `loom-<piece> ui --json` in a small section vocabulary (stats, list, table,
  text, link). Pieces send data, never markup: everything is escaped, the page
  has no script, and a CSP forbids script and framing. Invalid answers are
  dropped whole, and a slow or missing piece is left out.
  - **Login:** the bearer token, once. The page requires `LOOM_BEARER_TOKEN` (no
    token gives 403, like `/cli`). The cookie is keyed per daemon process, isn't
    the token, and lasts 30 days or until a restart. Pieces never see loom's
    tokens; on a timeout their whole process group is killed; concurrent loads
    share one run per piece.
  - **`/ui/sections.json`:** the same data, for scripts.
  - **Scope:** full scope only.

## [0.7.0] - 2026-10-24

### Added

- **Pieces: `loom <piece>` dispatches to `loom-<piece>` on PATH, and `loom
  pieces` lists them.** loom's command namespace now reaches separate,
  swappable extensions (tasks, secrets, a wake clock, …) the way `git` reaches
  `git-<cmd>`. loom never links them, and they never write loom's stores. Core
  commands always win, piece names are validated before PATH is searched,
  loom's env passes through unchanged, and the piece's exit code comes back.
  The tiers, the rules (alone, composes without requiring, a contract per
  role, no secrets in argv) and how pieces meet through named seams are in
  `docs/extensions.md`.

## [0.6.0] - 2026-10-24

### Added

- **CLI remote mode: `--url` / `LOOM_URL`, and `POST /cli` on loom-http.**
  The store verbs (`wake`, `recall`, `remember`, `update`, `forget`, `memory`,
  `knowledge`, `person`) can run against a daemon instead of a local stack,
  for hooks and scripts on a host or in a container where loom lives
  elsewhere. The CLI ships argv and stdin to `POST /cli`; the daemon runs the
  same CLI on its own stack and returns stdout, stderr and the exit code, so
  output and `--json` match a local run by construction. The bearer token
  comes from `LOOM_TOKEN_FILE`. The endpoint is full-scope only, needs
  `LOOM_BEARER_TOKEN` set, refuses browser requests (an `Origin` header or a
  non-JSON body), and sits behind the same bearer gate and payload cap as
  MCP. It takes only those verbs (minus `memory recompute-salience` and
  `memory recall-stats`, which have no MCP tool), refuses `--context-dir` and
  `--url`, and passes only `LOOM_CLIENT`/`LOOM_MODEL` through from the
  caller's env.

- **Person cards: `people` + `person_revisions`, eight `person_*` tools,
  `loom person show|list`, and identity's `people` param.** A card is the
  condensed current state of one human the agent works with: `where` fields
  carrying a freshness marker (`[ok]`, `[unverified]`, `[STALE <n>d]`), `how`
  fields (time zone, mode, who to loop in), descriptive `may` entries each with
  a source, and a short agent-written summary. One value per field,
  overwritten in place; every stored change snapshots the previous row (newest
  10 kept), and every mutation is one `BEGIN IMMEDIATE` transaction. Cards are
  not an authorization surface: the harness's gating names (`tier`, `field`,
  `projects`, `scope`, `trust`) are rejected anywhere on a card.
  `identity({people: [slug, ...]})` adds an `# In the room` block after the
  tape (≤ 4 cards, 6,500 chars, best-effort). The dossier now says worker
  bodies must not write cards. Design and acceptance criteria:
  `docs/specs/person-cards.md` (criteria 1–12; the misfile heuristic, 13, is
  still to come).

- **Knowledge actor attribution: `pages.author`, `page_revisions.actor`, and a
  `verifications` table (page_id, verifier, verified_at, outcome,
  citation_checked).** Previously the only attribution field was
  `created_by` — free text, meaning "who owns this `ours/` artifact," not
  "who actually wrote or verified it" — so there was no way to tell who wrote
  a page's first version, who performed a given body revision, or who has
  verified a page and found what. `pages.author` is stamped once at creation
  and never changed by later upserts; `page_revisions.actor` is stamped on
  every body-replacing write and every history-restore; `verifications` is an
  attributed audit trail additive to the existing `pages.verified_at` stamp
  (which stays as the fast single-column freshness field everything else
  sorts/filters on). All three are resolved server-side, never a free-text
  tool argument, so no caller can claim another identity's authorship or
  verification: MCP calls use the connection's identity from
  `registerKnowledgeTools` ('art' on the main server, the bearer-resolved
  identity on the knowledge-only service); the CLI and eurorack import use
  `resolveIdentityName()` (`LOOM_IDENTITY` env override, else the context
  dir's real basename).
  `knowledge_verify` gains `outcome` ('confirmed' | 'stale' | 'corrected') and
  `citation_checked` parameters; `knowledge_history`'s listing now shows who
  performed each revision and surfaces the page's verification history. (t-675)
  An outcome of 'stale' is a failed verification: it is recorded in
  `verifications` but does NOT advance `pages.verified_at`, so a known-wrong
  page keeps its place at the front of the stale-first queue; the result's
  new `stamped` flag (and the tool output) says whether the stamp moved.

- **`MemoryMatch` carries `similarity` alongside `relevance`, and `scope`
  alongside `project`.** `relevance` is now the post-MMR score that actually
  decided a result's rank — equal to `similarity` (raw cosine) unless MMR
  re-ranking traded a pick off against ones already selected, in which case
  the two now diverge and both are visible (modeled on MemoriLabs/Memori's
  `FactSearchResult.{similarity, rank_score}` split). Separately, every
  memory now has an effective `scope` ('project' or 'global'): `recall` and
  `memory similar` exclude a project-scoped memory tagged to a *different*
  project than the one passed via `--project`/`project`, while global-scoped
  memories (category default for `user`/`reference`, any untagged memory, or
  an explicit `scope: "global"` at write time) still come through regardless.
  Closes the gap where a preference learned on one project could surface
  while working on an unrelated one. `remember` (MCP tool and `loom remember
  --scope`) takes an explicit `project | global` override for the categories
  where the category default can't tell (`self`, `feedback`) — e.g. a
  security/git/tool-workflow lesson learned in one project but true
  everywhere. (t-337)

### Fixed

- **All 34 MCP tools now declare `ToolAnnotations`** (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`), so a client gating
  approval on these hints (e.g. Codex under `approval: never`) can tell a
  read from a write instead of refusing every call uniformly. Hints follow
  actual behavior, not tool-name conventions: `recall`/`knowledge_recall`
  are NOT read-only (they stamp `last_accessed`/`hit_count`, which
  `knowledge_maintain` reads to find cold pages); `knowledge_history` and
  `memory_revision_restore` are destructive in their restore mode even
  though the displaced body is snapshotted first. `update`,
  `knowledge_write` and `knowledge_move` are NOT idempotent: a repeated
  `observation` bumps the evidence count again, a repeated append stores
  the body twice, and a repeated prefix move into a child of itself
  (`music` → `music/gear`) nests again. `openWorldHint` is
  `false` everywhere — loom has no outbound network calls. This does not
  by itself prove any client relaxes its approval gate on these hints; that
  needs a live `tools/list` exchange against an updated server (tracked
  separately). (t-415)

- **`--context-dir` (and the other global flags) now work in front of the
  subcommand, as the help text has always claimed.** `loom --context-dir DIR
  knowledge write …` used to route to the stdio MCP server instead of the CLI:
  the entry point dispatched on `argv[2]`, which was `--context-dir`, not a known
  verb. The server read an empty stdin and exited 0, so a *write* verb reported
  success having never entered the write path — and never even reached argument
  validation, exiting 0 on an invocation that the working flag order rejects with
  exit 1. Measured against a disposable context dir: no `knowledge.db` was created
  and no row was written. Both entry points now resolve the subcommand past any
  leading global flags, skipping flag values in pairs so `--context-dir recall`
  still names a directory rather than invoking `recall`. Bare
  `loom --context-dir DIR` with no subcommand remains the MCP path. (t-665)

## [0.5.0] - 2026-09-04

### Changed

- **npm package renamed `loomai` → `@jbarket/loomai`.** The registry refused the
  unscoped name on publish: `403 Forbidden — Package name too similar to existing
  package loom-ai`. `loom-ai` is an unrelated, apparently abandoned package
  (0.1.1, 2026-06-03), and npm's similarity check is mechanical and applies only
  to unscoped names — so there is no appeal and no unscoped name in this family
  that is safe from it. Scoping settles it permanently. Nothing else moves: the
  brand is still `loom`, the CLI is still `loom`, the MCP server is still `loom`,
  the repo is still `sleepunit-agents/loom`. Only the install word changes:
  `npx loomai install` → `npx @jbarket/loomai install`. No version has ever been
  published under either name, so no installed tree anywhere needs migrating.

### Security

- **The `fastembed` dependency is gone; its ONNX runtime is vendored.** Six
  open Dependabot alerts (one critical, `GHSA-23hp-3jrh-7fpw`) all came from a
  single path: `fastembed@2.1.0` pins `tar: ^6.2.0`, and the 6.x line carries
  twelve unpatched advisories. `Anush008/fastembed-js` was archived on GitHub
  on 2025-12-15, so no upstream fix is coming, and an `overrides` bump to
  tar 7 does not work — fastembed does `import tar from "tar"`, which tar 7
  (no default export) turns into a `SyntaxError` at import, killing loom
  before it starts. The ~200 lines loom actually used now live in
  `src/backends/embedding-runtime.ts`, depending directly on
  `onnxruntime-node`, `@anush008/tokenizers` and `tar@^7.5.22`. `npm audit`
  is clean and the dependency tree loses `progress` and `@huggingface/hub`
  (both only reachable from the unused sparse-embedding path).

  Embedding output is **bit-for-bit identical** to `fastembed@2.1.0` — vectors
  already stored in a `memories.db` stay comparable to new ones. Two upstream
  quirks are preserved deliberately and marked in the source: vectors stay
  `Float32Array` through normalisation (so rounding matches), and `queryEmbed`
  keeps its E5-style `query: ` prefix even though BGE does not use one.
  `src/backends/embedding-runtime.parity.test.ts` asserts this against golden
  vectors captured from the upstream package before it was removed.

### Fixed

- **A failed model download poisoned the cache directory permanently.** The
  vendored downloader checks the HTTP status and deletes the partial file on
  failure. Previously a 403 or 404 from the model bucket was written into
  `<model>.tar.gz` as if it were the archive; the next run saw the file
  existed, skipped the download, and failed in `tar` — forever, until someone
  cleared the cache by hand. The error now names the URL, the status, and the
  new `LOOM_MODEL_BASE_URL` override.

- **The test suite was counting three abandoned worktrees.** `vitest` collected
  `.claude/worktrees/**`, so stale copies of the repo ran against current
  `node_modules` and inflated the reported total from 950 tests to ~2600.
  Excluded in `vitest.config.ts`.

- **The npm release path could never have worked, and the docs said it had.**
  Three separate blockers, none of which had ever been exercised because no
  `v*` tag has ever been pushed and `release.yml` has zero runs:
  1. `package.json` still declared `repository.url`, `homepage` and `bugs` as
     `jbarket/loom`, but the repo moved to `sleepunit-agents/loom`. With
     `publishConfig.provenance: true`, npm validates the manifest repository
     against the building repository and refuses to publish on a mismatch —
     so the very first tagged release would have failed at the publish step
     after a full build and test run.
  2. There were no publish credentials of any kind — no `NPM_TOKEN` repository
     or organization secret — so `npm publish` would have failed with
     `ENEEDAUTH`. Rather than add a 90-day token to rotate forever,
     `release.yml` now publishes with **npm trusted publishing** (OIDC): the
     workflow authenticates as `sleepunit-agents/loom` + `release.yml`, there
     is no secret to store or expire, and provenance is attested from the run
     itself. This requires npm >= 11.5.1, which Node 22.x does not ship, so
     the workflow upgrades npm before installing. See `docs/releasing.md` —
     trusted publishing cannot perform a package's *first* publish
     ([npm/cli#8544](https://github.com/npm/cli/issues/8544)), so the first
     release has to go up by hand once.
  3. The README advertised **Node.js ≥ 20 ("tested on 20 and 22")** while
     `engines` requires `>= 22` and CI only tests 22 and 24. A reader on
     Node 20 following the README would have hit `EBADENGINE`.
- Stale `jbarket/loom` links across `README.md`, `CHANGELOG.md` and
  `docs/privacy.md` now point at `sleepunit-agents/loom`, including the
  `gh attestation verify --owner` example (which named the wrong owner and
  a version that was never published).
- The README install section now states plainly that `loomai` is not on npm
  and gives the working `npx github:sleepunit-agents/loom` form. Remove that
  note in the commit that cuts the first real tag.

- **Every packaged install of loom was a silent no-op.** The entry-point guard
  in `src/index.ts` compared `process.argv[1]` against `import.meta.url` as raw
  strings. `npm i -g`, `npm link` and `npx` all install the bin as a *symlink*
  into a bin directory, so `argv[1]` was the symlink path while
  `import.meta.url` resolved to the real file — never equal, so `main()` never
  ran. `loom --version` exited 0 printing nothing, and `loom serve` started no
  server. Only `node dist/index.js` worked, which is exactly what every test
  and every dev checkout does, so nothing caught it. Both sides are now
  resolved with `realpathSync` before comparing, and
  `src/entry.integration.test.ts` invokes the built bin through a symlink so
  the packaged shape is exercised in CI.

### Added

- **The onboarding interview is four questions, and `bootstrap` writes a real
  identity.** The interview now asks for the *user's* name as well as the
  agent's name, purpose line and voice line — and nothing else. In exchange,
  `bootstrap` no longer emits a six-line IDENTITY.md: it writes the full
  scaffold underneath the four answers (what a persistent agent is and where
  its continuity lives, the three memory tiers, the reflection loop, honesty
  about what it knows, delegation, and a "Working with <user>" floor).
  `preferences.md` is seeded with the user's name. New optional `user` param
  on the `bootstrap` tool and `loom bootstrap --user`; the loom-setup skill
  shows an example answer *before* each question. Rationale: the structural
  half of an identity is the same for every loom agent, so asking for it wastes
  the interview — handing over the architecture is a hypothesis the agent can
  falsify, handing over a personality would be a verdict. (Art, 2026-09-04)

- **MMR diversity re-ranking on `recall`** — after the vector search, the
  candidate pool (`max(limit*3, 12)`) is re-ranked with Maximal Marginal
  Relevance (`λ·relevance − (1−λ)·max cosine sim to already-picked`,
  λ = 0.7) so near-duplicate memories on a well-covered topic stop crowding
  out different ones. The top result is unchanged; with ≤ `limit`
  candidates nothing moves. New optional `diversity` (0..1, default 0.3 =
  1−λ) on the `recall` tool and `loom recall --diversity`; `0` reproduces
  the old ranking exactly. Idea from xai-org/grok-build's memory search
  (Apache-2.0; idea only, no code). (Art, 2026-08-28)

- **Recall observation log** — every `recall` appends one JSON line to
  `<context>/telemetry/recall.jsonl` (query ≤120 chars, filters, pool
  size, returned, topScore, MMR drops, latency, hit). Local-only, never
  throws, `LOOM_RECALL_LOG=0` disables. `loom memory recall-stats
  [--since 7d] [--json]` reads it back: counts, hit rate, median latency
  and topScore, the 10 most recent misses. (Art, 2026-08-28)

- **Episode tier** — `episode` memory category (48h TTL by default), the
  `episodes` MCP tool and `loom memory tape [--hours N]` CLI, and a
  "Last 24h across bodies" block in `identity` (after preferences, before
  Top of Mind). Short-term cross-body memory: what other sleeves did in the
  last day, time-ordered and unconditional. Episodes are excluded from the
  salience digest (they would always be hottest). (Art t-142, 2026-08-25)

- **Soft-archive tier** (`memory_archive` / `memory_restore` MCP tools;
  `loom memory archive` / `loom memory restore` CLI subcommands). Memories
  can now be soft-retired with a tombstone (note + `archived_at` timestamp)
  instead of hard-deleted. Archived memories are excluded from `recall`,
  `memory_list`, `memory_prune`, `find_similar`, and `memory_audit` but
  remain fully recoverable. The original body is preserved in the row;
  `memory_restore` returns a memory to the active set and wipes the tombstone.
  Existing databases are migrated automatically on first open (`ALTER TABLE`
  guards against re-running on already-migrated schemas).

## [0.4.1] - 2026-04-23

Stabilization release consolidating v0.4.0-alpha.1 through alpha.7.
This is the first externally-promoted release: `npx loomai install` is
the canonical Quick Start path.

### Added

- **`loom install`** — writes the bundled `loom-setup` skill into a
  target harness's skills directory. Flag-driven (`--harness <key>`) or
  interactive single-select TUI. Targets: `claude-code`, `codex`,
  `gemini-cli`, `opencode`, `other`.
- **`loom doctor`** — read-only probe reporting node version, stack
  version compatibility, context dir resolution, and per-agent git
  fields.
- **`loom inject`** — writes a marker-bounded managed section into
  harness dotfiles (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
  `~/.gemini/GEMINI.md`) telling the agent to load identity via loom.
  Idempotent; re-running is safe.
- **`loom procedures list|show|adopt`** — CLI for procedural-identity
  seed templates (stack spec v1 §4.9). Ships 6 seed templates:
  `verify-before-completion`, `cold-testing`,
  `reflection-at-end-of-unit`, `handoff-to-unpushable-repo`,
  `confidence-calibration`, `RLHF-resistance`.
- **`loom harness init <name>`** — scaffolds a harness manifest from
  the template (stack spec v1 §4.7).
- **Full CLI surface** — every MCP tool has a `loom <subcommand>` shell
  equivalent: `wake`, `recall`, `remember`, `update`, `forget`,
  `memory list`, `memory prune`, `pursuits`, `update-identity`,
  `bootstrap`, `serve`. Write commands take body via stdin or
  `$VISUAL`/`$EDITOR`. `--json` on any command emits structured output.
- **MCP tools** for procedures and harness init:
  `mcp__loom__procedure_list`, `procedure_show`, `procedure_adopt`,
  `harness_init`.
- **Harness manifest block** (`harnesses/<client>.md`) and **model
  manifest block** (`models/<model>.md`) — loaded by `identity()` when
  `LOOM_CLIENT` / `LOOM_MODEL` resolve. Missing-manifest nudges emitted
  when set but absent.
- **Procedures block** (`procedures/*.md`) with seed nudge — emitted by
  `identity()` whenever `procedures/` is missing or empty.
- `LOOM_STACK_VERSION` file auto-stamped on server boot; startup
  refuses stacks ahead of what this loom understands.
- `LOOM_MODEL` env var + optional `model` param on the `identity` tool.
- Reusable `src/cli/tui/multi-select.ts` keyboard-nav checkbox
  primitive with `single: boolean` option.
- `src/install/names.ts` — canonical agent-name validation and
  reserved-names list.
- `assets/skill/SKILL.md` — bundled first-run setup skill.
- `.github/workflows/release.yml` — tag-triggered publish pipeline.
  Push a `v*` tag → `npm ci`, `npm test`, `npm run build`,
  `npm publish --provenance`, GitHub release with auto-generated notes.
  Pre-release tags flagged as prereleases. Requires `NPM_TOKEN` secret.
- `docs/privacy.md` — trust doc covering data locality (everything
  local, only outbound call is the first-run fastembed model
  download), the no-opt-out-telemetry policy, and a walkthrough for
  verifying release provenance via `npm audit signatures` and
  `gh attestation verify`. Linked from README and CONTRIBUTING.
- Stack spec §11 (Injection), §13 (Multi-agent layout), §14
  (Git-backed agent dirs).

### Changed

- **npm package renamed `loom` → `loomai`.** Brand (`loom`), CLI
  binary (`loom`), MCP server key (`loom`), and tool prefix
  (`mcp__loom__*`) are unchanged — only the `npx` install surface
  moves: `npx loom install` → `npx loomai install`.
- **License: MIT → AGPL-3.0-or-later.** Forks that modify loom and
  expose it over a network must offer source. Pre-alpha-1 releases
  remain MIT.
- `package.json` adds `publishConfig: { access: public, provenance: true }`
  and a `files` array so `assets/` ships in the published tarball.
- `loom bootstrap --name` validates against canonical name rules.
- `assertStackVersionCompatible()` called at MCP startup and every CLI
  command.
- README Quick Start rewritten around `npx loomai install` +
  `/loom-setup`.
- **`release.yml` switches to npm Trusted Publishing (OIDC).** Removes
  `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` from the publish step.
  Auth is handled by the OIDC token exchange between GitHub Actions and
  npm — no long-lived secret required. Requires a one-time bootstrap
  publish and Trusted Publisher configuration on npmjs.com.

## [0.4.0-alpha.7] - 2026-04-22

### Changed

- **npm package renamed `loom` → `loomai`.** The unscoped `loom`
  name is taken by an unrelated package. Brand (`loom`), CLI binary
  (`loom`), MCP server key (`loom`), and tool prefix
  (`mcp__loom__*`) are unchanged — only the `npx` install surface
  moves: `npx loom install` → `npx loomai install`. alpha.6 was
  never published to npm; alpha.7 is the first release tag.
- `package.json` adds `publishConfig: { access: public, provenance:
  true }` so tagged releases publish with Sigstore provenance.
- README Quick Start + CLI examples updated to `npx loomai`.

### Added

- `.github/workflows/release.yml` — tag-triggered publish pipeline.
  Push a `v*` tag → runs `npm ci`, `npm test`, `npm run build`,
  `npm publish --provenance`, then creates a GitHub release with
  auto-generated notes. Pre-release tags (`-alpha`, `-beta`, `-rc`)
  are flagged as prereleases on GitHub. Requires `NPM_TOKEN`
  repository secret.

## [0.4.0-alpha.6] - 2026-04-21

### Added

- `loom install` — CLI that writes the bundled `loom-setup` skill
  into a target harness's skills directory. Flag-driven
  (`--harness <key>`) or single-select TUI on a TTY. Targets:
  `claude-code`, `codex`, `gemini-cli`, `opencode`, `other`. `--to`
  overrides destination; `--force` overwrites; `--dry-run` /
  `--json` for scripting. The "other" target writes
  `./loom-setup-skill.md` in the current directory.
- `loom doctor` — read-only CLI probe reporting node version, stack
  version compatibility, context dir resolution, and enumerating
  existing agents under `~/.config/loom/*` with forward-looking
  `git: { initialized, hasRemote, dirty, gitignorePresent }` fields
  per agent. `--json` for scripting.
- `assets/skill/SKILL.md` — bundled skill that drives first-run
  setup inside the target harness: probe → interview → bootstrap →
  procedures adopt → harness init → MCP config edit
  (verify-before-write) → inject → wake verify. Never clobbers
  existing agent dirs; never proposes `--force`.
- `src/install/names.ts` — canonical agent-name validation plus
  reserved-names list (`current`, `default`, `config`, `backups`,
  `cache`, `tmp`, `shared`).
- Stack spec §13 (Multi-agent layout) and §14 (Git-backed agent
  dirs).

### Changed

- `loom bootstrap --name` now validates against the canonical name
  rules. Invalid or reserved names exit with code 2 and a specific
  error.
- `src/cli/tui/multi-select.ts` gains a `single: boolean` option
  (reducer + TTY adapter). Existing multi-select consumers are
  unchanged — the option defaults to `false`.
- `package.json` adds a `files` array so `assets/` ships in the
  published tarball alongside `dist/`.
- README Quick Start rewritten around `npx loom install` +
  `/loom-setup`. Per-command reference sections unchanged.

## [0.4.0-alpha.5] - 2026-04-21

### Added

- `loom procedures list|show|adopt` — CLI for procedural-identity seed
  templates (stack spec v1 §4.9). `adopt` supports positional keys,
  `--all`, `--force` overwrite, and an interactive multi-select picker
  (reuses the `src/cli/tui/multi-select.ts` primitive from alpha.4) on
  TTY. Idempotent by default.
- `loom harness init <name>` — CLI that scaffolds a harness manifest
  (stack spec v1 §4.7) from the template. Falls back to `--client` /
  `$LOOM_CLIENT` when no name is given. `--force` overwrites.
- `mcp__loom__procedure_list`, `procedure_show`, `procedure_adopt`,
  `harness_init` — MCP tools mirroring the CLI. Thin wrappers over the
  same shared core; first-class way for an agent to respond to the
  procedures seed nudge or a missing-manifest warning in the identity
  payload without needing harness-native filesystem tools.
- Stack spec §11 lists Procedures + Manifests as a new adapter.

### Changed

- `src/blocks/procedures.ts` gains `adoptProcedures`, `listProcedures`,
  `showProcedure`, and `UnknownProcedureError` (additive — existing
  exports untouched).
- `src/blocks/harness.ts` gains `initHarness` (additive).

## [0.4.0-alpha.4] - 2026-04-20

### Added

- `loom inject` — CLI command that writes a marker-bounded managed
  section into harness dotfiles (`~/.claude/CLAUDE.md`,
  `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`). The managed section
  tells the agent how to load identity via loom — prefer MCP
  (`mcp__loom__identity`), fall back to the CLI (`loom wake`).
  Content outside the `<!-- loom:start / loom:end -->` markers is
  preserved; re-running is idempotent.
- `--all`, `--harness <keys>`, `--to <path>`, `--dry-run`, `--json`
  flags for non-interactive use. Interactive keyboard-nav wizard
  when stdin is a TTY and no harness flags are given.
- Reusable `src/cli/tui/multi-select.ts` — stdlib keyboard-nav
  checkbox primitive with a pure reducer. Future consumers: bootstrap
  procedure adoption, harness-manifest selection.
- Stack spec §11 lists Injection as a new adapter.

### Changed

- No existing MCP tool surfaces or CLI commands altered. `loom inject`
  is purely additive.

## [0.4.0-alpha.3] - 2026-04-20

### Added

- Full CLI surface — every MCP tool has a `loom <subcommand>` shell
  equivalent: `wake`, `recall`, `remember`, `update`, `forget`,
  `memory list`, `memory prune`, `pursuits`, `update-identity`,
  `bootstrap`, plus an explicit `serve` alias. Write commands take
  body text via stdin (when piped) or `$VISUAL`/`$EDITOR` (when
  interactive). `--json` on any command emits the tool's structured
  return value for scripting.
- `assertStackVersionCompatible()` helper consolidates the
  stack-version gate; both MCP startup and every CLI command call it.

### Changed

- `node dist/index.js` with no subcommand still launches MCP (backward
  compatible with every existing `.mcp.json`). A known-subcommand
  argv[2] routes to the CLI instead.

## [0.4.0-alpha.2] - 2026-04-20

### Added

- Procedures seed content — 6 recommended seed templates (stack spec
  v1 §4.9) exposed as `SEED_PROCEDURES` in `src/blocks/procedures.ts`:
  `verify-before-completion`, `cold-testing`,
  `reflection-at-end-of-unit`, `handoff-to-unpushable-repo`,
  `confidence-calibration`, `RLHF-resistance`. Each template ships a
  prescriptive Rule sentence plus agent-authored slots for Why and
  How to apply, fenced by a ⚠ ownership-ritual notice the agent
  deletes on adoption.
- `seedNudge()` — renders an empty-directory onboarding message
  containing all 6 templates. Emitted by `identity()` whenever
  `procedures/` is missing or empty; suppressed as soon as any
  procedure file exists.

### Changed

- Documentation reshuffle: v0.4 arc docs moved out of the repo. The
  roadmap now lives in the
  [v0.4 discussion](https://github.com/sleepunit-agents/loom/discussions/10) and
  the [project board](https://github.com/users/jbarket/projects/1/views/1).
  Per-feature specs and plans moved from `docs/superpowers/{specs,plans}/`
  to `docs/{specs,plans}/` — tool-neutral paths, same content.

## [0.4.0-alpha.1] - 2026-04-19

### Added

- Harness manifest block (`harnesses/<client>.md`) — per-harness
  descriptor (tool prefixes, delegation primitive, scheduling,
  session search, gotchas). Loaded by `identity()` when
  `LOOM_CLIENT` resolves. Matches stack spec v1 §4.7.
- Model manifest block (`models/<model>.md`) — per-model-family
  descriptor (capability notes, workarounds, when-to-use /
  when-not-to-use). Loaded by `identity()` when `LOOM_MODEL`
  resolves. Matches stack spec v1 §4.8.
- Procedures block (`procedures/*.md`) — procedural-identity docs
  with a hard cap of ~10 files. Reader ships; populated content
  lands in a later alpha. Matches stack spec v1 §4.9.
- `LOOM_MODEL` environment variable + optional `model` param on the
  `identity` tool.
- `LOOM_STACK_VERSION` file at the context-dir root, auto-stamped
  with `1` on server boot. `createLoomServer` refuses to start
  against a stack version ahead of what this loom understands.
- Missing-manifest nudges: when `LOOM_CLIENT` or `LOOM_MODEL` is set
  but no corresponding manifest exists, `identity()` emits a
  template-filled section telling the agent exactly what to write.

### Changed

- License: MIT → **AGPL-3.0-or-later**. Forks that modify loom and
  expose it over a network must offer source to their users. Bundling
  loom into a larger product is still fine; closing the loom-derived
  code and reselling it is not. Pre-alpha-1 releases remain available
  under MIT.

## [0.3.1] - 2026-04-19

Initial public release.

### Added

- `SqliteVecBackend` — single-file memory store using
  [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) plus
  the [`sqlite-vec`](https://github.com/asg017/sqlite-vec) vec0 virtual
  table. One `memories.db` per agent. Real cosine similarity.
- `FastEmbedProvider` — embeddings via
  [`fastembed`](https://github.com/Anush008/fastembed-js) with
  BGE-small-en-v1.5 (384-dim, ~33MB ONNX, CPU-only). First run
  downloads the model to `~/.cache/loom/fastembed/`. No GPU, no
  Docker, no daemon.
- Stack specification — [`docs/archive/loom-stack-v1.md`](docs/archive/loom-stack-v1.md)
  defines the directory layout, block types, memory schema, wake
  sequence, and adapter contract that v0.4 work builds on.

### Changed

- Memory backend is now a single opinionated stack (sqlite-vec +
  fastembed). The env-driven backend selector is gone.

### Removed

- Qdrant backend, Ollama embedding provider, OpenAI embedding
  provider, filesystem backend. None were load-bearing for the new
  stack and all added external-service dependencies or operational
  overhead.

[Unreleased]: https://github.com/sleepunit-agents/loom/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/sleepunit-agents/loom/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/sleepunit-agents/loom/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/sleepunit-agents/loom/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/sleepunit-agents/loom/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/sleepunit-agents/loom/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/sleepunit-agents/loom/compare/v0.9.2...v0.10.0
[0.9.2]: https://github.com/sleepunit-agents/loom/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/sleepunit-agents/loom/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/sleepunit-agents/loom/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/sleepunit-agents/loom/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/sleepunit-agents/loom/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/sleepunit-agents/loom/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/sleepunit-agents/loom/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/sleepunit-agents/loom/compare/v0.3.1...v0.4.1
[0.4.0-alpha.7]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.6...v0.4.0-alpha.7
[0.4.0-alpha.6]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.5...v0.4.0-alpha.6
[0.4.0-alpha.5]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.4...v0.4.0-alpha.5
[0.4.0-alpha.4]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.3...v0.4.0-alpha.4
[0.4.0-alpha.3]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.2...v0.4.0-alpha.3
[0.4.0-alpha.2]: https://github.com/sleepunit-agents/loom/compare/v0.4.0-alpha.1...v0.4.0-alpha.2
[0.4.0-alpha.1]: https://github.com/sleepunit-agents/loom/compare/v0.3.1...v0.4.0-alpha.1
[0.3.1]: https://github.com/sleepunit-agents/loom/releases/tag/v0.3.1
