# A running body's Memory commands

The shared root registers memory.remember, memory.recall, memory.archive,
memory.restore, memory.forget, memory.propose and memory.ratify on its existing
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

Propose stages a private proposal without embedding or making it recallable. It
returns a distinct scoped proposal ID, such as art:proposal:<uuid>. Ratify
accepts that ID and optional title, content, category, project or TTL edits;
normal authored validation and episode defaults apply before it becomes a
real memory. The memory write and proposal removal share the source receipt
transaction. Failure retains the proposal; successful replay works after its
removal.

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

The native runtime's ordinary Root tools discover and call these commands.
No installed service or real source is changed by this implementation.

## Native private cards

memory.personWrite and memory.projectWrite author cards in the current body's
own declared source. They accept the existing card fields and merge behavior;
they return scoped opaque IDs for memoryPerson(id:) or memoryProject(id:).
A project alias resolves to its canonical card ID. Resolving a person opaque
reference does not report a merge; mergedFrom names only an actual redirect. Card statements and links
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


## Native edits and saved body revisions

memory.update accepts one own opaque ID and changed content, metadata, or a
feedback observation. A changed body saves the displaced revision first.
memory.restoreRevision accepts that ID and an integer revision_id belonging
to the same memory. It saves the displaced body before restoring the old one;
replay does not add another revision. Neither command chooses another source.

memoryHistory(id:) on the canonical GraphQL door returns the newest ten
retained revisions (id, op, replacedAt, content) under current private Memory
visibility. This explicit history read includes retained revisions of archived
or expired rows. Restoring a body revision does not unarchive the memory or
renew its lifetime; memory.restore is the separate archive restoration.
Shared command receipts contain only opaque IDs and keyed fingerprints;
private effects, revisions and receipts commit together and roll back if the
current body's authority ends before commit. Proposal browsing uses the retained read surface below.

A receiving body's Identity
---------------------------------

`memoryIdentity(agent: ...)` reads the declared agent folder's IDENTITY.md,
preferences.md and self-model.md, plus an assembled top-of-mind digest and
recent authored episodes. The current private Memory visibility rule applies;
being on a project together does not grant access. File targets must remain
inside the declared folder. No source is created or upgraded by this read,
and global source/timezone overrides are ignored. Expired memories and old or
future episodes are omitted. The response says when the snapshot was read.

The receiving body loads its Identity through its ordinary authenticated query
client after accepting mail and before calling its model. The private text
joins only that model's input; it never becomes a shared assignment, job brief,
status or receipt. The generic model/MCP factory remains unchanged.

Retained archives and pending proposals
---------------------------------

`memoryArchive(agent:, first:, before:)` and `memoryProposals(agent:, first:,
before:)` browse the declared agent's retained source under current private
Memory visibility. Project membership alone grants neither read. Archive pages
include archived memories even after expiry; proposal pages include only pending
proposals. These explicit retained reads do not make either kind active or
recallable, and they do not renew a current-memory freshness lease.

Each page returns `entries` and `nextBefore`. The default page size is 50,
with a maximum of 200. Pass `nextBefore` as the next request's `before` until
it is null. Entries follow descending source row order. The cursor is an exact
signed SQLite integer encoded as text; it grants no authority and cannot select
a file. Nullable fields preserve old source shapes and rough proposals. An older
row without a UUID has a null ID rather than receiving a newly written ID.
Missing or undeclared sources return null; an existing source with a missing
table returns an empty page. Reads never create or upgrade either.

Archive entries expose their retained note and archive time as well as the
memory's original expiry. `expiresAt` preserves the stored timestamp text; it
is not the numeric freshness deadline returned by active-memory reads. Proposal IDs use `agent:proposal:<uuid>`, distinct from
active memory IDs. Retained reads and proposal authoring use separate
selections on the same declared source.
