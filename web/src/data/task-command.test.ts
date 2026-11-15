import { expect, it, vi } from 'vitest';
import { taskCommandSubmitter } from './task-command';
const pendingStore = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, values };
};
const input = { action: 'claim' as const, id: 't-1' };
it('uses the exact shared HTTP envelope and keeps its ID after an unconfirmed response', async () => {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true, value: { id: 't-1' } })).mockRejectedValueOnce(new Error('network'));
  const makeId = vi.fn().mockReturnValueOnce('first').mockReturnValueOnce('second');
  const send = taskCommandSubmitter(request, makeId, pendingStore());
  await expect(send(input)).rejects.toThrow('Could not confirm');
  await send(input); await send(input);
  expect(request.mock.calls.map(([, init]) => JSON.parse(String(init!.body)).id)).toEqual(['first', 'first', 'second']);
  expect(request.mock.calls[0]).toEqual(['/api/tasks/command', { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input, id: 'first' }) }]);
});
it('does not treat a rejected or malformed response as confirmation', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: false, message: 'Access changed' }, { status: 403 }))
    .mockResolvedValueOnce(Response.json({ ok: true })).mockResolvedValueOnce(Response.json({ ok: true, value: {} }));
  const send = taskCommandSubmitter(request, vi.fn().mockReturnValueOnce('first').mockReturnValueOnce('second').mockReturnValueOnce('third'), pendingStore());
  await expect(send(input)).rejects.toThrow('Access changed');
  await expect(send(input)).rejects.toThrow('Could not confirm'); await send(input);
  expect(request.mock.calls.map(([, init]) => JSON.parse(String(init!.body)).id)).toEqual(['first', 'first', 'first']);
});

it('retains an unconfirmed intent across recreated screens and reload storage handles without storing task text', async () => {
  const storage = pendingStore();
  const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('response lost'))
    .mockImplementation(async () => Response.json({ ok: true, value: { id: 't-1' } }));
  const comment = { action: 'comment' as const, id: 't-1', text: 'Private task discussion' };
  await expect(taskCommandSubmitter(request, () => 'original', storage)(comment)).rejects.toThrow('Could not confirm');
  expect([...storage.values]).toEqual([[expect.stringMatching(/^loom:pending-task:[a-f0-9]{64}$/), 'original']]);
  await taskCommandSubmitter(request, () => 'replacement', { ...storage })(comment);
  expect(storage.values.size).toBe(0);
  await taskCommandSubmitter(request, () => 'new-intent', storage)(comment);
  expect(request.mock.calls.map(([, init]) => JSON.parse(String(init!.body)).id)).toEqual(['original', 'original', 'new-intent']);
});
