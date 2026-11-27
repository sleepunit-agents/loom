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
import { answerWord, from, managed, safeLink, stateWord, volumeNote, volumeWords, type InboxAnswer, type InboxItem } from '../pieces/inbox-view/model';
import { threadPath, useAgentNames } from './agents-data';
import { Action, Actions, Chip, Confirm, Fact, Facts, Lead, Loading, Note, Problem, Segmented, State, Time, Unavailable, ticketChip, words, type Act, type Params, type Tone } from './brick-kit';
import type { Form } from './layout';

/** Something the question is about, as a chip where a brick shows it. */
function about(ref: string) {
  if (/^t-[1-9]\d*$/.test(ref)) return <span key={ref}>{ticketChip(ref)}</span>;
  if (/^a-[A-Za-z0-9-]+$/.test(ref)) return <Chip key={ref} place={{ brick: 'approval', params: { approval: ref } }}>Approval</Chip>;
  return <span key={ref} className="font-mono">{ref}</span>;
}
/** Where an item stands, as a tone: it waits on someone, or it is a record. */
const tone = (item: InboxItem): Tone => (item.state === 'waiting' ? 'waiting' : item.answer === 'yes' || item.answer === 'done' ? 'good' : 'muted');
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
      <Actions><Action disabled={state === 'opening'} onClick={() => void open()}>{state === 'opening' ? 'Opening conversation…' : `Discuss with ${name(agent)}`}</Action></Actions>
      <Problem>{state === 'failed' && 'Could not open the conversation. Try again.'}</Problem>
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
  const [decided, setDecided] = useState('');
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
    if (lock.current || !join) return false;
    lock.current = true; setBusy(true); setError(''); setDecided('');
    try {
      await memberOperation('runtime.workerJoinDecide', { request: join[1], code: join[2], decision });
      act('join', { decision });
      setDecided(decision === 'allow' ? 'Machine admitted.' : 'Join request blocked.');
      return true;
    }
    catch (failure) { setError(failure instanceof MemberOperationError && failure.status === 403 ? 'Sign in again as a household owner to answer.' : 'Could not save this decision. Check the request and try again.'); return false; }
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
  if (form === 'compact') return <p className="board-brief"><State tone={tone(item)}>{item.answer ? answerWord(item.answer) : stateWord(item)}</State> {said}</p>;
  const big = form === 'primary';
  const record = (e: FormEvent) => { e.preventDefault(); void answer('words', draft); };
  const waitsOn = item.waitsOnKind === 'approval' && item.waitsOnId ? about(item.waitsOnId) : item.waitsOnKind === 'task' && item.waitsOnId ? about(item.waitsOnId) : null;
  const yesNo = item.answers === 'yes-no';
  // What it is weighed by, and the answer: the big form reads down to the answer; the small one answers first.
  const facts = (
    <>
      {(item.body?.why || item.body?.ifYes || item.body?.ifNo) && (
        <Facts>
          {item.body?.why && <Fact label="Why">{item.body.why}</Fact>}
          {item.body?.ifYes && <Fact label="If yes">{item.body.ifYes}</Fact>}
          {item.body?.ifNo && <Fact label="If no">{item.body.ifNo}</Fact>}
        </Facts>
      )}
    </>
  );
  const answers = (
    <>
      {(open || ofTask) && (
        <div className="board-form">
          <Actions label="Record your answer">
            {yesNo && <>
              <Action kind="primary" disabled={busy} onClick={() => void answer('yes')}>Yes</Action>
              <Action disabled={busy} onClick={() => void answer('no')}>No</Action>
            </>}
            {open && <>
              <Action kind="quiet" disabled={busy} onClick={() => void answer('done')}>Mark done</Action>
              <Action kind="quiet" disabled={busy} onClick={() => void answer('dismiss')}>Dismiss</Action>
            </>}
          </Actions>
          <form className="board-pick" onSubmit={record}>
            <input className="board-input" aria-label="Answer in your own words" placeholder={yesNo ? 'Or answer in your own words' : 'Answer in your own words'}
              value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} />
            <Action submit kind={yesNo ? 'plain' : 'primary'} disabled={busy || !draft.trim()}>Record answer</Action>
          </form>
        </div>
      )}
      {join && (
        <Actions label="Worker admission">
          <Confirm kind="primary" ask="Let it in…" yes="Let this machine in" busy={busy} act={() => decide('allow')} />
          <Confirm ask="Block…" yes="Block this request" busy={busy} act={() => decide('block')} />
        </Actions>
      )}
    </>
  );
  return (
    <>
      <Lead>{said}</Lead>
      <div className="board-meta">
        <State tone={tone(item)}>{stateWord(item)}</State>
        {item.agent ? <Chip place={{ brick: 'agent', params: { agent: item.agent } }}>{item.agent}</Chip> : <span>{from(item)}</span>}
        {item.project && <Chip place={{ brick: 'project', params: { project: item.project } }}>{item.project}</Chip>}
        {item.refs.map(about)}
        <Time at={item.at} />
      </div>
      {big ? <>{facts}{answers}</> : <>{answers}{facts}</>}
      {decided && <p role="status" className="board-note">{decided}</p>}
      {ofTask && waitsOn && <div className="board-meta"><span>Its task</span>{waitsOn}</div>}
      {item.state === 'waiting' && !open && !ofTask && !join && (
        <div className="board-meta"><span>{elsewhere ? 'This is answered where it was asked.' : 'This has no answer to give here.'}</span>{waitsOn}</div>
      )}
      {item.answer && (
        <Facts>
          <Fact label="Answer"><span>{[answerWord(item.answer), item.answeredBy].filter(Boolean).join(' · ')}</span><Time at={item.answeredAt} />{item.answerText && <span className="block w-full">{item.answerText}</span>}</Fact>
        </Facts>
      )}
      {item.resolution && <Note>{item.resolution}</Note>}
      {link && <Note><a href={link} target="_blank" rel="noreferrer">Open linked page</a></Note>}
      {item.discussionAgent && <Discuss key={item.id + ' ' + item.discussionAgent} item={item.id} agent={item.discussionAgent} act={act} />}
      {item.canSetVolume && big && (
        <>
          <Segmented<InboxItem['volume']> label="Notify" value={item.volume} options={volumes.map((value) => ({ value, label: volumeWords[value] }))} disabled={busy} onChange={(volume) => void notify(volume)} />
          {item.volume !== 'full' && <Note>{volumeNote[item.volume]}{item.quietUntil && <> · back to normal <Time at={item.quietUntil} /></>}</Note>}
        </>
      )}
      <Problem>{error}</Problem>
    </>
  );
}
