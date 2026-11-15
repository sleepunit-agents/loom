import { clock as realClock, type Clock } from '../clock.js';
import { createMeasuring, type Measuring, type MeasuringSettings, type TimingStore, type TimingTarget } from './index.js';

/** One stable dispatch handle for the composition root. Call reload only after
 * the shared approval transaction commits; read always reads committed settings.
 * Fence old work immediately, then drain its SDK before starting a replacement.
 * A failed replacement leaves measuring off and can be retried. */
export function measuringRuntime(
  read: () => Readonly<MeasuringSettings>, targets: readonly TimingTarget[] | (() => readonly TimingTarget[]), store?: TimingStore,
  reportError: () => void = () => {}, clock: Clock = realClock,
): Measuring & { reload(): Promise<void> } {
  let current: Measuring | undefined;
  let generation = 0;
  let stopped = false;
  let tail: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const report = () => { try { reportError(); } catch { /* diagnostics stay isolated */ } };
  const fence = () => {
    const old = current;
    current = undefined;
    // close synchronously fences spans and cancels idle retention before yielding.
    return old?.close() ?? Promise.resolve();
  };
  return {
    run(kind, name, work) { return current ? current.run(kind, name, work) : work(); },
    runAsync(kind, name, work) { return current ? current.runAsync(kind, name, work) : work(); },
    flush() { return current?.flush() ?? Promise.resolve(); },
    reload() {
      if (stopped) return Promise.reject(new Error('Measuring runtime is closed'));
      const ticket = ++generation;
      const draining = fence();
      // Attach rejection handling immediately even when an earlier load is pending.
      const drained = draining.then(() => undefined, () => { report(); });
      const loading = tail.then(async () => {
        await drained;
        if (stopped || ticket !== generation) return;
        const settings = { ...read() };
        const replacement = await createMeasuring(settings, typeof targets === 'function' ? targets() : targets, settings.keep_days === 0 ? undefined : store, report, clock);
        if (stopped || ticket !== generation) await replacement.close();
        else current = replacement;
      });
      tail = loading.catch(() => { report(); });
      return loading;
    },
    close() {
      if (closing) return closing;
      stopped = true;
      ++generation;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      const drained = fence();
      void Promise.all([tail, drained]).then(() => resolve(), reject);
      return closing;
    },
  };
}
