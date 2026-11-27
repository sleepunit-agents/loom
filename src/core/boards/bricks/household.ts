import { z } from 'zod';
import { brick, none } from './kit.js';

// Household setup, for a household owner. Revoking a token or signing a browser out is asked first: neither can
// be undone. A member, an agent's appearance or accounts and a restore are changed by a proposal the agent files,
// as on the desktop. Making a token shows its value once, and a portrait is two chosen files: both stay on the desktop.
export default brick({ name: 'household', big: true,
  shows: 'Household setup, for a household owner: the members with their roles and the agents each owns (each a person chip), the agents with the default one and their owners (each an agent chip), and counts of tokens and signed-in browsers. When big, also every token and browser by label and state, never a value, with revoke and sign out after asking, and what each outside program is allowed, which can be changed.',
  params: z.object({}).strict(), references: {},
  actions: {
    revokeToken: { operation: 'token.revoke', detail: none },
    revokeSession: { operation: 'sessions.revoke', detail: none },
    setGrants: { operation: 'program.setGrants', detail: none },
  } });
