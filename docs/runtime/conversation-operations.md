# Conversation mutation composition

`registerConversationOperations(operations, commsMessages, {authorize})` registers
the shared-schema `comms.open`, `comms.send`, `comms.change`, `inbox.answer` and
`inbox.read` and `inbox.dismissResult` operations. Both services must use the same SQLite connection. The
root installs this instead of the old Comms/Attention operation registrations;
installing both would duplicate operation names. This adapter does not bootstrap
the data schema or switch the root. The root supplies OperationResults and DataWrites to Operations on that same
shared database; no legacy core retry-table bootstrap is needed.

All six are writes from a signed-in member window, through the shared HTTP or socket
door. The HTTP root admits a window only from a current member cookie; a bearer,
including one accompanying a cookie, is not a window. Dispatch with `callAsync` and the door's current-authentication predicate.
The predicate is essential: a captured Viewer alone cannot prove that a session
remains signed in after encryption. The adapter uses the same member identity for
message sender, thread creator, answerer and Inbox read mark; these identities are
not input fields.

`authorize(viewer, access)` is a required synchronous current-policy callback.
The adapter resolves existing thread/conversation or Inbox records on each call;
thread changes include their exact change kind so read and stop can use distinct
authorization rules.
The callback receives current records, not input-supplied scope. It runs before
encryption, after encryption inside the final operation transaction, and before
receipt replay. It must be read-only and must apply the approved policy for each
action, including recipient-only answers, private-thread scope, current agent
ownership for sending work, and task-source project precedence. The adapter does
not supply an allow policy. Missing/deleted targets fail closed, including retries
after deletion. Root authorization and authentication are separate obligations.
Open requests include the target ID and any current thread/conversation; retries
reject tombstones and changed thread identities before consulting creation policy.

Prepared private writes encrypt outside the transaction and commit inside the
operation transaction. The adapter selects `CommsMessages.prepareAnswer` for
private questions and the shared Inbox answer service for ordinary questions.
Task/approval/secret questions are answered at their source, not through this
adapter. `inbox.read` marks only the item that was opened; answering never marks
it read. Thread read sequence is an explicit `comms.change` action.

Inputs use the injected key's keyed retry fingerprint. Outputs contain only IDs,
sequence or `{saved:true}`. Neither plaintext nor ciphertext enters a generic
operation result or retry receipt. Prepared closures remain in process. Changes
are collected through `Context.changed` and publish only after commit; the root
maps these shared table names to its generated subscriptions and Tempo hooks.
Deletion invalidates messages, Inbox and references as well as thread metadata.

Agent production and worker delivery use the typed `CommsMessages` and
`ConversationMail` interfaces, not these member-window operations. Never put
decrypted worker deliveries in an Operations result or a persisted job brief.
Generated read projections, decrypted query fields, root wiring, UI adoption,
action-result notices and removal of the replaced paths remain on t-2237 and its
coordinating rebuild tasks. No additional read endpoint belongs here.

`inbox.dismissResult({id})` acknowledges the current signed-in member's own
`action_results` row. It cannot dismiss someone else's result, preserves the
first read timestamp, returns only `{saved:true}`, and publishes `actionResults`
after its receipt commits. Ownership is checked again before receipt replay.
