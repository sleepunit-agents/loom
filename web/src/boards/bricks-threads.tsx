/** The `threads` brick: the member's own conversations, as the list beside the presence reads them (agents-data.ts,
 * Comms' rows and order), each an ordinary link to that thread's address on this page. */
import { threadPath, useAgentNames, useThreads } from './agents-data';
import { Few, Lead, Loading, More, Note, Row, Rows, Time, Unavailable, words, type Params } from './brick-kit';
import type { Form } from './layout';
import { ThreadLine } from './threads';

const count = (n: number, more: boolean, one: string, many: string) => `${more ? 'More than ' : ''}${n} ${n === 1 && !more ? one : many}`;
export function Threads({ params, form }: { params: Params; form: Form }) {
  const archived = words(params.scope) === 'archived';
  const list = useThreads(archived), name = useAgentNames();
  if (list.status === 'loading') return <Loading />;
  if (list.status !== 'live') return <Unavailable what="list of conversations" />;
  const working = list.rows.filter((t) => t.working).length, unread = list.rows.filter((t) => t.unread).length;
  const counts = `${count(list.rows.length, list.more, archived ? 'archived conversation' : 'conversation', archived ? 'archived conversations' : 'conversations')} · ${working} working · ${unread} unread`;
  if (form === 'compact') return <p className="board-brief">{counts}</p>;
  const big = form === 'primary';
  return (
    <>
      {form === 'primary' ? <Lead>{counts}</Lead> : <Note>{counts}</Note>}
      {list.rows.length > 0 && (
        <Few of={list.rows} first={big ? 50 : 6} fit={!big}>{(shown, hidden) => <>
        <Rows>
          {shown.map((t) => <Row key={t.id} title={<span className="board-threads-line"><a href={threadPath(t.id)}><ThreadLine thread={t} name={name} /></a></span>} end={form === 'primary' ? <Time at={t.lastAt} /> : undefined} />)}
        </Rows>
        <More n={hidden} />
        </>}</Few>
      )}
      {!list.rows.length && <Note>{archived ? 'No archived conversations.' : 'No conversations yet.'}</Note>}
    </>
  );
}
