# Measuring settings presentation

`web/src/pieces/measuring/settings.tsx` exports `MeasuringSettingsProposal`
and `MeasuringChange` for the normal owner settings and approval flows. They
are not mounted yet: the shared root and Approvals owner supply their data,
route and callbacks. No endpoint or permission rule is added here.

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

Inside the resulting approval card, pass `MeasuringChange` the validated
persisted before/after from its details. The shared Approvals presentation
owns Allow/Deny, current access checks, stale-card failures and the result.
Do not show this component for an unvalidated arbitrary details object.
After the outer approval transaction commits, reload Measuring; await its
close before closing the shared database. No SDK or database work runs in
these components, and no monitoring settings are sent to a separate store.

This unit implements presentation only. The shared root must mount the form
in the owner flow and the change card in Approvals; it must not add a visible
Measuring tile to a never-configured household. Request/operation/job dispatch
instrumentation and generated timing reads remain separate integration work.
