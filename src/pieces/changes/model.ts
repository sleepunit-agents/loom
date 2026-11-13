/** The normalized Change contract, ported from loom-changes. No forge writes. */
import { z } from 'zod';
export const week = 7 * 86400_000;
export const repoId = (raw: string): string => {
  const value = raw.startsWith('github:') ? raw.slice(7) : raw;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) throw new Error('A GitHub repository must be owner/repo');
  return `github:${value.toLowerCase()}`;
};
const stamp = z.string().nullable();
export const changeSchema = z.object({
  id: z.string(), repo: z.string(), number: z.number().int().positive(), page: z.string(), title: z.string(), url: z.string(),
  state: z.enum(['open','merged','closed']), draft: z.boolean(), author: z.object({ login: z.string(), name: z.string().optional() }),
  created: stamp, updated: stamp, closed: stamp,
  head: z.object({ ref: z.string(), id: z.string() }), base: z.object({ ref: z.string() }), body: z.string(),
  checks: z.object({ state: z.enum(['passing','failing','running','none']), failing: z.array(z.string()), running: z.array(z.string()), total: z.number().int().nonnegative() }),
  review: z.object({ state: z.enum(['approved','changes_requested','required','not_required']), by: z.array(z.string()) }),
  mergeable: z.enum(['yes','no','unknown']), conflicts: z.boolean(),
  people: z.array(z.object({ login: z.string(), name: z.string().optional(), role: z.string() })),
});
export type Change = z.infer<typeof changeSchema> & { project?: string; agent?: string; mine?: boolean; syncError?: string };
export interface Project { slug: string; name: string; repos: string[] }
export interface Attribution { agents: Record<string, { logins: string[]; branches: string[] }>; ownerLogins: string[]; taskOwner?: string }
export interface Rule { tier: 'do'|'tell'|'ask'; approval?: { state: string }; for?: { slug: string; name: string; state: string } }
export const targetOf = (c: Change) => `${c.id}@${c.head.id}`;
export const short = (c: Change) => `${c.repo.split('/').at(-1)}#${c.number}`;
export const groups = ['you','agent','ci','reviewer','author','done'] as const;
export function attribute(c: Change, settings: Attribution) {
  const mine = settings.ownerLogins.includes(c.author.login);
  const agent = Object.entries(settings.agents).find(([, how]) => how.logins.includes(c.author.login) || (mine && how.branches.some(p => p && c.head.ref.startsWith(p))))?.[0];
  const value = { ...c }; delete value.agent;
  return { ...value, mine, ...(agent ? { agent } : {}) };
}
export function waitsOn(c: Change, rule?: Rule): { group: typeof groups[number]; words: string } {
  const result = (group: typeof groups[number], words: string) => ({ group, words });
  if (c.state !== 'open') return result('done', c.state === 'merged' ? 'Merged' : 'Closed');
  if (c.draft) return result('author','Draft');
  if (c.conflicts) return result('author','Conflicts');
  if (c.mergeable === 'no') return result('author',"Can't be merged");
  if (c.checks.state === 'failing') return result('author','CI red');
  if (c.review.state === 'changes_requested') return result('author','Changes asked for');
  if (c.checks.state === 'running') return result('ci','CI running');
  if (c.mergeable === 'unknown') return result('ci','Checking for conflicts');
  if (c.review.state === 'required') return result('reviewer','Needs review');
  if (!c.agent) return result('author',c.mine ? 'Yours' : 'Ready');
  const name = c.agent[0].toUpperCase() + c.agent.slice(1);
  if (rule?.for) return rule.for.state === 'allowed' ? result('agent',`You said yes for ${rule.for.name}; ready for ${name} to merge`) : result('you',`Waiting on you, for ${rule.for.name}`);
  if ((!rule || rule.tier === 'ask') && rule?.approval?.state !== 'allowed') return result('you',rule?.approval?.state === 'denied' ? 'You said not yet' : 'Waiting on you');
  return result('agent',`Ready for ${name} to merge`);
}
export function stateLine(c: Change, words: string) {
  const ci = c.checks.state === 'failing' ? `CI red${c.checks.failing.length ? `: ${c.checks.failing.slice(0,3).join(', ')}` : ''}` : { passing:'CI green', running:'CI running', none:'no CI' }[c.checks.state];
  const rv = { approved:'approved', required:'needs review', changes_requested:'changes asked for', not_required:'' }[c.review.state];
  const parts = c.state === 'open' ? [ci,rv,c.conflicts ? 'conflicts' : ''].filter(Boolean) : [];
  if (!parts.some(p => p.toLowerCase() === words.toLowerCase()) && !(words === 'CI red' && c.checks.state === 'failing')) parts.push(words);
  return parts.join(', ') || words;
}
export function tasksCited(c: Change): string[] {
  const ids = new Set<string>();
  for (const text of [c.title,c.head.ref,c.body]) for (const m of text.matchAll(/(?<![A-Za-z0-9])t-([0-9]{1,7})(?![0-9])/g)) ids.add(`t-${m[1]}`);
  for (const m of c.head.ref.matchAll(/(?:^|\/)t-?([0-9]{2,7})(?=[-_/]|$)/g)) ids.add(`t-${m[1]}`);
  return [...ids].slice(0,20);
}
export function citations(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/(?<![A-Za-z0-9._/-])(?:(github):)?([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#([1-9][0-9]{0,9})(?![0-9A-Za-z])/g)) refs.add(`${repoId(m[2])}#${m[3]}`);
  for (const m of text.matchAll(/https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/([1-9][0-9]*)/g)) refs.add(`${repoId(m[1])}#${m[2]}`);
  return [...refs];
}
export interface CitingTask { id: string; title: string; description?: string; source?: string; comments?: { actor: string; text: string }[] }
/** Caller passes only tasks visible through the Tasks role. Forge text never vouches for a conversation. */
export function taskLinks(c: Change, tasks: CitingTask[], trusted: string[]) {
  const named = new Set(tasksCited(c));
  const citing = tasks.filter(t => named.has(t.id) || citations([t.description,...(t.comments ?? []).map(x=>x.text)].join('\n')).includes(c.id));
  const made = tasks.filter(t => citations([t.description,...(t.comments ?? []).filter(x=>trusted.includes(x.actor)).map(x=>x.text)].join('\n')).includes(c.id));
  const conversation = made.map(t => /^conversation:(cv-[0-9a-f]{12})$/.exec(t.source ?? '')?.[1]).find(Boolean);
  return { tasks: citing.map(t => ({ id:t.id,title:t.title })), ...(conversation ? { conversation } : {}) };
}
export const active = (c: Change, now: number) => c.state === 'open' || (!!c.closed && Date.parse(c.closed) + week > now);
