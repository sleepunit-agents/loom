# A running body's Memory commands

The shared root registers memory.remember, memory.recall, memory.archive,
memory.restore and memory.forget on its existing
command door. The runtime command catalogue supplies their input schemas.
All require a currently authenticated body and select the file declared
for that body's agent. Inputs cannot select another agent or a path.

Remember accepts a category, title and content, with optional project, TTL
and JSON metadata. Recall accepts a meaning query, optional category/project
and a bounded result limit. Its ranked matches add recall heat.

Archive, restore and forget accept one opaque scoped ID from the current
body's source. Archive optionally stores a private note and removes the memory
from recall; restore rebuilds its embedding. Forget records the deletion in
the private source before removing the memory. Forget is final; restore
applies to archived memories. Replaying a completed change returns its
original IDs, including after the forgotten row no longer exists.

Results contain opaque scoped IDs, such as art:<uuid>, and recall scores.
Read title and content with the existing GraphQL field
memoryProjectMemory(id: id). That read enforces current private Memory
visibility. Titles, source paths and memory words do not enter the shared
write receipt; its input fingerprint uses the existing configured key.

The private source owns pending reservations and completed receipts. A
pending operation ID is reserved against other commands during embedding.
A separately owned SQLite connection commits the Memory effect and its
source receipt together. Current body authority is checked again before
commit; failure rolls back the effect. Recovery preserves the original
thirty-day retry deadline. Retrying an already completed recall does not
add heat again.

Only fresh declared-file creation prepares these private metadata tables.
Startup and recovery do not upgrade an existing source. An unprepared
source remains readable and its semantic commands return unavailable until
the separate data move prepares it.

This is the canonical command/source side. The general native MCP
consumer is built on t-2241. Exposing the remaining semantic changes
(drafts, ratification, editing and version history) through that path is
still on t-2243; their existing core/stdio helpers remain. No installed
service or real source is changed by this implementation.

## Native private cards

memory.personWrite and memory.projectWrite author cards in the current body's
own declared source. They accept the existing card fields and merge behavior;
they return scoped opaque IDs for memoryPerson(id:) or memoryProject(id:).
A project alias resolves to its canonical card ID. Card statements and links
never grant access or change household membership or project sharing.

memory.personRestoreRevision restores a retained revision belonging to the
named own person card; memoryPerson(id:){history{id}} supplies its revision ID.
It snapshots the displaced card first. The private source owns a typed UUID-to-slug reference map. Shared receipts retain only opaque IDs and
keyed input fingerprints. The source card, revisions, aliases and private
receipt commit together, and completed retries do not repeat the mutation.

Card stores borrow the source writer's prepared connection and transaction.
They neither migrate nor close it, and publish no touch before its outer
commit. A borrowed writer refuses calls outside a source transaction. Existing
standalone card stores retain their own transaction and notification behavior.
No caller-selected agent, path, directory or grant is accepted by these native
commands. Existing unprepared sources remain unavailable for writes.

Private card-reference metadata has Drizzle definitions and offline generated
DDL. Fresh source preparation creates it alongside the existing semantic
preparation. Existing semantic-only sources keep their original preparation
fingerprint and remain usable for remember/recall/lifecycle commands; card
commands return unavailable without changing those files. Only the separate
data move explicitly prepares existing sources. Ordinary startup, reads,
recovery and command admission never create the missing reference tables.
