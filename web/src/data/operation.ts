/** One current signed-in HTTP window write. No queue, replay, body cache or
 * retained result; domain client IDs provide safe explicit retries. */
export async function memberOperation(name: string, input: object): Promise<void> {
  if (!/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/.test(name)) throw new Error('Invalid operation');
  const response = await fetch(`/api/${name.replace('.', '/')}`, { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input, id: crypto.randomUUID() }) });
  const result: unknown = await response.json();
  if (!response.ok || !result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) throw new Error('Could not save');
}
