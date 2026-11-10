/**
 * Comms' page routes (docs/specs/comms.md, "Routes"): JSON in and out, for a signed-in member. Every thread route asks
 * comms.ts threadFor first, so a member reaches only their own threads with agents they own; anything else is the same
 * 403, and their own deleted thread a 404. Writes take the session's form token, as every page action does.
 *
 *   GET  /comms                         the member's threads (?archived=1 for the archived ones)
 *   POST /comms/new                     {agent, project?, id, text, about?}: a thread and its first message; `about`
 *                                       (comms-about.ts) adds what it's about to that message, as one line
 *   GET  /comms/route?agent=<a>          who a chat about an item goes to for this member (comms-about.ts routeFor)
 *   GET  /comms/agents                  each agent the member owns: their last thread, unread replies, the first one's line
 *   GET  /comms/<thread>                the thread and its newest messages
 *   GET  /comms/<thread>/since/<seq>    the messages after seq
 *   GET  /comms/<thread>/before/<seq>   the 100 before seq
 *   GET  /comms/<thread>/events         its live stream (comms-live.ts)
 *   GET  /comms/<thread>/work           the work it names or made (comms-work.ts)
 *   GET  /comms/<thread>/refs?r=…       the loom things it names, as chips (comms-refs.ts)
 *   POST /comms/<thread>/send           {id, text}
 *   POST /comms/<thread>/title          {title}
 *   POST /comms/<thread>/project        {project | null}
 *   POST /comms/<thread>/pin, unpin, archive, unarchive, stop, resume, delete
 *   POST /comms/<thread>/read           {seq}
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  addMemberMessage, threadsAbout, agentsComms, threadIdOf, CommsError, COMMS_VENUE, deleteThread, digestsFor, markRead, memberWords, messagesOf, openThread,
  deliveryFacts, isBackground, isJob, recordDelivery, resendMessage, setArchived, setPinned, setProject, setTitle, settleThread, stateOf, stillSees, threadFor, threadsOf, type Thread,
} from '../comms.js';
import { getConversation } from '../backends/conversations.js';
import { agentDir } from '../household.js';
import { join } from 'node:path';
import { resolveSqliteDbPath } from '../config.js';
import { HOUSEHOLD_DB } from '../household-store.js';
import { waitForLocks, WRITE_WAIT_MS } from '../lock-gate.js';
import { deliverAsOwner } from '../delivery.js';
import type { Household, Member } from '../household.js';
import type { Chrome } from './render.js';
import { findPiece } from '../cli/pieces.js';
import { managedPieces } from '../cli/pieces-managed.js';
import { threadWork } from '../comms-work.js';
import { openThreadStream } from './comms-live.js';
import { pieceApi, type PieceInfo } from './pieces.js';
import { threadAsks, conversationOfItem, type ThreadAskView, type ThreadAsksDeps } from '../comms-asks.js';
import { refShape, resolveRefs, REFS_MAX } from '../comms-refs.js';
import { parseAbout, routeFor, withAbout } from '../comms-about.js';

export interface CommsContext {
  household: Household;
  /** The household read fresh: a live stream asks it before each event, so a member who stops owning the agent is cut off. */
  live: () => Household | undefined;
  member: Member | undefined;
  env: NodeJS.ProcessEnv;
  /** The stream owner (a session or a bearer): how many streams one browser may hold. */
  session: string;
  headers: Record<string, string>;
  /** Refuses a write that isn't the session's own (its form token, its origin): the reason, or null when it's fine. */
  guard: (req: IncomingMessage, body: Record<string, unknown>) => string | null;
  /** The page's chrome (its shell, dock and form token), for a GET the app draws as a view. */
  chrome?: () => Promise<Chrome>;
  /** The household's agents' marks (labels, colours, faces), as every view's ctx carries them. */
  agents?: Record<string, unknown>;
  /** The pieces this member may hear from, as the Inbox and Home have them (handler.ts forOwner over the scoped manifests). */
  pieces?: () => Promise<PieceInfo[]>;
  /** This member's Inbox, now (handler.ts inboxItems, the Inbox's own rule), for a thread's asks. */
  inbox?: () => Promise<ThreadAsksDeps>;
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

