/** The `tempo` brick (docs/specs/boards.md, "The first bricks"): one agent's triggers from the desktop's Tempo read,
 * in its order and its words, and the day's recorded firings in the big form. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { bricks, loadBricks } from './bricks';
import { bench } from './bricks-work.test.helper';
import { historyQuery } from '../pieces/tempo/day-model';
import { tempoQuery } from '../pieces/tempo/query';
import { at, trigger } from './tempo.test.helper';

await loadBricks();
const b = bench(feed);
beforeEach(b.before);
afterEach(b.after);

const triggers = [
  trigger('tr-water'),
  trigger('tr-fern', { to: 'fern', owner: 'fern', note: 'Fern only' }),
  trigger('tr-pr', { sourceKind: 'pull-request', watches: 'change:9', times: null, days: null, lifespan: 'once', note: 'Watch the fence PR', nextDueAt: null, lastFiredAt: null }),
  trigger('tr-old', { state: 'stopped', enabled: false, nextDueAt: null, note: 'Old round' }),
  trigger('tr-bad id', { note: 'Oddly named', nextDueAt: '2026-11-29T07:17:00.000Z' }),
];
const log = [
  { trigger: 'tr-water', seq: 5, at: '2026-11-27T07:17:00.000Z', event: 'fired', note: 'time:1' },
  { trigger: 'tr-fern', seq: 6, at: '2026-11-27T08:00:00.000Z', event: 'fired', note: 'time:2' },
  { trigger: 'tr-old', seq: 7, at: '2026-11-27T09:00:00.000Z', event: 'stopped', note: '' },
];
const data = (over: object = {}) => ({
  Tempo: { tempoTimezone: 'UTC', triggers, agentPauses: [] },
  BrickTempoClock: { deskTime: { at: Date.parse('2026-11-27T12:00:00.000Z') } },
  TempoDayHistory: { triggerLog: log, tempoCalendarOutcomes: [{ event: 5, kind: 'mail', state: 'done', reason: null }] }, ...over,
});

it('lists the agent\'s triggers from the desktop\'s read, in its order, with its words, each a chip for its trigger', async () => {
  b.answer(data());
  for (const form of ['primary', 'side'] as const) {
    await b.draw('tempo', { agent: 'art' }, form);
    expect(feed.mock.calls.some(([query]) => query === tempoQuery)).toBe(true);
    expect(feed.mock.calls.some(([query]) => query === historyQuery)).toBe(true);
    expect(b.asked('TempoDayHistory')).toEqual({ from: '2026-11-26T00:00:00.000Z', until: '2026-11-29T00:00:00.000Z', dueFrom: 'Next due 2026-11-26T00:00:00.000Z', dueUntil: 'Next due 2026-11-29T00:00:00.000Z', calendar: false });
    const all = b.all();
    expect(all).toContain('4 triggers');
    expect(all).toContain('UTC');
    expect(all).not.toContain('Fern only');
    // A trigger is a row of the kit: its name, its kind and source, its times and last outcome, and its state at the row's end.
    // The side form names each trigger and where it stands; its times are in the primary form and in its own brick.
    expect(all).toContain(form === 'primary' ? `Morning waterWakes an agent · 07:17 · weekdaysNext ${at('2026-11-28T07:17:00.000Z')} · Last fired ${at('2026-11-27T07:17:00.000Z')} · Agent wake doneStanding` : 'Morning waterWakes an agent · 07:17 · weekdaysStanding');
    expect(all).toContain(form === 'primary' ? 'Watch the fence PROnce · A pull request changes · change:9Never firedStanding' : 'Watch the fence PROnce · A pull request changes · change:9Standing');
    expect(all).toContain(form === 'primary' ? 'Old roundWakes an agent · 07:17 · weekdaysNo next firing' : 'Old roundWakes an agent · 07:17 · weekdays');
    // Sooner first; one with no next firing last.
    expect(all.indexOf('Morning water')).toBeLessThan(all.indexOf('Oddly named'));
    expect(all.indexOf('Oddly named')).toBeLessThan(all.indexOf('Old round'));
    expect(b.placed()).toEqual(expect.arrayContaining([{ brick: 'agent', params: { agent: 'art' } }, { brick: 'trigger', params: { trigger: 'tr-water' } }, { brick: 'trigger', params: { trigger: 'tr-pr' } }]));
    // An id a board cannot hold is said without a chip.
    expect(b.placed()).not.toContainEqual({ brick: 'trigger', params: { trigger: 'tr-bad id' } });
    expect(b.controls()).toEqual([]);
    expect(all.includes('Today'), form).toBe(form === 'primary');
  }
  expect(bricks.tempo.title({ agent: 'art' })).toBe('Tempo');
  expect(bricks.tempo.sub({ agent: 'art' })).toBe('art');
});

it('shows the day\'s recorded firings of this agent\'s triggers in the big form, newest first', async () => {
  b.answer(data());
  await b.draw('tempo', { agent: 'art' }, 'primary');
  const all = b.all(), today = all.slice(all.indexOf('Today'));
  expect(today).toContain(`Old roundstopped${at('2026-11-27T09:00:00.000Z')}`);
  expect(today).toContain(`Morning waterAgent wake done${at('2026-11-27T07:17:00.000Z')}`);
  expect(today.indexOf('Old round')).toBeLessThan(today.indexOf('Morning water'));
  expect(today).not.toContain('Fern only');
  b.answer(data({ TempoDayHistory: { triggerLog: [], tempoCalendarOutcomes: [] } }));
  await b.draw('tempo', { agent: 'art' }, 'primary');
  expect(b.all()).toContain('No recorded activity for this day.');
});

it('says a failed last firing and why, and that the agent is paused', async () => {
  b.answer(data({
    Tempo: { tempoTimezone: 'UTC', triggers, agentPauses: [{ agent: 'art', since: '2026-11-27T10:00:00.000Z' }] },
    TempoDayHistory: { triggerLog: log, tempoCalendarOutcomes: [{ event: 5, kind: 'mail', state: 'failed', reason: 'Exit code 2' }] },
  }));
  await b.draw('tempo', { agent: 'art' }, 'side');
  expect(b.all()).toContain(`Paused ${at('2026-11-27T10:00:00.000Z')}`);
  expect(b.all()).toContain('Morning waterWakes an agent');
  expect(b.all()).toContain('Its last firing failed.Held');
  await b.draw('tempo', { agent: 'art' }, 'primary');
  expect(b.all()).toContain('Agent wake failed, Exit code 2');
  expect(b.all()).toContain('Its last firing failed.');
  await b.draw('tempo', { agent: 'art' }, 'compact');
  b.oneLine();
  expect(b.controls()).toEqual([]);
});

it('folds to one line with no controls', async () => {
  b.answer(data());
  await b.draw('tempo', { agent: 'art' }, 'compact');
  b.oneLine();
  expect(b.all()).toBe(`4 triggers · next ${at('2026-11-28T07:17:00.000Z')}`);
  expect(b.controls()).toEqual([]);
  // Folded, it reads the triggers alone: the clock and the day's firings are not asked for.
  expect(feed.mock.calls.filter(([query]) => query === historyQuery).every(([, , options]) => options.pause)).toBe(true);
});

it('flags itself when a firing fails after the page read it, and not for a failure that was already there', async () => {
  const failing = { triggerLog: log, tempoCalendarOutcomes: [{ event: 5, kind: 'mail', state: 'failed', reason: null }] };
  b.answer(data({ TempoDayHistory: failing }));
  await b.draw('tempo', { agent: 'art' }, 'side');
  await b.redraw('tempo', { agent: 'art' }, 'side');
  expect(b.raised).not.toHaveBeenCalled();
  b.answer(data());
  await b.draw('tempo', { agent: 'art' }, 'side');
  // The day's read arriving is not a change.
  b.answer(data({ TempoDayHistory: undefined }));
  await b.draw('tempo', { agent: 'art' }, 'side');
  b.answer(data());
  await b.redraw('tempo', { agent: 'art' }, 'side');
  expect(b.raised).not.toHaveBeenCalled();
  b.answer(data({ TempoDayHistory: failing }));
  await b.redraw('tempo', { agent: 'art' }, 'side');
  expect(b.raised.mock.calls).toEqual([['A firing failed']]);
});

it('says there are none for an agent with no trigger the member may see, is unavailable when Tempo cannot be read, and loading until it answers', async () => {
  b.answer(data());
  await b.draw('tempo', { agent: 'moss' }, 'side');
  expect(b.all()).toContain('No triggers here. Ask an agent in chat to set a trigger.');
  for (const form of ['primary', 'side', 'compact'] as const) {
    feed.mockImplementation(() => ({ status: 'denied' }));
    await b.draw('tempo', { agent: 'art' }, form);
    expect(b.all(), form).toBe('This agent\'s tempo is unavailable.');
    b.answer({ Tempo: undefined });
    await b.draw('tempo', { agent: 'art' }, form);
    expect(b.all(), form).toBe('Loading…');
  }
});
