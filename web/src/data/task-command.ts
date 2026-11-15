import { useMemo } from 'react';
import type { TaskCommand } from '../pieces/tasks/shared-form';

/** Keep only pending intent IDs, never returned rows or optimistic Task state. */
export function taskCommandSubmitter(request: typeof fetch = fetch, makeId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}) {
  const pending = new Map<string, string>();
  return async (input: TaskCommand): Promise<void> => {
    const key = JSON.stringify(input), id = pending.get(key) ?? makeId();
    pending.set(key, id);
    let response: Response, result: unknown;
    try {
      response = await request('/api/tasks/command', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input, id }) });
      result = await response.json();
    } catch { throw new Error('Could not confirm the task. Try again.'); }
    if (!result || typeof result !== 'object' || Array.isArray(result) || !('ok' in result)) throw new Error('Could not confirm the task. Try again.');
    if (!response.ok || result.ok !== true) {
      throw new Error('message' in result && typeof result.message === 'string' ? result.message : 'Could not save the task. Try again.');
    }
    if (!('value' in result) || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)
      || ('id' in result.value && typeof result.value.id !== 'string')) throw new Error('Could not confirm the task. Try again.');
    pending.delete(key);
  };
}
export function useTaskCommandSubmitter() { return useMemo(() => taskCommandSubmitter(), []); }
