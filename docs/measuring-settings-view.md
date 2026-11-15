# Measuring settings presentation

`web/src/pieces/measuring/settings.tsx` exports `MeasuringSettingsProposal`
and `MeasuringChange` for the normal owner settings and approval flows. The
registered Approvals tile and exported live inline card now bind the change
renderer through `web/src/data/work-views.tsx` and the shared generated client.
The proposal form still needs an owner flow and authenticated command callback.
No endpoint or permission rule is added here.

Pass the proposal form an authoritative `MeasuringSettingsSnapshot` with
status `live` and the current four settings, or `loading`, `offline`, or
`denied`. Non-live states remove cached values and drafts. A changed current
value starts a fresh draft. The form shows each proposed value beside its
current value, including retained settings when measuring is off.

`propose(after)` requests a durable approval using
`measuringSettingsService(db).prepare(after)` and the shared `approvalService`;
it must not apply settings directly. Resolve after the request is stored,
not after Allow. Reject when requesting fails. A successful request disables
the form until committed settings change or the parent remounts it. Rejected
requests can be retried. Errors are displayed without transport details.
The server remains responsible for validating all values and authenticating
the current household owner; hiding a form is not authorization.

The shared `approval-view` tile and `ApprovalCard` both accept
`renderChange={renderMeasuringChange}` imported from the Measuring settings
module. The callback validates kind/target, strict persisted before/after and
the exact change summary using the same pure validator as the settings service
(`src/core/measuring/change.ts`). Malformed or unrelated changes return null.
The generic Approvals view never parses Measuring internals. Parsing for display
does not authorize or execute the persisted operation; that remains server work.
The callback is only invoked for a current, visible approval in a live snapshot.

Alternatively, pass `MeasuringChange` validated persisted before/after. The shared Approvals presentation
owns Allow/Deny, current access checks, stale-card failures and the result.
Do not show this component for an unvalidated arbitrary details object.
After the outer approval transaction commits, reload Measuring; await its
close before closing the shared database. No SDK or database work runs in
these components, and no monitoring settings are sent to a separate store.

The shared root must mount the form in the owner flow and place the live change
card in conversations; it must not add a visible
Measuring tile to a never-configured household. Request/operation/job dispatch
instrumentation and generated timing reads remain separate integration work.

The actual lazy Approvals registration now reaches the generated view and
Measuring renderer; the reachability check passes without exemptions. The root
still must compose the authenticated live endpoint and command callbacks before
this is proof of working behavior in the running program.
