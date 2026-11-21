/** One current signed-in HTTP window write. No queue, replay, body cache or
 * retained result; domain client IDs provide safe explicit retries. */
export class MemberOperationError extends Error {
  readonly status:number;
  constructor(status:number){super('Could not save');this.status=status;}
}
export async function memberOperation<T = void>(name: string, input: object, id: string = crypto.randomUUID()): Promise<T> {
  if (!/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/.test(name)) throw new Error('Invalid operation');
  const response = await fetch(`/api/${name.replace('.', '/')}`, { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input, id }) });
  const result: unknown = await response.json();
  if (!response.ok || !result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) throw new MemberOperationError(response.status);
  return ('value' in result ? result.value : undefined) as T;
}
