/**
 * Comms' page routes (docs/specs/comms.md, "Routes"): JSON in and out, for a signed-in member. Every thread route asks
 * comms.ts threadFor first, so a member reaches only their own threads with agents they own; anything else is the same
 * 403, and their own deleted thread a 404. Writes take the session's form token, as every page action does.
 *
 *   GET  /comms                         the member's threads (?archived=1 for the archived ones)
 *   POST /comms/new                     {agent, project?, id, text}: a thread and its first message
 *   GET  /comms/<thread>                the thread and its newest messages
 *   GET  /comms/<thread>/since/<seq>    the messages after seq
 *   GET  /comms/<thread>/before/<seq>   the 100 before seq
 *   GET  /comms/<thread>/events         its live stream (comms-live.ts)
 *   POST /comms/<thread>/send           {id, text}
 *   POST /comms/<thread>/title          {title}
 *   POST /comms/<thread>/project        {project | null}
 *   POST /comms/<thread>/pin, unpin, archive, unarchive, stop, delete
 *   POST /comms/<thread>/read           {seq}
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  addMemberMessage, askStop, CommsError, COMMS_VENUE, deleteThread, digestsFor, markRead, memberWords, messagesOf, openThread,
  recordDelivery, setArchived, setPinned, setProject, setTitle, stateOf, stillSees, threadFor, threadsOf, unreadCount, type Thread,
} from '../comms.js';
import { deliverAsOwner } from '../delivery.js';
import type { Household, Member } from '../household.js';
import { findPiece } from '../cli/pieces.js';
import { managedPieces } from '../cli/pieces-managed.js';
import { openThreadStream } from './comms-live.js';
import { pieceApi } from './pieces.js';

export interface CommsContext {
  household: Household;
  member: Member | undefined;
  env: NodeJS.ProcessEnv;
  /** The stream owner (a session or a bearer): how many streams one browser may hold. */
  session: string;
  headers: Record<string, string>;
  /** Refuses a write that isn't the session's own (its form token, its origin): the reason, or null when it's fine. */
  guard: (req: IncomingMessage, body: Record<string, unknown>) => string | null;
}

const MAX_BODY = 200 * 1024;

