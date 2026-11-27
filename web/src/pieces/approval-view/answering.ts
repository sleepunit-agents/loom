/** How an approval is read and answered: the decisions, with no component, no kit and no stylesheet.
 *
 * The desktop's approval view (./index.tsx) and the board's `approval` brick (web/src/boards/bricks-approval.tsx)
 * both draw from this file, so there is one copy of every safeguard: who is offered an answer, what is said before
 * one, the reviewed version an Allow names, the second yes a dangerous action takes, how a reason for denying is
 * sent, and how a refused answer is said. Each caller owns only its markup.
 *
 * A drawn control is not authority: `approvals.answer` rechecks every answer (src/shared-work-commands.ts). */
import { useRef, useState } from 'react';
import { shellCommandRecord } from '../../../../src/apps/shell-command-record';
import { approvalTitle, kindWord, quotedDecision, type Approval, type Record as ApprovalRecord } from './model';

/** The composition binds these commands to the authenticated operation door.
 * A visible button is not authority: the operation rechecks the exact request.
 * Always is offered only when that door supplies its concrete scope and action.
 */
export interface ApprovalActions {
  openRuleConversation?(path:string):void;
  refreshProposal?(id: string): void;
  supports?(approval: Approval): boolean;
  /** confirm is the second, explicit yes a dangerous action needs. */
  allow(id: string, confirm?: boolean, review?: string): Promise<void>;
  deny(id: string, reason?: string): Promise<void>;
  always?: { label: string; approval: string; run(id: string): Promise<void> };
}
export type Name = (id: string) => string;

/** The longest reason `approvals.answer` takes. */
export const reasonLimit = 2000;
/** Said when an answer failed and the program gave no words of its own for the person answering. */
export const answerFailed = 'Could not save your answer. Reconnect and try again.';
/** Said beside the second yes. */
export const secondYesWords = 'This cannot be undone.';

/** The question is said under the title only when it says more than the title with a question mark. */
export const same = (words: string) => words.trim().replace(/[?.!\s]+$/, '').toLowerCase();
/** Who a private request is for: "for you" when it is the viewer's own, the person's name otherwise. */
export const forWhom = (a: Pick<Approval, 'member'>, viewer: string | undefined, name: Name) => a.member ? a.member === viewer ? 'for you' : `for ${name(a.member)}` : '';

/** Whether answer controls are drawn at all: the request still waits, the composition gave this viewer the
 * commands (it gives them only to a member loom says may answer), and it does not rule this request out. */
export function answerable(approval: Pick<Approval, 'state'>, actions: ApprovalActions | undefined): actions is ApprovalActions {
  return approval.state === 'pending' && !!actions && (!actions.supports || actions.supports(approval as Approval));
}
/** An action that cannot be put back is allowed only on a second, explicit yes. */
export const needsSecondYes = (approval: Pick<Approval, 'kind'>) => approval.kind === 'dangerous';
/** The answering state belongs to one reading of one request. A view keys its answer controls by this, so a request
 * that is read again in a new version starts over: nothing pressed for the old version carries to the new one. */
export const answerKey = (approval: Pick<Approval, 'id' | 'review'>) => approval.review ?? approval.id;

/** Allow, naming the version of the change that was on screen where the program gave one. */
export function sendAllow(approval: Pick<Approval, 'id' | 'review'>, actions: ApprovalActions, confirm?: boolean): Promise<void> {
  return approval.review ? actions.allow(approval.id, confirm, approval.review)
    : confirm ? actions.allow(approval.id, true) : actions.allow(approval.id);
}
/** Deny, with the reason only when one was written. */
export function sendDeny(approval: Pick<Approval, 'id'>, actions: ApprovalActions, reason: string): Promise<void> {
  return reason.trim() ? actions.deny(approval.id, reason.trim()) : actions.deny(approval.id);
}
/** A refusal is the program's own answer, in words written for the person answering: say it as it is.
 * Anything else that failed stays behind one fixed line. */
export function refusalWords(error: unknown): string {
  const refused = error as { name?: unknown; message?: unknown } | null;
  return refused?.name === 'WorkRefused' && typeof refused.message === 'string' ? refused.message : answerFailed;
}
/** What is said above the answer: the request was read again in a new version, or something already stands
 * against allowing it. Null when there is nothing to say. */
