import { it, expect, vi } from 'vitest';
import { runWorker } from './worker-loop.js';
import type { WorkerControl, WorkerExecutor } from './worker.js';
const control = {} as WorkerControl, executor = {} as WorkerExecutor;
it('serializes attempts, backs off idle or abandoned work, and stops on abort', async () => {
  const abort = new AbortController(), order: string[] = [];
  const once = vi.fn().mockImplementationOnce(async () => { order.push('done'); return 'finished'; })
    .mockImplementationOnce(async () => { order.push('idle'); return 'idle'; })
    .mockImplementationOnce(async () => { order.push('lost'); return 'abandoned'; });
  const pause = async () => { order.push('pause'); if (once.mock.calls.length === 3) abort.abort(); };
  await runWorker({ box: 'b', control, executor, signal: abort.signal, once, pause });
  expect(order).toEqual(['done', 'idle', 'pause', 'lost', 'pause']);
});
it('never admits another job after a failed attempt or uncertain process cleanup', async () => {
  const once = vi.fn().mockRejectedValue(new Error('reaping failed'));
  await expect(runWorker({ box: 'b', control, executor, signal: new AbortController().signal, once })).rejects.toThrow('reaping failed');
  expect(once).toHaveBeenCalledOnce();
});
it('cancellation interrupts idle waiting and admits nothing more', async () => {
  const abort = new AbortController(), once = vi.fn().mockResolvedValue('idle');
  const pause = async () => { abort.abort(); throw new Error('cancelled'); };
  await runWorker({ box: 'b', control, executor, signal: abort.signal, once, pause });
  expect(once).toHaveBeenCalledOnce();
});
