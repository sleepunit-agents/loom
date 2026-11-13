/** Runtime records contain control metadata only. Briefs, messages and login credentials are not records. */
import { z } from 'zod';
const id = z.string().min(1).max(200);
/** Build identity only; capabilities and credential references are separate grants. */
export const houseConfig = z.object({
  repo: z.string().min(1).max(400).refine(value => {
    if (/^git@[A-Za-z0-9][A-Za-z0-9._-]*:[^\s?#]+$/.test(value)) return true;
    if (/^\/[^\s]+$/.test(value)) return true;
    if (!/^https:\/\/[^\s]+$/.test(value) || /[?#]/.test(value) || value.slice(8).split('/')[0].includes('@')) return false;
    try { const url = new URL(value); return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.search && !url.hash; }
    catch { return false; }
  }, 'Use a credential-free HTTPS or git@ repository, or an absolute path'),
  houseFile: z.string().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/).refine(value => !value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Use a path inside the repository'),
  branch: z.string().min(1).max(100).regex(/^[A-Za-z0-9._/-]+$/).optional(),
}).strict();
const scope = { project: id.optional(), agent: id, member: id.optional() };
export const boxRecord = z.object({
  id, name: id, owner: id, local: z.boolean(), mayHost: z.union([z.literal('*'), z.array(id)]),
  lentTo: z.array(id), facts: z.array(id), labels: z.array(id),
  alwaysOn: z.boolean(), reportOnly: z.boolean(), createdAt: z.number().int(),
  lastSeen: z.number().int().optional(), revokedAt: z.number().int().optional(),
}).strict();
export const jobRecord = z.object({
  id, ...scope, runner: id, box: id, title: z.string().max(200),
  state: z.enum(['queued', 'starting', 'running', 'waiting', 'done', 'failed', 'stopped', 'lost', 'uncertain']),
  conversation: id.optional(), model: id.optional(), account: id.optional(),
  createdAt: z.number().int(), endedAt: z.number().int().optional(),
}).strict();
export const settingsRecord = z.object({
  id, agent: id, boxes: z.array(id).max(8), model: id.optional(), house: houseConfig.optional(),
}).strict();
export const bindingRecord = z.object({
  id, ...scope, venue: id, place: id, job: id.optional(),
  home: z.object({ harness: id, slot: id }).strict().optional(),
}).strict();
export const records = { box: boxRecord, job: jobRecord, settings: settingsRecord, binding: bindingRecord };
export type RecordKind = keyof typeof records;
export interface RuntimeRecords {
  box: z.infer<typeof boxRecord>;
  job: z.infer<typeof jobRecord>;
  settings: z.infer<typeof settingsRecord>;
  binding: z.infer<typeof bindingRecord>;
}
