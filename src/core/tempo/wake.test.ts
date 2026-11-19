import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createDataSchema } from '../data/database.js';
import { agents, triggers } from '../data/schema.js';
import { WAKE_TARGETS, looksLikeWake, wakeClause, wakeRows } from './wake.js';
import { changeHappened, isWake, readWatched, waitingOn, wakeCondition, wakeTitle, wakeWords, watchName, watchedOf, WAKE_MS, WAKE_WORDS_MAX, type ChangeFacts } from './wake.js';

const now = Date.parse('2026-11-19T18:00:00.000Z');
const facts = (over: Partial<ChangeFacts> = {}): ChangeFacts => ({ state: 'open', draft: false, head: 'a'.repeat(40), title: 'A change', checks: 'running', failing: [], running: ['build'],
  review: 'required', reviewers: [], mergeable: 'yes', ...over });

it('reads what to watch, however a pull request is written, and refuses what it cannot read', () => {
  const pull = { kind: 'change', sourceKind: 'pull-request', id: 'github:sleepunit-agents/loom#33', repository: 'sleepunit-agents/loom', number: 33 };
  for (const what of ['github:Sleepunit-Agents/loom#33', 'sleepunit-agents/loom#33', ' https://github.com/sleepunit-agents/loom/pull/33 ']) expect(readWatched(what, now)).toEqual(pull);
  expect(watchName(readWatched('github:a/b#1', now))).toBe('change:github:a/b#1');
  expect(readWatched('job:job-1', now)).toEqual({ kind: 'job', sourceKind: 'job', id: 'job-1' });
  expect(readWatched('job-1', now)).toEqual({ kind: 'job', sourceKind: 'job', id: 'job-1' });
  expect(readWatched('secret:sr-1', now)).toEqual({ kind: 'secret-request', sourceKind: 'answer', id: 'sr-1' });
  expect(readWatched('in:90', now)).toEqual({ kind: 'time', sourceKind: 'time', at: '2026-11-19T19:30:00.000Z' });
  expect(readWatched('at:2026-11-20T09:00:00-06:00', now)).toEqual({ kind: 'time', sourceKind: 'time', at: '2026-11-20T15:00:00.000Z' });
  for (const bad of ['in:0', 'in:soon', 'at:2026-11-20T09:00:00', '2026-11-19T17:00:00Z', `in:${WAKE_MS / 60_000 + 1}`, 'a/b#0', 'approval:', 'pr 33'])
    expect(() => readWatched(bad, now), bad).toThrow();
  // A stored wake reads back as what was asked.
  expect(watchedOf({ sourceKind: 'pull-request', watches: 'change:github:a/b#12' })).toMatchObject({ kind: 'change', number: 12 });
  expect(watchedOf({ sourceKind: 'answer', watches: 'question:in-1' })).toEqual({ kind: 'question', sourceKind: 'answer', id: 'in-1' });
  expect(watchedOf({ sourceKind: 'job', watches: 'approval:a-1' })).toBeUndefined();
});

it('marks a wake by its inbox target, and titles it for a person', () => {
  expect(isWake({ targetKind: 'inbox', target: 'wake' })).toBe(true);
  expect(isWake({ targetKind: 'inbox', target: 'wake:review' })).toBe(true);
  for (const target of [null, 'wakeful', 'tempo.sweep']) expect(isWake({ targetKind: 'inbox', target })).toBe(false);
  expect(isWake({ targetKind: 'operation', target: 'wake' })).toBe(false);
  expect(wakeCondition({ target: 'wake:checks-finished' })).toBe('checks-finished');
  expect(wakeCondition({ target: 'wake:anything' })).toBeUndefined();
  const pull = readWatched('sleepunit-agents/loom#33', now);
  expect(wakeTitle('art', pull, 'checks-finished')).toBe('Wake Art when checks finish on sleepunit-agents/loom#33');
  expect(waitingOn(pull, 'checks-finished')).toBe('checks on sleepunit-agents/loom#33');
  expect(waitingOn(readWatched('in:5', now))).toBeNull();
});

