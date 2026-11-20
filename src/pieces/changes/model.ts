/** The normalized Change contract, ported from loom-changes. No forge writes. */
import { DAY_MS } from '../../core/day.js';
import { z } from 'zod';
import { TASK_ID, taskId } from '../../slug.js';
import { changes } from '../../core/data/schema.js';
export const week = 7 * DAY_MS;
/** One repository, one identity. GitHub reads `Acme/App`, `acme/app` and `acme/app.git` as the same
 * repository, so loom must too, or another spelling of a repository it reads would pass for one it does not.
 *  - `repositoryKey` is what two spellings are compared by: lower case, without a leading `github:` and
 *    without one trailing `.git`. It is for what is already stored or was given by GitHub.
 *  - `canonicalRepository` says whether a name is already in the one spelling loom writes: `owner/repo`, lower
 *    case, no trailing `.git`, neither part `.` or `..`. A name a caller types (a merge target, a project's
 *    repository) is refused unless it is canonical; nothing guesses what was meant.
 * A repository that was renamed on GitHub still answers to its old name there. loom cannot know that from the
 * words: it knows the names it reads, and the old name of one of them is to loom a repository it does not read. */
export const repositoryKey = (raw: string): string => (raw.startsWith('github:') ? raw.slice(7) : raw).toLowerCase().replace(/\.git$/, '');
export const canonicalRepository = (name: string): boolean =>
  /^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(name) && name === repositoryKey(name) && !name.split('/').some(part => part === '.' || part === '..');
export const repoId = (raw: string): string => {
  const value = raw.startsWith('github:') ? raw.slice(7) : raw;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) throw new Error('A GitHub repository must be owner/repo');
  return `github:${value.toLowerCase()}`;
};
const stamp = z.string().nullable();
export const changeSchema = z.object({
  id: z.string(), repo: z.string(), sourceRepository: z.string().optional(), number: z.number().int().positive(), page: z.string(), title: z.string(), url: z.string(),
  state: z.enum(changes.state.enumValues), draft: z.boolean(), author: z.object({ login: z.string(), name: z.string().optional() }),
  created: stamp, updated: stamp, closed: stamp,
  head: z.object({ ref: z.string(), id: z.string() }), base: z.object({ ref: z.string() }), body: z.string(),
  checks: z.object({ state: z.enum(changes.checks.enumValues), failing: z.array(z.string()), running: z.array(z.string()), total: z.number().int().nonnegative() }),
  review: z.object({ state: z.enum(changes.review.enumValues), by: z.array(z.string()) }),
  mergeable: z.enum(changes.mergeable.enumValues), conflicts: z.boolean(),
  people: z.array(z.object({ login: z.string(), name: z.string().optional(), role: z.string() })),
});
export type Change = z.infer<typeof changeSchema> & { project?: string; agent?: string; mine?: boolean; syncError?: string };
export interface Project { slug: string; name: string; repos: string[] }
export interface Attribution { agents: Record<string, { logins: string[]; branches: string[] }>; ownerLogins: string[]; taskOwner?: string }
export interface Rule { tier: 'do'|'tell'|'ask'; approval?: { state: string }; for?: { slug: string; name: string; state: string } }
export const groups = changes.waitingOn.enumValues;
export function attribute(c: Change, settings: Attribution) {
  const mine = settings.ownerLogins.some(login=>login.toLowerCase()===c.author.login.toLowerCase());
  const agent = Object.entries(settings.agents).find(([, how]) => how.logins.some(login=>login.toLowerCase()===c.author.login.toLowerCase()) || (mine && how.branches.some(p => p && c.head.ref.startsWith(p))))?.[0];
  const value = { ...c }; delete value.agent;
  return { ...value, mine, ...(agent ? { agent } : {}) };
}
export function waitsOn(c: Pick<Change,'state'|'draft'|'conflicts'|'mergeable'|'agent'|'mine'> & {checks:Pick<Change['checks'],'state'>;review:Pick<Change['review'],'state'>}, rule?: Rule): { group: typeof groups[number]; words: string } {
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
/** A task id standing by itself in words: not the tail of another word, and not cut short of its number. */
const CITED_TASK = new RegExp(`(?<![A-Za-z0-9])${TASK_ID}(?![0-9])`, 'g');
export function tasksCited(c: Change): string[] {
  const ids = new Set<string>();
  for (const text of [c.title,c.head.ref,c.body]) for (const m of text.matchAll(CITED_TASK)) ids.add(m[0]);
  // A branch may also name its task loosely, with no dash: `t123-fix`, `fix/t123`.
  for (const m of c.head.ref.matchAll(/(?:^|\/)t([0-9]{2,})(?=[-_/]|$)/g)) ids.add(taskId(m[1]));
  return [...ids].slice(0,20);
}
export function citations(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/(?<![A-Za-z0-9._/-])(?:(github):)?([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#([1-9][0-9]{0,9})(?![0-9A-Za-z])/g)) refs.add(`${repoId(m[2])}#${m[3]}`);
  for (const m of text.matchAll(/https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/([1-9][0-9]*)/g)) refs.add(`${repoId(m[1])}#${m[2]}`);
  return [...refs];
}
export const active = (c: Change, now: number) => c.state === 'open' || (!!c.closed && Date.parse(c.closed) + week > now);
