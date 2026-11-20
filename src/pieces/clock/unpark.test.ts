import { describe, it, expect } from 'vitest';
import { unpark } from './unpark.js';
import type { Wake } from './store.js';
const row = (note = 'DNS health check', id = 'a-24e194de'): Wake => ({
  id: 'w-1', agent: 'art', prompt: 'Continue the work', note, state: 'parked', due: 0,
  createdAt: 0, changedAt: 0, failures: 0, by: { kind: 'agent', id: 'art' }, wait: { id, until: 86400000 },
});
describe('parked continuation words', () => {
  it.each([
    ['allowed', 'Resumed after your OK'], ['granted', 'Resumed after your OK'],
    ['denied', 'Resumed after you said no'], ['pending', 'Resumed, no answer in 24h'],
    ['expired', 'Resumed, your OK expired'], ['unknown', "Resumed, your answer couldn't be read"],
    ['used', 'Resumed after your answer (used)'], ['withdrawn', 'Resumed after your answer (withdrawn)'],
    ['cancelled', 'Resumed after your answer (cancelled)'],
  ] as const)('names %s in the note and keeps the request id in the continuation', (state, label) => {
    const w = row(); unpark(w, { state });
    expect(w.note).toBe(`${label}: DNS health check`); expect(w.note).not.toContain('a-24e194de');
    expect(w.wait).toMatchObject({ id: 'a-24e194de', answer: state });
    expect(w.prompt).toContain('a-24e194de'); expect(w.prompt).toContain('\n\n---\n\nContinue the work');
  });
  it('strips previous current and legacy note prefixes exactly once', () => {
    for (const note of ['Resumed after your OK: DNS health check', 'unparked (a-1 denied): DNS health check',
      'Resumed after your answer (odd): Resumed, no answer in 24h: DNS health check']) {
      const w = row(note); unpark(w, { state: 'denied' }); expect(w.note).toBe('Resumed after you said no: DNS health check');
    }
  });
  it.each(['denied', 'expired', 'pending', 'unknown', 'withdrawn', 'used', 'cancelled'] as const)('never hands spending instructions to %s work', state => {
    const w = row(); unpark(w, { state, instruction: 'Spend the stale receipt', kind: 'merge', target: 'exact-head' });
    expect(w.prompt).not.toContain('Spend the stale receipt'); expect(w.prompt).not.toContain('approvals use');
    expect(w.prompt).toContain(state === 'pending' ? "stop; don't ask again" : "Don't work around it");
  });
  it('gives the allowed exact action with shell quoting and retains trusted role instructions', () => {
    const w = row(); unpark(w, { state: 'allowed', kind: 'merge', target: 'github:acme/app#12@' + 'a'.repeat(40) });
    expect(w.prompt).toContain("approvals use a-24e194de --kind merge --target 'github:acme/app#12@" + 'a'.repeat(40) + "'");
    const quoted = row(); unpark(quoted, { state: 'allowed', kind: 'host', instruction: 'Spend this yourself' });
    expect(quoted.prompt).toContain("there's nothing for you to spend"); expect(quoted.prompt).not.toContain('Spend this yourself');
    const role = row(); unpark(role, { state: 'allowed', instruction: 'Spend exact-head once' });
    expect(role.prompt).toContain('Spend exact-head once');
    const apostrophe = row(); unpark(apostrophe, { state: 'allowed', kind: 'merge', target: "a'b $(touch /tmp/no)" });
    expect(apostrophe.prompt).toContain("--target 'a'\\''b $(touch /tmp/no)'");
  });
  it.each(['grant', 'vouch-wake', 'principal-reset', 'box-write-off', 'host'])('does not ask a body to spend owner-applied %s', kind => {
    const w = row(); unpark(w, { state: 'allowed', kind, target: 'target' });
    expect(w.prompt).toContain("there's nothing for you to spend"); expect(w.prompt).not.toContain('approvals use');
  });
  it('refuses to spend a local approval when no trusted recovery instruction is available', () => {
    const w = row(); unpark(w, { state: 'allowed', kind: 'local-wake', target: 'art:digest' });
    expect(w.prompt).toContain("Don't spend it"); expect(w.prompt).not.toContain('--approval a-24e194de');
    const restored = row(); unpark(restored, { state: 'allowed', kind: 'local-wake', instruction: 'wake in 1m --approval a-24e194de' });
    expect(restored.prompt).toContain('wake in 1m --approval a-24e194de');
  });
  it('does not suggest spending an incomplete current Allow from a saved snapshot', () => {
    const w = row(); w.wait!.kind = 'merge'; w.wait!.target = 'saved-head';
    unpark(w, { state: 'allowed' });
    expect(w.prompt).toContain("Don't spend it or infer the action from saved metadata");
    expect(w.prompt).not.toContain('saved-head'); expect(w.prompt).not.toContain('--approval');
  });
  it('asks a new house to request an allowed secret again instead of spending its request id', () => {
    const w = row('waiting', 'q-secret'); unpark(w, { state: 'granted', instruction: 'approvals use q-secret' });
    expect(w.prompt).toContain('request it again'); expect(w.prompt).not.toContain('approvals use');
  });
});
