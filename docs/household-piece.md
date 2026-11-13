# Household on the new side

The household piece holds household metadata, agents, members, tokens, sessions,
passkeys, one-time links, push state, member preferences and read marks, and piece
settings in `loom.db`. It reuses the lossless, keyed household row stores already
in core. Existing commands and the old server continue using their current stores.
The importer does not enable any new request path or change the running household.

## Importing for the final move

With the owner present, stop both instances and back up the old home. Run:

```
loom migrate household --home <new-home> --from <stopped-old-home>
```

Both homes must be different directories, and the new home cannot be inside the old one. The destination's household tables must
be empty. The command acquires the destination daemon gate and uses one database
transaction for schema, rows, comparison and receipt. Source files are read only.
The importer compares full reconstructed content (including all ids, optional and
unknown fields), and rechecks the source checksum before committing. Repeating
an unchanged source is a no-op; a changed source is refused, even after later
changes on the new side. A no-op never resets live state to the imported state.

`ui-cookie.key` stays a file, copied byte for byte with exclusive creation and mode
0600; a different destination key is refused. An interrupted import can leave that
same key behind, harmlessly; retry accepts it. No secret is re-minted. Token
hashes, session bindings, passkey public keys/counters and push keys survive exactly.
Missing optional token/session files mean empty stores. A source session file
requires its cookie key; malformed documents fail rather than silently signing
people out. No import runs automatically at startup.

After all pieces are imported, start the new server on the new home and verify
sign-in and stdio continuity. This importer never deletes or rewrites old data;
reverting means restarting the old server on the untouched old home. Context and
commons stores and other key files must be copied as part of the overall move;
they are not app tables and are not imported here.

## Old-to-new mapping

| Old state | New rows |
| --- | --- |
| household.json | household_settings, household_agents, household_members |
| tokens.json / tokens.used.json | household_tokens / household_token_use |
| ui-sessions.json sessions, links, challenges, passkeys | corresponding household tables |
| ui-sessions.json push | household_push |
| ui-sessions.json per-member preferences/read marks | household_readers |
| ui-sessions.json first-owner preferences/read marks and remaining metadata | household_settings envelope |
| pieces/*/settings.json | household_piece_settings |
| ui-cookie.key | byte-identical key file |

The command/route/job replacement table, next-mode authentication, owner operations,
generated clients, offline continuity and Setup screen remain tracked by t-2203.

## Stdio metadata composition (new side)

`src/continuity/household.ts` is the explicit read-only metadata seam for the
new stdio composition. `readContinuityHousehold(home, agent?)` reads an existing
`loom.db`, chooses the named agent or household default, and returns ownership,
context and commons paths. Each call closes its connection and takes a fresh
snapshot; it sees committed WAL data while a daemon is up, too. It never opens
old JSON, migrates tables, creates app records, or runs jobs. SQLite may create
its WAL/SHM sidecars for a read-only connection; immutable mode is deliberately
avoided because it can miss a daemon's committed WAL.

`continuityTarget({home?, agent?, contextDir?})` makes the composition explicit:

- A home without a context chooses the named agent or household default.
- An explicit context inside that home's `agents/` chooses that registered
  agent, including through symlink aliases; an unknown agent is an error.
- An explicit standalone context needs no app database. It takes precedence
  over the home/agent selection.
- A missing database, absent schema or inconsistent household rows fails
  loudly when a household was selected. An import receipt never selects a
  backend, and contradictory old JSON has no effect.

This is a composition prerequisite, not the completed stdio cutover. Existing
`householdOf`, `contextFromHome`, CLI and MCP entry points still behave exactly
as before. The next stdio composition must pass this metadata to identity's
Owners block, knowledge and people paths, with end-to-end two-agent and
standalone identity/memory/knowledge/people tests before its entry point ships.

The People/Owners consumers now accept explicit selection too:
`createLoomServer({contextDir, peopleSelection})` passes a trusted
`{household, agent}` snapshot to every person tool, the Owners block and the
identity room cards. `readContinuityHousehold` supplies that shape directly.
Passing `null` selects only the standalone context; omitting the property
retains legacy JSON discovery. Selection stays per server, with no global path
registry or environment changes. Person ensure/merge helpers accept the same
selection for later new-side route composition. The room reader closes its
explicit store and keeps its existing rendering limits and failure handling.

Knowledge tools now also accept explicit selection (`knowledgeSelection` on
`createLoomServer` and `registerKnowledgeTools`). Every call, including freshness,
uses the selected commons or standalone database without JSON discovery or the
legacy knowledge-path environment override. Omitted selection preserves existing
callers. Maintain receives the explicit People selection for its person-page
check; isolation checks inspect the selected knowledge path, including hard links.

This still does not enable a new stdio entry point: the remaining server household consumers must be composed explicitly before that
entry point is exposed. The new MCP continuity tests cover two simultaneous
agents' Owners and room cards, shared directory/private relationships,
standalone override beside legacy JSON, and an agent-scoped merge with the
other agent's relationship database unchanged.

Conversation list/view readers accept `conversationSelection: {household, agent}`
(or `null` for standalone) on `createLoomServer`. Explicit readers use the
context's conversation records and core's generic render, with core venue labels
or the recorded venue name. They never discover installed venue pieces, open the
legacy venue registry, or run an external renderer. Omitted selection preserves
legacy venue rendering. `homeFor` also accepts the selection for subsequent
composition. This slice does not change the house conversation gate, digest,
profile, Comms, or project-hub composition, and exposes no new entry point.

During the remaining memory cutover, explicit knowledge isolation checks both
`<contextDir>/memories.db` and the active legacy memory environment override.
An override cannot hide a hard link between local memory and selected knowledge;
the active legacy store also remains protected. Memory tools still need explicit
routing before the new stdio entry point can ship.

### Next sign-in transport

`startLoom({home, next: true, publicUrl})` composes row-backed household,
TokenDatabase and SessionDatabase credentials for HTTP, MCP and live sockets.
`serve --next` passes `LOOM_PUBLIC_URL` as the trusted external origin; configure
it for TLS termination and WebAuthn. Forwarded headers never choose authority.
Browser cookie requests to API/MCP require `x-loom-csrf`, obtained from the
session status endpoint. Socket operation messages carry the same proof in `csrf`.
Bearer tokens identify members or agents and never
assert that a browser window is present. Runtime/review credentials are refused
until their trusted service composition exists.

| Next route | Behavior |
| --- | --- |
| `GET /auth/session` | Current member and session-bound CSRF token; no-store |
| `POST /auth/token` | JSON `{token}` opens a browser session for a live member token |
| `POST /auth/link` | JSON `{code}` consumes an existing unexpired one-time link atomically with session creation |
| `POST /auth/passkey/options` | Creates a bounded, expiring login challenge for the configured public URL |
| `POST /auth/passkey` | Verifies an existing credential's assertion, consumes challenge and advances counter atomically |
| `POST /auth/logout` | Requires cookie plus CSRF, ends that session and clears cookie |

Existing imported cookie IDs and cookie key bytes are preserved. At next-mode
startup, existing owner tokens are bound to their original member in household
settings so replacing the first owner cannot reassign an old credential. The integration
test removes the stopped source home before starting next mode and verifies its
browser cookie/CSRF and old bearer token on the real API. Old JSON on the new
home is ignored. These routes return JSON; the sign-in screen, new passkey
registration, token/link creation and owner session management are still required
follow-up work. No running home is imported or activated by these routes.
