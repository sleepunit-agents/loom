import { FILE_READER_UNAVAILABLE } from '../../../../src/core/tempo/lane-file.js';
import { newId } from '../../data/id.js';
import type { TempoActions } from './actions.js';
/** Cookie credentials identify the caller. A control supplies only its target. */
export function tempoActions(request: typeof fetch = fetch): TempoActions {
  // One unconfirmed intent per action. Retain its receipt after an uncertain
  // reply; a confirmed next click starts a new intent.
  const pending = new Map<string, { payload: string; id: string }>();
  async function call(action: string, input: object) {
    const payload = JSON.stringify(input);
    let attempt = pending.get(action);
    if (!attempt || attempt.payload !== payload) { attempt = { payload, id: newId() }; pending.set(action, attempt); }
    const response = await request(`/api/tempo/${action}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: attempt.id, input }) });
    const result: unknown = await response.json();
    if (response.status === 400 && result && typeof result === 'object' && 'ok' in result && result.ok === false &&
        'code' in result && result.code === 'invalid' && 'message' in result && result.message === FILE_READER_UNAVAILABLE) {
      throw new Error(FILE_READER_UNAVAILABLE);
    }
    if (!response.ok || !result || typeof result !== 'object' || !('ok' in result) || result.ok !== true
      || !('value' in result) || !result.value || typeof result.value !== 'object'
      || (action === 'set' ? !('id' in result.value) || typeof result.value.id !== 'string' || !result.value.id : !('saved' in result.value) || result.value.saved !== true)) throw new Error('Tempo could not confirm the change.');
    if (pending.get(action) === attempt) pending.delete(action);
  }
  return { create: input => call('set', input), runNow: id => call('runNow', { id }), stop: id => call('stop', { id }), start: id => call('start', { id }),
    pause: agent => call('pause', { agent }), resume: agent => call('resume', { agent }) };
}
