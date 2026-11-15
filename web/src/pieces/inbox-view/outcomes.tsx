import { useRef, useState } from 'react';
import { Button, Error } from '../../kit';
import type { InboxSnapshot } from './model';

export interface InboxActionResult {
  id: string; at: string; ok: boolean; text: string; page?: string | null; readAt?: string | null;
}
export interface InboxResultsSnapshot {
  status: InboxSnapshot['status']; results: readonly InboxActionResult[];
}

function Notice({ result, dismiss }: { result: InboxActionResult; dismiss?(id: string): Promise<void> }) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  async function read() {
    if (!dismiss || locked.current) return;
    locked.current = true; setBusy(true); setFailed(false);
    try { await dismiss(result.id); }
    catch { setFailed(true); }
    finally { locked.current = false; setBusy(false); }
  }
  const page = result.page && !result.page.includes('\\') && !/[\u0000-\u0020]/.test(result.page) && /^\/(?!\/)/.test(result.page) ? result.page : undefined;
  return <article role="status" className="grid gap-2 p-3">
    <p>{result.ok ? 'Saved' : 'Error'} · {result.text}</p>
    {page && <a href={page}>Open source page</a>}
    {dismiss && <Button disabled={busy} onClick={() => void read()}>Dismiss notice</Button>}
    {failed && <Error text="Could not dismiss notice. Try again." />}
  </article>;
}

/** Query status withdraws retained outcomes immediately. Dismissal is acknowledged
 * only by the next query result, so a failed write never hides the notice. */
export function InboxActionNotices({ snapshot, errorsOnly, dismiss }: {
  snapshot: InboxResultsSnapshot; errorsOnly?: boolean; dismiss?(id: string): Promise<void>;
}) {
  if (snapshot.status !== 'live') return null;
  const results = snapshot.results.filter(row => !row.readAt && (!errorsOnly || !row.ok));
  return results.length ? <section aria-label="Recent actions">{results.map(row => <Notice key={row.id} result={row} dismiss={dismiss} />)}</section> : null;
}
