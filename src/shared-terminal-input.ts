import { z } from 'zod';
import { MESSAGE_WORDS_MAX } from './core/conversations/words.js';
import { usageReport } from './runtime/usage-report.js';

const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.:@/-]+$/);
/** `wakes`: this hook shows its agent the wakes loom hands back (shared-terminal-session.ts). Only a report that says
 * so is handed any, so a hook that would drop them never takes one from the session. */
const base = { machine: id, sessionId: id, harness: id, instanceId: id.optional(), wakes: z.literal(true).optional() };
export const terminalEvent = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('open'), cwd: z.string().min(1).max(4096), model: id.nullable() }).strict(),
  z.object({ ...base, action: z.literal('turn'), role: z.enum(['member','agent']), eventId: id,
    words: z.string().min(1).max(MESSAGE_WORDS_MAX) }).strict(),
  z.object({ ...base, action: z.literal('usage'), runId: id, description: z.string().max(500).nullable(),
    completed: z.boolean().optional(), revision: z.number().int().nonnegative(), report: usageReport }).strict(),
  z.object({ ...base, action: z.literal('heartbeat') }).strict(),
  z.object({ ...base, action: z.literal('end') }).strict(),
]);
export type TerminalEvent = z.infer<typeof terminalEvent>;
