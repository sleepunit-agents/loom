# People app review

Required review: source retry-metadata migrations. High: source data effects,
central-policy boundaries, cross-source retry contract and source notifications.
No permission rule, sign-in/session implementation, credential, new content schema,
real store or host rollout changes. Three rounds maximum under the standing rule.

Claim: People preserves its screen actions and independently authorizes existing
source projections, with resumable creation and live updates.

## Round 1

Frozen commit 01a9477f7c5d2d84e6114723fafbbd2c9a7ee793; tree
`sha256:7ba7aa9b643b29ad9110bcfed80803c9733d872fa8e52b956ce5f2252578f830`.
Raw verdict BLOCKING. Source: git archive + diff origin/main; frozen copy at
`~/scratch/people-app-review/round-1/tree`. Raw output retained in the evidence note.

- NIT, projection breadth: accepted trade-off. The bounded read projection keeps each source's read transaction together; helper extraction is optional.
- CRITICAL, person-only service could read memory evidence: folded. Separate central memory policy check; service regression has real memory content.
- CRITICAL, id reuse after expiry: contract misread, clarified. The existing registry and Mind contract explicitly expire receipts after thirty days; global conflict protection applies inside the original window. No new permanent id reservation. See docs/mind-piece.md, Knowledge page actions and durable retries.
- CRITICAL, project changes fail to refresh: folded. Refresh on project notifications, tested with an outside project archive.
- CRITICAL, browser run possible outside CI: folded. Browser test requires CI explicitly; no browser was run locally.
- MAJOR, fixture bypassed session auth: folded. Removed injected authentication and sharing; disposable fixture now uses the real one-time-link/session resolver throughout.
- MAJOR, expiry tests missing: folded. Actual WebSocket windows/FakeClock cover evidence expiry and contact staleness at the exact deadlines.
- MAJOR, project and ownership tests missing: folded. Real ProjectsStore fixture and screen assertions exercise linked alias projects, owner roles and rendered destinations.
- MAJOR, conversation role/fallback tests missing: folded. Live subscriptions exercise viewer-bound fake results; screen test covers supplied links and absent-role fallback.
- MAJOR, navigation retention test missing: folded. Draft/request survives navigation away and back in addition to offline state.
- MAJOR, partial retry authorization test missing: folded. Revoking authorization after the first half prevents completion.

After folds: 47 focused tests pass, root TypeScript passes. The already-added
source-notification/expiry and redirect/archive tests are part of this revision.
