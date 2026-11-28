import { z } from 'zod';
import { brick } from './kit.js';

/** The ticket lists of the desktop's Tasks app (web/src/pieces/tasks/shared-view.tsx, its folders "Ready",
 * "In progress" and "Shelved"), and every ticket, closed ones included. The first is what the desktop opens on. */
export const ticketStates = ['ready', 'in-progress', 'shelved', 'all'] as const;

// The household's tickets across every project the member may read, by the tasks rule and nothing wider. A row's
// chip places the ticket brick, which acts on it; this brick acts on nothing. What the member types to search is
// never a parameter or a detail: it goes to the tasks read and nowhere else.
export default brick({ name: 'tickets', big: true,
  shows: "Every ticket the member may read, across projects, as the desktop's Tasks lists them: each one's id, title, project, state and who has it, each a chip that places its ticket brick. `state` is ready (the default: open, unblocked, not shelved), in-progress, shelved (open work of a retired project) or all (closed ones included, latest change first). Big, the member can search the list and load more.",
  params: z.object({ state: z.enum(ticketStates).default('ready') }).strict(), references: {},
  actions: {} });
