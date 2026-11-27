import { useRef, useState } from 'react';
import { LinkButton, NoteRow } from '../../kit';
import { currentNotices, when, type InboxActionResult, type InboxResultsSnapshot } from './model';
export { currentNotices } from './model';
export type { InboxActionResult, InboxResultsSnapshot } from './model';

/** The outcome of something this person did, as a quiet row among the list's rows: what happened, when, a link to
 * the page it happened on, and one way to dismiss it. */
export function InboxNotice({ result, dismiss, zone }: { result: InboxActionResult; dismiss?(id: string): Promise<void>; zone?: string }) {
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
  return <NoteRow role="status" title={result.text} status={[result.ok ? 'Saved' : 'Error', when(result.at, zone)].filter(Boolean).join(' · ')}
    actions={<>
      {page && <a className="loom-kit-link" href={page} aria-label={`Open the page for: ${result.text}`}>Open</a>}
      {dismiss && <LinkButton disabled={busy} aria-label={`Dismiss notice: ${result.text}`} onClick={() => void read()}>Dismiss</LinkButton>}
    </>}>
    {failed && <span role="alert" className="loom-kit-status">Could not dismiss this notice. Try again.</span>}
  </NoteRow>;
}

/** Query status withdraws retained outcomes immediately. Dismissal is acknowledged
 * only by the next query result, so a failed write never hides the notice. */
export function InboxActionNotices({ snapshot, errorsOnly, dismiss, zone }: {
  snapshot: InboxResultsSnapshot; errorsOnly?: boolean; dismiss?(id: string): Promise<void>; zone?: string;
}) {
  const results = currentNotices(snapshot, errorsOnly);
  return results.length ? <section aria-label="Recent actions">{results.map(row => <InboxNotice key={row.id} result={row} dismiss={dismiss} zone={zone} />)}</section> : null;
}
