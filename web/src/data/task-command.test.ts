import { expect, it, vi } from 'vitest';
import { taskCommandSubmitter } from './task-command';
const input = { action: 'claim' as const, id: 't-1' };
it('uses the exact shared HTTP envelope and keeps its ID after an unconfirmed response', async () => {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true, value: { id: 't-1' } })).mockRejectedValueOnce(new Error('network'));
  const makeId = vi.fn().mockReturnValueOnce('first').mockReturnValueOnce('second');
  const send = taskCommandSubmitter(request, makeId);
  await expect(send(input)).rejects.toThrow('Could not confirm');
  await send(input); await send(input);
  expect(request.mock.calls.map(([, init]) => JSON.parse(String(init!.body)).id)).toEqual(['first', 'first', 'second']);
  expect(request.mock.calls[0]).toEqual(['/api/tasks/command', { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input, id: 'first' }) }]);
});
it('does not treat a rejected or malformed response as confirmation', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: false, message: 'Access changed' }, { status: 403 }))
    .mockResolvedValueOnce(Response.json({ ok: true })).mockResolvedValueOnce(Response.json({ ok: true, value: {} }));
  const send = taskCommandSubmitter(request, () => 'pending');
  await expect(send(input)).rejects.toThrow('Access changed');
  await expect(send(input)).rejects.toThrow('Could not confirm'); await send(input);
  expect(request.mock.calls.map(([, init]) => JSON.parse(String(init!.body)).id)).toEqual(['pending', 'pending', 'pending']);
});
