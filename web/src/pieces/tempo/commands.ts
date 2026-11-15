import { newId } from '../../data/id';
import type { TempoActions } from './index';
/** Cookie credentials identify the caller. A control supplies only its target. */
export function tempoActions(request: typeof fetch = fetch): TempoActions {
  async function call(action: string, input: object) {
    const response = await request(`/api/tempo/${action}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: newId(), input }) });
    const result: unknown = await response.json();
    if (!response.ok || !result || typeof result !== 'object' || !('ok' in result) || result.ok !== true
      || !('value' in result) || !result.value || typeof result.value !== 'object'
      || (action === 'set' ? !('id' in result.value) || typeof result.value.id !== 'string' || !result.value.id : !('saved' in result.value) || result.value.saved !== true)) throw new Error('Tempo could not confirm the change.');
  }
  return { create: input => call('set', input), runNow: id => call('runNow', { id }), stop: id => call('stop', { id }),
    pause: agent => call('pause', { agent }), resume: agent => call('resume', { agent }) };
}
