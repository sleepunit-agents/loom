import { useEffect, useRef, useState } from 'react';
import { managed, type InboxItem } from '../inbox-view/model';
import { answerInboxItem } from './inbox-query';
import { bandSize, useDeskWaitingBand, waitingPath, type WaitingCounts } from './waiting';

/** Whether a Yes or No may be given where the ask stands. An approval, a secret request, a task's question and
 * anything that waits on another record are answered where that record is; an ask whose buttons carry lines
 * of their own ("If yes…") is read whole before it is pressed. Those open in the Inbox. */
export function answersInPlace(item: InboxItem): boolean {
  return item.state === 'waiting' && item.answers === 'yes-no' && !!item.canAnswer && !!item.body
    && !managed(item) && !item.body.ifYes && !item.body.ifNo;
}

/** One waiting ask: its words and who asked, opening it in the Inbox; Yes and No beside it where that is safe. */
export function NeedChip({ item, who, go }: { item: InboxItem; who: string; go(path: string): void }) {
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const lock = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const whole = item.body?.words ?? `A question from ${who}`;
  const words = item.volume === 'dim' ? whole.split('\n')[0] : whole;
  const say = async (answer: 'yes' | 'no') => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setFailed(false);
    try { await answerInboxItem(item.id, answer); }
    catch { if (mounted.current) setFailed(true); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  return <li className="desk-need" data-unread={!item.read || undefined}>
    <button type="button" className="desk-need-open" title={whole} aria-label={`${whole} From ${who}. Open in Inbox`} onClick={() => go(waitingPath(item.id))}>
      <b>{words}</b><small>{failed ? `${who} · Not recorded. Open it to answer.` : who}</small>
    </button>
    {answersInPlace(item) && <span className="desk-need-answer" role="group" aria-label={`Your answer to ${who}`}>
      <button type="button" disabled={busy} onClick={() => void say('yes')}>Yes</button>
      <button type="button" disabled={busy} onClick={() => void say('no')}>No</button>
    </span>}
  </li>;
}

/** Home's Needs you: a slim band over the cards. Its count, the first three asks as chips, and the Inbox at the end. */
export function NeedsBand({ waiting, names, go }: { waiting: WaitingCounts; names?: ReadonlyMap<string, string>; go(path: string): void }) {
  const band = useDeskWaitingBand();
  const live = waiting.status === 'live', count = live ? waiting.total ?? 0 : 0;
  const shown = live && band.status === 'live' ? band.items.slice(0, bandSize) : [];
  const who = (item: InboxItem) => item.agent ? names?.get(item.agent) ?? item.agent : 'Household';
  return <section className="desk-needs-band" aria-label="Needs you" data-zero={count ? undefined : ''}>
    <span className="desk-needs-label"><span className="desk-needs-dot" aria-hidden="true" />Needs you{live ? ` · ${count}` : ''}</span>
    {!live ? <span className="desk-needs-quiet" role="status">{waiting.status === 'loading' ? 'Checking…'
      : waiting.status === 'denied' ? 'Sign in to see what is waiting on you.' : 'Can’t tell what is waiting on you right now.'}</span>
      : !count ? <span className="desk-needs-quiet">All clear. Nothing is waiting on you.</span>
      : <ul className="desk-needs-items">{shown.map(item => <NeedChip key={item.id} item={item} who={who(item)} go={go} />)}</ul>}
    {count > 0 && <a className="desk-needs-all" href={waitingPath()} onClick={event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); go(waitingPath());
    }}>{shown.length && count > shown.length ? `+${count - shown.length} more · ` : ''}Inbox ›</a>}
  </section>;
}
