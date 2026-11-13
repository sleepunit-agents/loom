import type { Tasks } from './pieces/tasks/role.js';
import { taskFor, taskStatus } from './ui/task-work.js';
/**
 * The loom things a Comms thread names, as chips (docs/specs/comms.md, "Chips"): `GET /comms/<thread>/refs?r=…` answers,
 * for each ref asked, a small card (its title, its state, where it opens) or null. Null is "this viewer couldn't open
 * it": the app leaves the ref as its words. What a viewer may open is the same as everywhere else in loom:
 *
 *   t-N            a task: the thread's work (its pieces' feeds, asked as this member) knows it; or, for a household
 *                  owner, the tasks piece's own `show` (an agent owner's view of the tasks piece is the feed's)
 *   owner/repo#N   a pull request or issue: GitHub's, already a link anywhere loom draws one; its title and state when
 *                  the thread's work knows it
 *   a-…            an approval: one of this thread's asks, or pending in this member's own Inbox
 *   cv-…           a conversation of an agent this member owns
 *   note:<path>    a note of the thread's agent (loom has no note page: the card has no Open)
 *   knowledge:s    a knowledge page ([[s]] in a reply), project:s, person:s: a household owner's (agent owners have
 *                  no Knowledge, Projects or People: handler.ts refuses those pages to them)
 *   agent:a, at:a  an agent this member owns (@a in a reply: an agent, else a person as above)
 *
 * The words of a ref come from the thread the member is reading: nothing here is reachable outside their own thread
 * (threadFor before this), and an unknown or unseeable ref is null, never a reason.
 */
import { existsSync } from 'node:fs';
import { agentDir, type Household, type Member } from './household.js';
import { getConversation } from './backends/conversations.js';
import { agentName } from './ui/data.js';
import { venueLabel } from './household-store.js';
import { knowledgeView, householdPersonName } from './ui/household-pages.js';
import { listProjects } from './tools/project.js';
import { Notes, notesDbPath } from './notes.js';
import { pieceWithRole } from './needs-resolve.js';
import { pieceApi, type PieceInfo } from './ui/pieces.js';
import { owns, type Thread } from './comms.js';
import type { WorkItem } from './comms-work.js';
import type { ThreadAskView } from './comms-asks.js';

export type RefKind = 'task' | 'pr' | 'approval' | 'conv' | 'note' | 'knowledge' | 'project' | 'person' | 'agent';
/** A chip's card: what it is, its title and state in words, and where it opens (a loom page, path without the leading
 * slash; or an https link). */
export interface RefCard { kind: RefKind; title: string; status?: string; tone?: 'bad' | 'warn' | 'ok'; page?: string; href?: string }

