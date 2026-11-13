# Attention public words replies

Scope: public ordinary yes/no asks accept words, private reply text is refused before records/receipts, shared Home/Inbox controls preserve fresh checks and unsent drafts. Actual delivery and persistent drafts remain final-composition work.

ASSESS high: data—no migration/delete/external effect; security—private reply storage boundary; contracts—answer semantics; concurrency—first-answer/retry/shared guard; environment—no deployment/CI change; mechanism—tests and CI cover the claims. Three-round maximum per 2026-11-12 ruling.

Claim (excluded from reviewer prompt): public replies preserve the old words alternative while member-private text cannot become an Attention answer or core retry result.

- Round 1, BLOCKING. Frozen25d41e148cc1bf15e614b50c632e43be8a9e68f9; TREE sha256:0e71c8eb0806558e790b0b01d074b39aedecac32844a3f24129539a6770946ca. Spec MAJOR, valid/actionable: managed yes/no words refusal lacked a discriminating test. Added source callback, record/receipt equality and no-notification assertions plus successful Yes counterpart. Author also retained source-managed declared modes in the UI, with a test.
- Round 2, CLEAR. Frozenf1705db770934770539634fa73733825c92c6a63; TREE sha256:c294b6ae38eb1cf832a3e826dc105b9aff4395b3ec00a5bf4dadb42ae78df406. Spec NIT, valid/actionable: managed words mode lacked its positive counterpart. Added next-mode fixture test proving callback sees the committed answer inside the transaction and retry never invokes it twice; UI test covers both managed modes. Test-only fold after clear; no further round.

Frozen trees and raw replies: /home/art/scratch/attention-public-words-review/round-{1,2}/ (reply.md beside tree). Each contract referenced the old AnswerBox, central privacy, first answer/retries, ownership and kit/new-side requirements. No author ledger in either tree.

Baseline new tests failed in public unset/yes-no modes and private words mode. Final175 affected tests/13files pass, root TypeScript and web kit/type/Vite build pass. CI/browser evidence is linked on PR961. No local browser suite, live-home change, deployment or real import.
