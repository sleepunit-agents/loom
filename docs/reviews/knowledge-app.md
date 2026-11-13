# Knowledge app and source composition cold review

Scope: the Knowledge app, next-mode source identities and complete transport /
reader lifetime. The artifact is the PR diff; the frozen tree supplies context.
Review ledgers are excluded from subsequent freezes.

Assessment: high. (1) Existing receipt metadata migration is activated on selected
stores; (2) source identity boundary and policy-driven UI; (3) operations/live app
contracts; (4) sockets, shutdown and retained retries; (5) next-mode composition
and CI browser evidence; (6) affected tests reverify the claims, so this final
trigger does not apply. No tier reduction. Claim: Knowledge should operate end to
end on the new side without losing request identity or source lifetime. This
claim did not enter the review prompt. At most three rounds; no fourth read.

## Round 1

Frozen commit dee3cc55bddd19bc56d22149c45e5b18dee71053.
TREE sha256:cf01111130727e1f1c082eb2b6e15f56885d05580ad068536861ddfebb399715.
Raw verdict BLOCKING, three critical, four major, one nit.

- Major / valid actionable: untyped wire test frames need a comment explaining
  the intentional erasure. Added that comment.
- Critical / valid actionable: a Reader-local request was lost on disconnect.
  Lifted retained requests into the app, keyed by slug. A focused component test
  disconnects, reconnects, navigates away/back and receives the original failure;
  it asserts no second call and disabled buttons throughout pending recovery.
- Critical / valid actionable: initial feed loading rendered an offline reader.
  Added the loading branch and a component test distinguishing initial loading,
  offline and denied from empty content. Independently added content-free
  knowledge.access policy state to distinguish an empty store from denied access.
- Critical / valid actionable: browser fixture aging used wall-clock content
  timestamps. Seeded explicit verified_at values aligned with FakeClock.
- Major / valid actionable: missing topic/recent/direct-beyond-cap evidence.
  Added browser topic/recent assertions and an in-process 2,001-page fixture whose
  scoped WebSocket target is outside the list cap.
- Major / valid actionable: agent and commons-person binding lacked checks.
  Added source inventory, exact namespace, wrong viewer/type and empty-local-id
  tests for memory, person and project, including absent agents/stores.
- Major / valid actionable: close ordering lacked observations. Reader callbacks
  now assert source endpoints are removed while loom.db remains open on success
  and post-source HTTP startup failure. Added shared concurrent close/restart and
  failing synchronous-reader cleanup tests. Home release runs in finally.
- Nit / valid actionable: a resized desktop was weak phone evidence. Open one
  window at phone width and the other at desktop width; capture the phone image
  from the former, desktop images from the latter.

No known findings left standing after these folds. Round 2 pending.

## Round 2

Frozen commit 54880ed0cfbe276f60ce0649a931707de6a457a6 (before the
GitHub-conflict-only rebase to 59be3f85e151b4cde22efa51331f59c43dea63cd;
only CHANGELOG needed resolution, preserving both entries).
TREE sha256:3772b3af500d49cb506795399212041d7b9af354853656832dc52976ae24fd78.
Raw verdict BLOCKING: one critical, two major, one nit.

- Major / valid actionable: screen reached the shared renderer outside kit.
  Exported the existing pure safe markdown renderer through kit and changed the
  screen to consume that public interface. Web build/kit checks cover the import.
- Critical / valid actionable: post-bind chmod failure leaked the current source
  listener because the group had not yet received its stop function. The binder
  now owns cleanup until it returns successfully. An injected second-source
  chmod failure asserts both endpoints disappear and the group can bind again.
- Major / valid actionable: source markup lacked a discriminating browser check.
  Added citation claim and destination assertions.
- Nit / valid actionable: Due assertion could pass if the filter showed every
  page. Assert Clock tempo is absent before FakeClock advance and present after.

All actionable findings folded with checks; no finding left standing. Third and
final review pending; no fourth round.

## Round 3 — bounded stop

Frozen commit ddd92e8070465e4dd2e8a2616eb3e0c6d0f75570.
TREE sha256:72aeed6bbea61a2b233f73a6d905b967a45e174040ed514d54ff31e6adaefc92.
Raw verdict BLOCKING: one critical, two major. Review is UNCONVERGED; no fourth
round. All three findings were actionable and folded afterward:

- Major / valid actionable: the new chmod-failure server test bypassed startLoom.
  Reworked it to seed metadata offline, then exercise failing and successful
  startup through next-mode startLoom with FakeClock.
- Critical / valid actionable: browser selectors treated a search input as a
  textbox. Corrected every Search knowledge selector to role searchbox.
- Major / valid actionable: browser detection omitted chromium-browser accepted
  by CI. Added that executable and made missing Chrome/build fail explicitly in
  CI instead of silently skipping the Knowledge evidence test.

Convergence audit: all findings folded; critical/major count stayed at three;
none repeats a defect previously reported fixed. The three-round bound wins:
review remains raw BLOCKING / UNCONVERGED, with no known finding left unfixed.
CI browser execution is required before merge.

## Scope correction after the frozen rounds

Author inspection of `newFactPage` / `householdAct('fact-add')` showed the earlier
mapping of Add a fact to Conversations was false. That was the author's mistake,
not an owner ruling. Restored the actual create-only Knowledge form/operation in
this PR. It uses the same central Knowledge policy and source receipt recovery,
adds no schema or permission rule, and injects the existing pure freshness
classifier. Author-tested: provisional/web citations, attribution, duplicate and
invalid refusal, partial-member denial, source rollback, core failure/restart
recovery, namespace conflict and a two-window create path. This addition is after
the frozen review bytes and is not claimed cold-clear. No fourth review was run.
