# Household replacement inventory

This is an implementation inventory for t-2203, checked against main `b909cd0`.
It records existing behavior and gaps; it does not change the contract in
[web-foundation.md](specs/web-foundation.md#moving-there). **Pending** means
there is no complete replacement yet, not that the behavior has been dropped.
The task remains open until the required operations, records, clients and Setup
screen are merged. Importing a row is not evidence that its command or screen exists.

## Commands and offline continuity

The old command contract is [src/cli/household.ts](../src/cli/household.ts).
The generated client's complete current surface is
[household/commands.ts](../src/core/household/commands.ts); invocation and exit
codes are in [household-piece.md](household-piece.md#generated-household-api-client).

| Old command | Current next replacement or gap |
| --- | --- |
| `loom household show` | `loom-household show '{}'`; same summary fields, JSON instead of aligned text |
| `loom household add AGENT` | `loom-household addAgent '{"agent":"AGENT"}'`; registers an existing context (also in Setup), JSON agent list instead of `Agents: …` |
| `loom household init AGENT [--owner PERSON]` | Fresh `serve --next --home NEW_HOME` creates an OS-owned household and complete default assistant context before its first sign-in link; Setup creates additional named agents. **Pending** old directory move/symlink and implicit commons split; importing an existing household is separate |
| `loom household commons` | **Pending** explicit offline commons migration. The app importer does not move knowledge or split People; neither the daemon nor stdio runs this old command implicitly |
| `loom household sprite AGENT SHEET PIXELLAB` and its weight/variant options | **Pending** artwork installation on the new side |
| `loom household sprite AGENT --manifest MANIFEST [SHEETS…]` | **Pending** manifest/sheet replacement on the new side |
| `loom household icons install DIR [--name SET]` | **Pending** icon-set installation and selection |
| `loom household icons set APP PNG` | **Pending** icon replacement |
| `loom household icons use SET\|none` | **Pending** active-set selection |
| `loom household icons list` | **Pending** installed-set projection/client |
| `loom token create` (agent/service/house, owner, peer, piece, runtime roles) | `token.create` / `loom-token create`; explicit member/agent/active runner/service only; retired legacy roles are disposed in household-piece.md |
| `loom token list` | `token.list` / `loom-token list`, safe metadata only |
| `loom token revoke LABEL [--with-passkeys] [--with-devices]` | `token.revoke` / `loom-token revoke`, atomic optional descendant-passkey and device cascades; old internal `signin.revokeToken` remains |
| `loom token link` | Existing explicit `loom token link --next --member PERSON`; [client.ts](../src/core/signin/client.ts) supports remote bearer and local operator modes. This is an ephemeral, non-retrying credential command |
| `loom sessions list` | `sessions.list` / `loom-sessions list`, safe metadata and ended state |
| `loom sessions revoke REF` | `sessions.revoke({ref})` / `loom-sessions revoke`, unique-ref lookup and device removal |
| `loom sessions revoke --label LABEL` | `sessions.revoke({label})` / `loom-sessions revoke`, agent/headless sessions only |
| Legacy bare stdio `loom` | Explicit `loom mcp --next --home HOME [--agent AGENT]` or `loom mcp --next --context-dir CONTEXT`; stopped-daemon two-agent and standalone acceptance is implemented |

New member/project/account commands have no old CLI spelling:
`setMember`, `removeMember`, `setOwnedAgents`, `setMemberProjects`,
`setAgentAccounts`, `createProject`, `setProjectMembers`, `setProjectAgents`.
All are available in `loom-household`, through the same daemon operations as
other callers. They do not bootstrap a context or mint a token.

## Page actions and routes

Old household forms/actions are in
[household-pages.ts](../src/ui/household-pages.ts); Account, sign-in, settings
and artwork routes are in [ui/handler.ts](../src/ui/handler.ts). Next sign-in's
routes and authority are in [signin/routes.ts](../src/core/signin/routes.ts)
and [next-signin.md](next-signin.md). API operations are posted to
`/api/PIECE/OPERATION`; this is separate from the shell's `/p/…` routes.

| Old action or route | Current next replacement or gap |
| --- | --- |
| `member-set`, `member-remove` | `household.setMember`, `household.removeMember`; owner operations and Setup member controls are implemented |
| `add-agent` | `household.addAgent` covers registration only; `household.bootstrapAgent` creates context/creed/rules; Setup selects first-token creation and shows an explicit next-mode harness snippet. Appearance remains **pending** |
| `create-token`, `revoke-token` on agent Setup | `token.create` / `token.revoke` in `/p/setup-preview`; single-send mint and confirmed optional passkey/device cascade; first-token bootstrap still pending |
| `face-set`, `mark-set` | **Pending** appearance operations/records and Setup controls |
| `about-set`, `about-ask` | **Pending** household profile editing and regeneration request. Explicit offline `describe_self` refuses app access |
| `identity-set`, `identity-section-set`, `identity-section-add` | **Pending** Setup/identity behavior reconciliation; no next page editor. The household spec describes Setup identity as read-only |
| `backup-set`, Setup health/backup status | **Pending** next backup settings/status integration; no new-side invocation of the old backup program |
| `person-add` | `mind.personAdd`; People screen handles the new-side form |
| `fact-add`, `knowledge-verify`, `knowledge-recheck` | `mind.knowledgeAdd`, `mind.knowledgeVerify`, `mind.knowledgeRecheck`; Knowledge screen handles the new-side forms |
| GET `/a/AGENT/setup` | `/p/setup-preview` now provides member ownership/removal, project lists, account attribution and existing-context registration via Live/call; token/session administration via `signin.admin` and socket calls; **pending** read-only identity, health and full bootstrap coverage |
| GET `/new-agent`, GET `/members` | Setup member forms and existing-context registration implemented; fresh context bootstrap via `household.bootstrapAgent` and Setup |
| GET `/account`, GET `/passkeys` | **Pending** complete Account administration screen; the new sign-in shell is not that screen |
| `passkey-remove` (including descendants), `session-revoke` | **Pending** Account administration operations/records; passkey login/registration and own-session logout already exist |
| `signin-link`, `member-link` | `signin.link` and the explicit next link client cover owner link issuance; **pending** Account/Setup UI. Browser sessions cannot mint links through its HTTP door |
| GET/POST `/login/CODE` | Existing confirmation-only GET and atomic POST spend/session creation |
| POST `/logout` | Existing same-origin, CSRF-protected own-session logout and access refresh |
| POST `/passkeys/options`, `/passkeys` | Existing fresh-session, CSRF-protected registration |
| POST `/login/passkey/options`, `/login/passkey` | Existing expiring challenge, signature, verification and counter checks |
| GET `/faces/AGENT/…`, `/pixel-icons/APP.png` | **Pending** new-side asset serving with appropriate household/agent access; file import alone does not mount these routes |
| Appearance/accessibility preferences and per-member saved settings | `household.preferences`, `household.setPreferences` and member-private Live records preserve imported choices. Shell controls apply look, reduced motion, contrast and zoom across windows; **pending** ground, sound, pixel faces/icons, haptics and one-window layout integration |
| Push subscription/device controls, `push-test`, `push-remove` | **Pending** next notification/device administration; retained push rows alone do not send notifications |
| Piece `settings.json` reads/writes | Rows are imported into `household_piece_settings`; **pending** settings operation/record/client coverage. Built-in service registration is an in-process authority seam, not a settings editor |

Household project Live records and post-commit sharing/access refreshes already
exist in [household/operations.ts](../src/core/household/operations.ts). They do
not constitute a general Setup, token or session record feed. Attribution
accounts are implemented in [household/accounts.ts](../src/core/household/accounts.ts);
they are metadata, not credentials or grants. Built-in service authority lives
in [core/services.ts](../src/core/services.ts).

## Jobs and import boundaries

| Old work | Current next replacement or gap |
| --- | --- |
| Household init/add/commons/artwork commands and household form actions | No periodic job in the old implementation; perform explicit operations or offline migration, not a daemon poller |
| Token/session last use | Accepted next-mode HTTP/MCP admission, session status and incoming Live messages record throttled row-backed usage; pure validity checks and idle sockets do not |
| Browser/session/token expiry checks | Sign-in enforces expiry at authentication; session-cap eviction happens at session creation. Link creation prunes expired links. No separate household expiry timer is installed |
| Legacy HTTP push watch | **Pending** next notification job; do not start old `pushWatch` from next mode |
| Legacy HTTP backup tick launching `loom backup tick` | **Pending** next backup job; do not call the detached old program from next mode |
| Old per-listener settings/store discovery | No replacement poller; next composition selects row stores explicitly |

Sources for the legacy background work are
[http-server.ts](../src/transport/http-server.ts) and
[backup-tick.ts](../src/backup-tick.ts); next composition is
[next.ts](../src/next.ts). Household scope does not replace other pieces' jobs
(Clock, Runtime, Bridges and Attention have their own inventories).

The household importer preserves metadata, credentials, reader/push state and
piece settings, but does not copy context/commons stores, install artwork,
start services, update harness arguments or deploy. The final coordinated move
must account for those files and verify each implemented replacement before
retiring its old caller. This inventory authorizes no live move or deletion.