/** Proxy an owner's thread preference through the runtime; never trust a client conversation id. */
async function threadModel(c: CommsContext, t: Thread, member: Member, harness?: unknown): Promise<{ status: number; body: unknown }> {
  if (harness !== undefined && (typeof harness !== 'string' || !['auto', 'claude', 'codex'].includes(harness))) return { status: 400, body: { error: 'model is auto, claude or codex' } };
  const p = runtimePath(c.env);
  if (!p) return { status: 503, body: { error: 'the runtime is unavailable' } };
  return pieceApi(p, { caller: { kind: 'owner', agents: member.agents, who: member.person }, path: 'model-choice',
    body: { agent: t.agent, conversation: t.conversation, ...(harness === undefined ? {} : { harness }) } }, c.env);
}

/** Control only the server-resolved thread, with its member's actual agent scope. */
async function threadControl(c: CommsContext, t: Thread, member: Member, action: 'interrupt' | 'resume'): Promise<{ status: number; body: unknown }> {
  const p = runtimePath(c.env);
  if (!p) return { status: 503, body: { error: 'the runtime is unavailable' } };
  return pieceApi(p, { caller: { kind: 'owner', agents: member.agents, who: member.person }, path: 'conversation-control',
    body: { agent: t.agent, conversation: t.conversation, action } }, c.env);
}

const noRuntimeConversation = (r: { status: number; body: unknown }): boolean => r.status === 404 &&
  !!r.body && typeof r.body === 'object' && 'error' in r.body && r.body.error === 'no such conversation';

/**
 * What a delivery the runtime took says for the thread: its body's state, and an error when no body started. The
 * runtime answers `queued` with "no body could start (…): trying again in N s" while it retries a start that failed
 * (loom-box delivery.mjs): that's "couldn't start; retrying", with its trace, never "busy" (t-1918). `failed` is a start
 * it gave up on.
 */
export function deliveredOutcome(b: { body?: string; reason?: string }): { delivered: true; body?: string; error?: { code: string; reason?: string } } {
  if (b.body === 'failed') return { delivered: true, body: b.body, error: { code: 'start-failed', reason: b.reason } };
  if (b.body === 'queued' && /^no body could start\b/.test(b.reason ?? '')) return { delivered: true, body: b.body, error: { code: 'start-retry', reason: b.reason } };
  return { delivered: true, body: b.body };
}

/** A member's message into the runtime, and what came of it recorded on the thread. */
async function deliverMessage(c: CommsContext, t: Thread, seq: number, id: string, text: string): Promise<{ delivered: boolean; body?: string; error?: string }> {
  // The same delivery every time, Send again too (its id, its time and its label from its first try): core and the
  // runtime answer a repeat with the first answer, so a message whose first try got through after all (its answer
  // lost) never reaches a body twice.
  await waitForLocks({ read: [join(c.household.home, HOUSEHOLD_DB), resolveSqliteDbPath(agentDir(c.household, t.agent))] });
  const facts = deliveryFacts(c.household, t, seq);
  const backing = getConversation(agentDir(c.household, t.agent), t.conversation);
  const spawned = backing?.venue === 'spawn';
  const r = await deliverAsOwner(c.env, c.household, {
    id: `comms:${t.id}:${id}`, agent: t.agent, venue: spawned ? backing.venue : COMMS_VENUE, place: spawned ? backing.place : t.id, label: facts.label, person: t.member, text, at: facts.at,
  });
  const b = r.body as { body?: string; reason?: string; error?: string };
  // What came of it lands on the thread: once household.db is free, waited out off the event loop (lock-gate.ts).
  await waitForLocks({ write: [join(c.household.home, HOUSEHOLD_DB)], budgetMs: WRITE_WAIT_MS });
  if (r.status === 200) {
    recordDelivery(c.household, t, seq, deliveredOutcome(b));
    return { delivered: true, body: b.body };
  }
  const err = String(b.error ?? `the runtime answered ${r.status}`);
  const code = r.status === 503 && /no installed piece offers delivery/.test(err) ? 'no-runtime' : r.status >= 400 && r.status < 500 ? 'refused' : 'unreachable';
  recordDelivery(c.household, t, seq, { delivered: false, error: { code, reason: err } });
  return { delivered: false, error: err };
}

/**
 * The delivery, in the background (t-1881): a send is accepted once it's recorded, and answers at once. A body can take
 * 20 s or more to start, and the app shows the message on its way from the thread's live state until core records
 * what came of it, delivered or not. The words come from the store when they aren't given (Send again).
 */