/** The most refs one read answers. */
export const REFS_MAX = 60;
/** The most tasks one read asks the tasks piece for itself (each is a run of it). */
const SHOWS_MAX = 20;
/** Where a card may open inside loom, by exact shape (web/src/comms-refs.tsx checks the same again): nothing else. */
export const CARD_PAGE = /^(?:p\/[a-z0-9-]{1,40}\/task\/t-\d{1,9}|conversation\/cv-[0-9a-f]{12}|knowledge\/[a-z0-9][a-z0-9-]{0,79}|projects\/[a-z0-9][a-z0-9-]{0,79}|people\/[a-z0-9][a-z0-9-]{0,79}|a\/[a-z][a-z0-9-]{0,39}|inbox)$/;
const HTTPS = /^https:\/\/[^\s<>"'\\]{1,500}$/;
/** A card with only the page and link it may have: a page of an allowed shape, an https link. */
const safe = (c: RefCard): RefCard => {
  const { page, href, ...rest } = c;
  return { ...rest, ...(page && CARD_PAGE.test(page) ? { page } : {}), ...(href && HTTPS.test(href) ? { href } : {}) };
};
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** Whether a ref is one this endpoint answers, by shape alone. */
export function refShape(r: string): RefKind | 'at' | undefined {
  if (/^t-\d{1,9}$/.test(r)) return 'task';
  if (/^github:[\w.-]{1,100}\/[\w.-]{1,100}#\d{1,10}$/.test(r)) return 'pr';
  if (/^a-[0-9a-f]{8}$/.test(r)) return 'approval';
  if (/^cv-[0-9a-f]{12}$/.test(r)) return 'conv';
  if (/^note:[A-Za-z0-9][\w./-]{0,199}$/.test(r) && !r.split('/').includes('..')) return 'note';
  const m = /^(knowledge|project|person|agent|at):(.+)$/.exec(r);
  return m && SLUG.test(m[2]) ? m[1] as RefKind | 'at' : undefined;
}

export interface RefsDeps {
  tasks?: Tasks;
  /** The pieces this member may hear from (the Inbox's filter). */
  pieces: () => Promise<PieceInfo[]>;
  /** The thread's work, as this member sees it (comms-work.ts threadWork). */
  work: () => Promise<{ items: WorkItem[] }>;
  /** The thread's asks (comms-asks.ts threadAsks), and this member's Inbox items, for an approval's card. */
  asks: () => Promise<ThreadAskView[]>;
  pending: () => Promise<Array<{ id: string; text: string; agent?: string }>>;
}

const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
const VERDICT: Readonly<Record<string, string>> = { allowed: 'Allowed', denied: 'Denied', expired: 'Expired', gone: 'Gone', yes: 'You said yes', no: 'You said no', replied: 'Replied', done: 'Done', dismissed: 'Dismissed', resolved: 'Cleared itself' };

/** Each ref's card for `member` reading thread `t`, or null. Every ref is answered; a failure answers null. */
export async function resolveRefs(h: Household, env: NodeJS.ProcessEnv, t: Thread, member: Member, refs: string[], d: RefsDeps): Promise<Record<string, RefCard | null>> {
  const out: Record<string, RefCard | null> = {};
  const want = [...new Set(refs)].slice(0, REFS_MAX);
  const householdOwner = member.agents === '*';
  let shows = 0;
  let showing: Promise<unknown> = Promise.resolve();
  const lazy = <T>(f: () => Promise<T>, none: T) => { let p: Promise<T> | undefined; return () => (p ??= f().catch(() => none)); };
  const work = lazy(async () => new Map((await d.work()).items.map((i) => [i.ref, i])), new Map<string, WorkItem>());
  const asks = lazy(d.asks, [] as ThreadAskView[]);
  const pending = lazy(d.pending, [] as Array<{ id: string; text: string; agent?: string }>);
  const pieces = lazy(d.pieces, [] as PieceInfo[]);
  // Read once a request, however many of their refs it names: the knowledge index, each agent's projects.
  const knowledge = lazy(async () => new Map(knowledgeView(h).pages.map((p) => [p.slug, p])), new Map<string, ReturnType<typeof knowledgeView>['pages'][number]>());
  const projects = lazy(async () => h.agents.map((a) => agentDir(h, a)).filter((dir) => existsSync(dir))
    .map((dir): [string, ReturnType<typeof listProjects>] => { try { return [dir, listProjects(dir, { include_archived: true })]; } catch { return [dir, []]; } }), [] as Array<[string, ReturnType<typeof listProjects>]>);
  const fromWork = (i: WorkItem, kind: RefKind): RefCard => ({ kind, title: i.title, status: i.status, ...(i.tone ? { tone: i.tone } : {}),
    ...(i.url?.startsWith('/') && !i.url.startsWith('//') ? { page: i.url.slice(1) } : i.url?.startsWith('https://') ? { href: i.url } : {}) });
  const one = async (r: string): Promise<RefCard | null> => {
    const kind = refShape(r);
    if (!kind) return null;
    if (kind === 'task') {
      if (d.tasks) {
        if (shows++ >= SHOWS_MAX) return null;
        const task = taskFor(d.tasks,member.person,r);
        return task ? {kind:'task',title:task.title.slice(0,200),status:taskStatus(task),page:`p/tasks/task/${task.id}`,...(task.status === 'closed' ? {tone:'ok' as const} : {})} : null;
      }
      const w = (await work()).get(r);
      if (w) return fromWork(w, 'task');
      // A household owner's tasks piece answers them all; an agent owner's view of it is only the feed's.
      if (!householdOwner) return null;
      const tasks = pieceWithRole(env, 'tasks');
      if (!tasks || !(await pieces()).some((p) => p.piece === tasks.name) || shows++ >= SHOWS_MAX) return null;
      // One at a time: the piece API's pool is shared with the whole household's pages.
      const next = showing.then(() => taskCard(env, tasks.path, tasks.name, r));
      showing = next.catch(() => null);
      return next;
    }
    if (kind === 'pr') {
      const w = (await work()).get(r);
      const [repo, n] = r.slice('github:'.length).split('#');
      const href = `https://github.com/${repo}/issues/${n}`;
      return w ? { ...fromWork(w, 'pr'), href: w.url?.startsWith('https://') ? w.url : href } : { kind: 'pr', title: `${repo}#${n}`, status: 'On GitHub', href };
    }
    if (kind === 'approval') {
      const a = (await asks()).find((x) => x.ref === `approval:${r}`);
      if (a) return { kind, title: a.text, status: a.state === 'open' ? 'Waiting on you' : Object.hasOwn(VERDICT, a.answer?.verdict ?? '') ? VERDICT[a.answer!.verdict] : 'Answered', tone: a.state === 'open' ? 'warn' : 'ok', page: 'inbox' };
      const p = (await pending()).find((x) => x.id === r && (!x.agent || owns(member, x.agent)));
      return p ? { kind, title: p.text, status: 'Waiting on you', tone: 'warn', page: 'inbox' } : null;
    }
    if (kind === 'conv') {
      for (const a of h.agents.filter((x) => owns(member, x))) {
        const dir = agentDir(h, a);
        if (!existsSync(dir)) continue;
        const c = getConversation(dir, r);
        if (c) return { kind, title: c.label ?? c.place, status: `${agentName(dir)} · ${venueLabel(h.home, c.venue)}`, page: `conversation/${r}` };
      }
      return null;
    }
    if (kind === 'note') {
      const dir = agentDir(h, t.agent);
      if (!existsSync(notesDbPath(dir))) return null;
      const n = new Notes(dir);
      try {
        const row = n.read(r.slice('note:'.length));
        return row ? { kind, title: row.path, status: `Note · ${row.lifespan === 'keep' ? 'kept' : `until ${row.expires?.slice(0, 10) ?? '?'}`}` } : null;
      } catch { return null; } finally { n.close(); }
    }
    const slug = r.slice(r.indexOf(':') + 1);
    if (kind === 'agent' || kind === 'at') {
      if (h.agents.includes(slug)) {
        if (!owns(member, slug)) return null;
        const dir = agentDir(h, slug);
        return { kind: 'agent', title: existsSync(dir) ? agentName(dir) : cap(slug), status: 'Agent', page: `a/${slug}` };
      }
      if (kind === 'agent') return null;
    }
    // Knowledge, projects and people are the household's: an agent owner has none of them.
    if (!householdOwner) return null;
    if (kind === 'knowledge') {
      const k = (await knowledge()).get(slug);
      return k ? { kind, title: k.title, status: k.verified_at ? `Verified ${k.verified_at.slice(0, 10)}` : 'Not verified yet', ...(k.fresh === 'due' ? { tone: 'warn' as const } : {}), page: `knowledge/${slug}` } : null;
    }
    if (kind === 'project') {
      for (const [dir, list] of await projects()) {
        void dir;
        const p = list.find((x) => x.slug === slug);
        if (p) return { kind, title: p.name, status: p.archived ? 'Archived' : cap(String(p.status)), page: `projects/${slug}` };
      }
      return null;
    }
    // person, or an @ that isn't an agent
    const name = householdPersonName(h, slug);
    return name ? { kind: 'person', title: name, status: 'Person', page: `people/${slug}` } : null;
  };
  await Promise.all(want.map(async (r) => { try { const c = await one(r); out[r] = c ? safe(c) : null; } catch { out[r] = null; } }));
  return out;
}

/** A task's card from the tasks piece itself (its `run show`, as the household owner), or null. Only for a reader who
 * is the household owner (resolveRefs checks that first): it reads any task. */
async function taskCard(env: NodeJS.ProcessEnv, path: string, piece: string, id: string): Promise<RefCard | null> {
  const r = await pieceApi(path, { caller: { kind: 'owner', agents: '*' }, path: 'run', body: { argv: ['show', id] } }, env);
  const b = r.body as { stdout?: string } | undefined;
  if (r.status !== 200 || typeof b?.stdout !== 'string') return null;
  let o: { ok?: boolean; task?: { title?: unknown; status?: unknown } | null };
  try { o = JSON.parse(b.stdout); } catch { return null; }
  if (!o.ok || !o.task || typeof o.task.title !== 'string') return null;
  const status = typeof o.task.status === 'string' ? o.task.status : '';
  return { kind: 'task', title: o.task.title.slice(0, 200), status: cap(status.replace(/_/g, ' ')) || 'Task',
    ...(status === 'closed' ? { tone: 'ok' as const } : {}), page: `p/${piece}/task/${id}` };
}
