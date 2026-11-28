import { z } from 'zod';
import { brick, none } from './kit.js';

/** Comms' two folders of a member's threads (web/src/pieces/comms-view, "Threads" and "Archived"). */
export const threadScopes = ['open', 'archived'] as const;

// The member's own conversations, read as the member looking: an agent names none of them and no member sees another's.
// Pin, unpin and delete are Comms' own `comms.change`, which lets in the thread's member and nobody else
// (src/shared-conversations.ts). Which thread is the row's; nothing of it is told in the detail. What the member types
// to search is never a parameter or a detail: it goes to Comms' own read and nowhere else.
export default brick({ name: 'threads', big: true,
  shows: "The member's conversations, as Comms lists them: each one's title and agent, whether the agent is working in it and whether a reply is unread, each a link that opens it. `scope` is open (the default) or archived. Big, the member can search them as Comms does, pin or unpin one, and delete one after asking.",
  params: z.object({ scope: z.enum(threadScopes).default('open') }).strict(), references: {},
  actions: { pin: { operation: 'comms.change', detail: none }, unpin: { operation: 'comms.change', detail: none }, delete: { operation: 'comms.change', detail: none } } });
