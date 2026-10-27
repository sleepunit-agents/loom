# Changelog

All notable changes to loom are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

> **Publish status:** `@jbarket/loomai@0.5.0` is the first version published to
> npm. `0.4.1` and everything before it exists only as a git tag — those versions
> were never on the registry, so the four months of work between `0.4.1`
> (2026-04-23) and this release ship together as `0.5.0`.

## [Unreleased]

### Changed

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
