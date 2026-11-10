/**
 * Needs you that clear themselves (docs/specs/conversations.md, "Needs you"): an ask that says what it waits on
 * (`waits_on`: an approval, a task) is checked on a tick, and once that's resolved it leaves the owner's Inbox as a
 * quiet FYI ("Cleared itself: the approval was allowed and used"), answered `resolved` by loom. An ask that only
 * named an approval in its words, written before the object, waits on that approval too: that's how the one that
 * asked Jonathan to allow a card he'd already allowed and that was already spent (2026-11-03) goes.
 *
 * What's resolved is each piece's to say, through its own API, as the household owner: an approval's state from
 * the approvals piece (role `approvals`: `state`), a task's from the tasks piece (role `tasks`: `run show`). A pull
 * request isn't checked: loom has no sanctioned way to read GitHub, so `waits_on` refuses one (needs.ts). A piece
 * that's absent or doesn't answer resolves nothing: the ask stays, as it would have.
 */
import { answerNeeds, ConversationError, openNeeds } from './backends/conversations.js';
import type { WaitsOn } from './backends/needs.js';
import { findPiece } from './cli/pieces.js';
import { managedPieces } from './cli/pieces-managed.js';
import { agentDir, type Household } from './household.js';
import { pieceApi } from './ui/pieces.js';
import { sameAskWords } from './ui/ask-words.js';

/** An approval as the approvals piece tells core: its state, and whose it is. */
export interface ApprovalState { state: string; agent?: string; kind?: string;
  /** An owner-applied one's target only (a `grant`'s `<piece>:<agent>[:<paths>]`, t-1970; a `vouch-wake`'s or a
   * `principal-reset`'s, t-1975; a `box-write-off`'s, t-2057): what the owner's Allow does, for the piece that applies it. */
  target?: string }

/** How core learns whether what an ask waits on is resolved. Undefined: couldn't tell (the piece is absent, or failed). */
export interface WaitCheckers {
  /** Each id's approval, or null for one the piece has no record of (gone). */
  approvals(ids: string[]): Promise<Record<string, ApprovalState | null> | undefined>;
  /** A task's status (open, in_progress, closed, …), or null when there's no such task. */
  task(id: string): Promise<string | null | undefined>;
  /**
   * Whether the owner answered this ask on the task itself since `since` (t-2098): its comment, as the tasks page
   * writes his Yes, No or words ("Yes, to: <ask>"), naming the same words. The ask was folded into that task's card,
   * so his answer there is his answer to it. Undefined: couldn't tell.
   */
  taskAnswered?(id: string, ask: string, since: string): Promise<boolean | undefined>;
}

/** Why an approval's state clears the ask, in words for the FYI; undefined while it still waits (pending). */
export function approvalCleared(a: ApprovalState | null): string | undefined {
  if (a === null) return 'the approval it asked about is gone';
  return ({ allowed: 'the approval was allowed', used: 'the approval was allowed and used', denied: 'the approval was denied', expired: 'the approval was allowed, and expired unused', withdrawn: 'the approval was withdrawn unanswered (asked again with an up-to-date list)' } as Record<string, string>)[a.state];
}

export interface Resolved { agent: string; conversation: string; digest: string; reason: string }

/**
 * One pass: every agent's open asks that wait on something, checked, and each one that's resolved answered so
 * (`resolved`, by loom, with its reason). Several listeners may run it at once; an ask already answered is skipped.
 */
export async function resolveNeeds(h: Household, check: WaitCheckers, now: () => Date = () => new Date()): Promise<Resolved[]> {
  const waiting = h.agents.flatMap((agent) => {
    let open: ReturnType<typeof openNeeds>;
    try { open = openNeeds(agentDir(h, agent)); } catch { return []; }
    return open.flatMap(({ conversation: c, digest: d }) => (d.needs?.waits_on ? [{ agent, conversation: c.id, digest: d.id, on: d.needs.waits_on, ask: d.needs.ask, at: d.at }] : []));
  });
  if (!waiting.length) return [];
  const ids = [...new Set(waiting.flatMap((w) => ('approval' in w.on ? [w.on.approval] : [])))];
  const approvals = ids.length ? await check.approvals(ids).catch(() => undefined) : {};
  const out: Resolved[] = [];
  for (const w of waiting) {
    const reason = await clearedBy(w.on, approvals, check, w);
    if (!reason) continue;
    try {
      answerNeeds(agentDir(h, w.agent), { conversation: w.conversation, digest: w.digest, verdict: 'resolved', by: 'loom', reason }, now());
      out.push({ agent: w.agent, conversation: w.conversation, digest: w.digest, reason });
    } catch (e) {
      // Answered meanwhile (another listener, the owner, a newer digest): nothing to clear.
      if (!(e instanceof ConversationError)) throw e;
    }
  }
  return out;
}

