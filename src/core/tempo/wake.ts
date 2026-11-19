/** Wake me when: what an agent may ask loom to watch for it, and the words a wake is said in.
 *
 * A wait is an ordinary once-only trigger with an inbox target. What makes it a wake is its `target`, which an
 * inbox trigger otherwise leaves empty: exactly one of WAKE_TARGETS (`wake`, or `wake:<condition>` for a pull
 * request). Nothing else on a trigger holds settings of its own, and this needs no column. It is one of a closed
 * list of exact strings and never a prefix, so the test in code (isWake) and the test in SQL (wakeRows) are the
 * same comparison and cannot disagree. Its `note` is the title a person reads in Tempo, and its `conversation`
 * the one it was asked from. The agent's note to itself is NOT on the trigger: a trigger is read more widely than
 * a private conversation, so the note is kept with the conversation (src/shared-wake.ts, keepNote).
 *
 * Everything here is pure: reading what was asked, judging a condition between two readings of a change, and
 * building plain sentences from records. Who may ask, and where a wake is delivered, is src/shared-wake.ts. */
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { triggers } from '../data/schema.js';
import { DAY_MS } from '../day.js';

export const WAKE_TARGET = 'wake';
/** What a pull request can be watched for. `changed` is anything in its snapshot. */
export const wakeConditions = ['changed', 'checks-finished', 'checks-failed', 'review', 'merged-or-closed'] as const;
export type WakeCondition = typeof wakeConditions[number];
/** How many waits one agent may have pending, how long one may live, and how long its words may be. */
export const WAKES_MAX = 50, WAKE_DAYS = 14, WAKE_MS = WAKE_DAYS * DAY_MS, WAKE_NOTE_MAX = 2_000, WAKE_WORDS_MAX = 4_000;
/** A time may be asked for at most this far ahead: the life of a wait less a clear margin, so a time wake always
 * comes due well before the sweep that ends old waits could meet it (src/shared-wake.ts, expireWakes). */
export const WAKE_TIME_MARGIN_MS = 3_600_000, WAKE_TIME_MOST_MS = WAKE_MS - WAKE_TIME_MARGIN_MS;
export const WAKE_TOO_OLD = `That wait was asked more than ${WAKE_DAYS} days ago and has ended: ask again.`;
/** The trigger log rows a wake keeps for itself: what it last read of a change, as JSON. */
export const WAKE_FACTS = 'wake-facts';

export const wakeInput = z.object({
  /** `github:owner/repo#12` (or `owner/repo#12`, or the pull request's address), `job:<id>`, `approval:<id>`,
   * `question:<id>`, `secret-request:<id>`, `at:<instant with offset>` or `in:<minutes>`. */
  what: z.string().min(1).max(300),
  when: z.enum(wakeConditions).optional(),
  /** A note to self: what I was doing, and what to do when woken. Kept with the conversation the wake belongs to, never on the trigger (src/shared-wake.ts, keepNote). */
  note: z.string().max(WAKE_NOTE_MAX).optional(),
  /** A terminal session says which session it is, by either of the two ids its hook holds: its harness session id
   * (`session`) or the conversation `terminal.session` answered (`conversation`). loom checks that it is a live
   * session of the caller's own machine, member and agent. A body names nothing: it is woken where it works. */
  session: z.string().min(1).max(200).optional(),
  conversation: z.string().min(1).max(200).optional(),
}).strict();
export type WakeInput = z.infer<typeof wakeInput>;

export const wakeTarget = (condition?: WakeCondition): string => condition ? `${WAKE_TARGET}:${condition}` : WAKE_TARGET;
/** Every target a wake can have, exactly. */
export const WAKE_TARGETS: readonly string[] = [WAKE_TARGET, ...wakeConditions.map(wakeTarget)];
/** Is this trigger a wake: an inbox trigger whose target is exactly one of WAKE_TARGETS. */
export const isWake = (t: { targetKind?: string | null; target?: string | null }): boolean =>
  t.targetKind === 'inbox' && typeof t.target === 'string' && WAKE_TARGETS.includes(t.target);
