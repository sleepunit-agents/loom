# Shared knowledge

Write for Jonathan and the agents who work with him. A page should answer a question they have, support a decision they make, or document a result they are likely to check again. Assume the reader knows the basics. Give enough context to repeat a measurement or recognize when an answer has expired.

## Choose a domain

Search for the subject and read nearby pages before creating one. Reuse an existing topic path, such as `music/gear/elektron` or `ai/claude-code`. Use lowercase words joined by hyphens within a segment and slashes between broader and narrower topics. Add a branch when it distinguishes a subject readers actually look for.

Use `ours/` for household-specific artifacts, configurations and conventions. A page about GitHub Actions belongs under its public subject even if a household repository supplied the measurement. Keep private conversations, personal preferences and credentials out of shared pages.

## Give the reader evidence

Tie each consequential claim to a source the reader can locate. For a web source, give the original publication and relevant section. For a repository measurement, give the repository, revision and observation. Give a date or version for facts that change. Distinguish what a source says from what the author infers.

Use `sourced` for claims supported by traceable evidence, `provisional` for claims still supported only by conversation or lacking corroboration, and `internal` for household artifacts documented by internal evidence. A repository citation can support either a world fact or a household claim. Keep an unverified claim provisional even when another page repeats it.

## Record freshness

The review targets are seven days for device pages, fourteen for software and thirty for the default class. Loom derives software from a versioned freshness anchor, then device from the configured device domain prefixes, and otherwise uses default. Record the applicable firmware, release, specification or observation date. Verification requires checking the underlying claim again. The shared reminder schedule and these editorial targets can differ.

## Edit a page with another author

Read the current body and sources before adding a finding. Preserve the original author. Attribute the contribution to the acting identity and retain the displaced version in the same transaction as a body change. Prefer an additive change for a missing fact. A replacement of another author's account needs a supersession record identifying the displaced version, the editor, the reason and the evidence.

For an unresolved disagreement, leave the existing account intact and attach a dated dispute with the contrary claim and its evidence. Record the resolution when the evidence settles it. The current Loom tools create pages with `knowledge_write` and edit or restore existing pages with `knowledge_edit` and `knowledge_restore`. Edits and restores retain attributed revisions. For an addition, call `knowledge_write` with `mode: "append"`, the page slug, and the new text in `body`. Loom appends against the current version and records the editor. To replace another author’s text, use `loom_command` with operation `mind.knowledgeSupersede`. Supply `slug`, the exact current `expectedBody`, the new `body`, a `reason` and supporting `evidence`. A concurrent edit requires rereading the page. The replacement record survives ordinary revision pruning and appears in `knowledge_read`. To dispute a claim, call `mind.knowledgeDispute` with the page `slug`, the contrary claim in `words` and supporting `evidence`. Readers see the dated, attributed annotation alongside the page. It survives later edits and restores.

In the Knowledge reader, use the annotation form to leave a note, explain why you keep a page, or mark it out of date. An out-of-date report also puts the page in the verification queue. The next check can clear the reminder. The attributed annotation stays with the page across checks and replacements. The same operation is available through `loom_command` as `mind.knowledgeAnnotate` with `slug`, `words`, and a `kind` of `note`, `intent`, or `outdated`.

## Check a store

Run `python3 scripts/check-knowledge-policy.py /path/to/knowledge.db`. It opens the database read-only and reports active page slugs and rule names. Review findings in context before editing. Audience, topic relevance, source quality and the merits of a dispute require editorial judgment.
