/** The `threads` brick: the member's own conversations, as the list beside the presence reads them (agents-data.ts,
 * Comms' rows and order), each an ordinary link to that thread's address on this page. */
import { briefTime } from '../kit/time';
import { threadPath, useAgentNames, useThreads } from './agents-data';
import { Loading, Unavailable, words, type Params } from './brick-kit';
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
  const shown = list.rows.slice(0, form === 'primary' ? 50 : 6);
  return (
    <>
      <p>{counts}</p>
      {shown.map((t) => (
        <div className="board-line" key={t.id}>
          <a href={threadPath(t.id)}><ThreadLine thread={t} name={name} /></a>
          {form === 'primary' && <span className="text-muted-foreground">{briefTime(t.lastAt)}</span>}
        </div>
      ))}
      {list.rows.length > shown.length && <p className="text-muted-foreground">and {list.rows.length - shown.length} more</p>}
      {!list.rows.length && <p className="text-muted-foreground">{archived ? 'No archived conversations.' : 'No conversations yet.'}</p>}
    </>
  );
}
