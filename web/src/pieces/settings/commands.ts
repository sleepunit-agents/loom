import { newId } from '../../data/id';
/** Responses acknowledge only. Never render upstream bodies, errors or values. */
export async function settingsCommand(operation: 'command' | 'set' | 'remove', input: object, request: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await request(`/api/secrets/${operation}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: newId(), input }) });
    if (!response.ok) return false;
    const answer: unknown = await response.json();
    return !!answer && typeof answer === 'object' && 'ok' in answer && answer.ok === true
      && 'value' in answer && !!answer.value && typeof answer.value === 'object' && 'saved' in answer.value && answer.value.saved === true;
  } catch { return false; }
}
/** Uncontrolled input is emptied synchronously, before any network work. No
 * value enters component state, storage, query variables or automatic replay. */
export function submitSecret(input: { name: string; description: string; mode: 'add' | 'replace'; field: { value: string } }, request: typeof fetch = fetch) {
  const value = input.field.value;
  input.field.value = '';
  return settingsCommand('set', { id: newId(), name: input.name, description: input.description, mode: input.mode, value }, request);
}
