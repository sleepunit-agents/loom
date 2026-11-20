import { useEffect, useState } from 'react';
import { useDataQuery } from '../../data/graphql';
import { inboxApp } from '../attention/registration';
import './notice.css';

export const settledNoticeQuery = '{ settledInboxNotice { id needs fyi } }';
type Notice = { id: string; needs: number; fyi: number };

function Popup({ notice, dismiss }: { notice: Notice; dismiss: (id: string) => void }) {
  const [closing, setClosing] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!closing && (focused || hovered)) return;
    const timer = setTimeout(() => {
      if (closing) dismiss(notice.id);
      else setClosing(true);
    }, closing ? 180 : 8000);
    return () => clearTimeout(timer);
  }, [closing, focused, hovered, dismiss, notice.id]);

  const counts = [
    notice.needs > 0 && `${notice.needs} ${notice.needs === 1 ? 'needs' : 'need'} your response`,
    notice.fyi > 0 && `${notice.fyi} ${notice.fyi === 1 ? 'FYI' : 'FYIs'}`,
  ].filter(Boolean).join(' · ');
  return <aside role="status" aria-label="Inbox notification" className="tempo-inbox-notice" data-closing={closing}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={event => setFocused(event.currentTarget.contains(event.relatedTarget))}>
    <a href={inboxApp.path}><strong>Inbox</strong><span>{counts}</span></a>
    <button type="button" aria-label="Dismiss Inbox notification" onClick={() => setClosing(true)}>Dismiss</button>
  </aside>;
}

export default function InboxNotice() {
  const query = useDataQuery<{ settledInboxNotice: Notice | null }>(settledNoticeQuery);
  const [dismissed, dismiss] = useState<string>();
  const notice = query.status === 'live' ? query.data?.settledInboxNotice : undefined;
  if (!notice || ![notice.needs, notice.fyi].every(n => Number.isSafeInteger(n) && n >= 0)
    || notice.needs + notice.fyi === 0 || notice.id === dismissed) return null;
  return <Popup key={notice.id} notice={notice} dismiss={dismiss} />;
}
