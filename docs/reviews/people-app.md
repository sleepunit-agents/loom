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

## Round 2

Frozen pre-rebase commit 482a5adc80c40a7a0e3cc3791247187d37497370; tree
`sha256:9a34f89651c9a67450d422b48367a8789b298fd06d3861ae5f4e78af8243eda0`.
Current review ledger excluded from archive and patch. Raw verdict BLOCKING.
GitHub later reported CONFLICTING; rebase onto 9148234 changed only the conflicting
CHANGELOG insertion, preserving both Clock and People entries; resulting head
8b03ab21561d29ebae368c131517ad938e46977a. No merged branch was rebased.

- NIT, repeated save predicate: folded into saveFrozen.
- CRITICAL, partial completion extends expiry: folded. New half/core receipts retain the earliest source expiry; test completes on day one and reuses the id at original day thirty.
- CRITICAL, access link reload loses draft: folded. Internal links use shell go; window-local draft/request state survives shell docking/remount. Tests actually unmount and remount and assert the retained pending save; sharing click prevents reload.
- CRITICAL, Projects destination not installed: folded as unavailable-state implementation. People now shows project references without dead links until composition supplies a registered destination. The remaining Projects app unit on t-2207 owns the destination; next.ts enables it when mind.projectsList is installed. docs/mind-piece.md carries the remaining work explicitly. Contract clarifies this beside-old dependency rather than requiring the absent app in this PR.
- CRITICAL, relationship metadata search missing: folded. Search includes authorized relationship agent ids and directory display names; test searches the relationship agent.
- MAJOR, global-id conflict coverage missing: folded. An unrelated registered write cannot use a partial creation's id after restart.

Author inspection also found default contact staleness differs from the first
projection: old cards use fourteen days and strict greater-than. Restored that
rule and tested both explicit/default thresholds before and after the exact
boundary. Tests with a populated private project now discriminate the
person-only service grant as well as the populated private memory.
After folds: 73 affected tests, root TypeScript and web build pass.

## Round 3 — bounded end

Frozen commit d67b9212c6deeb99052168befe5a1fc1870890c7; tree
`sha256:92905660326f59a93304f8c77c7227aecfd7896f4153ff0ab61e10bbe35a44ad`.
Current ledger excluded. Raw verdict BLOCKING / UNCONVERGED. No fourth round.

- MAJOR, component tests separate from source: folded. Tests now sit at web/src/pieces/people/index.test.ts; browser integration retains the repository's required src/ui placement.
- NIT, conversation link repeats navigation logic: folded into internal.
- CRITICAL, generic CI could run browser on a lab runner: folded. People evidence now runs only in the existing app-kit workflow's hosted ubuntu-latest after job. General CI lacks its explicit opt-in flag. A self-hosted environment with the flag fails before launch. Runner contract test guards the split. The inspected prior CI job actually used GitHub Actions' ubuntu-latest runner; no local browser ran.
- CRITICAL, label hides raw contact handle: folded. Projection retains label and value separately; backend/UI tests assert both for a Slack id with a friendly label.
- MAJOR, destination/fallback callbacks not exercised: folded. Backend fixture injects projectHref and asserts the resulting encoded destination; UI asserts a supplied destination and explicit unavailable fallback.

Additional author correction after frozen bytes: creation now exactly matches
old slugOf's NFKD normalization, letter-leading and forty-character cap. Tests
cover accented/digit-leading names, long names and a name without letters.

Final author judgment: all identified defects folded and checked; no known
blocking defect left. This is an unconverged bounded review, not cold-clear.
After folds: 100 affected tests, root TypeScript and web build pass. Exact-head
CI and hosted People browser/screenshots remain the merge gate. No host rollout.
