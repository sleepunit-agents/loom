import { useEffect } from 'react';
import { call, type Snapshot } from '../../data';

export const MEMBER_RETENTION_INTERVAL = 86_400_000;

/** The existing operation applies central policy to the authenticated socket member.
 * Results contain counts only and never become a second source of desk records. */
export function useMemberRetention(status: Snapshot['status']): void {
  useEffect(() => {
    if (status !== 'live') return;
    let stopped = false, pending = false;
    const sweep = async () => {
      if (stopped || pending) return;
      pending = true;
      try { await call('attention.retain', {}).result; }
      catch { /* Refusals and connection failures hold metadata until a later sweep. */ }
      finally { pending = false; }
    };
    void sweep();
    const timer = setInterval(() => { void sweep(); }, MEMBER_RETENTION_INTERVAL);
    return () => { stopped = true; clearInterval(timer); };
  }, [status]);
}