function deliverLater(c: CommsContext, t: Thread, seq: number, id: string, text: string | null): void {
  void (async () => {
    const words = text ?? await memberWords(c.household, c.env, t, seq);
    if (words === null) { recordDelivery(c.household, t, seq, { delivered: false, error: { code: 'refused', reason: 'its words are gone; send it again as a new message' } }); return; }
    await deliverMessage(c, t, seq, id, words);
  })().catch((e) => {
    process.stderr.write(`loom: delivering a Comms message failed: ${(e as Error).message}\n`);
    try { recordDelivery(c.household, t, seq, { delivered: false, error: { code: 'unreachable', reason: (e as Error).message } }); } catch { /* the stale sweep records it */ }
  });
}

const view = (t: Thread) => ({
  id: t.id, agent: t.agent, title: t.title, titled_by: t.titled_by, project: t.project, pinned: t.pinned, archived: t.archived,
  opened: t.opened, last: t.last, read_seq: t.read_seq, channel: t.channel, conversation: t.conversation, state: stateOf(t),
});

/**
 * What makes a Comms answer a view the app draws (web/src/comms.tsx): `view: 'comms'`, which part, the page's chrome
 * and its ctx. The API's own fields sit beside them.
 */
async function asView(c: CommsContext, which: 'list' | 'thread', pathname: string): Promise<Record<string, unknown>> {
  if (!c.chrome) return {};
  const chrome = await c.chrome();
  return { view: 'comms', which, chrome, ctx: { source: { id: 'loom', base: '/' }, path: pathname.slice(1), query: {}, csrf: chrome.csrf, agents: c.agents ?? {} },
    ...(c.household.github ? { github: c.household.github } : {}) };
}

/**
 * A thread's asks (comms.md, "Asks inline"; src/comms-asks.ts): the member's own Inbox items asked from this thread by its
 * agent, open with the Inbox's own buttons, and those it showed before, answered. Without the Inbox given, none: never
 * every piece's.
 */
async function asksOf(c: CommsContext, t: Thread): Promise<ThreadAskView[]> {
  if (!c.inbox) return [];
  try {
    const i = await c.inbox();
    const conversations = [...new Set(i.items.filter((it) => it.agent === t.agent)
      .flatMap((it) => [conversationOfItem(it), it.approval?.conversation])
      .filter((cv): cv is string => typeof cv === 'string' && /^cv-[0-9a-f]{12}$/.test(cv) && cv !== t.conversation))].slice(0, 128);
    let origins: Record<string, string> = {};
    const runtime = conversations.length ? runtimePath(c.env) : undefined;
    if (runtime) {
      try {
        const r = await pieceApi(runtime, { caller: { kind: 'owner', agents: [t.agent] }, path: 'conversation-origins', body: { agent: t.agent, conversations } }, c.env) as { status?: number; body?: { origins?: Record<string, string> } };
        if (r.status === 200 && r.body?.origins) origins = r.body.origins;
      } catch { /* Older/unavailable runtime: directly linked cards still work. */ }
    }
    return await threadAsks(c.household, c.env, t, { ...i, origins });
  } catch (e) {
    process.stderr.write(`loom: a Comms thread's asks couldn't be read: ${(e as Error).message}\n`);
    return [];
  }
}

