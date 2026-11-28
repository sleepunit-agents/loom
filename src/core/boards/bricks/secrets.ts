import { z } from 'zod';
import { brick, none, secretName } from './kit.js';

// The household's secrets, for an owner: the server answers `secretsReader` and takes the three secrets operations
// for a household owner only (src/pieces/bridges/readers.ts, src/shared-secret-commands.ts), and the page draws
// its unavailable line for anyone else. No parameter. A value goes from a password field to `secrets.set` and
// nowhere else, and a description is never told. After a value is set or a secret removed, and only once loom
// acknowledged it, the board is told the secret's NAME and what happened to it (the owner's ruling, 2026-11-27:
// the agent knows a key now exists under that name and never sees the key). Nothing else typed reaches a board.
const outcome = (...outcomes: [string, ...string[]]) => z.object({ secret: secretName, outcome: z.enum(outcomes) }).strict();
export default brick({ name: 'secrets', big: true, flags: ['new request'],
  shows: "For a household owner: the household's secrets by name (never a value), each one's rule, who may use it and its recorded use, and the requests agents have made for one. Big, a waiting request is allowed, denied or cancelled, a grant revoked, a value set or replaced, and a secret removed after asking. A value set or a secret removed is reported with the secret's name and whether it was added, replaced or removed; never its value or description.",
  params: none, references: {},
  actions: { allow: { operation: 'secrets.command', detail: none }, deny: { operation: 'secrets.command', detail: none },
    cancel: { operation: 'secrets.command', detail: none }, revoke: { operation: 'secrets.command', detail: none },
    setValue: { operation: 'secrets.set', detail: outcome('added', 'replaced') }, remove: { operation: 'secrets.remove', detail: outcome('removed') } } });
