# Attention offline importer review

Task t-2205, PR883. ASSESS high: data (import/schema5), security (mapped audience), consumed contract (CLI/mapping), concurrency (snapshots/lock/repeat) apply; delivery/environment does not (no install/deploy), uncaught does not (fixtures and CI). Claim: preserve legacy records and human answer state atomically. Why: the final move must not leave a mixed or reopened desk. No real import is part of this patch.

Uses skills/cold-review/SKILL.md via runtime oneshot; three rounds maximum under the 2026-11-12 rule. All frozen trees are under /home/art/scratch/attention-import-review. Prompt is ARTIFACT + CONTRACT only. Original source for round1 is commit b28292dd5fc63b3ba4f0a130f62b6ffb4a87b40e; tree includes full archive and REVIEW.patch against base7202ad48.

## Round 1 — BLOCKING

TREE sha256:16cd4ba154bf4dec47441ab53eeb857d0461782956cedf7e8f74fda680beb1ec (1399 files). Reply round-1/reply.md.

- CRITICAL, actionable: CLI self-import check came after writable foundation open. Moved shared inode check before createFoundation; real CLI fixtures prove direct and hardlink refusal leaves bytes, journal mode and schema unchanged, plus mocked ordering test.
- CRITICAL, actionable: impossible calendar dates normalized silently. Calendar component check now precedes normalization for all timestamp fields; independent conversation/turn/digest/finding impossible-date rejection cases.
- CRITICAL, actionable: cleared digest skipped malformed question JSON. Validate every present stored question JSON before deciding whether its headline is null; malformed cleared-question fixture.
- MAJOR, actionable: missing hash/overlap/total rejection cases. Added independent bad conversation/digest/finding identities, held/folded overlap and inconsistent turn-total fixtures.
- NIT, actionable: duplicated migration list. Shared attentionMigrations exported from schema/index.ts and used by install/import.

Additional author correction after frozen round1: preserve prototype-like folded model labels via Object.fromEntries, with a literal __proto__/constructor regression fixture (Zod record normalization could discard arbitrary own keys). Changelog documents offline staging command.

## Round 2 — BLOCKING

Valid frozen tree round-2-clean/tree from02c46b65c29c9c0c87b4f899ecc344ff8f1b3756, TREE sha256:9f7827487578c9951a07a4bb65e749379e500afcf23e1de34fca1100b0a56041 (1401 files), reply round-2-clean/reply.md. Recipe excludes this ledger from archive and patch. First round-2 invocation accidentally included the author ledger, was canceled and discarded without using a verdict; only the clean contract-only invocation counts.

- CRITICAL, actionable: old lexical timestamp bounds can invert chronological bounds for valid mixed-precision inputs. Reconcile min/max using both source bounds and held turns, retaining exact original bounds as legacyBounds when repaired; regression fixture covers reachable same-second case. Document folded-turn precision limitation.
- MAJOR, actionable: revision/order were not checked through runtime reads. Installed-piece fixture asserts all digest ids/revisions/orders through attention.digests, including timestamp and same-clock rowid ordering.

GitHub reported CONFLICTING against main716994f768c2aabfd863deadc9af093b33630b4a (shared changelog insertion). Resolved by signed branch merge, retaining both entries and published history. No remote history rewrite.
