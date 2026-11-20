import { useEffect, useRef } from 'react';
import { call, type Snapshot } from '../../data';
import type { Ask } from './model';

/** One member's page checks only its current live asks. Results are never cached here. */
export function waitChecks(check: (id: string) => Promise<unknown>) {
  let snapshot: Snapshot<Ask> = { records: [], status: 'loading' }, stopped = false, running = false;
  const checked = new Map<string, number>();
  async function drain() {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped && snapshot.status === 'live') {
        const ask = snapshot.records.find(a => a.state === 'open' && a.waits_on && !a.sourceManaged && checked.get(a.id) !== a.changedAt);
        if (!ask) break;
        checked.set(ask.id, ask.changedAt);
        // Refusal/offline/unknown holds the ask. The next sweep gets a fresh operation id.
        try { await check(ask.id); } catch { /* No foreign wording or response facts are retained. */ }
      }
    } finally { running = false; }
  }
  return {
    update(next: Snapshot<Ask>) {
      if (snapshot.status !== 'live' || next.status !== 'live') checked.clear();
      snapshot = next;
      const ids = new Set(next.records.map(a => a.id));
      for (const id of checked.keys()) if (!ids.has(id)) checked.delete(id);
      void drain();
    },
    sweep() { checked.clear(); void drain(); },
    stop() { stopped = true; snapshot = { records: [], status: 'loading' }; checked.clear(); },
  };
}
/** The socket operation keeps the authenticated member; there is no service or owner impersonation. */
export function useWaitChecks(snapshot: Snapshot<Ask>): void {
  const latest = useRef(snapshot); latest.current = snapshot;
  const worker = useRef<ReturnType<typeof waitChecks> | undefined>(undefined);
  useEffect(() => {
    const current = waitChecks(id => call('attention.checkWait', { id }).result);
    worker.current = current;
    current.update(latest.current);
    const timer = setInterval(() => current.sweep(), 60_000);
    return () => { clearInterval(timer); current.stop(); worker.current = undefined; };
  }, []);
  useEffect(() => { worker.current?.update(snapshot); }, [snapshot]);
}