async function clearedBy(on: WaitsOn, approvals: Record<string, ApprovalState | null> | undefined, check: WaitCheckers,
  asked: { ask?: string; at?: string } = {}): Promise<string | undefined> {
  if ('approval' in on) {
    if (!approvals || !(on.approval in approvals)) return undefined;
    return approvalCleared(approvals[on.approval]);
  }
  const status = await check.task(on.task).catch(() => undefined);
  if (status === undefined) return undefined;
  if (status === null) return `${on.task} is gone`;
  if (status === 'closed') return `${on.task} is closed`;
  if (!check.taskAnswered || !asked.ask?.trim() || !asked.at) return undefined;
  return (await check.taskAnswered(on.task, asked.ask, asked.at).catch(() => undefined)) ? `you answered it on ${on.task}` : undefined;
}

/** The ask an owner's answer on a task names, as the tasks page writes it ("Yes, to: <ask>", "No, to: …", "Answer, to: …"). */
export function answeredAsk(text: string): string | undefined {
  const m = /^(?:Yes|No|Answer), to: (.*)$/m.exec(text.split('\n', 1)[0] ?? '');
  return m ? m[1] : undefined;
}

/** The one managed piece holding `role` (the clock's `runtime`, `approvals`, `tasks`), and its bin; none with several. */
export function pieceWithRole(env: NodeJS.ProcessEnv, role: string): { name: string; path: string } | undefined {
  const named = managedPieces(env).filter((r) => r.loom.role === role);
  if (named.length !== 1) return undefined;
  const path = findPiece(named[0].name, env);
  return path ? { name: named[0].name, path } : undefined;
}

const OWNER = { kind: 'owner' as const, agents: '*' as const };

/** The checkers, through the pieces' own APIs as the household owner. */
export function pieceCheckers(env: NodeJS.ProcessEnv): WaitCheckers {
  return {
    async approvals(ids) {
      const p = pieceWithRole(env, 'approvals');
      if (!p) return undefined;
      const r = await pieceApi(p.path, { caller: OWNER, path: 'state', body: { ids } }, env);
      const got = (r.body as { approvals?: Record<string, ApprovalState> } | undefined)?.approvals;
      if (r.status !== 200 || !got || typeof got !== 'object') return undefined;
      // The piece answers for the ids it knows; one it doesn't is gone (aged out, or never was).
      return Object.fromEntries(ids.map((id) => [id, got[id] && typeof got[id].state === 'string' ? got[id] : null]));
    },
    async task(id) {
      const p = pieceWithRole(env, 'tasks');
      if (!p) return undefined;
      const r = await pieceApi(p.path, { caller: OWNER, path: 'run', body: { argv: ['show', id] } }, env);
      const b = r.body as { exit?: number; stdout?: string } | undefined;
      if (r.status !== 200 || !b || typeof b.stdout !== 'string') return undefined;
      let out: { ok?: boolean; task?: { status?: unknown } | null; errors?: unknown };
      try { out = JSON.parse(b.stdout); } catch { return undefined; }
      // No such task is the store saying so (E_UNKNOWN_ID); any other failure tells nothing.
      if (out.ok === false) return Array.isArray(out.errors) && out.errors.includes('E_UNKNOWN_ID') ? null : undefined;
      return typeof out.task?.status === 'string' ? out.task.status : undefined;
    },
    async taskAnswered(id, ask, since) {
      const p = pieceWithRole(env, 'tasks');
      if (!p) return undefined;
      const r = await pieceApi(p.path, { caller: OWNER, path: 'run', body: { argv: ['show', id] } }, env);
      const b = r.body as { stdout?: string } | undefined;
      if (r.status !== 200 || !b || typeof b.stdout !== 'string') return undefined;
      let out: { ok?: boolean; task?: { comments?: unknown } | null };
      try { out = JSON.parse(b.stdout); } catch { return undefined; }
      const comments = Array.isArray(out.task?.comments) ? out.task!.comments as { at?: unknown; text?: unknown }[] : undefined;
      if (out.ok === false || !comments) return undefined;
      return comments.some((c) => typeof c.at === 'string' && typeof c.text === 'string' && c.at >= since
        && sameAskWords(answeredAsk(c.text) ?? '', ask));
    },
  };
}
