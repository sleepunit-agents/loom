# Activity on the new side

Activity at `/p/activity-preview` reads existing private agent episode databases
selected by household database metadata. It creates no content tables, imports,
watchers, polling jobs or default-home discovery. Connections are retained read-only;
missing files stay missing until restart. Content never moves into loom.db.

| Existing surface | New surface |
| --- | --- |
| `/activity` and its `who/where/what/day/e` address | `/p/activity-preview/` with the same filter and reader parameters |
| `activityView`, three days and Earlier up to thirty days back | `mind.activityList`, scoped `activity.window` live records; each Earlier adds one three-day subscription |
| `openEntry`, digest or moved conversation | `mind.activityRead`, `activity.entry`, through the new synchronous `ActivityConversations` role |
| `tapeRows`, episode reader | Retained existing `memories.db`, active unexpired episodes, full reader up to 20,000 characters |
| Conversation digest, moved conversation and steps IO | New role only; explicit unavailable until its owner is composed |
| Who / Where / What, shown-day counts and hourly strip | Kit Split folders, narrow filter menu, hourly jump, OR within groups and AND between groups |
| Read story, asked/decided, task/PR links, other runs | Live entry reader, new Tasks destination and owner-supplied new Comms destinations |
| `whatOf`, `venueKey`, `dayBefore`, `oneLine`, `refsIn`, episode title cleanup | Pure Activity-local helpers; no old IO imports |

There were no Activity write actions, CLI commands, background jobs or content
imports to port. The old fetch/JSON view and cached page are deliberately absent
from the new app. Earlier windows remain in the shared data store, not in a second
app cache. Filters and selection live in the address; only the number of requested
windows persists for the window session. There are no requests or drafts to replay.

## Conversation owner contract

`src/pieces/mind/activity-role.ts` is the minimal synchronous seam. Its list
filters access before bounding; returns digests and moved conversations with no
digest in that window; and its reader and conversation lookup enforce the same
member policy. It supplies safe plain titles, metadata and only authorized sibling
run titles. Comms rows always name their member, even for the household owner.
`needsForMember` identifies who may see a run's needs and destination. Text cards
are not steps. Role failures/malformed output preserve the episode section and
show an error instead of implying an empty household. Source errors are generic.

Activity separately checks memory/agent visibility and conversation/agent/member
visibility with unchanged central policy. It never puts project scope on private
agent records. Episodes about Comms, including mislabeled terminal episodes, need
an authorized conversation lookup. Until that new owner is available, episodes
naming conversations are withheld rather than reading old stores to infer access.
Standalone episodes still work. A Comms episode without a conversation id is
withheld. This is an explicit unavailable dependency, not an old-store adapter.

A window has at most 600 visible entries; truncation is explicit. Visible episodes
are bounded after access/deduplication. Digests suppress covered episodes and nearby
same-agent/same-venue episodes (twenty minutes). Source notifications and new role
change events refresh windows and open readers. Expiry uses the supplied clock at
actual expiry/day boundaries, including DST. Missing/gone/unauthorized readers give
the same not-found answer. Offline and denied feeds render no retained content.

## Final coordinated move

The coordinator wires the NEW Conversations/Comms role; it must emit `conversation`,
`digest`, or `comms.*` changes for new/changed/removed content and return its next
expiry deadline. No old conversations/comms program or database is permitted.
Use the household database's timezone, owner and GitHub owner metadata. Verify
existing listed agent memory paths in the copied home, ensure no competing source
listeners, and start/verify next mode only at the coordinated move. This PR makes
no host rollout, installed piece, systemd or real import changes.

Validation is in-process with fake clocks plus one hosted-only two-window browser
test behind `CI` and `LOOM_ACTIVITY_EVIDENCE=1`. Self-hosted evidence is refused
before launch. Hosted artifacts contain six Neon Noir/Daylight shots at 390, 1280
and 1920 wide and the actual browser JSON report; ordinary CI skips that browser.
