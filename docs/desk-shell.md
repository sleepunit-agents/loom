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
| Per-agent face sheets / colours | Live `household.agentDisplay` projects database colours and drawn face shapes/eyes; existing lazy Face shows reported state. Pixel-sheet assets remain a separate slice; no old file lookup or invented sprite |
| Per-device dock/rail hide modes, rail accordion and Comms companion portal | Follow-up desk slice; the existing 64px rail reservation under 1280 remains a compact agent strip |
| Grouped launcher sections and account tile | Flat registration inventory for now; no old Shell discovery or fabricated live stats |
| Home Needs you band and full questions, clock, runtime jobs, reported work | Existing live Home content in desk-coloured cut cards; desktop cards scroll within the available height; phone cards grow |
| Depth / Contours / Wash | Existing lazy ground components, selected by member `household.preferences`; Appearance offers all three |
| Faces/assets, Home conversations/composer, phone bars, ticker, per-app parity | Follow-up slices before owner acceptance |

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
and an offline report means needs a look. Unavailable status is neutral. This
slice adds no write operation, schema, job or importer: Household's existing
lossless importer already retains `marks` and `faces`. Pixel sprite metadata,
safe new-home asset serving/import and the Pixel faces preference remain the
next slice; drawn faces here do not claim to replace Jonathan's supplied sheets.