/** The same test as a filter on trigger rows: `=` on the same exact strings (SQLite compares text exactly). */
export const wakeRows = () => and(eq(triggers.targetKind, 'inbox'), inArray(triggers.target, [...WAKE_TARGETS]));
/** A target no ordinary trigger may carry: anything that begins like a wake's, in any case. Only the wake door
 * writes one, and it writes only WAKE_TARGETS, so nothing that looks like a wake and is not one can be stored. */
export const looksLikeWake = (target: string | null | undefined): boolean => !!target && target.trim().toLowerCase().startsWith(WAKE_TARGET);
export function wakeCondition(t: { target?: string | null }): WakeCondition | undefined {
  const named = t.target?.startsWith(`${WAKE_TARGET}:`) ? t.target.slice(WAKE_TARGET.length + 1) : undefined;
  return (wakeConditions as readonly string[]).includes(named ?? '') ? named as WakeCondition : undefined;
}

export type Watched =
  | { kind: 'change'; sourceKind: 'pull-request'; id: string; repository: string; number: number }
  | { kind: 'job'; sourceKind: 'job'; id: string }
  | { kind: 'approval' | 'question' | 'secret-request'; sourceKind: 'answer'; id: string }
  | { kind: 'time'; sourceKind: 'time'; at: string };
/** The watch name a source reports under (sources.ts, tempoWatch), or nothing for a time. */
export const watchName = (w: Watched): string | null => w.kind === 'time' ? null : `${w.kind}:${w.id}`;

