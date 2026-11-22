import { z } from 'zod';
import { SHA256_HEX } from './core/sha256-hex.js';
import { MESSAGE_WORDS_MAX } from './core/conversations/words.js';
import { usageReport } from './runtime/usage-report.js';

const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.:@/-]+$/);
const base = { machine: id, sessionId: id, harness: id, instanceId: id.optional() };
export const terminalEvent = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('open'), cwd: z.string().min(1).max(4096), model: id.nullable() }).strict(),
  z.object({ ...base, action: z.literal('turn'), role: z.enum(['member','agent']), eventId: id,
    words: z.string().min(1).max(MESSAGE_WORDS_MAX) }).strict(),
  z.object({ ...base, action: z.literal('usage'), runId: id, description: z.string().max(500).nullable(),
    completed: z.boolean().optional(), revision: z.number().int().nonnegative(), report: usageReport }).strict(),
  z.object({ ...base, harness: z.literal('codex'), action: z.literal('adopt'), instanceId: z.uuid(), native: z.string().regex(SHA256_HEX).nullable(), resume: z.object({children:z.array(id)}).strict().optional() }).strict(),
  z.object({ ...base, harness: z.literal('codex'), action: z.literal('present'), instanceId: id, replace: id.optional(), cwd: z.string().min(1).max(4096) }).strict(),
  z.object({ ...base, harness: z.literal('codex'), action: z.literal('pulse'), instanceId: id, cwd: z.string().min(1).max(4096) }).strict(),
  z.object({ ...base, harness: z.literal('codex'), action: z.literal('idle'), instanceId: id }).strict(),
  z.object({ ...base, action: z.literal('heartbeat') }).strict(),
  z.object({ ...base, action: z.literal('end') }).strict(),
]);
export type TerminalEvent = z.infer<typeof terminalEvent>;