it('judges checks finished once per head: not while a new run is starting, not again for the head it was already finished on', () => {
  const on = (before: ChangeFacts | undefined, after: ChangeFacts) => changeHappened('checks-finished', 'a/b#1', before, after);
  const green = facts({ checks: 'passing', running: [] }), pushed = 'b'.repeat(40);
  expect(on(facts(), green)).toBe('Checks on a/b#1 finished on aaaaaaa: all passed. Before: 1 still running.');
  expect(on(green, { ...green, title: 'Renamed' })).toBeUndefined();
  // After a push: no checks yet, then running, are both unfinished; finished on the new head is news even straight from green.
  expect(on(green, facts({ head: pushed, checks: 'none', running: [] }))).toBeUndefined();
  expect(on(green, facts({ head: pushed }))).toBeUndefined();
  expect(on(green, { ...green, head: pushed })).toBe('Checks on a/b#1 finished on bbbbbbb: all passed. Before: all passed on aaaaaaa.');
  // A check that failed while another still runs is not finished; it is a failed check.
  const half = facts({ checks: 'failing', failing: ['lint'], running: ['build'] });
  expect(on(facts(), half)).toBeUndefined();
  expect(changeHappened('checks-failed', 'a/b#1', facts(), half)).toBe('A check failed on a/b#1: lint; 1 still running. Before: 1 still running.');
  expect(changeHappened('checks-failed', 'a/b#1', half, { ...half, running: [] })).toBeUndefined();
});

it('bounds the words of a wake, and quotes the note as the agent\'s own', () => {
  const words = wakeWords({ clause: 'a/b#1 changes', askedAt: '2026-11-19T18:00:00.000Z', askedBy: 'You', happened: 'x'.repeat(5_000), link: 'https://github.com/a/b/pull/1', note: 'line one\nline "two"' + 'y'.repeat(5_000) });
  expect(words.length).toBeLessThanOrEqual(WAKE_WORDS_MAX);
  expect(words.startsWith('[A wake from loom, not a person speaking now. You asked at 2026-11-19T18:00:00.000Z to be woken when a/b#1 changes.]')).toBe(true);
  expect(words).toContain('See https://github.com/a/b/pull/1');
  expect(words).toContain('Your note to yourself when you asked, in the words written then: "line one\\nline \\"two\\"');
});

it('tells a wake by one exact test, the same in code and in SQL, over every odd target', () => {
  const client = new Database(':memory:'), at = '2026-11-19T18:00:00.000Z', db = createDataSchema(client, () => at);
  try {
    db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
    const targets = [...WAKE_TARGETS, null, '', 'Wake', 'WAKE', 'wake ', ' wake', 'Wake:review', 'WAKE:REVIEW', 'wake:Review', 'wake:review ', 'wake:bogus', 'wake:', 'wake%', 'wake:%', 'wake_', 'wakeful', 'awake', 'tempo.sweep'];
    targets.forEach((target, n) => db.insert(triggers).values({ id: `t-${n}`, ownerKind: 'agent', owner: 'art', sourceKind: 'job', watches: 'job:j', lifespan: 'once', targetKind: 'inbox', target,
      toKind: 'agent', to: 'art', note: 'n', enabled: true, state: 'standing', createdAt: at, changedAt: at }).run());
    // An operation trigger is never a wake, whatever it is called.
    db.insert(triggers).values({ id: 'op', ownerKind: 'agent', owner: 'art', sourceKind: 'job', watches: 'job:j', lifespan: 'once', targetKind: 'operation', target: 'wake', note: 'n', enabled: true, state: 'standing', createdAt: at, changedAt: at }).run();
    const rows = db.select().from(triggers).all();
    const bySql = db.select({ id: triggers.id }).from(triggers).where(wakeRows()).all().map(row => row.id).sort();
    expect(bySql).toEqual(rows.filter(isWake).map(row => row.id).sort());
    expect(bySql).toEqual(WAKE_TARGETS.map((_target, n) => `t-${n}`).sort());
    // Everything that is a wake, and everything that could be mistaken for one, is refused at the ordinary door.
    for (const row of rows) if (isWake(row)) expect(looksLikeWake(row.target)).toBe(true);
    for (const target of ['Wake', 'WAKE:REVIEW', ' wake', 'wake:bogus', 'wakeful']) expect(looksLikeWake(target), target).toBe(true);
    for (const target of [null, '', 'awake', 'tempo.sweep']) expect(looksLikeWake(target), String(target)).toBe(false);
  } finally { client.close(); }
});

it('calls the review condition what it is: the review changing, either way', () => {
  const pull = readWatched('a/b#1', now);
  expect(wakeClause(pull, 'review')).toBe('the review of a/b#1 changes');
  expect(waitingOn(pull, 'review')).toBe('the review of a/b#1 to change');
  const approved = facts({ review: 'approved', reviewers: ['jo'] });
  // An approval taken back by a push is a change of the review, and the words say which way it went.
  expect(changeHappened('review', 'a/b#1', approved, facts({ review: 'required', reviewers: ['jo'], head: 'b'.repeat(40) }))).toBe('Review on a/b#1: review required, none given yet (before: approved).');
  expect(changeHappened('review', 'a/b#1', facts(), approved)).toBe('Review on a/b#1: approved (before: review required, none given yet). Reviewed by jo.');
  expect(changeHappened('review', 'a/b#1', approved, { ...approved, head: 'b'.repeat(40) })).toBeUndefined();
});