function json(res: ServerResponse, headers: Record<string, string>, status: number, body: unknown): void {
  res.writeHead(status, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null | 'big'> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return 'big';
    parts.push(c as Buffer);
  }
  const raw = Buffer.concat(parts).toString('utf-8');
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

/** The runtime piece, if one is installed: archiving or deleting a thread ends its body there. */
function runtimePath(env: NodeJS.ProcessEnv): string | undefined {
  const named = managedPieces(env).filter((r) => r.loom.role === 'runtime');
  return named.length === 1 ? findPiece(named[0].name, env) ?? undefined : undefined;
}

/** End the thread's body, through the runtime's `deliver end <conversation>` as the household owner. Never waits on it. */
function endBody(env: NodeJS.ProcessEnv, t: Thread): void {
  const p = runtimePath(env);
  if (!p) return;
  void pieceApi(p, { caller: { kind: 'owner', agents: '*' }, path: 'run', body: { argv: ['deliver', 'end', t.conversation] } }, env).catch(() => undefined);
}

/** A member's message into the runtime, and what came of it recorded on the thread. */
async function deliverMessage(c: CommsContext, t: Thread, seq: number, id: string, text: string): Promise<{ delivered: boolean; body?: string; error?: string }> {
  const r = await deliverAsOwner(c.env, c.household, {
    id: `comms:${t.id}:${id}`, agent: t.agent, venue: COMMS_VENUE, place: t.id, label: t.title ?? 'New thread', person: t.member, text,
  });
  const b = r.body as { body?: string; reason?: string; error?: string };
  if (r.status === 200) {
    const failed = b.body === 'failed';
    recordDelivery(c.household, t, seq, { delivered: true, body: b.body, ...(failed ? { error: { code: 'start-failed', reason: b.reason } } : {}) });
    return { delivered: true, body: b.body };
  }
  const err = String(b.error ?? `the runtime answered ${r.status}`);
  const code = r.status === 503 && /no installed piece offers delivery/.test(err) ? 'no-runtime' : r.status >= 400 && r.status < 500 ? 'refused' : 'unreachable';
  recordDelivery(c.household, t, seq, { delivered: false, error: { code, reason: err } });
  return { delivered: false, error: err };
}

const view = (c: CommsContext, t: Thread) => ({
  id: t.id, agent: t.agent, title: t.title, titled_by: t.titled_by, project: t.project, pinned: t.pinned, archived: t.archived,
  opened: t.opened, last: t.last, read_seq: t.read_seq, channel: t.channel, conversation: t.conversation, state: stateOf(t),
  ...(c ? {} : {}),
});

/** Answer a /comms route, or false when the path isn't one. */
export async function commsRoute(req: IncomingMessage, res: ServerResponse, pathname: string, c: CommsContext): Promise<boolean> {
  if (pathname !== '/comms' && !pathname.startsWith('/comms/')) return false;
  const h = c.household;
  const send = (status: number, body: unknown) => json(res, c.headers, status, body);
  const refuse = (e: unknown) => {
    if (e instanceof CommsError) return send(e.status, { error: e.message });
    process.stderr.write(`loom: a Comms route failed: ${(e as Error).message}\n`);
    return send(503, { error: 'unavailable: Comms couldn\'t answer; see the daemon log' });
  };
  const m = c.member;
  try {
    if (pathname === '/comms') {
      if (req.method !== 'GET') return send(405, { error: 'method not allowed' }), true;
      if (!m) return send(403, { error: 'forbidden: Comms is for an agent\'s owners' }), true;
      const archived = new URL(req.url ?? '/', 'http://x').searchParams.get('archived') === '1';
      send(200, { threads: threadsOf(h, m, { archived }).map((t) => ({ ...view(c, t), unread: t.unread, last_seq: t.last_seq })), unread: unreadCount(h, m),
        agents: h.agents.filter((a) => m.agents === '*' || m.agents.includes(a)) });
      return true;
    }
    if (pathname === '/comms/new') {
      if (req.method !== 'POST') return send(405, { error: 'method not allowed' }), true;
      const body = await readBody(req);
      if (body === 'big') return send(413, { error: 'too large' }), true;
      if (!body) return send(400, { error: 'bad-input: a JSON object' }), true;
      const why = c.guard(req, body);
      if (why) return send(403, { error: why }), true;
      if (!m) return send(403, { error: 'forbidden: Comms is for an agent\'s owners' }), true;
      const o = openThread(h, c.env, m, body);
      if (o.created) {
        const d = await deliverMessage(c, o.thread, o.seq, String(body.id), String(body.text));
        send(200, { thread: view(c, o.thread), seq: o.seq, delivered: d.delivered, ...(d.error ? { error: d.error } : {}) });
      } else send(200, { thread: view(c, o.thread), seq: o.seq, repeat: true });
      return true;
    }
    const mm = /^\/comms\/(th:[a-z2-7]{10}|[^/]+)(?:\/(since|before)\/(\d{1,12})|\/([a-z]+))?$/.exec(pathname);
    if (!mm) return send(404, { error: 'not-found' }), true;
    const [, id, dir, seqRaw, verb] = mm;
    const t = threadFor(h, m, decodeURIComponent(id));
    if (req.method === 'GET') {
      if (verb === 'events') {
        const from = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('from') ?? '0') || 0;
        const person = m!.person;
        openThreadStream(res, c.headers, h.home, { thread: t.id, session: c.session, from, may: () => stillSees(c.household, person, t.id) });
        return true;
      }
      if (verb) return send(404, { error: 'not-found' }), true;
      const seq = seqRaw === undefined ? undefined : Number(seqRaw);
      const messages = messagesOf(h, c.env, t, dir === 'since' ? { after: seq } : dir === 'before' ? { before: seq } : {});
      const swept = messages.some((x) => x.text === null && x.kind !== 'error');
      send(200, { thread: view(c, t), messages, ...(dir === undefined || swept ? { earlier: digestsFor(h, t) } : {}) });
      return true;
    }
    if (req.method !== 'POST' || !verb) return send(405, { error: 'method not allowed' }), true;
    const body = await readBody(req);
    if (body === 'big') return send(413, { error: 'too large' }), true;
    if (!body) return send(400, { error: 'bad-input: a JSON object' }), true;
    const why = c.guard(req, body);
    if (why) return send(403, { error: why }), true;
    switch (verb) {
      case 'send': {
        const a = addMemberMessage(h, c.env, t, body);
        if (a.repeat && a.delivered) return send(200, { seq: a.seq, delivered: true, repeat: true }), true;
        const words = a.repeat ? memberWords(h, c.env, t, a.seq) : String(body.text);
        if (words === null) return send(409, { error: 'conflict: that message\'s words are gone; send it again as a new message' }), true;
        const d = await deliverMessage(c, t, a.seq, String(body.id), words);
        send(200, { seq: a.seq, delivered: d.delivered, ...(a.repeat ? { repeat: true } : {}), ...(d.error ? { error: d.error } : {}) });
        return true;
      }
      case 'title': send(200, { thread: view(c, setTitle(h, t, body.title, 'member')) }); return true;
      case 'project': send(200, { thread: view(c, setProject(h, t, body.project ?? null)) }); return true;
      case 'pin': setPinned(h, t, true); send(200, { ok: true }); return true;
      case 'unpin': setPinned(h, t, false); send(200, { ok: true }); return true;
      case 'archive': setArchived(h, t, true); endBody(c.env, t); send(200, { ok: true }); return true;
      case 'unarchive': setArchived(h, t, false); send(200, { ok: true }); return true;
      case 'read': markRead(h, t, body.seq); send(200, { ok: true }); return true;
      case 'stop': askStop(h, t); send(200, { ok: true }); return true;
      case 'delete': deleteThread(h, t); endBody(c.env, t); send(200, { ok: true }); return true;
      default: send(404, { error: 'not-found' }); return true;
    }
  } catch (e) { refuse(e); return true; }
}
