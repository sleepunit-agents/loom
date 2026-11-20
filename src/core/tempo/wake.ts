import { z } from 'zod';
import { DAY_MS } from '../day.js';
import { wakes } from '../data/schema.js';

export const wakeConditions = wakes.condition.enumValues;
export type WakeCondition = typeof wakeConditions[number];
/** How many waits one conversation may have pending, how long one may live, and how long its words may be. */
export const WAKES_PER_CONVERSATION = 20, WAKE_DAYS = 14, WAKE_MS = WAKE_DAYS * DAY_MS, WAKE_NOTE_MAX = 2_000, WAKE_WORDS_MAX = 4_000;
/** A time may be asked for at most this far ahead: the life of a wait less a clear margin, so a time wake always
 * comes due well before the sweep that ends old waits could meet it (src/shared-wake.ts). */
export const WAKE_TIME_MARGIN_MS = 3_600_000, WAKE_TIME_MOST_MS = WAKE_MS - WAKE_TIME_MARGIN_MS;

export const wakeInput = z.object({
  /** `github:owner/repo#12` (or `owner/repo#12`, or the pull request's address), `job:<id>`, `approval:<id>`. */
  what: z.string().min(1).max(300),
  when: z.enum(wakeConditions).optional(),
  /** A note to self: what I was doing, and what to do when woken. Kept with the conversation the wake belongs to, never on the trigger (src/shared-wake.ts). */
  note: z.string().max(WAKE_NOTE_MAX).optional(),
}).strict();
export type Watched =
  | { kind: 'change'; id: string; repository: string }
  | { kind: 'job'; id: string }
  | { kind: 'approval' | 'question'; id: string }
  | { kind: 'time'; at: string };

const pull = /^(?:github:)?([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#([1-9][0-9]{0,9})$/;
const pullAddress = /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/([1-9][0-9]{0,9})\/?$/;
const instant = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/;
/** Read what was asked. Throws a plain Error, in words for the asker, for anything it cannot read. */
export function readWatched(what: string, now: number): Watched {
  const text = what.trim(), change = pull.exec(text) ?? pullAddress.exec(text);
  if (change) {
    const repository = change[1];
    return { kind: 'change', id: `github:${repository}#${change[2]}`, repository };
  }
  const colon = text.indexOf(':'), prefix = colon > 0 ? text.slice(0, colon) : '', rest = colon > 0 ? text.slice(colon + 1).trim() : '';
  if (/^job-/.test(text)) return { kind: 'job', id: text };
  if (prefix === 'job' && rest) return { kind: 'job', id: rest };
  if ((prefix === 'approval' || prefix === 'question') && rest) return { kind: prefix, id: rest };
  if (prefix === 'in') {
    if (!/^[1-9][0-9]{0,5}$/.test(rest)) throw new Error('A delay is a whole number of minutes: in:30');
    return time(now + Number(rest) * 60_000, now);
  }
  const at = prefix === 'at' ? rest : text;
  if (instant.test(at) && Number.isFinite(Date.parse(at))) return time(Date.parse(at), now);
  throw new Error('Say what to watch: github:owner/repo#12, job:<id>, approval:<id>, question:<id>, at:<instant with its offset> or in:<minutes>');
}
function time(at: number, now: number): Watched {
  if (at <= now) throw new Error('That time has passed');
  if (at - now > WAKE_TIME_MOST_MS) throw new Error(`A time to be woken at is at most ${WAKE_DAYS} days less an hour away`);
  return { kind: 'time', at: new Date(at).toISOString() };
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
        : condition === 'review' ? `the review decision changes or a new reviewer reviews ${name}` : condition === 'merged-or-closed' ? `${name} is merged or closed` : `${name} changes`; }
    case 'job': return `job ${shown(w.id)} ends`;
    case 'approval': return `approval ${shown(w.id)} is answered`;
    case 'question': return `question ${shown(w.id)} is answered`;
    case 'time': return `it is ${w.at}`;
  }
}
/** "Waiting on <this>", for the agent's doing list. Times are shown by their UTC instant. */
export function waitingOn(w: Watched, condition?: WakeCondition): string {
  switch (w.kind) {
    case 'change': { const name = changeName(w.id);
      return condition === 'checks-finished' ? `checks on ${name}` : condition === 'checks-failed' ? `a failing check on ${name}`
        : condition === 'review' ? `the review decision to change or a new reviewer to review ${name}` : condition === 'merged-or-closed' ? `${name} to merge or close` : `${name} to change`; }
    case 'job': return `job ${shown(w.id)}`;
    case 'approval': return `an answer to approval ${shown(w.id)}`;
    case 'question': return `an answer to question ${shown(w.id)}`;
    case 'time': return w.at;
  }
}
export interface ChangeFacts {
  state: 'open' | 'merged' | 'closed'; draft: boolean; head: string; title: string;
  checks: 'passing' | 'failing' | 'running' | 'none'; failing: string[]; running: string[];
  review: 'approved' | 'changes_requested' | 'required' | 'not_required'; reviewers: string[]; mergeable: 'yes' | 'no' | 'unknown';
}
const list = (names: readonly string[], most = 5): string => names.length > most ? `${names.slice(0, most).join(', ')} and ${names.length - most} more` : names.join(', ');
const commit = (head: string): string => head.slice(0, 7) || 'an unknown commit';
/** No check pending or running, and at least one reported: `none` is a head whose checks have not begun. */
export const finished = (f: ChangeFacts): boolean => (f.checks === 'passing' || f.checks === 'failing') && f.running.length === 0;
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
  if (condition === 'merged-or-closed') return ended ? `${name} ${how}.` : undefined;
  const pushed = !!before && before.head !== now.head;
  if (condition === 'checks-finished') {
    if (finished(now) && !(before && finished(before) && !pushed))
      return `Checks on ${name} finished on ${commit(now.head)}: ${checksWords(now)}.${before ? ` Before: ${checksWords(before)}${pushed ? ` on ${commit(before.head)}` : ''}.` : ''}`;
  } else if (condition === 'checks-failed') {
    const alreadyFailing = before && before.checks === 'failing' && !pushed;
    const fresh = now.failing.filter(check => !alreadyFailing || !before.failing.includes(check)
      || before.running.includes(check) && !now.running.includes(check));
    if (now.checks === 'failing' && (!alreadyFailing || fresh.length))
      return `A check failed on ${name}: ${fresh.length ? list(fresh) : 'GitHub does not say which'}${now.running.length ? `; ${now.running.length} still running` : ''}.${before ? ` Before: ${checksWords(before)}.` : ''}`;
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
}

export function storedWatch(kind: Watched['kind'], key: string): Watched {
  if (kind === 'time') return { kind, at: key };
  if (kind === 'change') {
    const separator = key.lastIndexOf('#');
    return { kind, id: key, repository: key.slice(7, separator) };
  }
  return { kind, id: key };
}

export const WATCH_ENDED = 'The watch ended: what it watched is no longer yours to read.';
