# Projects on the new data path

Projects reads the existing private agent databases selected by household database
metadata. This follows the explicit private project selection in #923; it never
opens a legacy default home, commons memory store, JSON inventory or piece program.
Missing files stay absent until restart. No content schema, import or migration
is added. The project card is the existing card; its hub is computed per viewer.

| Existing screen | New surface |
| --- | --- |
| Projects cards, every agent, active / paused and done | `mind.projectsList`, `project` live records; kit Split card list |
| Agent project hub and alias | `mind.projectRead`, scoped `project.hub`; `/p/projects-preview/project/<encoded-agent:slug>` |
| Waiting / Lately / seven day activity / people / repos / Changes counts | Computed from independent role sections and source projections |
| Goal and where, stale markers | Existing private project card fields |
| Memories | Existing agent SQL; 20 newest plus 10 highest salience, union by ref; active/unexpired slug and alias matches |
| People | New Mind role, directory and same-agent relationships, hyphens mapped to underscores |
| Tasks | New Tasks role; epic descendants, name matches, waiting / ready / blocked or in progress / done lately |
| Changes | New Changes operations; authorized records selected by names and normalized repo selectors |
| Notes and Conversations | Own synchronous `ProjectSectionRole` interfaces with test fakes; unavailable until their new owners are supplied |

Old project MCP maintenance commands (write, verify, archive, restore, history,
revision restore, orphans) have no controls on these read-only screens. They are
outside this app unit and continue through existing source writers. No replacement
CLI is needed for these screen reads. Project selection never grants private agent
content through project membership; every memory and relationship is authorized
by its own central type and agent scope. Roles receive the original viewer and
must enforce their own policy, including member-private conversations.

Tasks is first, as the owner's current ruling requires. The kit Split replaces
the old card grid. Paused/done cards are folded into a folder that opens when no
active projects exist. Their index projection does not call section roles; an
explicit hub still does. There is no feed cache, polling or asynchronous operation.
A failed section keeps the rest of the hub. Absent roles say unavailable; waiting
counts say they are incomplete rather than claiming zero. The old executable feed
seam and its timeout/cache do not carry into the new synchronous role model.

The Tasks role retains the legacy `jonathan` assignee as the household owner's
queue, as well as a task addressed to the viewer's canonical id. Only an actual
household owner gets that legacy queue. Readiness comes from Tasks before visibility
filtering, preserving hidden blockers. Links open the new Tasks/Changes/People apps;
memories open a scoped full-body reader inside Projects, using a separate memory policy check. Note metadata has no invented destination before its owner supplies one.

Notes roles must select `card.links.notes` prefixes (default the slug), deduplicate,
exclude expired notes, return newest twenty and total, plus latest activity and
next expiry. Conversation roles must select twenty newest project conversations,
preserve summary/who/venue/last and member-only asks, and supply destinations in
the new Comms/Inbox apps. Optional `expires` on a section schedules its next live
refresh. No legacy conversation or digest IO is used.

Outside project, memory, person, task, change, note and conversation notifications
refresh derived records per subscriber. Memory expiry and field staleness use the
fake-clock-compatible Live deadline mechanism. UI filters survive tile remounts;
all reads use `useRecords`, and the screen has no writes to replay.

## Final move

No host changes are included. The coordinator must assemble a copied home, verify
household metadata and existing source paths, wire the new Notes and Conversations
roles, avoid competing source listeners, and start/verify next mode during the
final coordinated move. There is no Mind importer. Activity remains a separate
unit of t-2207, which stays open until all four apps merge.
