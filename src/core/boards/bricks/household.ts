import { z } from 'zod';
import { brick, none, ref, typedName } from './kit.js';

// Household setup, for a household owner. Revoking a token or signing a browser out is asked first: neither can
// be undone. A member, an agent's appearance or accounts and a restore are changed by a proposal the agent files,
// as on the desktop.
//
// An agent's animated portrait is two files chosen in the brick (a PixelLab PNG sheet and its animation JSON), checked
// against the desktop's limits in the page and sent from the page straight to the desktop's `household.setPortrait`,
// never through the board (web/src/boards/bricks-household-portrait.tsx). The board is told which agent and whether
// its portrait was uploaded or the generated face restored: no file's name, size or contents.
//
// A token is made by the sign-in door the desktop uses (`POST /api/signin/token`, and `/api/signin/program` for an
// outside program: src/core/signin/shared-links.ts), which a current household owner whose browser signed in
// within the last ten minutes may call. Its value is shown once in the brick and never leaves it: the board is told
// the token's label, in the shape of a reference so it cannot carry a sentence and refused when it has the shape of a
// credential (`typedName`, ../value-shape.ts), and which kind it is. Nothing else.
export const tokenKinds = ['member', 'agent', 'machine', 'program'] as const;
export const portraitOutcomes = ['uploaded', 'restored'] as const;
export default brick({ name: 'household', big: true,
  shows: 'Household setup, for a household owner: the members with their roles and the agents each owns (each a person chip), the agents with the default one and their owners (each an agent chip), and counts of tokens and signed-in browsers. When big, also every token and browser by label and state, never a value, the live ones first and the revoked, expired or signed-out ones folded with their count and opened thirty at a time, with a search in the page over label, kind and owner whose words are never sent or told, and revoke and sign out after asking, what each outside program is allowed, which can be changed, and making a token for a member, an agent, a machine or an outside program, whose value is shown once to the member and never to the board: a token made is reported by its label and kind; and changing an agent\'s animated portrait from two chosen files, or restoring its generated face, reported by the agent and which of the two, never a file.',
  params: z.object({}).strict(), references: {},
  actions: {
    revokeToken: { operation: 'token.revoke', detail: none },
    revokeSession: { operation: 'sessions.revoke', detail: none },
    setGrants: { operation: 'program.setGrants', detail: none },
    setPortrait: { operation: 'household.setPortrait', detail: z.object({ agent: ref, outcome: z.enum(portraitOutcomes) }).strict() },
    token: { operation: 'signin.token', detail: z.object({ label: typedName(ref), kind: z.enum(tokenKinds) }).strict() },
  } });
