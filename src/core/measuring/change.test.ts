import { expect, it } from 'vitest';
import { measuringChangeSummary, readMeasuringChange } from './change.js';
const before = { on: false, send_outside: false, outside_address: '', keep_days: 90 };
const after = { ...before, on: true, send_outside: true, outside_address: 'https://monitor.example/v1/traces', keep_days: 7 };
const card = { kind: 'setting', target: 'measuring', details: JSON.stringify({ before, after }), changeSummary: measuringChangeSummary(before, after) };
it('reads persisted exact values without requiring JSON property order', () => {
  expect(readMeasuringChange(card)).toEqual({ before, after });
  expect(readMeasuringChange({ ...card, details: JSON.stringify({ after, before }) })).toEqual({ before, after });
});
it.each([
  { kind: 'command' }, { target: 'other' }, { details: '{' }, { changeSummary: null }, { changeSummary: 'A different change' },
  ...[{}, { ...after, extra: true }, { ...after, on: 'true' }, { ...after, keep_days: 0 },
    { ...after, keep_days: 1.5 }, { ...after, keep_days: 3651 },
    { ...after, outside_address: '' }, { ...after, outside_address: 'file:///tmp/traces' },
    { ...after, outside_address: 'https://user:secret@monitor.example' },
    { ...after, outside_address: 'https://monitor.example?token=secret' },
    { ...after, outside_address: 'https://monitor.example#private' },
  ].map(after => ({ details: JSON.stringify({ before, after }) })),
  { details: JSON.stringify({ before: { ...before, keep_days: 0 }, after }) },
  { details: JSON.stringify({ before, after, extra: true }) },
])('declines malformed, unrelated or mismatched persisted changes: %j', patch => {
  expect(readMeasuringChange({ ...card, ...patch })).toBeUndefined();
});
