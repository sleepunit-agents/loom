import { useState } from 'react';
import { useDataQuery } from '../../data/graphql';
import { inboxApp } from '../attention/registration';
export const settledNoticeQuery = '{ settledInboxNotice { id count } }';
type Notice = { id: string; count: number };
/** One word-free notification on the shell's existing generated connection. */
export default function InboxNotice() {
  const query = useDataQuery<{ settledInboxNotice: Notice | null }>(settledNoticeQuery);
  const [dismissed, dismiss] = useState<string>();
  const notice = query.status === 'live' ? query.data?.settledInboxNotice : undefined;
  if (!notice || typeof notice.id !== 'string' || !Number.isSafeInteger(notice.count) || notice.count <= 0 || notice.id === dismissed) return null;
  return <aside role="status" aria-label="Inbox notification" className="fixed bottom-12 right-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-background text-foreground p-3 shadow-lg">
    <a href={inboxApp.path}>{notice.count === 1 ? '1 item is' : `${notice.count} items are`} waiting in your Inbox</a>
    <button type="button" aria-label="Dismiss Inbox notification" onClick={() => dismiss(notice.id)}>Dismiss</button>
  </aside>;
}
