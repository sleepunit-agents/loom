/**
 * A Comms thread's asks (docs/specs/comms.md, "Asks inline"): what its agent asked its owner from the thread, drawn in
 * the thread as a card at the point it was raised, with the Inbox's own words and buttons. One object, not two: the
 * card IS the Inbox's item (its key, its actions, posted to the same piece through the same `/act`), so answering either
 * answers both, and loom's live stream (`/events`) tells the other to read again.
 *
 * Which asks: the viewer's own Inbox items (handler.ts inboxItems, with the Inbox's own piece filter) that are still open,
 * need the owner, are this thread's agent's, and name this thread's conversation: a piece's ask by its `conversation`
 * (the approvals piece's, any kind: merge, grant, vouch-wake, principal-reset, relay…), a Needs you by its page
 * (`loom:conversation/<cv>`). The approvals piece keeps a body's conversation only when the runtime's signed statement
 * is for it (t-2117), and core takes a house's digest only for the conversation that house holds (t-2061); the agent
 * binds it too.
 *
 * Once shown, an ask is kept on its thread (comms.ts keepThreadAsk: its words sealed like the thread's), so after it
 * has left the Inbox the thread still shows it, answered: "Allowed by you · 14:14". The answer is what core recorded
 * when the answer went through it (answerKeptAsk, from `/act`); else, for a Needs you, its answer in the agent's store;
 * else, for an approval, its state from the approvals piece.
 */
import { agentDir, type Household } from './household.js';
import { answeredNeeds } from './backends/conversations.js';
import { answerKeptAsk, keepThreadAsk, keptAsksOf, threadOfAgentConversation, type AskAnswer, type Thread } from './comms.js';
import type { WaitCheckers } from './needs-resolve.js';
import type { InboxItem, Source } from './ui/render.js';
import type { Button } from './ui/vocab.js';

/** A card's words, as the thread keeps them: what the Inbox's reader shows. */
export interface AskWords {
  /** permission: Allow and Deny (an approval, or a Needs you waiting on one); question: the agent's own ask. */
  kind: 'permission' | 'question';
  text: string; why?: string; if_yes?: string; if_no?: string; fine?: string;
  /** The ids it's about (a Needs you's refs): drawn as chips. */
  refs?: string[];
  /** Mark asks, via Art (a relayed ask). */
  relayedFrom?: string;
  /** What Allow does is the household owner's alone to give (a grant, a vouch, a reset: the approvals piece's lead cards). */
  ownerOnly?: true;
}

/** An ask as the thread draws it. Open: with what answers it (the Inbox item's own buttons and sources). */
export interface ThreadAskView extends AskWords {
  /** Its Inbox key while it's open (`/inbox/open?k=`), else its ref. */
  key: string;
  ref: string;
  /** When it was raised: where in the thread it sits. */
  at: string;
  state: 'open' | 'answered';
  /** Allow and Deny, posted to the approval's own piece. */
  decide?: { allow: Button; deny: Button; source: Source };
  /** Yes and No (a yes/no Needs you with nothing to allow), posted as `needs-answer` with the reply's fields. */
  yesNo?: true;
  /** An answer in words, posted as `action` with `fields` and `text`, to `source` (the agent's own actions). */
  reply?: { action: string; label: string; fields: Record<string, string>; source: Source };
  /** Its other buttons (a Needs you's Done and Dismiss; a piece's other choices), posted to `source`. */
  buttons?: { list: Button[]; source: Source };
  /** An absorbed approval's other choices, beside Allow and Deny, posted to its piece. */
  more?: { list: Button[]; source: Source };
  answer?: AskAnswer;
}

/** The conversation an Inbox item was asked from: a piece's ask names it (`conversation`); a Needs you (core's, with
 * its reply box) is its page. A piece's page that happens to name a conversation binds nothing. */
export function conversationOfItem(it: Pick<InboxItem, 'page' | 'reply' | 'source'> & { conversation?: string }): string | undefined {
  if (it.conversation) return it.conversation;
  return it.reply?.action === 'needs-reply' && it.source.id === 'loom' && /^\/a\/[a-z][a-z0-9-]{0,39}\/act\/loom$/.test(it.source.act ?? '') ? /^loom:conversation\/(cv-[0-9a-f]{12})$/.exec(it.page ?? '')?.[1] : undefined;
}