/** Whether a /comms page load names a thread the member may not see: the same 403 as its JSON form (rule 3). */
export function pageRefused(pathname: string, household: Household, member: Member | undefined): string | null {
  const m = /^\/comms\/([^/]+)/.exec(pathname);
  if (!m || m[1] === 'new' || m[1] === 'agents') return null;
  try { threadFor(household, member, threadIdOf(decodeURIComponent(m[1]))); return null; } catch (e) { return e instanceof CommsError ? e.message : 'forbidden'; }
}

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
      settleThread(h.home, null);
      const background = new URL(req.url ?? '/', 'http://x').searchParams.get('background') === '1';
      const threads = threadsOf(h, m, { archived, ...(background ? { background: 'only' as const } : {}) });
      const unread = archived ? threadsOf(h, m).filter((t) => t.unread).length : threads.filter((t) => t.unread).length;
      send(200, { ...(await asView(c, 'list', pathname)), threads: threads.map((t) => ({ ...view(t), unread: t.unread, last_seq: t.last_seq })), unread,
        agents: h.agents.filter((a) => m.agents === '*' || m.agents.includes(a)), member: m.person });
      return true;
    }
    // The desktop's agent cards (docs/specs/agent-desk.md, "Unread"): the member's own threads only, never another's.
    if (pathname === '/comms/agents') {
      if (req.method !== 'GET') return send(405, { error: 'method not allowed' }), true;
      if (!m) return send(403, { error: 'forbidden: Comms is for an agent\'s owners' }), true;
      settleThread(h.home, null);
      send(200, { agents: await agentsComms(h, c.env, m) });
      return true;
    }
    if (pathname === '/comms/about') {
      if (req.method !== 'GET') return send(405, { error: 'method not allowed' }), true;
      if (!m) return send(403, { error: 'forbidden' }), true;
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const about = parseAbout({ label: 'item', ...(q.get('ref') ? { ref: q.get('ref') } : {}), ...(q.get('page') ? { page: q.get('page') } : {}) });
      return send(200, { threads: threadsAbout(h, m, q.get('agent') ?? '', about.ref ? `ref:${about.ref}` : `page:${about.page}`) }), true;
    }
    if (pathname === '/comms/route') {
      if (req.method !== 'GET') return send(405, { error: 'method not allowed' }), true;
      if (!m) return send(403, { error: 'forbidden: Comms is for an agent\'s owners' }), true;
      const item = new URL(req.url ?? '/', 'http://x').searchParams.get('agent') ?? undefined;
      // An agent named but not as an agent is named: not one they can ask, said so, never quietly the default's.
      return send(200, routeFor(h, m, item ? (/^[a-z][a-z0-9-]{0,39}$/.test(item) ? item : '?') : undefined)), true;
    }
    if (pathname === '/comms/new') {
      if (req.method !== 'POST') return send(405, { error: 'method not allowed' }), true;
      const body = await readBody(req);
      if (body === 'big') return send(413, { error: 'too large' }), true;
      if (!body) return send(400, { error: 'bad-input: a JSON object' }), true;
      const why = c.guard(req, body);
      if (why) return send(403, { error: why }), true;
      if (!m) return send(403, { error: 'forbidden: Comms is for an agent\'s owners' }), true;
      // Chat about this (t-2034): what it's about goes in the first message, so the same about and words are the same
      // thread again (openThread's repeat), never a second one.
      let aboutKey: string | undefined;
      if (body.about !== undefined) {
        if (typeof body.text !== 'string') return send(400, { error: 'bad-input: text is the first message' }), true;
        const about = parseAbout(body.about);
        aboutKey = about.ref ? `ref:${about.ref}` : `page:${about.page}`;
        body.text = withAbout(body.text, about);
        delete body.about;
      }
      const o = openThread(h, c.env, m, body, new Date(), aboutKey);
      if (o.created) {
        deliverLater(c, o.thread, o.seq, String(body.id), String(body.text));
        send(200, { thread: view(o.thread), seq: o.seq, delivery: 'sending' });
      } else send(200, { thread: view(o.thread), seq: o.seq, repeat: true });
      return true;
    }
    const mm = /^\/comms\/(th:[a-z2-7]{10}|[^/]+)(?:\/(since|before)\/(\d{1,12})|\/([a-z]+))?$/.exec(pathname);
    if (!mm) return send(404, { error: 'not-found' }), true;
    const [, id, dir, seqRaw, verb] = mm;
    let t = threadFor(h, m, threadIdOf(decodeURIComponent(id)));
    if (req.method === 'GET') {
      // What's recorded made true of now first: a send cut off is not delivered, a body long silent isn't working.
      if (verb !== 'events' && settleThread(h.home, t.id)) t = threadFor(h, m, t.id);
      if (verb === 'events') {
        const from = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('from') ?? '0') || 0;
        const person = m!.person;
        openThreadStream(res, c.headers, h.home, { thread: t.id, session: c.session, from, may: () => { const now = c.live(); return !!now && stillSees(now, person, t.id); } });
        return true;
      }
      if (verb === 'model' && dir === undefined) {
        const r = await threadModel(c, t, m!); send(r.status, r.body); return true;
      }
      // Work in this thread (comms.md, "The panel"): live from the pieces, for this member only.
      if (verb === 'work' && dir === undefined) return send(200, await threadWork(h, c.env, t, m!)), true;
      // The loom things it names, as chips (comms.md, "Chips"): each ref's card, or null where this member can't open it.
      if (verb === 'refs' && dir === undefined) {
        const asked = new URL(req.url ?? '/', 'http://x').searchParams.getAll('r').filter((r) => r.length <= 220 && refShape(r)).slice(0, REFS_MAX);
        const refs = await resolveRefs(h, c.env, t, m!, asked, {
          pieces: async () => (c.pieces ? c.pieces() : []),
          work: () => threadWork(h, c.env, t, m!),
          asks: () => asksOf(c, t),
          pending: async () => (c.inbox ? (await c.inbox()).items : []).filter((it) => it.box !== 'done').flatMap((it) =>
            [...(it.actions ?? []), ...(it.approval?.actions ?? [])].flatMap((b) => (typeof b.fields?.id === 'string' ? [{ id: b.fields.id, text: it.approval?.text ?? it.text, ...(it.agent ? { agent: it.agent } : {}) }] : []))),
        });
        return send(200, { refs }), true;
      }
      if (verb) return send(404, { error: 'not-found' }), true;
      const seq = seqRaw === undefined ? undefined : Number(seqRaw);
      const messages = await messagesOf(h, c.env, t, dir === 'since' ? { after: seq } : dir === 'before' ? { before: seq } : {});
      const swept = messages.some((x) => x.text === null && x.kind !== 'error');
      // A spawned job's thread (t-2043): opened to watch, read-only, until its member chooses to write in it.
      const job = isJob(h, t) ? { job: { joined: !isBackground(h, t) } } : {};
      send(200, { ...(dir === undefined ? await asView(c, 'thread', pathname) : {}), thread: { ...view(t), ...job }, messages, asks: dir === 'before' ? undefined : await asksOf(c, t),
        ...(dir === undefined || swept ? { earlier: digestsFor(h, t) } : {}), member: m!.person });
      return true;
    }
    if (req.method !== 'POST' || !verb) return send(405, { error: 'method not allowed' }), true;
    const body = await readBody(req);
    if (body === 'big') return send(413, { error: 'too large' }), true;
    if (!body) return send(400, { error: 'bad-input: a JSON object' }), true;
    const why = c.guard(req, body);
    if (why) return send(403, { error: why }), true;
    switch (verb) {
      case 'model': {
        if (typeof body.harness !== 'string') return send(400, { error: 'model is auto, claude or codex' }), true;
        const r = await threadModel(c, t, m!, body.harness); send(r.status, r.body); return true;
      }
      case 'send': {
        // Accepted once recorded (t-1881): the delivery goes on in the background, and the thread's live state says
        // what came of it. The same id again is Send again: a message not delivered goes again, once; one on its way
        // or delivered answers where it is.
        const a = addMemberMessage(h, c.env, t, body);
        if (!a.repeat) { deliverLater(c, t, a.seq, String(body.id), String(body.text)); return send(200, { seq: a.seq, delivery: 'sending' }), true; }
        if (a.delivery !== 'failed') return send(200, { seq: a.seq, delivery: a.delivery, repeat: true }), true;
        if (await memberWords(h, c.env, t, a.seq) === null) return send(409, { error: 'conflict: that message\'s words are gone; send it again as a new message' }), true;
        if (resendMessage(h, t, a.seq)) deliverLater(c, t, a.seq, String(body.id), null);
        send(200, { seq: a.seq, delivery: 'sending', repeat: true });
        return true;
      }
      case 'title': send(200, { thread: view(setTitle(h, t, body.title, 'member')) }); return true;
      case 'project': send(200, { thread: view(setProject(h, t, body.project ?? null)) }); return true;
      case 'pin': setPinned(h, t, true); send(200, { ok: true }); return true;
      case 'unpin': setPinned(h, t, false); send(200, { ok: true }); return true;
      case 'archive':
      case 'delete': {
        const r = await threadControl(c, t, m!, 'interrupt');
        // A new thread may never have reached the runtime: there is no body to stop.
        if (r.status !== 200 && !noRuntimeConversation(r)) { send(r.status, r.body); return true; }
        if (verb === 'archive') setArchived(h, t, true); else deleteThread(h, t);
        send(200, { ok: true, ...(r.status === 200 ? { interruption: r.body } : {}) }); return true;
      }
      case 'unarchive': setArchived(h, t, false); send(200, { ok: true }); return true;
      case 'read': markRead(h, t, body.seq); send(200, { ok: true }); return true;
      case 'stop':
      case 'resume': {
        const r = await threadControl(c, t, m!, verb === 'stop' ? 'interrupt' : 'resume');
        if (noRuntimeConversation(r) && verb === 'stop') send(200, { ok: true, state: 'idle' });
        else send(r.status, r.body);
        return true;
      }
      default: send(404, { error: 'not-found' }); return true;
    }
  } catch (e) { refuse(e); return true; }
}
