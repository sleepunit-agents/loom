import { describe, expect, it } from 'vitest';
import { maySee, mayAct, mayCreate, mayMove, type Viewer, type RecordScope } from './policy.js';
import { fixtureSharing } from './fixture.js';
const sharing = fixtureSharing();
const viewers: Viewer[] = [
  { kind: 'member', id: 'jonathan' }, { kind: 'member', id: 'pollock' },
  { kind: 'agent', id: 'art' }, { kind: 'agent', id: 'mark' }, { kind: 'agent', id: 'pond-bot' },
  { kind: 'runner', id: 'box' }, { kind: 'service', id: 'keyholder' },
];
describe('ordered household policy', () => {
  it.each<[string, RecordScope, boolean[]]>([
    ['pond made by Art', { project: 'pond', agent: 'art' }, [true, true, true, false, true, false, false]],
    ['other made by bot', { project: 'other', agent: 'pond-bot' }, [true, false, true, false, false, false, false]],
    ['bot personal', { agent: 'pond-bot' }, [true, true, false, false, true, false, false]],
    ['Art personal', { agent: 'art' }, [true, false, true, false, false, false, false]],
    ['Jonathan private overrides project and agent', { member: 'jonathan', project: 'pond', agent: 'pond-bot' }, [true, false, false, false, false, false, false]],
    ['Pollock private overrides owner', { member: 'pollock', project: 'other', agent: 'art' }, [false, true, false, false, false, false, false]],
    ['unfiled', {}, [true, false, false, false, false, false, false]],
    ['unknown project', { project: 'unknown', agent: 'pond-bot' }, [true, false, false, false, false, false, false]],
    ['empty field is set', { project: '', agent: 'pond-bot' }, [true, false, false, false, false, false, false]],
    ['assigned job', { type: 'runtime.job', runner: 'box' }, [true, false, false, false, false, true, false]],
    ['another job', { type: 'runtime.job', runner: 'elsewhere' }, [true, false, false, false, false, false, false]],
    ['service type', { type: 'secret' }, [true, false, false, false, false, false, true]],
    ['private service type', { type: 'secret', member: 'jonathan' }, [true, false, false, false, false, false, false]],
  ])('%s', (_, record, expected) => {
    expect(viewers.map(v => maySee(v, record, sharing))).toEqual(expected);
    expect(viewers.map(v => mayAct(v, record, sharing, v.kind === 'runner' ? 'report-job' : 'act', 'secrets.unlock'))).toEqual(expected);
  });
  it('limits work, setup, household changes and answering people', () => {
    const pollock = viewers[1], bot = viewers[4];
    for (const action of ['give-work', 'agent-setup'] as const) {
      expect(mayAct(pollock, { project: 'pond', agent: 'pond-bot' }, sharing, action)).toBe(true);
      for (const agent of ['art', 'mark']) expect(mayAct(pollock, { project: 'pond', agent }, sharing, action)).toBe(false);
      expect(mayAct(bot, { agent: 'pond-bot' }, sharing, action)).toBe(false);
    }
    expect(mayAct(viewers[0], { agent: 'pond-bot' }, sharing, 'give-work')).toBe(false);
    expect(mayAct(viewers[5], { type: 'runtime.job', runner: 'box' }, sharing, 'act')).toBe(false);
    expect(maySee(viewers[5], { type: 'task', runner: 'box' }, sharing)).toBe(false);
    for (const v of [viewers[5], viewers[6]]) expect(maySee(v, { member: '', type: 'secret', runner: 'box' }, sharing)).toBe(false);
    expect(maySee(viewers[6], { type: 'task' }, sharing)).toBe(false);
    for (const agent of ['art', 'mark']) for (const action of ['give-work', 'agent-setup'] as const) expect(mayAct(viewers[0], { agent }, sharing, action)).toBe(true);
    for (const action of ['household', 'give-work', 'answer-person'] as const) expect(mayAct(viewers[6], { type: 'secret' }, sharing, action, 'secrets.unlock')).toBe(false);
    for (const id of ['constructor', '__proto__', 'toString']) {
      expect(maySee(pollock, { project: id }, sharing)).toBe(false);
      expect(maySee({ kind: 'member', id }, { agent: 'art' }, sharing)).toBe(false);
      expect(maySee({ kind: 'service', id }, { type: 'secret' }, sharing)).toBe(false);
    }
    expect(mayAct(pollock, { project: 'pond' }, sharing, 'household')).toBe(false);
    expect(mayAct(viewers[0], {}, sharing, 'household')).toBe(true);
    expect(mayAct(bot, { project: 'pond' }, sharing, 'answer-person')).toBe(false);
    expect(mayAct(pollock, { project: 'pond' }, sharing, 'answer-person')).toBe(true);
    expect(maySee(viewers[5], { type: 'runtime.job', runner: 'box', member: '' }, sharing)).toBe(false);
    expect(maySee(viewers[5], { type: 'runtime.job', runner: 'box', member: 'jonathan' }, sharing)).toBe(false);
    expect(mayAct(viewers[6], { type: 'secret' }, sharing, 'act', 'secrets.destroy')).toBe(false);
  });
  it('checks both ends, attached agents, and immutable private membership', () => {
    const p = viewers[1];
    expect(mayMove(p, { member: 'pollock', agent: 'pond-bot' }, { agent: 'pond-bot' }, sharing)).toBe(false);
    expect(mayCreate(viewers[6], { type: 'secret' }, sharing, 'secrets.unlock')).toBe(true);
    expect(mayMove(viewers[6], { type: 'secret' }, { type: 'secret' }, sharing, 'secrets.unlock')).toBe(true);
    expect(mayCreate(viewers[6], { type: 'secret' }, sharing, 'secrets.destroy')).toBe(false);
    expect(mayCreate(p, { member: 'pollock', project: 'other' }, sharing)).toBe(false);
    expect(mayMove(p, { project: 'pond' }, { agent: 'pond-bot' }, sharing)).toBe(true);
    expect(mayCreate(p, { project: 'pond', agent: 'art' }, sharing)).toBe(false);
    expect(mayCreate(p, { project: 'pond', agent: 'pond-bot' }, sharing)).toBe(true);
    expect(mayMove(p, { project: 'pond' }, { project: 'other' }, sharing)).toBe(false);
    expect(mayMove(p, { project: 'other' }, { project: 'pond' }, sharing)).toBe(false);
    expect(mayMove(viewers[0], { member: 'jonathan' }, { member: 'pollock' }, sharing)).toBe(false);
    expect(maySee({ kind: 'member', id: 'removed' }, { member: 'removed' }, sharing)).toBe(false);
  });
});

it('allows only an exact runner to report its own nonprivate box, without registry visibility', () => {
  const own = { type: 'runtime.box', runner: 'box' };
  const runner: Viewer = { kind: 'runner', id: 'box' };
  expect(viewers.map(v => mayAct(v, own, sharing, 'report-box'))).toEqual([false, false, false, false, false, true, false]);
  for (const record of [{ ...own, runner: 'other' }, { ...own, member: 'jonathan' }, { ...own, type: 'runtime.job' }, { type: 'runtime.box' }])
    expect(mayAct(runner, record, sharing, 'report-box')).toBe(false);
  expect(maySee(runner, own, sharing)).toBe(false);
  expect(mayAct(runner, own, sharing)).toBe(false);
});
