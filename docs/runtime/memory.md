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
(drafts and ratification) through that path is
still on t-2243; their existing core/stdio helpers remain. No installed
service or real source is changed by this implementation.

## Native edits and saved body versions

memory.update accepts one own opaque ID and changed content, metadata, or a
feedback observation. A changed body saves the displaced version first.
memory.restoreRevision accepts that ID and an integer revision_id belonging
to the same memory. It saves the displaced body before restoring the old one;
replay does not add another revision. Neither command chooses another source.

memoryHistory(id:) on the canonical GraphQL door returns the newest ten
retained versions (id, op, replacedAt, content) under current private Memory
visibility. This explicit history read includes retained versions of archived
or expired rows. Restoring a body version does not unarchive the memory or
renew its lifetime; memory.restore is the separate archive restoration.
Shared command receipts contain only opaque IDs and keyed fingerprints;
private effects, versions and receipts commit together and roll back if the
current body's authority ends before commit. Draft browsing remains separate.
