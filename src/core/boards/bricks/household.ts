import { z } from 'zod';
import { brick, none, ref, typedName } from './kit.js';

// Household setup, for a household owner. Revoking a token or signing a browser out is asked first: neither can
// be undone. A member, an agent's appearance or accounts and a restore are changed by a proposal the agent files,
// as on the desktop. A portrait is two chosen files and stays on the desktop.
//
// A token is made by the sign-in door the desktop uses (`POST /api/signin/token`, and `/api/signin/program` for an
// outside program: src/core/signin/shared-links.ts), which a current household owner whose browser signed in
// within the last ten minutes may call. Its value is shown once in the brick and never leaves it: the board is told
// the token's label, in the shape of a reference so it cannot carry a sentence and refused when it has the shape of a
// credential (`typedName`, ../value-shape.ts), and which kind it is. Nothing else.
export const tokenKinds = ['member', 'agent', 'machine', 'program'] as const;
export default brick({ name: 'household', big: true,
  shows: 'Household setup, for a household owner: the members with their roles and the agents each owns (each a person chip), the agents with the default one and their owners (each an agent chip), and counts of tokens and signed-in browsers. When big, also every token and browser by label and state, never a value, with revoke and sign out after asking, what each outside program is allowed, which can be changed, and making a token for a member, an agent, a machine or an outside program, whose value is shown once to the member and never to the board: a token made is reported by its label and kind.',
  params: z.object({}).strict(), references: {},
  actions: {
    revokeToken: { operation: 'token.revoke', detail: none },
    revokeSession: { operation: 'sessions.revoke', detail: none },
    setGrants: { operation: 'program.setGrants', detail: none },
    token: { operation: 'signin.token', detail: z.object({ label: typedName(ref), kind: z.enum(tokenKinds) }).strict() },
  } });
