import { z } from 'zod';
import { brick } from './kit.js';

/** Comms' two folders of a member's threads (web/src/pieces/comms-view, "Threads" and "Archived"). */
export const threadScopes = ['open', 'archived'] as const;

// The member's own conversations, read as the member looking: an agent names none of them and no member sees another's.
export default brick({ name: 'threads', big: true,
  shows: "The member's conversations, as Comms lists them: each one's title and agent, whether the agent is working in it and whether a reply is unread, each a link that opens it. `scope` is open (the default) or archived.",
  params: z.object({ scope: z.enum(threadScopes).default('open') }).strict(), references: {}, actions: {} });
