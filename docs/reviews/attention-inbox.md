# Attention Inbox preview review

ASSESS high: data no (no schema/import); security yes (answer controls); contracts no (unchanged backend); concurrency yes (fresh checks/pending writes); environment no (no deploy/CI change); uncaught no (component fakes and CI browser).

CLAIM: the central-record preview records ordinary answers only after fresh daemon confirmation.
WHY: a displayed row cannot establish current openness, and a lost response must not permit concurrent UI answers.

## Round 1 — BLOCKING, folded

Frozen 83ef55b89ba8c87a4051fcfa7c213a9d8aae1e26 in `/home/art/scratch/attention-inbox-review/round-1/tree`; TREE sha256:f0116f9b5b7c711ee7202fe5f2103b938ff81c2321d0ee4f8aa8a3c3bb7db5df. Reply beside tree.

- Standards MAJOR, actionable: removed effect-created reads. Opening a row creates the display confirmation; direct links/invalidated checks offer Check again. The immediate pre-write read remains in its event handler. Component and browser tests exercise opening/check actions.
- Standards MAJOR, actionable: replaced unchecked global/element types, documented dynamic renderer props and the renderer dependency's missing declarations.
- Standards MAJOR, actionable: moved component tests alongside `web/src/pieces/attention/index.tsx`.
- Spec CRITICAL, actionable: shared write lock now lives above keyed readers and remains held until the write result, including navigation while a response is pending. New regression navigates to a second ask during a pending write, confirms it, proves no second write, then releases the first response and proves the controls recover.
- Spec MAJOR, actionable: added separate No/Done/Dismiss submission tests with fresh reads.
- Spec MAJOR, actionable: added alphabetical agent-folder/filtering and resolved-history test.
- Spec MAJOR, actionable: regression asserts the delivery limitation is visible.
- Spec MAJOR, actionable: full-reader regression asserts authored references, recorded answer words, actor, CT time and resolution.

Runtime delivery, optional public words on yes/no, private encrypted replies, Home and production composition remain required on t-2205 and docs/attention-piece.md. This preview explicitly labels answers as recorded and does not claim that they have reached an agent.
