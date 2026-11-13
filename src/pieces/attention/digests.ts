/** Agent-authored summaries. Delivered messages never pass through this operation. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { operation, mayAct, maySee, type Db, type Operations, type Live, type Sharing, type Scope, type LiveRecord } from '../../core/index.js';
import type { Conversation } from './conversations.js';
import { attentionRole } from './role.js';
import { parseNeeds, answersOf, type NeedsOwner } from './needs.js';
const key = z.string().regex(/^cv-[a-f0-9]{12}$/);
const run = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/);
const list = (count: number, length: number) => z.array(z.string().min(1).max(length).refine(s => !!s.trim()).transform(s => s.trim())).max(count).default([]);
const needs = z.unknown();
const normalizeNeeds = (raw: unknown, href: unknown, ctx: z.RefinementCtx) => {
  const value = parseNeeds(raw, href);
  if (typeof value === 'string') { ctx.addIssue({ code: 'custom', message: value }); return z.NEVER; }
  return value;
};
const content = z.object({ summary: z.string().min(1).max(600).refine(s => !!s.trim()).transform(s => s.trim()), asks: list(8, 200), decisions: list(8, 200), tasks: list(16, 64), projects: z.array(z.string().max(80).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)).max(4).default([]), needs_owner: needs.optional(), needs_owner_href: z.unknown().optional() }).strict().transform((d, ctx) => {
  const { needs_owner_href, ...rest } = d;
  return { ...rest, needs_owner: normalizeNeeds(d.needs_owner, needs_owner_href, ctx) };
});
export const digestInput = z.object({ conversation: key, run, digest: content }).strict();
export interface Digest extends Scope {
  id: string; conversation: string; run: string; at: string; revision: number; order: number;
  summary: string; asks: string[]; decisions: string[]; tasks: string[]; projects: string[];
  needs_owner: NeedsOwner | null; ask: string | null;
}
export const digestId = (conversation: string, run: string) => `dg-${createHash('sha256').update(`${conversation}\0${run}`).digest('hex').slice(0, 12)}`;
export function installDigests(db: Db, operations: Operations, live: Live, sharing: () => Sharing) {
  const role = attentionRole(operations);
  const read = <T>(table: string, id: string): T | undefined => {
    const row = db.prepare(`SELECT record FROM ${table} WHERE id=?`).get(id) as { record: string } | undefined;
    return row && JSON.parse(row.record) as T;
  };
  const conversation = (id: string) => read<Conversation>('attention_conversations', id);
  const all = (id: string) => (db.prepare('SELECT record FROM attention_digests WHERE conversation=? ORDER BY rowid').all(id) as { record: string }[]).map(r => JSON.parse(r.record) as Digest);
  operations.register(operation({ name: 'attention.writeDigest', write: true, input: digestInput, output: z.unknown(),
    may: (v, i) => { const c = conversation(i.conversation); return !!c && mayAct(v, { type: 'attention.digest', ...c }, sharing(), 'act', 'attention.writeDigest'); },
    run(ctx, input) {
      const c = conversation(input.conversation)!;
      const id = digestId(c.id, input.run), previous = read<Digest>('attention_digests', id);
      const revision = (previous?.revision ?? 0) + 1;
      const records = all(c.id);
      // Commit order, including same-clock rewrites, decides which digest asks now.
      for (const d of records) if (d.ask) {
        const result = role.resolve(ctx.viewer, { id: d.ask, reason: 'Superseded by a later digest' }, `digest-resolve:${id}:${revision}:${d.ask}`);
        if (!result.ok) return result;
      }
      const scope = { agent: c.agent, ...(c.project ? { project: c.project } : {}), ...(c.member ? { member: c.member } : {}) };
      const ask = input.digest.needs_owner ? `${id}:${revision}` : null;
      if (ask) {
        const { legacy: _legacy, ...question } = input.digest.needs_owner!;
        const result = role.raise(ctx.viewer, { ...question, answers: answersOf(input.digest.needs_owner!), ...scope, id: ask, source: { kind: 'conversation', id: c.id } }, `digest-raise:${id}:${revision}`);
        if (!result.ok) return result;
      }
      const record: Digest = { ...input.digest, ...scope, projects: [...new Set(input.digest.projects)], id, conversation: c.id, run: input.run, revision, order: Math.max(0, ...records.map(d => d.order)) + 1, at: new Date(ctx.now).toISOString(), ask };
      db.prepare('INSERT INTO attention_digests VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, record=excluded.record').run(id, c.id, revision, JSON.stringify(record));
      c.projects = [...new Set([...records.filter(d => d.id !== id).flatMap(d => d.projects), ...record.projects])].sort();
      db.prepare('UPDATE attention_conversations SET record=? WHERE id=?').run(JSON.stringify(c), c.id);
      ctx.changed('attention.digest', id); ctx.changed('attention.conversation', c.id);
      return record;
    },
  }));
  operations.register(operation({ name: 'attention.digests', input: z.object({ conversation: key, limit: z.number().int().min(1).max(500).default(100) }).strict(), output: z.unknown(),
    may: (v, i) => { const c = conversation(i.conversation); return !!c && maySee(v, { type: 'attention.digest', ...c }, sharing()); },
    run: (_ctx, i) => all(i.conversation).sort((a, b) => b.order - a.order).slice(0, i.limit),
  }));
  live.register({ name: 'attention.digest', ids: () => (db.prepare('SELECT id FROM attention_digests ORDER BY id').all() as { id: string }[]).map(r => r.id),
    read(id, viewer) { const d = read<Digest>('attention_digests', id); return d && maySee(viewer, { type: 'attention.digest', ...d }, sharing()) ? d as unknown as LiveRecord : undefined; },
    inScope: (r, parent) => parent === undefined || r.conversation === parent,
  });
}
