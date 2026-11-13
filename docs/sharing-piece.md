# Household project sharing

`installSharing(app, home)` registers the database-backed household project
operations for the next side. It migrates only the already-defined household
tables and reads only `loom.db`; an empty home needs no import receipt to install.
The default `startLoom` composition calls it before installing tasks and reads
sharing from the database. A composition that supplies its own listener installs
pieces explicitly and can use the returned sharing reader. The `--next` CLI and
listener are the separate frame task in t-2190; old startup never calls this hook.

| Existing foundation operation | Screen action |
| --- | --- |
| `household.createProject` | Create a named project and its member/agent lists |
| `household.setProjectMembers` | Save the project's members |
| `household.setProjectAgents` | Save the project's agents |
| `household.project` live records | List projects and show their current sharing |

There is no old piece program or CLI to replace. All checks use `src/policy.ts`.
The `household.sharing` live record supplies member and agent choices only to a
household owner. It holds no new persisted data. The screen reads it through
`useRecords`, submits through `call`, and shows errors inline. Other viewers see
an explanation instead of editing controls. The server still rejects their writes.

Choices: projects created here start with an empty repository list; this is a
sharing screen rather than a project-card editor. Member and agent lists save
separately using the existing operations. The fixture's default sharing reader
comes from its household tables, so changing a project changes task visibility.
Explicit injected sharing remains available for central policy tests.

The final move imports household metadata and tasks with all the other pieces,
starts the whole new side, and verifies sharing before old stores are retired.
There is no per-piece cutover switch. See [tasks-piece.md](tasks-piece.md) for
the task import procedure and the web foundation's “Moving there” for the move.

Owners can set optional public agent attribution with
`household.setAgentAccounts({agent, accounts: {github: [...]}})`. GitHub logins
are normalized to lower case, duplicates collapse, and a login cannot belong
to two current household agents. An empty list clears the mapping. Unknown
agents and non-owner writes are refused. These are public account names, never
tokens or permission grants; matching a login does not authorize a caller.
`HouseholdAccounts` reads the metadata from existing household settings rows
keyed by agent, without changing the lossless imported agent-id rows or reading
legacy files. The owner-only `household.sharing` record includes the mappings.
Changes daemon composition will consume this metadata; this operation alone
does not start GitHub synchronization or open merge controls.
