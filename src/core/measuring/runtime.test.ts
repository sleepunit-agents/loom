import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../clock.js';
import { DEFAULT_MEASURING, type TimingDay } from './index.js';
import { measuringRuntime } from './runtime.js';

const targets = [{ kind: 'request', name: 'tasks' }] as const;
describe('committed Measuring runtime replacement', () => {
  it('starts inert, enables from committed settings, and fences unfinished work on disable', async () => {
    let settings = { ...DEFAULT_MEASURING };
    const rows: TimingDay[] = [];
    const clock = new FakeClock(Date.UTC(2026, 10, 14));
    const schedule = vi.spyOn(clock, 'at');
    const prune = vi.fn();
    const runtime = measuringRuntime(() => settings, targets, {add: row => rows.push(row), prune}, undefined, clock);
    expect(runtime.run('request', 'tasks', () => 1)).toBe(1);
    await runtime.reload();
    expect(schedule).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
    settings = { ...settings, on: true };
    await runtime.reload();
    runtime.run('request', 'tasks', () => 2);
    expect(rows).toHaveLength(1);
    let finish!: (value: number) => void;
    const pending = runtime.runAsync('request', 'tasks', () => new Promise<number>(resolve => {finish = resolve;}));
    settings = { ...settings, on: false };
    const disabling = runtime.reload();
    finish(3);
    expect(await pending).toBe(3);
    await disabling;
    clock.advance(2 * 86400_000);
    expect(rows).toHaveLength(1);
    expect(prune).toHaveBeenCalledTimes(1);
    await runtime.close();
  });

  it('coalesces concurrent reloads, keeps one timer, and drains before database shutdown', async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 14));
    let settings = { ...DEFAULT_MEASURING, on: true, keep_days: 2 };
    const prune = vi.fn();
    const read = vi.fn(() => settings);
    const runtime = measuringRuntime(read, targets, {add(){}, prune}, undefined, clock);
    const first = runtime.reload();
    settings = { ...settings, keep_days: 3 };
    const second = runtime.reload();
    await Promise.all([first, second]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(prune.mock.calls).toEqual([['2026-11-12']]);
    clock.advance(86400_000);
    expect(prune).toHaveBeenCalledTimes(2);
    const reloading = runtime.reload();
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    await Promise.all([reloading, closing]);
    clock.advance(86400_000);
    expect(prune).toHaveBeenCalledTimes(2);
    await expect(runtime.reload()).rejects.toThrow('closed');
  });

  it('recovers after a rejected configuration while application work stays usable', async () => {
    let settings = { ...DEFAULT_MEASURING, on: true, keep_days: 0 };
    const report = vi.fn(() => {throw new Error('diagnostic');});
    const add = vi.fn();
    const runtime = measuringRuntime(() => settings, targets, {add, prune(){}}, report, new FakeClock(0));
    await expect(runtime.reload()).rejects.toThrow('keep_days');
    const failure = new Error('work');
    expect(() => runtime.run('request', 'tasks', () => {throw failure;})).toThrow(failure);
    const promise = Promise.resolve(4);
    expect(runtime.runAsync('request', 'tasks', () => promise)).toBe(promise);
    settings = { ...settings, keep_days: 90 };
    await runtime.reload();
    runtime.run('request', 'tasks', () => 5);
    expect(add).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    await runtime.close();
  });

  it('closes an SDK initialized while shutdown is already pending', async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 14));
    const prune = vi.fn();
    const add = vi.fn();
    let closing: Promise<void> | undefined;
    const runtime = measuringRuntime(() => {
      // createMeasuring yields for its SDK import after this committed read.
      queueMicrotask(() => { closing = runtime.close(); });
      return { ...DEFAULT_MEASURING, on: true };
    }, targets, {add, prune}, undefined, clock);
    await runtime.reload();
    await closing;
    const expired = prune.mock.calls.length;
    clock.advance(86400_000);
    runtime.run('request', 'tasks', () => 6);
    expect(prune).toHaveBeenCalledTimes(expired);
    expect(add).not.toHaveBeenCalled();
  });
});
