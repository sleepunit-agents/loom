import { brick, none } from './kit.js';

// The household's secrets, for an owner: the server answers `secretsReader` and takes the three secrets operations
// for a household owner only (src/pieces/bridges/readers.ts, src/shared-secret-commands.ts), and the page draws
// its unavailable line for anyone else. No parameter and no detail: a secret's name, its description and above all
// its value never reach a board. The value goes from a password field to `secrets.set` and nowhere else.
export default brick({ name: 'secrets', big: true, flags: ['new request'],
  shows: "For a household owner: the household's secrets by name (never a value), each one's rule, who may use it and its recorded use, and the requests agents have made for one. Big, a waiting request is allowed, denied or cancelled, a grant revoked, a value set or replaced, and a secret removed after asking.",
  params: none, references: {},
  actions: { allow: { operation: 'secrets.command', detail: none }, deny: { operation: 'secrets.command', detail: none },
    cancel: { operation: 'secrets.command', detail: none }, revoke: { operation: 'secrets.command', detail: none },
    setValue: { operation: 'secrets.set', detail: none }, remove: { operation: 'secrets.remove', detail: none } } });
