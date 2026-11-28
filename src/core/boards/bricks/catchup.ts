import { z } from 'zod';
import { brick } from './kit.js';

/** How far back the catch-up looks: since the start of today, or of the day two or six days before it, in the
 * member's own time (the trend brick's days are counted the same way). */
export const catchupSince = ['today', '3-days', '7-days'] as const;

// The desktop's Work catch-up (web/src/pieces/work/catch-up.tsx) across every project the member may read, by the
// tasks and projects rules and nothing wider: the agents' latest updates and the tickets changed since a time. Its
// chips place the ticket, project and agent bricks, which act; this brick acts on nothing.
export default brick({ name: 'catchup', big: true,
  shows: "The desktop's Work catch-up across every project the member may read: the agents' latest updates on tickets and the tickets changed since a time, grouped by project, newest first, each ticket a chip that places its ticket brick. `since` is today (the default: since the start of the member's day), 3-days or 7-days.",
  params: z.object({ since: z.enum(catchupSince).default('today') }).strict(), references: {}, actions: {} });
