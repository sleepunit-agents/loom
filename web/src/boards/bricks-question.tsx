/** The `question` brick: one Inbox item waiting on the member, read with the Inbox's own selection and answered
 * with the Inbox's own action (pieces/attention/inbox-query.ts), under the rule the desktop's reader answers by
 * (pieces/inbox-view/index.tsx): the item waits, takes an answer, has its words, the member may answer it, and it
 * is not one that is answered somewhere else. The board is told which answer was chosen and never the words. */
import { useRef, useState, type FormEvent } from 'react';
import { useDataQuery } from '../data/graphql';
import { answerInboxItem, inboxItemQuery, retainedInboxItem } from '../pieces/attention/inbox-query';
import { useDeadline } from '../pieces/comms/use-deadline';
import { answerWord, from, managed, stateWord, when, type InboxAnswer, type InboxItem } from '../pieces/inbox-view/model';
import { Chip, Loading, Unavailable, ticketChip, words, type Act, type Params } from './bricks';
import type { Form } from './layout';

/** Something the question is about, as a chip where a brick shows it. */
function about(ref: string) {
  if (/^t-[1-9]\d*$/.test(ref)) return <span key={ref}>{ticketChip(ref)}</span>;
  if (/^a-[A-Za-z0-9-]+$/.test(ref)) return <Chip key={ref} place={{ brick: 'approval', params: { approval: ref } }}>Approval</Chip>;
  return null;
}

export function Question({ params, form, act }: { params: Params; form: Form; act: Act }) {
  const id = words(params.item);
  const read = useDataQuery<{ inboxItem: InboxItem | null }>(inboxItemQuery, { id }, { keep: true });
  const stored = read.data?.inboxItem;
  const now = useDeadline(stored ? [stored.bodyKeepUntil, stored.answerKeepUntil] : []);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [draft, setDraft] = useState('');
  const lock = useRef(false);
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !stored) return <Unavailable what="question" />;
  const item = retainedInboxItem(stored, now);
  const elsewhere = managed(item);
  const open = item.state === 'waiting' && !!item.answers && !!item.body && !elsewhere && item.canAnswer === true;
  async function answer(verdict: InboxAnswer, text?: string) {
    if (lock.current || !open || (verdict === 'words' && !text?.trim())) return;
    lock.current = true; setBusy(true); setError('');
    try { await answerInboxItem(id, verdict, text?.trim()); act('answer', { answer: verdict }); setDraft(''); }
    catch { setError('Could not save. Try again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  const said = item.body?.words ?? 'Message words are unavailable';
  if (form === 'compact') return <p className="board-brief"><span className="board-state">{item.answer ? answerWord(item.answer) : stateWord(item)}</span> {said}</p>;
  const record = (e: FormEvent) => { e.preventDefault(); void answer('words', draft); };
  const waitsOn = item.waitsOnKind === 'approval' && item.waitsOnId ? about(item.waitsOnId) : item.waitsOnKind === 'task' && item.waitsOnId ? about(item.waitsOnId) : null;
  return (
    <>
      <p className="board-lead">{said}</p>
      <dl>
        {item.body?.why && <div><dt>Why</dt><dd>{item.body.why}</dd></div>}
        {item.body?.ifYes && <div><dt>If yes</dt><dd>{item.body.ifYes}</dd></div>}
        {item.body?.ifNo && <div><dt>If no</dt><dd>{item.body.ifNo}</dd></div>}
      </dl>
      <div className="board-line">
        <span className="board-state">{stateWord(item)}</span>
        {item.agent ? <Chip place={{ brick: 'agent', params: { agent: item.agent } }}>{item.agent}</Chip> : <span>{from(item)}</span>}
        {item.project && <Chip place={{ brick: 'project', params: { project: item.project } }}>{item.project}</Chip>}
        {item.refs.map(about)}
        <span className="text-muted-foreground">{when(item.at)}</span>
      </div>
      {open && (
        <>
          <div className="board-line" role="group" aria-label="Record your answer">
            {item.answers === 'yes-no' && <>
              <button type="button" className="board-action" disabled={busy} onClick={() => void answer('yes')}>Yes</button>
              <button type="button" className="board-action" disabled={busy} onClick={() => void answer('no')}>No</button>
            </>}
            <button type="button" className="board-action" disabled={busy} onClick={() => void answer('done')}>Mark done</button>
            <button type="button" className="board-action" disabled={busy} onClick={() => void answer('dismiss')}>Dismiss</button>
          </div>
          <form className="board-line" onSubmit={record}>
            <input className="board-input" aria-label="Answer in your own words" placeholder={item.answers === 'yes-no' ? 'Or answer in your own words' : 'Answer in your own words'}
              value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} />
            <button type="submit" className="board-action" disabled={busy || !draft.trim()}>Record answer</button>
          </form>
        </>
      )}
      {item.state === 'waiting' && !open && (
        <p className="board-line text-muted-foreground">{elsewhere ? 'This is answered where it was asked.' : 'This has no answer to give here.'}{waitsOn}</p>
      )}
      {item.answer && (
        <dl style={{ marginTop: '.8rem' }}>
          <div><dt>Answer</dt><dd>{[answerWord(item.answer), item.answeredBy, item.answeredAt && when(item.answeredAt)].filter(Boolean).join(' · ')}{item.answerText && <span className="block">{item.answerText}</span>}</dd></div>
        </dl>
      )}
      {item.resolution && <p className="board-line text-muted-foreground">{item.resolution}</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </>
  );
}
