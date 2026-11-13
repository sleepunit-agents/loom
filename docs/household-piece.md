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

This still does not enable a new stdio entry point: knowledge routing and the
remaining server household consumers must be composed explicitly before that
entry point is exposed. The new MCP continuity tests cover two simultaneous
agents' Owners and room cards, shared directory/private relationships,
standalone override beside legacy JSON, and an agent-scoped merge with the
other agent's relationship database unchanged.