const pull = /^(?:github:)?([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#([1-9][0-9]{0,9})$/;
const pullAddress = /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/([1-9][0-9]{0,9})\/?$/;
const instant = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/;
/** Read what was asked. Throws a plain Error, in words for the asker, for anything it cannot read. */
export function readWatched(what: string, now: number): Watched {
  const text = what.trim(), change = pull.exec(text) ?? pullAddress.exec(text);
  if (change) {
    const repository = change[1].toLowerCase().replace(/\.git$/, '');
    return { kind: 'change', sourceKind: 'pull-request', id: `github:${repository}#${change[2]}`, repository, number: Number(change[2]) };
  }
  const colon = text.indexOf(':'), prefix = colon > 0 ? text.slice(0, colon) : '', rest = colon > 0 ? text.slice(colon + 1).trim() : '';
  if (/^job-/.test(text)) return { kind: 'job', sourceKind: 'job', id: text };
  if (prefix === 'job' && rest) return { kind: 'job', sourceKind: 'job', id: rest };
  if ((prefix === 'approval' || prefix === 'question') && rest) return { kind: prefix, sourceKind: 'answer', id: rest };
  if ((prefix === 'secret-request' || prefix === 'secret') && rest) return { kind: 'secret-request', sourceKind: 'answer', id: rest };
  if (prefix === 'in') {
    if (!/^[1-9][0-9]{0,5}$/.test(rest)) throw new Error('A delay is a whole number of minutes: in:30');
    return time(now + Number(rest) * 60_000, now);
  }
  const at = prefix === 'at' ? rest : text;
  if (instant.test(at) && Number.isFinite(Date.parse(at))) return time(Date.parse(at), now);
  throw new Error('Say what to watch: github:owner/repo#12, job:<id>, approval:<id>, question:<id>, secret-request:<id>, at:<instant with its offset> or in:<minutes>');
}
function time(at: number, now: number): Watched {
  if (at <= now) throw new Error('That time has passed');
  if (at - now > WAKE_TIME_MOST_MS) throw new Error(`A time to be woken at is at most ${WAKE_DAYS} days less an hour away`);
  return { kind: 'time', sourceKind: 'time', at: new Date(at).toISOString() };
}
/** What was asked, read back from a stored wake. */
export function watchedOf(t: { sourceKind: string; watches?: string | null; times?: string | null }): Watched | undefined {
  if (t.sourceKind === 'time') return t.times ? { kind: 'time', sourceKind: 'time', at: t.times } : undefined;
  const watch = t.watches ?? '', colon = watch.indexOf(':'), prefix = watch.slice(0, colon), id = watch.slice(colon + 1);
  if (colon < 1 || !id) return undefined;
  if (t.sourceKind === 'pull-request' && prefix === 'change') { const found = pull.exec(id); return found ? { kind: 'change', sourceKind: 'pull-request', id, repository: found[1], number: Number(found[2]) } : undefined; }
  if (t.sourceKind === 'job' && prefix === 'job') return { kind: 'job', sourceKind: 'job', id };
  if (t.sourceKind === 'answer' && (prefix === 'approval' || prefix === 'question' || prefix === 'secret-request')) return { kind: prefix, sourceKind: 'answer', id };
  return undefined;
}

/** A pull request as people write it: `owner/repo#12`. */
export const changeName = (id: string): string => id.replace(/^github:/, '');
/** An id as loom's own lines show it: cut at a length, with nothing in it that is not printable. */
const shown = (id: string): string => { const clean = id.replace(/[\p{C}\u2028\u2029]/gu, ''); return clean.length > 80 ? clean.slice(0, 80) + '…' : clean; };
/** "…when <this>": what the wait is for, as a clause. */
export function wakeClause(w: Watched, condition?: WakeCondition): string {
  switch (w.kind) {
    case 'change': { const name = changeName(w.id);
      return condition === 'checks-finished' ? `checks finish on ${name}` : condition === 'checks-failed' ? `a check fails on ${name}`
        : condition === 'review' ? `the review of ${name} changes` : condition === 'merged-or-closed' ? `${name} is merged or closed` : `${name} changes`; }
    case 'job': return `job ${shown(w.id)} ends`;
    case 'approval': return `approval ${shown(w.id)} is answered`;
    case 'question': return `question ${shown(w.id)} is answered`;
    case 'secret-request': return `secret request ${shown(w.id)} is answered`;
    case 'time': return `it is ${w.at}`;
  }
}
/** "Waiting on <this>", for the agent's doing list. Nothing for a time: that is said by its instant. */
export function waitingOn(w: Watched, condition?: WakeCondition): string | null {
  switch (w.kind) {
    case 'change': { const name = changeName(w.id);
      return condition === 'checks-finished' ? `checks on ${name}` : condition === 'checks-failed' ? `a failing check on ${name}`
        : condition === 'review' ? `the review of ${name} to change` : condition === 'merged-or-closed' ? `${name} to merge or close` : `${name} to change`; }
    case 'job': return `job ${shown(w.id)}`;
    case 'approval': return `an answer to approval ${shown(w.id)}`;
    case 'question': return `an answer to question ${shown(w.id)}`;
    case 'secret-request': return `an answer to secret request ${shown(w.id)}`;
    case 'time': return null;
  }
}
const titled = (id: string) => id ? id[0].toUpperCase() + id.slice(1) : id;
/** The trigger's note: what a person reads in Tempo's list. */
export const wakeTitle = (agent: string, w: Watched, condition?: WakeCondition): string =>
  w.kind === 'time' ? `Wake ${titled(agent)} at ${w.at}` : `Wake ${titled(agent)} when ${wakeClause(w, condition)}`;

/** What a wake keeps of a change between two readings: enough to judge a condition and to say before and after. */
export interface ChangeFacts {
  state: 'open' | 'merged' | 'closed'; draft: boolean; head: string; title: string;
  checks: 'passing' | 'failing' | 'running' | 'none'; failing: string[]; running: string[];
  review: 'approved' | 'changes_requested' | 'required' | 'not_required'; reviewers: string[]; mergeable: 'yes' | 'no' | 'unknown';
}
export function parseFacts(note: string | undefined): ChangeFacts | undefined {
  if (!note) return undefined;
  try { const value = JSON.parse(note) as ChangeFacts; return value && typeof value.head === 'string' && Array.isArray(value.failing) && Array.isArray(value.running) && Array.isArray(value.reviewers) ? value : undefined; }
  catch { return undefined; }
}
const list = (names: readonly string[], most = 5): string => names.length > most ? `${names.slice(0, most).join(', ')} and ${names.length - most} more` : names.join(', ');
const commit = (head: string): string => head.slice(0, 7) || 'an unknown commit';
/** No check pending or running, and at least one reported: `none` is a head whose checks have not begun. */
const finished = (f: ChangeFacts): boolean => (f.checks === 'passing' || f.checks === 'failing') && f.running.length === 0;
export function checksWords(f: ChangeFacts): string {
  if (f.checks === 'none') return 'none reported yet';
  if (f.checks === 'passing') return 'all passed';
  const failed = f.failing.length ? `${f.failing.length} failed: ${list(f.failing)}` : 'failing';
  return f.checks === 'running' || f.running.length ? [f.failing.length ? failed : '', `${f.running.length || 'some'} still running`].filter(Boolean).join(', ') : failed;
}
const reviewWords: Record<ChangeFacts['review'], string> = { approved: 'approved', changes_requested: 'changes requested', required: 'review required, none given yet', not_required: 'no review required' };
/** One line on how a change stands now, for the answer to "wake me when". */
export function standsNow(f: ChangeFacts): string {
  if (f.state !== 'open') return f.state === 'merged' ? 'it is merged' : 'it is closed, not merged';
  return `${f.draft ? 'a draft; ' : ''}checks: ${checksWords(f)}; review: ${reviewWords[f.review]}`;
}
/** `review` is any change in where the review stands: a review submitted (a new reviewer), or its state moving
 * either way, which includes an approval taken back by a new push. The words say which.
 *
 * What happened, in plain words with before and after, when this wake's condition has come true between the last
 * reading (`before`) and this one; nothing when it has not. A wake fires on its condition becoming true, never on
 * its staying true: checks that finished on one head commit are said once for that head, and a new head starts
 * unfinished. A change that is merged or closed ends every other wait on it, and says so. */
export function changeHappened(condition: WakeCondition, name: string, before: ChangeFacts | undefined, now: ChangeFacts): string | undefined {
  const ended = now.state !== 'open' && (!before || before.state === 'open');
  const how = now.state === 'merged' ? 'was merged' : 'was closed without merging';
  if (condition === 'merged-or-closed') return now.state === 'open' ? undefined : `${name} ${how}.`;
  const pushed = !!before && before.head !== now.head;
  if (condition === 'checks-finished') {
    if (finished(now) && !(before && finished(before) && !pushed))
      return `Checks on ${name} finished on ${commit(now.head)}: ${checksWords(now)}.${before ? ` Before: ${checksWords(before)}${pushed ? ` on ${commit(before.head)}` : ''}.` : ''}`;
  } else if (condition === 'checks-failed') {
    if (now.checks === 'failing' && !(before && before.checks === 'failing' && !pushed))
      return `A check failed on ${name}: ${now.failing.length ? list(now.failing) : 'GitHub does not say which'}${now.running.length ? `; ${now.running.length} still running` : ''}.${before ? ` Before: ${checksWords(before)}.` : ''}`;
  } else if (condition === 'review') {
    const fresh = before ? now.reviewers.filter(login => !before.reviewers.includes(login)) : now.reviewers;
    if (!before ? now.review === 'approved' || now.review === 'changes_requested' : before.review !== now.review || fresh.length > 0)
      return `Review on ${name}: ${reviewWords[now.review]}${before && before.review !== now.review ? ` (before: ${reviewWords[before.review]})` : ''}.${fresh.length ? ` Reviewed by ${list(fresh)}.` : ''}`;
  } else {
    if (!before) return `${name} changed. Now: ${standsNow(now)}.`;
    const parts = [
      before.state !== now.state ? `it ${how}` : '',
      pushed ? `new head commit ${commit(now.head)} (was ${commit(before.head)})` : '',
      before.checks !== now.checks || before.failing.join('\n') !== now.failing.join('\n') || before.running.length !== now.running.length ? `checks: ${checksWords(now)} (before: ${checksWords(before)})` : '',
      before.review !== now.review ? `review: ${reviewWords[now.review]} (before: ${reviewWords[before.review]})` : '',
      before.draft !== now.draft ? (now.draft ? 'it became a draft' : 'it is no longer a draft') : '',
      before.mergeable !== now.mergeable ? (now.mergeable === 'no' ? 'it now conflicts with its base' : now.mergeable === 'yes' ? 'it can be merged cleanly' : 'whether it merges cleanly is not known') : '',
      before.title !== now.title ? 'its title changed' : '',
    ].filter(Boolean);
    return `${name} changed: ${parts.length ? parts.join('; ') : 'something other than its commit, checks, review or state (its text, its people or the tasks it names)'}.`;
  }
  // The thing waited for can no longer happen on a change that is merged or closed: the wait ends, and says so.
  return ended ? `${name} ${how} before ${condition === 'review' ? 'a new review' : condition === 'checks-failed' ? 'a check failed' : 'its checks finished'}; the watch has ended.` : undefined;
}
/** Whether two readings differ in anything a later "before" would say. */
export const factsDiffer = (a: ChangeFacts | undefined, b: ChangeFacts): boolean => !a || JSON.stringify(a) !== JSON.stringify(b);

/** All that is said when a wake's words cannot be delivered anywhere as private as where it was asked: no note, no
 * subject, no conversation id. */
export const WAIT_ENDED_BARE = 'A wait you set has ended; the conversation it was set in is gone.';
/** Why a wake is not changed after it is asked: its bounds (how long it lives, how much it says) are set at its door. */
export const WAKE_EDIT_REFUSAL = 'A wait is not changed once it is asked for: cancel it (tempo.stop) and ask again.';
export const wakesFull = (agent: string): string => `${agent} already has ${WAKES_MAX} waits pending. Cancel one first (tempo.stop).`;
/** What a wake says when the thing it watched is no longer the asker's to read: that the watch ended, and no more. */
export const WATCH_ENDED = 'The watch ended: what it watched is no longer yours to read.';
export const watchExpired = (clause: string): string => `The watch ended: ${WAKE_DAYS} days passed and it never happened that ${clause}.`;
/** The same, for a time that never came because the wait could not fire (its agent was held). */
export const TIME_EXPIRED = `The wait ended: ${WAKE_DAYS} days passed since you asked, and it could not be delivered at its time.`;
/** The whole message of a wake, bounded: loom's own lines first, and the agent's note last and named as its own. */
export function wakeWords(parts: { clause: string; askedAt: string; askedBy: string; happened: string; link?: string | null; note?: string | null; also?: string }): string {
  const cut = (text: string, most: number) => text.length > most ? text.slice(0, most - 1) + '…' : text;
  const lines = [
    `[A wake from loom, not a person speaking now. ${parts.askedBy} asked at ${parts.askedAt} to be woken when ${parts.clause}.]`,
    cut(parts.happened, 1_200),
    parts.link ? `See ${cut(parts.link, 300)}` : '',
    parts.also ?? '',
    parts.note ? `Your note to yourself when you asked, in the words written then: ${JSON.stringify(cut(parts.note, WAKE_NOTE_MAX))}` : '',
  ].filter(Boolean);
  return cut(lines.join('\n\n'), WAKE_WORDS_MAX);
}
