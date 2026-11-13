import { expect, it } from 'vitest';
import { memberInput, accountInput, frozen } from './model';
it('sends the selected scope without confusing all agents with household authority', () => {
  const data = new FormData(); data.set('person', 'pollock'); data.set('ownership', 'scoped'); data.append('agents', 'art'); data.append('agents', 'mark');
  expect(memberInput(data)).toEqual({ person: 'pollock', agents: ['art', 'mark'] });
  data.set('ownership', 'household'); expect(memberInput(data)).toEqual({ person: 'pollock', agents: '*' });
});
it('clears account metadata with an empty list and splits logins without accepting arbitrary properties', () => {
  const data = new FormData(); expect(accountInput(data, 'art')).toEqual({ agent: 'art', accounts: { github: [] } });
  data.set('github', 'Art-Bot, another\nthird'); data.set('token', 'ignored');
  expect(accountInput(data, 'art')).toEqual({ agent: 'art', accounts: { github: ['Art-Bot', 'another', 'third'] } });
});
it('blocks new writes on uncertainty, permitting a new request only after a definitive outcome', () => {
  expect(frozen({ pending: true, status: 'offline' })).toBe(true);
  expect(frozen({ pending: false, status: 'done', result: { ok: false, code: 'unavailable', message: 'uncertain' } })).toBe(true);
  expect(frozen({ pending: false, status: 'done', result: { ok: false, code: 'invalid', message: 'no' } })).toBe(false);
  expect(frozen({ pending: false, status: 'done', result: { ok: true, value: {} } })).toBe(false);
});
