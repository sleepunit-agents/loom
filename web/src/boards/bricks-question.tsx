/** The `question` brick: one Inbox item waiting on the member, read with the Inbox's own selection and answered
 * with the Inbox's own action (pieces/attention/inbox-query.ts), under the rule the desktop's reader answers by
 * (pieces/inbox-view/index.tsx): the item waits, takes an answer, has its words, the member may answer it, and it
 * is not one that is answered somewhere else. The board is told which answer was chosen and never the words.
 *
 * It also shows what the desktop's opened item shows around the answer: a household change's approval by its plain
 * title, the linked page, everything the item is about, and how loudly it is shown ("Notify", by `inbox.volume`,
 * for an item the member may set it on), and the three answers the desktop's reader gives beside the Inbox's own:
 * "Discuss with" for an item loom names an agent for (`inbox.discuss`), a task's question answered through its task
 * (`tasks.command` answer), and a machine asking to join (`runtime.workerJoinDecide`, after asking). */
import { useRef, useState, type FormEvent } from 'react';
import { useDataQuery } from '../data/graphql';
import { answerInboxItem, inboxItemQuery, retainedInboxItem, useInboxItemWords } from '../pieces/attention/inbox-query';
import { MemberOperationError, memberOperation } from '../data/operation';
import { useTaskCommandSubmitter } from '../data/task-command';
import { useDeadline } from '../pieces/comms/use-deadline';
import { answerWord, from, managed, safeLink, stateWord, volumeNote, volumeWords, when, type InboxAnswer, type InboxItem } from '../pieces/inbox-view/model';
import { threadPath, useAgentNames } from './agents-data';
import { Chip, Loading, Unavailable, ticketChip, words, type Act, type Params } from './brick-kit';
import type { Form } from './layout';

/** Something the question is about, as a chip where a brick shows it. */
function about(ref: string) {
  if (/^t-[1-9]\d*$/.test(ref)) return <span key={ref}>{ticketChip(ref)}</span>;
  if (/^a-[A-Za-z0-9-]+$/.test(ref)) return <Chip key={ref} place={{ brick: 'approval', params: { approval: ref } }}>Approval</Chip>;
  return <span key={ref} className="font-mono">{ref}</span>;
}
/** How loudly an item is shown, in the order the Inbox lists the choices. */
export const volumes = Object.keys(volumeWords) as InboxItem['volume'][];

/** A machine asking to join, as the desktop's card reads its notice (pieces/attention/worker-join.tsx). */
const joinRequest = (item: InboxItem) => (item.source === 'notice' && item.state === 'waiting' ? /^worker-join:([a-f0-9-]{36}):([A-Z2-9]{4}-[A-Z2-9]{4})$/.exec(item.sourceId ?? '') : null);

/** "Discuss with": the conversation about this item with the agent loom names for it, opened by `inbox.discuss`
 * as the desktop opens it (pieces/attention/inbox-discussion.tsx), then shown on this page. */
function Discuss({ item, agent, act }: { item: string; agent: string; act: Act }) {
  const name = useAgentNames();
  const [state, setState] = useState<'idle' | 'opening' | 'failed'>('idle');
  const lock = useRef(false);
  async function open() {
    if (lock.current) return;
    lock.current = true; setState('opening');
    try {
      const { thread } = await memberOperation<{ thread: string }>('inbox.discuss', { item, expectedAgent: agent });
      act('discuss', {});
      setState('idle');
      window.location.assign(threadPath(thread));
    } catch { setState('failed'); }
    finally { lock.current = false; }
  }
  return (
    <>
      <div className="board-line"><button type="button" className="board-action" disabled={state === 'opening'} onClick={() => void open()}>{state === 'opening' ? 'Opening conversation…' : `Discuss with ${name(agent)}`}</button></div>
      {state === 'failed' && <p role="alert" className="text-destructive">Could not open the conversation. Try again.</p>}
    </>
  );
}

