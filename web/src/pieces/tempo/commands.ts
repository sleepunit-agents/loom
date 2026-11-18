import { newId } from '../../data/id.js';
import { TempoFiringFailure, type TempoActions } from './actions.js';
/** Cookie credentials identify the caller. A control supplies only its target. */
export function tempoActions(request: typeof fetch = fetch): TempoActions {
  // One unconfirmed intent per action. Retain its receipt after an uncertain
  // reply; a confirmed next click starts a new intent.
  const pending = new Map<string, { payload: string; id: string }>();
  async function call(action: string, input: object, piece = 'tempo') {
    const payload = JSON.stringify(input);
    let attempt = pending.get(action);
    if (!attempt || attempt.payload !== payload) { attempt = { payload, id: newId() }; pending.set(action, attempt); }
    const response = await request(`/api/${piece}/${action}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: attempt.id, input }) });
    const result: unknown = await response.json();
    if (!response.ok || !result || typeof result !== 'object' || !('ok' in result) || result.ok !== true
      || !('value' in result) || !result.value || typeof result.value !== 'object') throw new Error('Tempo could not confirm the change.');
    if (action === 'runNow' && 'saved' in result.value && result.value.saved === false &&
      'failed' in result.value && result.value.failed === true && 'reason' in result.value && typeof result.value.reason === 'string') {
      if (pending.get(action) === attempt) pending.delete(action);
      throw new TempoFiringFailure(result.value.reason);
    }
    if (action === 'propose') {
      if (!('id' in result.value) || typeof result.value.id !== 'string' || !result.value.id || !('state' in result.value) || result.value.state !== 'pending') throw new Error('Tempo could not confirm the machine request.');
      if (pending.get(action) === attempt) pending.delete(action);
      return result.value.id;
    }
    if (action === 'set' ? !('id' in result.value) || typeof result.value.id !== 'string' || !result.value.id : !('saved' in result.value) || result.value.saved !== true) throw new Error('Tempo could not confirm the change.');
    if (pending.get(action) === attempt) pending.delete(action);
  }
  const change = async (action: string, input: object) => { await call(action, input); };
  return {
    async requestMachine(id, machine) {
      const card = await call('propose', { change: 'triggerMachine', input: { trigger: id, machine }, why: 'Run this trigger on the selected machine.' }, 'household');
      if (!card) throw new Error('Tempo could not confirm the machine request.');
      return card;
    },
    withdrawMachine: id => change('edit', { id, machine: null }), create: input => change('set', input),
    runNow: id => change('runNow', { id }), stop: id => change('stop', { id }),
    pause: agent => change('pause', { agent }), resume: agent => change('resume', { agent }),
  };
}
