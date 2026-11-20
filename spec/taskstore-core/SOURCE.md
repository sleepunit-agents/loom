Copied unchanged from sleepunit-agents/taskstore at
3736e1c72bee3cbd3e65c65768996476bc5c4a7a (2026-11-12).
Both spec.jsonl and fixtures.jsonl are byte-for-byte copies.
The pure transition implementation is copied to src/pieces/tasks/domain.ts;
plain.ts is the upstream plain-word lint. Keep the contract corpus unchanged.
The concurrent-writers case is bound to simultaneous HTTP clients of the one
in-process daemon, rather than multiple SQLite writers (the daemon owns writes).
