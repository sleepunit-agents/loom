/** What the `ticket` and `comments` bricks share: one of loom's own ticket commands, then the report to the board
 * that the member used it. */
import { useState } from 'react';
import { memberOperation } from '../data/operation';
import type { Act } from './brick-kit';

/** One of loom's own ticket commands, then the report to the board that the member used it. */
export function useTicketAction(act: Act, own: () => void = () => {}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function run(action: string, input: Record<string, unknown>) {
    if (busy) return false;
    setBusy(true); setError('');
    try { own(); await memberOperation('tasks.command', { action, ...input }); act(action, {}); return true; }
    catch { setError('That did not save.'); return false; }
    finally { setBusy(false); }
  }
  return { busy, error, run };
}