/** Whether an Inbox item is one of this thread's asks: open, needing the owner, its agent's, from its conversation. */
export function isThreadAsk(it: InboxItem & { conversation?: string }, t: Pick<Thread, 'agent' | 'conversation'>, origins: Record<string, string> = {}): boolean {
  return it.box !== 'done' && it.kind !== 'fyi' && it.kind !== 'answered' && it.attention !== false && it.agent === t.agent && (conversationOfItem(it) === t.conversation || origins[conversationOfItem(it) ?? ''] === t.conversation);
}

const isId = (s: unknown): s is string => typeof s === 'string' && /^a-[0-9a-f]{4,32}$/.test(s);

/** Which ask an item is, across its life: an approval's id (the approvals piece's, `approvals` its source id), another
 * piece's ask by its piece and id, a Needs you's digest, else its Inbox key. And the approval a Needs you waits on,
 * absorbed (its Allow answers both). Only the approvals piece's ids are approvals: another piece's id names nothing there. */
export function askRef(it: InboxItem, approvals?: string): { ref: string; approval?: string } {
  const own = !it.reply ? it.actions?.find((b) => isId(b.fields?.id))?.fields?.id : undefined;
  if (own && approvals && it.source.id === approvals) return { ref: `approval:${own}`, approval: own };
  if (own && /^[a-z][a-z0-9-]{0,39}$/.test(it.source.id)) return { ref: `ask:${it.source.id}:${own}` };
  const absorbed = it.approval?.actions.find((b) => isId(b.fields?.id))?.fields?.id;
  const digest = it.reply?.fields.digest;
  if (digest && /^[\w.:-]{1,80}$/.test(digest)) return { ref: `digest:${digest}`, ...(absorbed ? { approval: absorbed } : {}) };
  return { ref: `key:${it.key}`, ...(absorbed ? { approval: absorbed } : {}) };
}

/** An item's words, as its card and the Inbox's reader say them. `lead`: its approval card is one the owner alone answers. */
export function wordsOf(it: InboxItem, lead = false): AskWords {
  const n = it.needs;
  const a = it.approval;
  const permission = !!a || !!it.waitsOnApproval || it.kind === 'permission';
  const why = n?.why ?? (it.meta && it.meta !== it.text ? it.meta : undefined);
  return {
    kind: permission ? 'permission' : 'question', text: it.text,
    ...(why ? { why } : {}),
    ...(n?.if_yes ?? a?.if_yes ? { if_yes: n?.if_yes ?? a?.if_yes } : {}),
    ...(n?.if_no ?? a?.if_no ? { if_no: n?.if_no ?? a?.if_no } : {}),
    ...(it.fine ?? a?.fine ? { fine: it.fine ?? a?.fine } : {}),
    ...(n?.refs.length ? { refs: n.refs.slice(0, 12) } : {}),
    ...(it.relayedFrom ? { relayedFrom: it.relayedFrom } : {}),
    ...(lead ? { ownerOnly: true as const } : {}),
  };
}

/** An open item as the thread's card: its words and exactly the Inbox's ways to answer it. `householdOwner`: may give
 * what an owner-only card gives (else that card has no Allow here, as the approvals piece would refuse it). */
