# The next desk's appearance

The new side (`loom serve --next`) reuses loom's three looks and existing visual components. It reads only the new live records. No importer, daemon operation or separate command is needed for this shell: Household already owns saved appearance and its importer. Starting the old side remains unchanged.

| Present desk | New desk / remaining work |
|---|---|
| Default Neon Noir, saved look/accessibility, manifest and build-only worker | Member `household.preferences`, same look tokens/fonts, next manifest/assets/worker (#1019) |
| App-tinted cut window frames, navigation, trail, make-big, minimize, close | Registration-tinted frames around the existing shell router and tiling algorithm |
| Icon dock with open marks and keyboard navigation | Existing `Dock` and `AppIcon`; inventory from registrations. All installed apps remain reachable in the scrolling dock |
| All apps search, arrows, Enter, Escape, focus return | Registration-driven modal using the existing launcher presentation; Ctrl/Command+Shift+Space |
| Needs you and owned compact agent cards beside work | Registered Attention Rail surface; roster, directory names, status, open asks and private thread metadata from existing live records |
| Clicking a rail agent | First unread open thread, else latest open thread, else Comms; asks open the exact Inbox reader |
| Reply counts and first reply words | Current thread feed offers unread **flags**; show unread thread counts explicitly. Reply-word previews await an owning metadata role; do not decrypt whole message feeds for a rail |
| Per-agent face sheets / colours | Live `household.agentDisplay` projects database colours and drawn face shapes/eyes; existing lazy Face shows reported state. Imported pixel sheets now travel with the offline household import and are served from the new database; no old file lookup or invented sprite |
| Rail accordion | Measures full cards before paint; on overflow keeps one open, working thread then ask then unread then first, while the rest become compact lines in alphabetical order. Comms selection priority comes with the companion slice |
| Per-device dock/rail hide modes | Always show / Minimize to strip / Auto-hide; browser-local next-only keys, overlay reveals, live ask/unread dot, keyboard agent shortcuts. Below 1280 the rail is a 14px strip |
| Selected Comms companion | Visible live thread selects its owned agent above Needs you; others stay alphabetical. Minimize, list navigation or source loss releases it; short move respects reduced motion |
| Comms portrait portal | Next slice; the selected companion currently retains its card |
| Grouped launcher sections and account tile | Grouped registration inventory and Your account shortcut; no old Shell discovery or fabricated live stats |
| Home Needs you band and full questions, clock, runtime jobs, reported work | Existing live Home content in desk-coloured cut cards; desktop cards scroll within the available height; phone cards grow |
| Depth / Contours / Wash | Existing lazy ground components, selected by member `household.preferences`; Appearance offers all three |
| Home conversations and composer | Existing private `comms.agents` summary; latest thread and unread-thread navigation. Shared Comms composer opens a thread with member/agent drafts and stable retry IDs. No Home message-feed subscription or retained reply-word preview |
| Home composition | Full question first; work/runtime and recent conversation beside Clock on a wide single-agent card, stacked on narrower cards; composer follows the details |
| Phone bar and centered desktop ticker | Registration title, shared existing ticker renderer, owned roster/status and live Needs you count; exact Inbox navigation, appearance gear on phone; all apps stays in dock |
| System clock and status glyphs | Member-private `household.time` carries server minutes and database timezone; desktop shows connection and working-agent glyphs. Phone retains its device status bar |
| Boxes/backup status glyphs, piece-stat ticker items | Runtime enrollment count with unknown health; policy-filtered Tasks/Clock/Bridges/Changes records supply live counts. Backup has no new-side source and stays absent |
| Phone Home accordion | Under 1024px, more than four owned agents keep one full card (working open thread, ask, unread, first). Other agents use kit rows in alphabetical order, navigating to first unread/latest open thread, else Comms. Full readers/composers are unmounted, never CSS-hidden. Four or fewer retain full cards; desktop keeps all cards |
| Last three tape steps | Shared `activity.window:recent` live projection, per owned agent, linked to the existing Activity reader; unavailable/truncated sources are explicit |
| Per-app parity | Account actions stay in Your account; remaining composition follows owner testing |

Every unavailable live feed drops its old content immediately. Roster loss removes cards; directory failure uses canonical roster names; status, ask and thread failures show unavailable words instead of stale values. Rail navigation is read-only. Approval and private ask actions stay in the owning reader.

The shell's one evidence scenario runs against an isolated next `startLoom` home and an isolated **old-format fixture** only. It captures Home, work and launcher old/new boards at 390, 1280 and 1920 in Neon Noir, Low Light and Daylight, in the Desk shell evidence CI artifact. The old reference uses the existing legacy fixture harness (including its fake executable); next code never reads it. This evidence does not claim the remaining Home/phone/app slices are finished.

For the final move, use Household's existing appearance import as part of the coordinator's offline import. No real data import, installed piece change or rollout is part of this task. Keep t-2214 in progress until all slices are merged and Jonathan says it looks like his loom.

## Agent display metadata

`household.agentDisplay` is a read-only Live projection of `loom.db` household
metadata: agent id, palette mark, shape and eyes only. It uses the existing
central agent visibility rule; it exposes neither the raw household document
nor paths, account metadata or credentials. Roster order supplies the same
palette/shape defaults as the present desk. Imported palette choices retain the
present desk's palette selection behavior. Missing/offline display data falls
back to a neutral initial immediately.

Home and the rail reuse the lazy drawn Face component: an open ask means
waiting on you, a working report means working, a waiting report means thinking,
and an offline report means needs a look. Unavailable status is neutral. The initial drawn-face slice (#1056) added no write operation, schema, job or
importer: Household's lossless importer already retained `marks` and `faces`.
The pixel-face slice below extends that importer for the supplied sheets.

### Imported pixel faces

The offline household importer now includes each registered agent's sprite
manifest and its named PNG sheets. It checks bounded regular files within the
source home, PNG dimensions against animation rows, and includes the bytes in
the source checksum, transaction and content comparison. Artwork occupies
`agent-sprite:<agent>` rows in `household_settings`; no table or policy changes.
A fresh staging home must be rebuilt through the importer to acquire artwork;
a previously imported home's receipt still refuses a changed source.

`household.agentDisplay` includes only the sprite's version, facings and URL.
Authenticated `/faces/<agent>/manifest.json` and manifest-named sheets read the
new database and recheck existing central agent visibility on every request.
They are never cached by HTTP or the service worker. Home and the rail reuse
PixelFace, including its existing animation, reduced-motion and drawn fallback,
and honor the member's Pixel faces preference. No runtime lookup of old artwork
and no artwork is generated or bundled by this change. Fixture comparison boards
without imported sheets continue to show drawn faces; they are not evidence of
Jonathan's real artwork. Its visual acceptance follows a coordinator-managed
staging rebuild, outside this implementation's authorized host scope.

## Bar and ticker

Attention registers a bar alongside its Home and rail surfaces. It reads only
owned roster, directory names, reported status and open asks from the existing
live records; unavailable feeds immediately remove their words/count. The bar
never retains conversation words. A count links to Inbox through the shell
router. Agent ticker links open Home, where all owned cards are visible; a
dedicated agent window remains follow-up. All apps stays reachable in the dock
and by its existing keyboard shortcut. Appearance stays in the bar, a named
gear on a phone.

The present ticker renderer is shared unchanged: only overflow moves, at
24px/second, paused while touched or hidden, still with reduced motion. Its
loop copy stays out of the tab order and screen readers. Desktop sides have
equal width around the centered ticker. On a phone the title, ticker, brand
and fixed Needs you count fit one line, below the device's own status bar.
No old Shell object or legacy fetching is used. Clock and status glyphs await
proper new-side sources; they are not inferred from device time or hidden
legacy data.


### Server time and system indicators

`household.time` is a member-scoped read-only record, using the existing central
member rule. A foundation-owned clock job refreshes it at each server minute and stops on
close. Scheduling after the clock turn coalesces a long sleep or clock jump into
one current update instead of replaying missed minutes. It reads the household timezone from loom.db (UTC when unset).
The bar uses that snapshot directly: no device clock, elapsed-time estimate or
polling. An unavailable snapshot immediately clears the time. No operation, CLI,
importer or schema is needed for this derived record.

On desktop the clock precedes the title; connection and working-agent glyphs
follow the brand, with names and tooltips. The iOS home-screen app also keeps its own status bar at desktop widths. Phones retain the single compact bar
under their own status bar. Connection means the bar's source feeds are live;
agent counts use the owned roster and latest reports. Boxes and backup remain
explicit follow-ups, pending proper owning sources. No tiling behavior changes.

The former 640–1023 two-line tablet status bar is omitted: the new shell treats
all widths below 1024 as phone composition, keeping its compact single bar.
Desktop separators/order match the present clock/title and brand/glyphs/count.

### Piece counts and Boxes

The bar subscribes to existing policy-filtered `task`, `wake`, `bridges.venue`,
`change` and `runtime.box` records through the same live feed. Tasks counts in
progress and ready work, Clock counts active wakes (pending/parked/held/firing),
Bridges counts enabled venues, Changes counts open pull requests and failing CI.
CI trouble precedes ordinary piece counts. Each links to its registered app.
Unavailable sources replace their own counts immediately; they never become zero.
Counts describe the visible records, not a household-wide total or health check.

Boxes counts nonrevoked enrollments. The rack glyph and ticker explicitly say
health is unavailable: `runtime.box` carries enrollment and last-seen metadata,
but no authoritative health/alert record. Placement eligibility is not a health
contract, so the desk does not infer “all quiet” from it. There is no registered
Boxes screen yet, so its glyph is a focusable tooltip rather than a dead link.
The backup glyph stays absent because no new-side backup record or owning role
exists; neither backup results nor their age can be inferred from the clock or
old files. These are deliberate honest gaps, not claims of operational parity.
No schema, operation, importer, generated command or permission change is needed.

### Rail overflow

Full cards remain when they fit. A layout effect measures the rail before paint;
on overflow the other agents fold to one line with face, name, status dot, ASK
and unread-thread count. One full card stays open: working private thread first,
then open ask, then unread thread, then first agent. Alphabetical order stays
fixed. Lines open the same first unread/latest thread as the full cards.
Changes to authorized content or available width/height retry full cards.
No message words are fetched. Lost feeds clear their facts and priority.
Comms' reader-owned portrait now uses the destination described below.
Device hide choices below preserve the tiling algorithm.


### Device hide choices

Right-click the rail, its strip/edge, or the dock ground/Home/All apps keys.
Always show reserves room. Minimize to strip keeps a 14px rail strip; clicking
reveals the rail over the apps. Auto-hide reserves no rail room and reveals
from its edge on pointer entry or touch. Leaving an auto overlay, Escape or a
press outside dismisses it. A hidden dock returns its room to the desktop.
Temporary reveals never reflow tiles. Hidden controls are inert; edge buttons
remain keyboard accessible. Reduced motion disables the slide.

`loom-next-rail` and `loom-next-dock` are browser-local choices, shared only
between next windows on that device, never member settings or the old desk's
keys. This intentionally drops migration of old hide settings: both sides
remain independent. Storage refusal still permits the current window's choice.
Below 1280 the desktop rail is a strip regardless of Always show. Phone dock
stays visible, preserving the existing phone navigation. Attention's record-only desk signals supply
the strip/edge's ask/unread glow from authorized feeds, clearing unavailable
facts. Ctrl+Shift+1…9 opens the corresponding alphabetical agent's first unread,
else latest thread, else Comms, including while typing. The reader-owned companion portal is described below; no tiling algorithm, operation, importer, client or schema is added.

Desk signals render no hidden cards. Their small registered surface keeps the
dock glow and agent shortcuts alive on Home as well as Work; the rail mounts
only while apps are visible. No Home composition or reader is duplicated.


### Selected Comms companion

The new shell provides the existing pure RailContext. Only the visible Comms
pane announces its live selected thread's agent, and clears it on minimize,
list navigation, unmount or source loss. Focusing another app keeps the visible
thread's companion. Ownership is still the rail's authoritative roster; an
unknown agent never gains a card. A late cleanup from an earlier pane cannot
clear a newer selection. Context carries agent identity only, no thread words.

That agent sits above Needs you with “With … in Comms”; the rest remain in
alphabetical order below it. It wins the measured accordion priority. Selection
changes retry full cards. The selected and previous companion slide260ms from
their measured previous position; reduced motion moves immediately. No tiling
algorithm or Home composition changes. The permanently shown companion receives the reader-owned portrait; other rail modes keep its compact card and leave the portrait in Comms.
The shared context's old provider remains compatible and reads no new data.

### Comms portrait and rail destination

The new Comms reader owns its portrait, driven only by its live thread and retained authorized messages. It uses household.agentDisplay and the member Pixel faces preference. A new retained reply gives 250ms static then 1–4 bounded talking beats (150 characters per beat); reduced motion suppresses both. An outstanding ask or error wins over talking. The channel line reports real connection/work/thinking/ask state and the latest retained reply harness; no legacy channel number is invented because new threads have no radio channel field.

| Old desk behavior | New desk |
|---|---|
| Comms portrait in band, moved to permanent rail | Reader-owned portrait portal through pure RailContext, selected owned card supplies destination |
| Hidden/auto-hide/narrow/phone rail | Portrait stays in Comms, exactly once |
| Old numeric channel | Omitted: no new-side channel field; state and harness retained |
| Old Comms fetch/marks | Replaced with retained message feed and household.agentDisplay; no old data reads |

Slot registration and cleanup carry source tokens; stale cleanup cannot remove a newer destination. List navigation, minimize and source loss release selection. No tiling changes. The existing five-agent comparison scenario includes the same 36 boards; fixture evidence is not owner acceptance.

### Launcher groups and account shortcut

The registered inventory is grouped in the old desk's order: Work, People & agents, Library, System, Look & feel, Pieces. Empty groups disappear; unknown registrations stay in Work. Within a group the registration order stays unchanged. No app is duplicated across groups. Section names and profile/passkey/sign-out aliases participate in search. Enter chooses a title prefix, then an alias, then the first result. Arrow keys continue to measure the displayed tiles. Enter on the account shortcut or Close activates that control.

| Old launcher behavior | New desk |
|---|---|
| Grouped applications | Registration IDs select groups; every registered app remains reachable |
| Member account tile | Your account / Profile shortcut opens the registered account screen |
| Profile found by passkey or sign out | Search aliases select the existing Your account app |
| Separate Appearance/Accessibility launch apps | Not duplicated in the launcher: Appearance and accessibility stay together in the existing status-bar panel; Settings is the actual secrets/access app, so it is never falsely offered as appearance |
| Individual agent tiles and per-app count duplicates | Not carried: agents stay on Home/rail, live counts in bar/owning app; no second launcher data subscription |
| Member name in launcher header | Generic Your account label; no new session or credential handling for a navigation shortcut |

This is presentation/navigation only. No new operations, records, importer, client or data authority is needed; no old data is read and no tiling rule changes. The same five-agent36board evidence scenario checks grouping, aliases and keyboard activation and captures every size/look.

### Counted Comms playback and compact pixels

Retained new replies request one to four PixelFace beats (one per 150 characters, summing a batch). The player supplies TALKING, DONE and the return to the thread's state, including its real gaps and manifest animation source. A drawn or unavailable face uses 1530ms per beat, 800ms between beats and 900ms for DONE. Sprite loading waits for its player; a failed sheet falls back to drawn timing. The 250ms signal begins after a painted frame.

An expired contributing reply, disconnected source, pending ask, error, reduced motion, changed display or portrait destination cancels playback. Initial live snapshots and reconnect history establish a baseline and never replay. The permanently shown selected-agent rail remains the only portal destination. The measured glass selects 1x for compact and 2x for full portraits; CSS never shrinks the sprite canvas. No new data source, backend operation, policy or session behavior is introduced.

### Account controls stay in Your account

The authenticated sign-in gate renders the desk without a fixed corner toolbar.
Passkey registration, signed-in browsers and Sign out this device stay in the
registered Your account app, reachable from All apps and its profile/passkey/
sign-out search aliases. This removes the provisional duplicate passkey handler
and its overlap with app content and the phone dock. The gate still checks
`/auth/session`, installs the CSRF meta value and requires sign-in before mounting
the desk; its passkey login flow is unchanged. No backend or session policy changes.

### Last steps on Home

Home subscribes once to Activity's existing `recent` live window and shows the
latest three entries for each expanded owned agent, with title, summary, reported
time in CT and location. Each opens that exact entry and day in Activity with the
agent filter. Phone accordion rows remain compact; only the full card has steps.
There is no new backend, importer, command, retained tape cache or message reader.
Activity owns access filtering, expiry, deduplication and source notifications.

The old desk read three raw tape episodes from a rolling 72 hours. The new desk
uses Activity's current three calendar days and its deduplicated episodes/digests.
This deliberately avoids a second tape query or different visibility rules. A
partial source is labelled; a disconnected or denied feed withdraws all words at
once. The recent window's global bound can omit a quiet agent, so truncation is
explicit rather than claiming complete per-agent history. On current main the
Activity Conversations role is not composed; Home shows its visible episodes and
says some activity is unavailable until the owning piece connects that role.
The SAME five-agent evidence scenario now includes a dedicated Last steps board
at every width/look and real fixture episode updates across both next windows.
No real import or host step is part of this slice.
