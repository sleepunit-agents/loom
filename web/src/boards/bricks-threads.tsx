/** The `threads` brick: the member's own conversations, as the list beside the presence reads them (agents-data.ts,
 * Comms' rows and order), each an ordinary link to that thread's address on this page. Big, it has Comms' search
 * (asked on submit, once, by `useThreadSearch`: what was typed is state of this drawn brick, never a parameter or a
 * detail, and the board never shows it), and each row of the member's own has Comms' Pin or Unpin and Delete (asked
 * first, naming the conversation), by `comms.change`. The board is told `pin`, `unpin` or `delete` and nothing else. */
import { useState, type ReactNode } from 'react';
import { memberOperation } from '../data/operation';
import type { CommsThread } from '../pieces/comms-view/model';
import { threadPath, useAgentNames, useThreads, type ThreadsReading } from './agents-data';
import { Action, Actions, Asking, Few, Lead, Loading, More, Note, Problem, Row, Rows, Time, Unavailable, useHereThread, words, type Act, type Params } from './brick-kit';
import type { Form } from './layout';
import { changeFor, deleteQuestion, searchFailed, searchNone, ThreadLine, ThreadSearch, useThreadSearch, type ThreadAct } from './threads';

const count = (n: number, more: boolean, one: string, many: string) => `${more ? 'More than ' : ''}${n} ${n === 1 && !more ? one : many}`;
export function Threads({ params, form, act }: { params: Params; form: Form; act?: Act }) {
  const archived = words(params.scope) === 'archived';
  const list = useThreads(archived), name = useAgentNames();
  // A search is asked again after one of its rows is pinned or deleted (a new round): its answer does not follow changes.
  const [asked, setAsked] = useState(''), [round, setRound] = useState(0);
  if (list.status === 'loading') return <Loading />;
  if (list.status !== 'live') return <Unavailable what="list of conversations" />;
  const working = list.rows.filter((t) => t.working).length, unread = list.rows.filter((t) => t.unread).length;
  const counts = `${count(list.rows.length, list.more, archived ? 'archived conversation' : 'conversation', archived ? 'archived conversations' : 'conversations')} · ${working} working · ${unread} unread`;
  if (form === 'compact') return <p className="board-brief">{counts}</p>;
  const big = form === 'primary';
  const done = (what: ThreadAct) => { act?.(what, {}); if (asked) setRound((n) => n + 1); };
  const rows = (reading: ThreadsReading, empty: string) => (
    <>
      {reading.rows.length > 0 && (
        <Few of={reading.rows} first={big ? 50 : 6} fit={!big}>{(shown, hidden) => <>
        <Rows>
          {shown.map((t) => big ? <ThreadRow key={t.id} thread={t} name={name} done={done} /> : <Row key={t.id} title={<span className="board-threads-line"><a href={threadPath(t.id)}><ThreadLine thread={t} name={name} /></a></span>} />)}
        </Rows>
        <More n={hidden} />
        </>}</Few>
      )}
      {!reading.rows.length && <Note>{empty}</Note>}
    </>
  );
  return (
    <>
      {big ? <Lead>{counts}</Lead> : <Note>{counts}</Note>}
      {big && <ThreadSearch asked={asked} ask={(w) => { setAsked(w); setRound(0); }} />}
      {big && asked
        ? <Found key={`${asked}\0${round}`} asked={asked} archived={archived} draw={rows} />
        : rows(list, archived ? 'No archived conversations.' : 'No conversations yet.')}
    </>
  );
}

/** What a search found: asked once when drawn (a new key asks again), drawn as the list is. */
function Found({ asked, archived, draw }: { asked: string; archived: boolean; draw(reading: ThreadsReading, empty: string): ReactNode }) {
  const found = useThreadSearch(asked, archived);
  if (found.status === 'loading') return <Loading />;
  if (found.status !== 'live') return <Problem>{searchFailed}</Problem>;
  return <>{draw(found, searchNone)}{found.more && <Note>More match than these fifty; the rest are in Comms.</Note>}</>;
}

/** One row of the big form: the link, when it was last used, and for the member's own thread Pin or Unpin and Delete. */
function ThreadRow({ thread: t, name, done }: { thread: CommsThread; name(id: string): string; done(what: ThreadAct): void }) {
  const [asking, setAsking] = useState(false), [busy, setBusy] = useState(false), [failed, setFailed] = useState('');
  const here = useHereThread() === t.id;
  const run = async (what: ThreadAct) => {
    if (busy) return;
    setBusy(true); setFailed('');
    try { await memberOperation('comms.change', { thread: t.id, ...changeFor(what) }); setAsking(false); done(what); }
    catch { setFailed(what === 'delete' ? 'Could not delete the conversation. Try again.' : 'Could not save. Try again.'); }
    finally { setBusy(false); }
  };
  return (
    <Row title={<span className="board-threads-line"><a href={threadPath(t.id)}><ThreadLine thread={t} name={name} /></a></span>} end={<Time at={t.lastAt} />}>
      {asking && !here
        ? <Asking label={`Delete conversation ${t.title}`} yes="Delete conversation" no="Keep it" busy={busy} onYes={() => void run('delete')} onNo={() => setAsking(false)}>{deleteQuestion(t.title)}</Asking>
        : (
          <Actions>
            <Action kind="quiet" disabled={busy} label={`${t.pinned ? 'Unpin' : 'Pin'} ${t.title}`} onClick={() => void run(t.pinned ? 'unpin' : 'pin')}>{t.pinned ? 'Unpin' : 'Pin'}</Action>
            {!here && <Action kind="quiet" disabled={busy} label={`Delete ${t.title}…`} onClick={() => { setFailed(''); setAsking(true); }}>Delete…</Action>}
          </Actions>
        )}
      <Problem>{failed}</Problem>
    </Row>
  );
}
