import { describe, expect, it } from 'vitest';
import { claudeRefusal, codexRefusal, lastRefusal, refusedUntil } from './refusals.js';
import { nextQuotaHold } from './quota.js';
const claude = (error = 'rate_limit') => ({ type: 'assistant', isApiErrorMessage: true, error });
const codex = (info: unknown = 'usage_limit_exceeded') => ({ type: 'event_msg', payload: { type: 'error', codex_error_info: info } });
const lines = (...values: unknown[]) => values.map(v => JSON.stringify(v)).join('\n');
describe('structured provider refusals', () => {
  it('accepts quota and billing codes but never prose or authentication errors', () => {
    expect(claudeRefusal(claude())).toEqual({ code: 'rate_limit' });
    expect(claudeRefusal(claude('billing_error'))).toEqual({ code: 'billing_error' });
    expect(claudeRefusal({ type: 'result', is_error: true, error: 'rate_limit' })).toEqual({ code: 'rate_limit' });
    expect(claudeRefusal({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })).toEqual({ code: 'rate_limit' });
    for (const v of [null, [], 2, 'usage limit', claude('authentication_failed'), { type: 'assistant', error: 'rate_limit' }, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }]) expect(claudeRefusal(v)).toBeNull();
    expect(codexRefusal(codex())).toEqual({ code: 'usage_limit_exceeded' });
    expect(codexRefusal(codex({ usage_limit_exceeded: {} }))).toEqual({ code: 'usage_limit_exceeded' });
    expect(codexRefusal({ type: 'token_count', rate_limits: { rate_limit_reached_type: 'primary' } })).toEqual({ code: 'usage_limit_exceeded' });
    for (const v of [null, [], codex('internal_server_error'), { type: 'turn.failed', error: { message: 'usage limit exceeded' } }]) expect(codexRefusal(v)).toBeNull();
  });
  it('preserves refusals through bookkeeping, malformed JSON and tool results', () => {
    expect(lastRefusal('claude', lines(claude(), { type: 'user', message: { content: [{ type: 'tool_result' }] } }, { type: 'result', is_error: true }) + '\n{broken\nnull\n[]')).toEqual({ code: 'rate_limit' });
    expect(lastRefusal('codex', lines(codex(), { type: 'turn.failed', error: { message: 'failed' } }, { type: 'event_msg', payload: { type: 'task_complete' } }))).toEqual({ code: 'usage_limit_exceeded' });
    expect(lastRefusal('claude', lines(claude(), claude('billing_error')))).toEqual({ code: 'billing_error' });
  });
  it('does not inherit a prior turn refusal after work or a new prompt', () => {
    for (const v of [claude('authentication_failed'), { type: 'assistant' }, { type: 'user' }, { type: 'result', result: 'answer' }]) expect(lastRefusal('claude', lines(claude(), v))).toBeNull();
    for (const v of [codex('internal_server_error'), { type: 'item.completed', item: { type: 'agent_message' } }, { type: 'response_item' }, { type: 'turn_context' }, { type: 'event_msg', payload: { type: 'user_message' } }, { type: 'event_msg', payload: { type: 'task_started' } }]) expect(lastRefusal('codex', lines(codex(), v))).toBeNull();
    expect(lastRefusal('claude', lines(claude(), { type: 'user' }, claude()))).toEqual({ code: 'rate_limit' });
  });
  it('chooses the latest full reset, else the earliest future reset, and feeds bounded holds', () => {
    const reading = { windows: { '5h': .97, '7d': 1 }, resets: { '5h': 200, '7d': 900 } };
    expect(refusedUntil(reading, 100)).toBe(900);
    expect(refusedUntil({ ...reading, windows: { '5h': .4, '7d': .8 } }, 100)).toBe(200);
    expect(refusedUntil(reading, 200)).toBe(900);
    expect(refusedUntil(reading, 900)).toBeUndefined();
    expect(refusedUntil(null, 100)).toBeUndefined();
    expect(refusedUntil({ windows: { bad: Infinity }, resets: { bad: Infinity, nan: NaN, past: 99 } }, 100)).toBeUndefined();
    expect(nextQuotaHold(undefined, { until: refusedUntil(reading, 100) }, 100_000)).toEqual({ until: 900, at: 100 });
    expect(nextQuotaHold(undefined, { until: refusedUntil(null, 100) }, 100_000)).toEqual({ until: 1900, at: 100, blind: 0 });
  });
});
