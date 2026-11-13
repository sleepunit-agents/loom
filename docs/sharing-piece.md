# Household project sharing

`installSharing(app, home)` registers the database-backed household project
operations for the next side. It migrates only the already-defined household
tables and reads only `loom.db`; an empty home needs no import receipt to install.
The next composition calls it before installing tasks and supplies its returned
sharing reader to pieces. Old startup never calls it.

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
