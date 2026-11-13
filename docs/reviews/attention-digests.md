# Attention digests cold review

ASSESS: high. Data: schema 3. Security: inherited central scopes and nested role grants. Contract: digest operations. Concurrency: retry revisions and nested rollback. Environment: no install/deploy changes. Uncaught: targeted tests and CI cover this implementation.

CLAIM: digest rewrites atomically supersede central asks using revision-specific identity.
WHY: retrying a write must preserve a person's answer; an explicit rewrite may ask again.

Round 1: BLOCKING. Frozen source 5b74f81e150eb393d4300650c8c8030922c94015; TREE sha256:4e386f58790a02db5f7a417d3422789f069f3f118c78ea667986c1f44f559157. /home/art/scratch/attention-digest-review/round-1/reply.md.

- NIT unused legacy helpers: actionable, removed needsOfRow and yesNoText from the copied pure question parser.
- CRITICAL missing service collection operation grant: actionable, added central mayAct for attention.digests; type-only service test now expects denial, separately granted collection service succeeds.
- MAJOR untested collection bounds: actionable, tests now cover default 100, explicit 1 and 500, and reject 0/501/fractional limits.
- MAJOR nested resolve refusal rollback: actionable, two prior asks plus an injected second nested refusal prove all asks, digests, conversation references, receipts and notifications unchanged. Separate raise-refusal-after-resolve test also restores the previous open ask.
- MAJOR authored fields untested: actionable, read-back and replacement assert summary, asks, decisions and tasks.
- MAJOR policy project inheritance untested: actionable, digest/ask/conversation scope checked, shared-project member can read, member of only the referenced project cannot read or see live record.
- NIT hash vector: actionable, pinned literal dg-29237ec06e2f for cv-b28ed6ba6479 + NUL + run-1, independently calculated with SHA-256.

Round 2: BLOCKING. Frozen source 83b72eef1f4a327f9d7bea9224882ad3c1163ceb; TREE sha256:b852c10ef6f108f2de120ffc38d3f85c2364cc2e0dcd783fe280a022ca121282. /home/art/scratch/attention-digest-review/round-2/reply.md.

- CRITICAL creation used only mayAct: actionable, new digest ids now use central mayCreate (separate inherited project/agent visibility), existing immutable-scope digests use mayAct. Added shared-project member who can read the conversation but cannot see its agent separately: denied creation, permitted read after the agent creates it. Services likewise cannot create agent-scoped records without satisfying central creation policy.
- MAJOR independent limits untested: actionable, added decisions count, tasks count, asks item length, projects count, legacy/object question length, why/if_yes/if_no/href length rejections.

Round 3: BLOCKING (two MAJOR missing-test findings; no standards findings). Frozen source cae44e2360217ede2039a3b90714fe21f5cb39cd; TREE sha256:bb9e2d9c7cfd7ac0990c4f62b3ec90b743a9611df4330189eea8d3628bcebc87. /home/art/scratch/attention-digest-review/round-3/reply.md.

- MAJOR remaining independent limits: actionable, added decisions item length, project slug length, a valid HTTPS URL over the href cap, nine refs, and eight refs overflowing when waits_on adds a ninth.
- MAJOR copied question semantics: actionable, added legacy internal-word lint rejection; explicit words overriding yes/no outcome lines; explicit yes-no without lines; valid task and approval waits_on; single-approval inference and no inference with two approvals. Tested central ask mode and actual answer acceptance as well as stored digest shape.

Convergence: all final substantive findings actionable and folded; no CRITICAL; two MAJOR equals the prior substantive count; exact newly covered cases were not previously claimed fixed. Stop at the standing three-round bound. Final reviewer tag remains BLOCKING and is reported as such in the PR/task. No fourth review, no known implementation hole; ship by implementer judgment on green current-head CI. Final validation: 31 attention tests across four files, TypeScript noEmit pass.
