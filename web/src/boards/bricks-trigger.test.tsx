/** The `trigger` brick (docs/specs/boards.md, "The first bricks"): one trigger as the desktop's reader shows it,
 * and its buttons through the desktop's own calls to /api/tempo. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { bricks, loadBricks } from './bricks';
import { bench } from './bricks-work.test.helper';
import { journalDetailsQuery, programDetailsQuery, tempoCardQuery, triggerHistoryQuery } from '../pieces/tempo/query';
import { at, trigger } from './tempo.test.helper';

await loadBricks();
const b = bench(feed);
beforeEach(() => { b.before(); b.reply.value = { saved: true }; });
afterEach(b.after);

const run = (event: number, state: string, conversation: string | null) => ({ event, kind: 'mail', at: '2026-11-27T07:17:00.000Z',
  job: { state, startedAt: '2026-11-27T07:17:01.000Z', endedAt: '2026-11-27T07:18:06.000Z' }, usage: null,
  conversation: conversation ? { id: conversation, venue: 'wake', place: 'x' } : null });
const history = (runs: unknown[] = [run(5, 'done', 'cv-water-1')]) => ({ tempoRecentRuns: runs, triggerLog: [
  { seq: 5, trigger: 'tr-water', at: '2026-11-27T07:17:00.000Z', event: 'fired', note: 'time:1' },
  { seq: 1, trigger: 'tr-water', at: '2026-11-14T00:00:00.000Z', event: 'set', note: '' },
] });
const data = (fields: object = {}, over: object = {}) => ({
  TempoCard: { tempoTimezone: 'UTC', triggers: [trigger('tr-water', { project: 'garden', ...fields })], agentPauses: [] },
  TriggerHistory: history(), ProgramDetails: { tempoProgram: null },
  JournalDetails: { tempoJournal: { lessons: 'The hose leaks.', state: '', stateChangedAt: null } }, ...over,
});
const draw = (form: 'primary' | 'side' | 'compact' = 'primary') => b.draw('trigger', { trigger: 'tr-water' }, form);

it('shows one trigger in full from the desktop\'s reads: when it fires, its words, lifespan, target, runs, lessons and history', async () => {
  b.answer(data());
  await draw('primary');
  for (const query of [tempoCardQuery, triggerHistoryQuery, programDetailsQuery, journalDetailsQuery]) expect(feed.mock.calls.some(([asked, variables, options]) => asked === query && variables.id === 'tr-water' && !options?.pause), query).toBe(true);
  const all = b.all();
  expect(all).toContain('Morning water');
  expect(all).toContain('StandingWakes an agent · time · until-stopped · standing');
  expect(all).toContain('07:17 · weekdays');
  expect(all).toContain(`Due: ${at('2026-11-28T07:17:00.000Z')} · UTC`);
  expect(all).toContain('Set byAgent · Art');
  expect(all).toContain('TargetAn item in art\'s inbox');
  expect(all).toContain('Requested modelAgent default');
  expect(all).toContain('LessonsThe hose leaks.');
  expect(all).toContain('WordsWater the beds');
  expect(all).toContain(`${at('2026-11-27T07:17:00.000Z')}Agent wake · done · 1 min 5 sSession`);
  expect(all).toContain(`${at('2026-11-14T00:00:00.000Z')} · set`);
  expect(all).toContain('To change its times or words, ask its agent');
  expect(b.placed()).toEqual(expect.arrayContaining([{ brick: 'agent', params: { agent: 'art' } }, { brick: 'tempo', params: { agent: 'art' } },
    { brick: 'project', params: { project: 'garden' } }, { brick: 'session', params: { session: 'cv-water-1' } }]));
  expect(b.fields()).toEqual([]);
  expect(bricks.trigger.title({ trigger: 'tr-water' })).toBe('Trigger');
});

it('draws the small form without the program, the journal and the history, and folds to one line with no controls', async () => {
  b.answer(data());
  await draw('side');
  expect(b.all()).toContain('WordsWater the beds');
  expect(b.all()).not.toContain('Lessons');
  expect(b.all()).not.toContain('Recent history');
  expect(b.placed()).toContainEqual({ brick: 'session', params: { session: 'cv-water-1' } });
  await draw('compact');
  b.oneLine();
  expect(b.all()).toBe(`Standing Morning water · next ${at('2026-11-28T07:17:00.000Z')}`);
  expect(b.controls()).toEqual([]);
});

it('runs it now and stops it only after asking, with the desktop\'s input, and tells the board nothing typed', async () => {
  b.answer(data());
  await draw('side');
  expect(b.labels()).toEqual(['Run now…', 'Stop…', 'Pause agent']);
  await b.press('Run now…');
  expect(b.sent).not.toHaveBeenCalled();
  expect(b.labels()).toEqual(['Run it now', 'Not now']);
  await b.press('Not now');
  expect(b.sent).not.toHaveBeenCalled();
  await b.press('Run now…');
  await b.press('Run it now');
  expect(b.sent.mock.calls).toEqual([['/api/tempo/runNow', { id: 'tr-water' }]]);
  expect(b.reported.mock.calls).toEqual([['runNow', {}]]);
  b.sent.mockReset(); b.reported.mockReset();
  await b.press('Stop…');
  expect(b.sent).not.toHaveBeenCalled();
  expect(b.labels()).toEqual(['Stop this trigger', 'Keep it']);
  await b.press('Stop this trigger');
  expect(b.sent.mock.calls).toEqual([['/api/tempo/stop', { id: 'tr-water' }]]);
  expect(b.reported.mock.calls).toEqual([['stop', {}]]);
});

it('pauses and resumes the trigger\'s agent, and starts a stopped standing trigger', async () => {
  b.answer(data());
  await draw('side');
  await b.press('Pause agent');
  expect(b.sent.mock.calls).toEqual([['/api/tempo/pause', { agent: 'art' }]]);
  expect(b.reported.mock.calls).toEqual([['pause', {}]]);
  b.sent.mockReset(); b.reported.mockReset();
  b.answer(data({ state: 'held' }, { TempoCard: { tempoTimezone: 'UTC', triggers: [trigger('tr-water', { state: 'held' })], agentPauses: [{ agent: 'art', since: '2026-11-27T10:00:00.000Z' }] } }));
  await draw('side');
  expect(b.all()).toContain('Held · agent paused');
  expect(b.button('Run now…')!.props.disabled).toBe(true);
  await b.press('Resume agent');
  expect(b.sent.mock.calls).toEqual([['/api/tempo/resume', { agent: 'art' }]]);
  expect(b.reported.mock.calls).toEqual([['resume', {}]]);
  b.sent.mockReset(); b.reported.mockReset();
  b.answer(data({ state: 'stopped', enabled: false, nextDueAt: null }));
  await draw('side');
  expect(b.labels()).toEqual(['Start', 'Pause agent']);
  await b.press('Start');
  expect(b.sent.mock.calls).toEqual([['/api/tempo/start', { id: 'tr-water' }]]);
  expect(b.reported.mock.calls).toEqual([['start', {}]]);
  // A schedule that was removed, and a wait that was for once, cannot be started again.
  b.answer(data({ state: 'stopped', enabled: false, scheduleRemovedAt: '2026-11-27T00:00:00.000Z' }));
  await draw('side');
  expect(b.labels()).toEqual(['Pause agent']);
  b.answer(data({ lifespan: 'once' }));
  await draw('side');
  expect(b.labels()).toEqual(['Run now…', 'Cancel…', 'Pause agent']);
});

it('tells the board nothing when Tempo refuses, and says so', async () => {
  b.answer(data());
  await draw('side');
  b.reply.ok = false;
  await b.press('Stop…');
  await b.press('Stop this trigger');
  expect(b.sent).toHaveBeenCalledTimes(1);
  expect(b.reported).not.toHaveBeenCalled();
  expect(b.alert()).toBe('Tempo could not complete that action. Try again.');
});

it('flags itself when a run fails after the page read it, and not for a failure already there or runs arriving', async () => {
  b.answer(data({}, { TriggerHistory: history([run(5, 'failed', null)]) }));
  await draw('side');
  expect(b.all()).toContain('Its last firing failed.');
  await b.redraw('trigger', { trigger: 'tr-water' }, 'side');
  expect(b.raised).not.toHaveBeenCalled();
  b.answer(data({}, { TriggerHistory: undefined }));
  await draw('side');
  b.answer(data());
  await b.redraw('trigger', { trigger: 'tr-water' }, 'side');
  expect(b.raised).not.toHaveBeenCalled();
  b.answer(data({}, { TriggerHistory: history([run(6, 'lost', null), run(5, 'done', null)]) }));
  await b.redraw('trigger', { trigger: 'tr-water' }, 'side');
  expect(b.raised.mock.calls).toEqual([['Failed']]);
});

it('is unavailable for a trigger the member may not see or when Tempo cannot be read, and loading until it answers', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    b.answer(data({}, { TempoCard: { tempoTimezone: 'UTC', triggers: [], agentPauses: [] } }));
    await draw(form);
    expect(b.all(), form).toBe('This trigger is unavailable.');
    expect(b.controls()).toEqual([]);
    feed.mockImplementation(() => ({ status: 'denied' }));
    await draw(form);
    expect(b.all(), form).toBe('This trigger is unavailable.');
    b.answer({ TempoCard: undefined });
    await draw(form);
    expect(b.all(), form).toBe('Loading…');
  }
});