export function Question({ params, form, act }: { params: Params; form: Form; act: Act }) {
  const id = words(params.item);
  const read = useDataQuery<{ inboxItem: InboxItem | null }>(inboxItemQuery, { id }, { keep: true });
  const stored = read.data?.inboxItem;
  const now = useDeadline(stored ? [stored.bodyKeepUntil, stored.answerKeepUntil] : []);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [draft, setDraft] = useState('');
  const lock = useRef(false);
  const submit = useTaskCommandSubmitter();
  const [asking, setAsking] = useState<'' | 'allow' | 'block'>(''), [decided, setDecided] = useState('');
  const plain = useInboxItemWords(stored ? [stored] : []);
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !stored) return <Unavailable what="question" />;
  const item = retainedInboxItem(stored, now);
  const elsewhere = managed(item);
  const open = item.state === 'waiting' && !!item.answers && !!item.body && !elsewhere && item.canAnswer === true;
  // A task owns the answer to its question (pieces/tasks/question-answer.tsx): Yes, No or words, through the task.
  const ofTask = item.state === 'waiting' && !!item.body && !!item.answers && item.source === 'task' && item.waitsOnKind === 'task' && !!item.waitsOnId;
  const join = joinRequest(item);
  async function answer(verdict: InboxAnswer, text?: string) {
    if (lock.current || !(open || ofTask) || (verdict === 'words' && !text?.trim())) return;
    lock.current = true; setBusy(true); setError('');
    try {
      if (ofTask) {
        if (verdict !== 'yes' && verdict !== 'no' && verdict !== 'words') return;
        await submit({ action: 'answer', id: item.waitsOnId!, question: item.id, answer: verdict, ...(verdict === 'words' ? { text: text!.trim() } : {}) });
        act('taskAnswer', { answer: verdict });
      } else { await answerInboxItem(id, verdict, text?.trim()); act('answer', { answer: verdict }); }
      setDraft('');
    }
    catch { setError(ofTask ? 'Could not save your answer. Reconnect and try again.' : 'Could not save. Try again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function decide(decision: 'allow' | 'block') {
    if (lock.current || !join) return;
    lock.current = true; setBusy(true); setError(''); setDecided('');
    try {
      await memberOperation('runtime.workerJoinDecide', { request: join[1], code: join[2], decision });
      act('join', { decision }); setAsking('');
      setDecided(decision === 'allow' ? 'Machine admitted.' : 'Join request blocked.');
    }
    catch (failure) { setError(failure instanceof MemberOperationError && failure.status === 403 ? 'Sign in again as a household owner to answer.' : 'Could not save this decision. Check the request and try again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function notify(volume: InboxItem['volume']) {
    if (lock.current || volume === item.volume || !item.canSetVolume) return;
    lock.current = true; setBusy(true); setError('');
    try { await memberOperation('inbox.volume', { item: id, volume }); act('volume', { volume }); }
    catch { setError('Could not save. Try again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  const said = plain(item) ?? item.body?.words ?? 'Message words are unavailable';
  const link = safeLink(item.body?.link);
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
      {(open || ofTask) && (
        <>
          <div className="board-line" role="group" aria-label="Record your answer">
            {item.answers === 'yes-no' && <>
              <button type="button" className="board-action" disabled={busy} onClick={() => void answer('yes')}>Yes</button>
              <button type="button" className="board-action" disabled={busy} onClick={() => void answer('no')}>No</button>
            </>}
            {open && <>
              <button type="button" className="board-action" disabled={busy} onClick={() => void answer('done')}>Mark done</button>
              <button type="button" className="board-action" disabled={busy} onClick={() => void answer('dismiss')}>Dismiss</button>
            </>}
          </div>
          <form className="board-line" onSubmit={record}>
            <input className="board-input" aria-label="Answer in your own words" placeholder={item.answers === 'yes-no' ? 'Or answer in your own words' : 'Answer in your own words'}
              value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} />
            <button type="submit" className="board-action" disabled={busy || !draft.trim()}>Record answer</button>
          </form>
        </>
      )}
      {join && (
        <div className="board-line" role="group" aria-label="Worker admission">
          {asking ? <>
            <button type="button" className="board-action" disabled={busy} onClick={() => void decide(asking)}>{asking === 'allow' ? 'Let this machine in' : 'Block this request'}</button>
            <button type="button" className="board-action" disabled={busy} onClick={() => setAsking('')}>Cancel</button>
          </> : <>
            <button type="button" className="board-action" disabled={busy} onClick={() => setAsking('allow')}>Let it in…</button>
            <button type="button" className="board-action" disabled={busy} onClick={() => setAsking('block')}>Block…</button>
          </>}
        </div>
      )}
      {decided && <p role="status" className="text-muted-foreground">{decided}</p>}
      {ofTask && waitsOn && <p className="board-line text-muted-foreground">Its task{waitsOn}</p>}
      {item.state === 'waiting' && !open && !ofTask && !join && (
        <p className="board-line text-muted-foreground">{elsewhere ? 'This is answered where it was asked.' : 'This has no answer to give here.'}{waitsOn}</p>
      )}
      {item.answer && (
        <dl style={{ marginTop: '.8rem' }}>
          <div><dt>Answer</dt><dd>{[answerWord(item.answer), item.answeredBy, item.answeredAt && when(item.answeredAt)].filter(Boolean).join(' · ')}{item.answerText && <span className="block">{item.answerText}</span>}</dd></div>
        </dl>
      )}
      {item.resolution && <p className="board-line text-muted-foreground">{item.resolution}</p>}
      {link && <p className="board-line"><a href={link} target="_blank" rel="noreferrer">Open linked page</a></p>}
      {item.discussionAgent && <Discuss key={item.id + ' ' + item.discussionAgent} item={item.id} agent={item.discussionAgent} act={act} />}
      {item.canSetVolume && (
        <div className="board-line" role="group" aria-label="Notify">
          <span className="text-muted-foreground">Notify</span>
          {volumes.map((volume) => <button key={volume} type="button" className="board-action" aria-pressed={volume === item.volume} disabled={busy || volume === item.volume} onClick={() => void notify(volume)}>{volumeWords[volume]}</button>)}
          {item.volume !== 'full' && <span className="text-muted-foreground">{volumeNote[item.volume]}{item.quietUntil ? ` · back to normal ${when(item.quietUntil)}` : ''}</span>}
        </div>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </>
  );
}
