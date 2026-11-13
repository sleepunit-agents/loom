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
| Per-device dock/rail hide modes, rail accordion and Comms companion portal | Follow-up desk slice; the existing 64px rail reservation under 1280 remains a compact agent strip |
| Grouped launcher sections and account tile | Flat registration inventory for now; no old Shell discovery or fabricated live stats |
| Home Needs you band and full questions, clock, runtime jobs, reported work | Existing live Home content in desk-coloured cut cards; desktop cards scroll within the available height; phone cards grow |
| Depth / Contours / Wash | Existing lazy ground components, selected by member `household.preferences`; Appearance offers all three |
| Home conversations and composer | Existing private `comms.agents` summary; latest thread and unread-thread navigation. Shared Comms composer opens a thread with member/agent drafts and stable retry IDs. No Home message-feed subscription or retained reply-word preview |
| Home composition | Full question first; work/runtime and recent conversation beside Clock on a wide single-agent card, stacked on narrower cards; composer follows the details |
| Phone bar and centered desktop ticker | Registration title, shared existing ticker renderer, owned roster/status and live Needs you count; exact Inbox navigation, appearance gear on phone; all apps stays in dock |
| System clock, Boxes/backup status glyphs, piece-stat ticker items | Follow-up proper new-side sources; no browser clock presented as loom time or fabricated piece stats |
| Last steps, phone Home accordion, per-app parity | Follow-up slices before owner acceptance; no invented tape steps |

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