export function cautionWords(a: Pick<Approval, 'operation' | 'state' | 'review' | 'blocked' | 'problem'>): string | null {
  const household = a.operation === 'household.change';
  return a.review ? 'The request has been refreshed. Review the current settings before allowing it.'
    : household && a.state === 'pending' && a.blocked ? `loom will refuse this as things stand: ${a.blocked.replace(/^This cannot be allowed(?: yet| as it stands)?: /, '')}`
    : !household && a.problem ? `This cannot be allowed as it stands: ${a.problem}` : null;
}

/** Everything a view says about one request before it is answered, decided once.
 *
 * A household change's stored words are the filing agent's. They are shown only with the owner's reading of the
 * change as it stands now (`card`); without it, the title and the reason are all that is said. */
export function approvalReading(a: Approval, records: readonly ApprovalRecord[], name: Name, options: { displayTitle?: string; change?: boolean } = {}) {
  const household = a.operation === 'household.change';
  const record = records.filter(r => r.approval === a.id).sort((x, y) => x.seq - y.seq);
  const decision = record.filter(r => r.event === 'allow' || r.event === 'deny').at(-1);
  const card = a.card;
  const kind = kindWord[a.kind] ?? a.kind;
  const shell = a.kind === 'command' && record.some(event => event.event === 'request' && event.note === shellCommandRecord);
  return {
    household, record, decision, card, kind, shell,
    title: card?.title ?? options.displayTitle ?? approvalTitle(a),
    /** The stored question, where it says more than the title. */
    ask: !household && a.ask && same(a.ask) !== same(a.what) ? a.ask : '',
    /** Whether the stored words (who, for whom, what each answer does, the answer given) are shown. */
    showStored: !household || !!card,
    ifYes: card?.ifYes ?? a.ifYes, ifNo: card?.ifNo ?? a.ifNo,
    /** The stored summary of the change, unless the view draws that change as a checked before and after. */
    storedSummary: !household && !options.change && a.changeSummary ? a.changeSummary : '',
    /** Exactly what an Allow lets the agent do. */
    allows: household ? '' : `${kind}: ${a.target}`,
    /** The literal command, where the request was filed as one. */
    fullCommand: shell ? a.details : '',
    /** The request as the program says it to an owner. */
    exact: card?.exact ?? a.exactRequest ?? '',
    /** The stored details, where nothing above already says them. */
    details: !household && !shell && !options.change && a.details ? a.details : '',
    /** Who answered, in the record's own words where the answer was quoted from a conversation. */
    answered: a.decidedBy ? quotedDecision(decision) ?? `Answered by ${name(a.decidedBy)}` : '',
  };
}
export type ApprovalReading = ReturnType<typeof approvalReading>;

/** The answer itself, step by step, for one reading of one request (see answerKey).
 *
 * `open` says whether any control is drawn. Allow is one press, except for a dangerous action: there `allow` only
 * asks, and `confirm` sends. One call is in flight at a time; while it is, `busy` is true and every press is
 * dropped. A failed Allow has the composition read the request again. */
export function useAnswering(approval: Approval, actions?: ApprovalActions) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirming, setConfirming] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [reason, setReason] = useState('');
  const dangerous = needsSecondYes(approval);
  const active = useRef(false);
  async function send(action: () => Promise<void>, allowing = false) {
    if (active.current) return;
    active.current = true; setBusy(true); setError('');
    try {
      await action();
      if (allowing) setAllowed(true);
    } catch (error) {
      if (allowing) actions?.refreshProposal?.(approval.id);
      setError(refusalWords(error));
    }
    finally { active.current = false; setBusy(false); }
  }
  const open = answerable(approval, actions);
  const always = open && actions.always?.approval === approval.id ? actions.always : undefined;
  return {
    open, busy, error, reason, setReason,
    /** An Allow sent from here was taken: what stood against the request is no longer said. */
    allowed,
    /** The second yes is being asked. */
    confirming: dangerous && confirming,
    /** The first press. It sends, unless the action is dangerous: then it only asks for the second yes. */
    allow() { if (!open) return; if (dangerous) setConfirming(true); else void send(() => sendAllow(approval, actions), true); },
    /** The second, explicit yes of a dangerous action. */
    confirm() { if (open && dangerous && confirming) void send(() => sendAllow(approval, actions, true), true); },
    cancel() { setConfirming(false); },
    deny() { if (open) void send(() => sendDeny(approval, actions, reason)); },
    /** A standing answer, where the composition offers one for this very request. */
    always: always && { label: always.label, run() { void send(() => always.run(approval.id)); } },
  };
}
