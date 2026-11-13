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
| Per-agent face sheets / colours | Monogram until shared display metadata supplies a face; no old file lookup or invented sprite |
| Per-device dock/rail hide modes, rail accordion and Comms companion portal | Follow-up desk slice; the existing 64px rail reservation under 1280 remains a compact agent strip |
| Grouped launcher sections and account tile | Flat registration inventory for now; no old Shell discovery or fabricated live stats |
| Home ground/faces/composer, phone bars, ticker, per-app parity | Follow-up slices before owner acceptance |

Every unavailable live feed drops its old content immediately. Roster loss removes cards; directory failure uses canonical roster names; status, ask and thread failures show unavailable words instead of stale values. Rail navigation is read-only. Approval and private ask actions stay in the owning reader.

The shell's one evidence scenario runs against an isolated next `startLoom` home and an isolated **old-format fixture** only. It captures Home, work and launcher old/new boards at 390, 1280 and 1920 in Neon Noir, Low Light and Daylight, in the Desk shell evidence CI artifact. The old reference uses the existing legacy fixture harness (including its fake executable); next code never reads it. This evidence does not claim the remaining Home/phone/app slices are finished.

For the final move, use Household's existing appearance import as part of the coordinator's offline import. No real data import, installed piece change or rollout is part of this task. Keep t-2214 in progress until all slices are merged and Jonathan says it looks like his loom.
