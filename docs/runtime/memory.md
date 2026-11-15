# A running body's Memory commands

The shared root registers memory.remember and memory.recall on its existing
command door. The runtime command catalogue supplies their input schemas.
Both require a currently authenticated body and select the file declared
for that body's agent. Inputs cannot select another agent or a path.

Remember accepts a category, title and content, with optional project, TTL
and JSON metadata. Recall accepts a meaning query, optional category/project
and a bounded result limit. Its ranked matches add recall heat.

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
(drafts, ratification, archive, restore and history) through that path is
still on t-2243; their existing core/stdio helpers remain. No installed
service or real source is changed by this implementation.
