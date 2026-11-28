import { sha256 } from '@noble/hashes/sha2.js';
import { useMemo } from 'react';
import type { TaskCommand } from '../pieces/tasks/model';

type PendingIntents = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
/** What tasks.command answers: the task it made or changed, or the tasks a move took. */
export type TaskCommandResult = { id?: string; moved?: string[] };
/** Tab-scoped pending IDs survive screen remount/reload; task text is never stored. */
export function taskCommandSubmitter(...door: Parameters<typeof taskCommandSender>) {
  const send = taskCommandSender(...door);
  return async (input: TaskCommand): Promise<void> => { await send(input); };
}
/** The same door, for a caller that needs the answer: a new task's id (the boards page offers it as a chip). */
export function taskCommandSender(request: typeof fetch = fetch, makeId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}, pending: PendingIntents = {
  getItem: key => sessionStorage.getItem(key),
  setItem: (key, value) => sessionStorage.setItem(key, value),
  removeItem: key => sessionStorage.removeItem(key),
}) {
  return async (input: TaskCommand): Promise<TaskCommandResult> => {
    const digest = sha256(new TextEncoder().encode(JSON.stringify(input)));
    const key = 'loom:pending-task:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    let id: string;
    try {
      id = pending.getItem(key) ?? makeId();
      // Persist before sending: unavailable storage must not risk an untracked write.
      pending.setItem(key, id);
    } catch { throw new Error('Could not prepare the task. Try again.'); }
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
    pending.removeItem(key);
    return result.value as TaskCommandResult;
  };
}
export function useTaskCommandSubmitter() { return useMemo(() => taskCommandSubmitter(), []); }
