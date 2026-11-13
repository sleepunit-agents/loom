# Attention Home review

Scope: bounded next-mode owned-agent cards and central ask count/top3/full-first-reader; final desk panels and delivery remain in docs/attention-piece.md. Three-round maximum under the rebuild brief. No local browser suite or host changes.

ASSESS high: data no (no new schema/delete); security yes (owned roster); contracts yes (live type); concurrency yes (shared card request guard); environment no (no deploy); uncaught no (focused/socket/browser tests). CLAIM: idle owned cards and shared ask records remain coherent. WHY: status and project visibility must not define ownership or duplicate asks.

## Round 1 — BLOCKING

Frozen f116ef1fada93a5480e2f75268fd4bac27c53552 at /home/art/scratch/attention-home-review/round-1/tree. TREE sha256:32a7fc1c7e0b5618925be5db008ebca1326de99886462e3ab904f6e1d95cc67b. Reply beside tree.

- Standards MAJOR, actionable: renderer/fake heterogeneous snapshots used any without a justification. Added the explanation at their declarations.
- Spec CRITICAL, actionable: the answered first reader unmounted when the live answer arrived, losing its receipt. Home now selects each agent's latest central answer fact as a visible receipt, using the same extracted AnswerReceipt as Inbox. No local answer copy or extra store. Component and browser cases require the receipt after advancing/count changes.
- Spec MAJOR, actionable: ownership loss with a still-visible project ask had no pending-prewrite regression. Added exactly that regression (independently identified while this frozen review ran).
- Spec MAJOR, actionable: status Central-time rendering was untested. Added a fixed November timestamp and literal CT assertion.
- Additional author checks: separate ask/status failure regressions and responsive columns use all available card slots for 1/2/3/4/5/6 cards. These are included in the next frozen tree.

## Round 2 — BLOCKING

Frozen75d60a517a0a0aa554ffc90b55f689250f8ccfa9 at /home/art/scratch/attention-home-review/round-2/tree. TREE sha256:577cf87a29db82dd4f9d0c3ccd5be34e8b22be8c64a976452ba8d765641117d5. Own ledger excluded from archive and diff; reply beside tree.

- Standards NIT, actionable: shared the existing stamp formatter between AskReader receipts and Home status.
- Spec MAJOR, actionable: added next-mode startup test with old foldable turn, fake clock advanced two full days, observed fetch boundary and core_effects table; asserts no retention/fold or outside effects occur. Foundation receipt-expiry timers are permitted and are not external jobs.
- Author browser correction: reboot shell at every screenshot width, rather than resizing an already chosen desktop shell into a narrow viewport. The 390 capture now exercises the actual phone shell.

## Round 3 — BLOCKING; review complete at the three-round bound

Frozen0597493a5458fb85b0a7a415133a406e24e6ae5f at /home/art/scratch/attention-home-review/round-3/tree. TREE sha256:ff5a73ea82997f7e2bd2b7e08728a8c0aa904ea8c12daba7f3e0df9be754038d. Own ledger excluded from archive/diff; reply beside tree. No fourth round.

- Standards: none.
- Spec CRITICAL, actionable: an already queued Home write survives reader unmount; if first sent only after ownership loss, ordinary project-visible answer policy would still permit it. Added optional literal `requireOwnership: true` to attention.answer and role input. Home AskReader supplies it, Inbox omits it. The daemon combines ordinary answer-person policy and central give-work ownership in the same transaction as the write. Retry receipts retain the original fact when already committed; an uncommitted retry rechecks current policy.
- Tests use the actual DataStore with controlled dropped request / dropped committed response, mutable Sharing, next-mode fixture and fake clock. They assert byte-identical retry id/input, denial after ownership removal with project access retained, open ask after refusal, unchanged Inbox authority, and original receipt after an already committed write. Component test requires Home's narrowing flag.
- Final bound judgment: every actionable finding folded; no known remaining hole. Final verdict remains BLOCKING and is reported in PR/task. R3 carried a new reachable transport case rather than the previous prewrite-only test gap. The standing rebuild brief caps review at three rounds; implementation ships by author judgment after affected tests and current-head CI, not by a claim of CLEAR.

Signed main merge225b054973ce7e1e4fc948636885316636f248ed preserves main012f55df2d29724f1eed2ecce0e744828528e193; only web/src/apps.ts conflicted, resolved additively with Bridges and Home. No history rewrite.89 affected tests/8files pass after final implementation fold; root TypeScript/web build/diff-check and current-head CI/screenshots are recorded on the PR/task.

## CI layout follow-up (no fourth review)

CI43387007799 shard1 failed the Home inner-width check at390 and the existing next-shell proof found fixed account controls intercepting the added dock entry. These are actionable layout findings after the bounded review. Reserve40px for the existing fixed account controls, let an overfull dock scroll from a safe starting edge, constrain Home to its parent's width and remove the shared answer fieldset's intrinsic minimum. The Home browser proof now writes all six screenshots and measured width diagnostics before asserting no overflow, so a failed capture remains inspectable. Existing shell proof remains unchanged and must pass; no sign-in logic or controls changed. Local110 affected tests/11files pass; CI must verify the actual layout fix.

Main49c8a095645fa455d81895facdb33910c2bca9e3 added People and its own dock/account clearance regression. Merge preserves People registration and Home surface; shell.css now uses upstream's fix exactly (superseding our provisional40px shell padding). Removed duplicate HouseholdDatabase import contributed by the independent upstream next.ts additions.126 affected tests/13files, root TypeScript/web build/diff-check pass on the combined tree. Existing32123bb CI shards2/3/4 passed; shard1 browser/artifacts awaited before pushing the merge so layout evidence is not discarded again.

CI43389415160 produced all six measured captures: the shell proof and shards2/3/4 pass, but Home reports exactly10px inner overflow at every width/look. Measured JSON isolates the flush header Inbox button and its `v-morph` SVG (the shared morph painter deliberately pads the SVG beyond the control); page width itself stays correct. Home now gives the entire AppFrame16px breathing room, moving its existing body padding to that outer frame, so the header control's paint fits too. No content clipping or weakened width assertion. Screenshot setup restores Home scrollTop to0 after clicking Check again, so captures show the actual Home band/cards instead of the focus-scrolled reader. These measured CI findings are folded after the bounded review; no fourth review. Final CI must prove this correction.