export function openView(it: InboxItem, lead: boolean, householdOwner: boolean, approvals?: string, waits = false): ThreadAskView {
  const w = wordsOf(it, lead);
  const { ref } = askRef(it, approvals);
  const base: ThreadAskView = { ...w, key: it.key, ref, at: it.at ?? new Date().toISOString(), state: 'open' };
  const may = !w.ownerOnly || householdOwner;
  // Allow and Deny by what they do (the approvals piece's `allow` and `deny`), never by where or how they're drawn; a
  // card without both is drawn as its buttons, every one, as the Inbox draws them.
  const decideOf = (list: Button[] | undefined, source: Source): { decide?: ThreadAskView['decide']; rest: Button[] } => {
    const allow = list?.find((b) => b.action === 'allow');
    const deny = list?.find((b) => b.action === 'deny');
    // One only the household owner may give or refuse: no button of its at all, for anyone else (the approvals piece
    // refuses them; an `allow` by another name is still an Allow).
    if (!may) return { rest: [] };
    if (!allow || !deny) return { rest: list ?? [] };
    return { decide: { allow, deny, source }, rest: (list ?? []).filter((b) => b !== allow && b !== deny) };
  };
  if (it.approval) {
    const d = decideOf(it.approval.actions, it.approval.source);
    return { ...base, ...(d.decide ? { decide: d.decide } : {}), ...(it.reply ? { reply: { ...it.reply, source: it.source } } : {}),
      // A Needs you's Done and Dismiss (its own source); an approval's other choices are its piece's.
      ...(it.actions?.length ? { buttons: { list: it.actions, source: it.source } } : {}),
      ...(d.rest.length ? { more: { list: d.rest, source: it.approval.source } } : {}) };
  }
  if (it.kind === 'permission' && !it.reply) {
    const d = decideOf(it.actions, it.source);
    return { ...base, ...(d.decide ? { decide: d.decide } : {}), ...(d.rest.length ? { buttons: { list: d.rest, source: it.source } } : {}) };
  }
  return { ...base,
    ...(it.reply && it.needs?.answers === 'yes-no' && !it.waitsOnApproval && !waits ? { yesNo: true as const } : {}),
    ...(it.reply ? { reply: { ...it.reply, source: it.source } } : {}),
    // A piece's own buttons on a card only the household owner may answer: none, for anyone else (a Needs you's Done and
    // Dismiss are the agent's, and stay).
    ...(it.actions?.length && (may || it.reply) ? { buttons: { list: it.actions, source: it.source } } : {}) };
}

/** What a card keeps once it's shown: its words only (comms.ts keepThreadAsk seals them). */
function keep(h: Household, env: NodeJS.ProcessEnv, thread: string, it: InboxItem, lead: boolean, raised: string, approvals?: string): void {
  const r = askRef(it, approvals);
  const { kind, text, why, if_yes, if_no, fine, refs, relayedFrom, ownerOnly } = wordsOf(it, lead);
  keepThreadAsk(h.home, env, thread, { ref: r.ref, ...(r.approval ? { approval: r.approval } : {}), raised,
    words: { kind, text, why, if_yes, if_no, fine, refs, relayedFrom, ownerOnly } });
}

/** The approval kinds only the household owner gives (core applies them: handler.ts applyGrant/applyOwnerApproval). */
export const OWNER_KINDS: ReadonlySet<string> = new Set(['grant', 'vouch-wake', 'principal-reset', 'box-write-off']);

const VERDICT_OF_STATE: Record<string, string> = { allowed: 'allowed', used: 'allowed', denied: 'denied', expired: 'expired' };
const verdictOfState = (s: string): string => (Object.hasOwn(VERDICT_OF_STATE, s) ? VERDICT_OF_STATE[s] : /^[a-z-]{1,20}$/.test(s) ? s : 'closed');

export interface ThreadAsksDeps {
  /** The viewer's Inbox items, now (the Inbox's own: its pieces filter, its absorbing). */
  items: InboxItem[];
  /** Runtime-verified display roots for follow-up conversations; never supplies additional Inbox items. */
  origins?: Record<string, string>;
  /** The approval ids whose card only the household owner answers (the approvals piece's lead cards). */
  leads: Set<string>;
  householdOwner: boolean;
  /** The approvals piece's source id (its ids are approvals; another piece's aren't). */
  approvals?: string;
  /** The approvals piece's state of these ids (needs-resolve.ts pieceCheckers): for an ask that left without core
   * seeing its answer (it expired, or was answered elsewhere). */
  checkers?: Pick<WaitCheckers, 'approvals'>;
}

/**
 * The thread's asks, oldest first: each open one (kept on the thread the first time it's shown), then each kept one that
 * is no longer open, with how it was answered.
 */
export async function threadAsks(h: Household, env: NodeJS.ProcessEnv, t: Thread, d: ThreadAsksDeps): Promise<ThreadAskView[]> {
  // A Needs you here that waits on an approval asked from another conversation: its own card, without that approval's
  // words or buttons (they're that conversation's). One asked from here, absorbed by a Needs you elsewhere: its own card
  // here all the same, its Allow and Deny its piece's.
  const belongs = (cv: string | undefined) => !!cv && (cv === t.conversation || d.origins?.[cv] === t.conversation);
  const elsewhere = (it: InboxItem) => !!it.approval?.conversation && !belongs(it.approval.conversation);
  const waiting = new Set<InboxItem>();
  const mine: InboxItem[] = [];
  for (const it of d.items) {
    if (isThreadAsk(it, t, d.origins)) {
      if (elsewhere(it)) { const own = { ...it, approval: undefined }; waiting.add(own); mine.push(own); } else mine.push(it);
    } else if (it.approval && belongs(it.approval.conversation) && isThreadAsk({ ...it, conversation: t.conversation, page: undefined }, t)) {
      const a = it.approval;
      mine.push({ key: it.key, kind: 'permission', box: it.box, attention: it.attention, unread: false, text: a.text, ...(a.meta ? { meta: a.meta } : {}),
        at: it.at, agent: it.agent, source: a.source, actions: a.actions, conversation: t.conversation,
        ...(a.if_yes || a.if_no ? { needs: { ...(a.if_yes ? { if_yes: a.if_yes } : {}), ...(a.if_no ? { if_no: a.if_no } : {}), answers: 'words' as const, refs: [], details: '' } } : {}),
        ...(a.fine ? { fine: a.fine } : {}) });
    }
  }
  // Which of them only the household owner may give: the approvals piece's lead cards, and, for anyone else reading,
  // every kind the household owner's Allow applies, read from the piece itself (a card filed without `lead` is still
  // one only he may give: never an Allow for an agent owner on the strength of a missing flag).
  const owners = new Set(d.leads);
  if (!d.householdOwner && d.checkers) {
    const ids = [...new Set(mine.map((it) => askRef(it, d.approvals).approval).filter((x): x is string => !!x))];
    const states = ids.length ? await d.checkers.approvals(ids).catch(() => undefined) : {};
    for (const id of ids) {
      const k = states?.[id]?.kind;
      // Unread (the piece busy): owner-only until it says otherwise.
      // Unknown to it, or of no kind it names: owner-only too. Only a kind it names, and not one of his, has an Allow here.
      if (!states || !states[id] || !k || OWNER_KINDS.has(k)) owners.add(id);
    }
  }
  const open = mine.map((it) => {
    const r = askRef(it, d.approvals);
    const lead = !!r.approval && owners.has(r.approval);
    const v = openView(it, lead, d.householdOwner, d.approvals, waiting.has(it));
    try { keep(h, env, t.id, it, lead, v.at, d.approvals); } catch { /* not kept (age missing): it still shows while it's open */ }
    return v;
  });
  let kept: Awaited<ReturnType<typeof keptAsksOf>> = [];
  try { kept = await keptAsksOf(h, env, t); } catch { kept = []; }
  const openRefs = new Set(open.map((v) => v.ref));
  const gone = kept.filter((k) => !openRefs.has(k.ref));
  // Each one left without an answer core saw: a Needs you's from the agent's store, an approval's from its piece.
  const unknown = gone.filter((k) => !k.answer);
  if (unknown.some((k) => k.ref.startsWith('digest:'))) {
    try {
      const since = new Date(Math.min(...unknown.map((k) => Date.parse(k.raised) || Date.now())) - 86_400_000).toISOString();
      for (const n of answeredNeeds(agentDir(h, t.agent), since)) {
        const k = unknown.find((x) => x.ref === `digest:${n.digest.id}` && n.conversation.id === t.conversation);
        if (!k) continue;
        k.answer = { verdict: n.answer.verdict, ...(n.answer.by ? { by: n.answer.by } : {}), at: n.answer.at };
        answerKeptAsk(h.home, { ref: k.ref, thread: t.id }, k.answer);
      }
    } catch { /* the next read asks again */ }
  }
  const ids = [...new Set(unknown.filter((k) => !k.answer && k.approval).map((k) => k.approval!))];
  if (ids.length && d.checkers) {
    const states = await d.checkers.approvals(ids).catch(() => undefined);
    for (const k of unknown) {
      if (k.answer || !k.approval || !states || !(k.approval in states)) continue;
      const s = states[k.approval];
      // Still pending, but not in this viewer's Inbox (filed quiet, or filtered): not shown as answered.
      if (s && s.state === 'pending') continue;
      k.answer = { verdict: s === null ? 'gone' : verdictOfState(s.state) };
      answerKeptAsk(h.home, { ref: k.ref, thread: t.id }, k.answer);
    }
  }
  const answered: ThreadAskView[] = gone.filter((k) => k.answer).map((k) => {
    const w = (k.words ?? {}) as Partial<AskWords>;
    return { kind: w.kind === 'permission' ? 'permission' : 'question', text: typeof w.text === 'string' ? w.text : '',
      ...(typeof w.why === 'string' ? { why: w.why } : {}), ...(typeof w.if_yes === 'string' ? { if_yes: w.if_yes } : {}),
      ...(typeof w.if_no === 'string' ? { if_no: w.if_no } : {}), ...(typeof w.fine === 'string' ? { fine: w.fine } : {}),
      ...(Array.isArray(w.refs) ? { refs: w.refs.filter((x): x is string => typeof x === 'string').slice(0, 12) } : {}),
      ...(typeof w.relayedFrom === 'string' ? { relayedFrom: w.relayedFrom } : {}),
      key: k.ref, ref: k.ref, at: k.raised, state: 'answered', answer: k.answer! };
  });
  return [...answered, ...open].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

/** What a member's answer was, from the action that answered it (`/act`), or undefined when it isn't one. */
export function verdictOf(action: string, fields: Record<string, string>): string | undefined {
  if (action === 'allow') return 'allowed';
  if (action === 'deny') return 'denied';
  if (action === 'needs-answer') return fields.answer === 'yes' || fields.answer === 'no' ? fields.answer : undefined;
  return ({ 'needs-reply': 'replied', 'needs-done': 'done', 'needs-dismiss': 'dismissed' } as Record<string, string>)[action];
}

/**
 * An answer that went through core (`/act`, from the Inbox or a thread): kept on the thread that showed the ask, so it
 * says who answered and how. `item` is the Inbox item as it was just before (the answer takes it out of the Inbox). An
 * ask its thread hasn't shown yet is kept now, but only when the one answering is that thread's own member: nobody's
 * answer puts words into someone else's thread.
 */
export function recordAnswer(h: Household, env: NodeJS.ProcessEnv, item: InboxItem | undefined,
  answer: { verdict: string; by: string; at?: string }, o: { lead?: boolean; approvals?: string } = {}): void {
  const lead = !!o.lead;
  // Never the answer's business: whatever goes wrong here, the answer stands as the piece gave it.
  try {
    if (!item || !item.agent) return;
    const cv = conversationOfItem(item);
    if (!cv) return;
    const t = threadOfAgentConversation(h.home, item.agent, cv);
    if (!t) return;
    const at = answer.at ?? new Date().toISOString();
    if (t.member === answer.by) { try { keep(h, env, t.id, item, lead, item.at ?? at, o.approvals); } catch { /* not kept: nothing to answer below */ } }
    answerKeptAsk(h.home, { ref: askRef(item, o.approvals).ref, thread: t.id }, { verdict: answer.verdict, by: answer.by, at });
  } catch (e) {
    process.stderr.write(`loom: a Comms thread couldn't keep an answer: ${(e as Error).message}\n`);
  }
}

/** An approval answered (Allow or Deny), wherever its card was: every kept ask that is it, or waits on it. */
export function recordApprovalAnswer(h: Household, id: string, answer: { verdict: string; by: string; at?: string }): void {
  if (!isId(id)) return;
  try { answerKeptAsk(h.home, { approval: id }, { verdict: answer.verdict, by: answer.by, at: answer.at ?? new Date().toISOString() }); } catch { /* not kept anywhere */ }
}
