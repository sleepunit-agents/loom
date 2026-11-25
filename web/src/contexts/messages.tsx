import { useState } from 'react';
import { useDataQuery } from '../data/graphql';
import type { CommsMessage } from '../pieces/comms-view/model';
import { messageFields, retainedCommsMessage } from '../pieces/comms/shared-query';
import { useDeadline } from '../pieces/comms/use-deadline';
import { Facts, FieldContext, type FieldFocus } from './entity-facts';
import type { EntityTarget } from './entities';
export function Messages({
  target,
  open,
  quote,
  talk,
  pin,
  companion,
}: {
  target: EntityTarget;
  open(t: EntityTarget): void;
  quote: FieldFocus['quote'];
  talk(): void;
  pin?(): void;
  companion?: boolean;
}) {
  const [cursors, page] = useState<number[]>([]);
  const threads = useDataQuery<{ rows: { id: string; title: string }[] }>(
    '{rows:commsThreads(limit:50){id title}}',
    {},
    { pause: !!target.scope },
  );
  const thread = target.scope || threads.data?.rows[0]?.id;
  const seq = Number(target.id);
  const before = target.id ? seq + 1 : cursors.at(-1);
  const read = useDataQuery<{ thread: { id: string; title: string } | null; rows: CommsMessage[] }>(
    'query Messages($thread:String!,$before:Int,$count:Int!){thread:commsThread(id:$thread){id title} rows:commsMessages(thread:$thread,beforeSeq:$before,limit:$count){' +
      messageFields +
      '}}',
    { thread, before, count: target.id ? 1 : 31 },
    { pause: !thread || (!!target.id && !Number.isSafeInteger(seq)) },
  );
  const rows = read.status === 'live' && read.data?.thread?.id === thread ? read.data?.rows || [] : [];
  const now = useDeadline(rows.map((r) => r.wordsKeepUntil));
  const selected = rows.find((r) => r.seq === seq);
  return (
    <FieldContext.Provider value={{ target, open, quote }}>
      <section className={'module entityModule ' + (companion ? 'near' : 'core')}>
        <h1>{target.id ? 'Message ' + target.id : 'Messages'}</h1>
        {thread && (
          <button onClick={() => open({ kind: 'conversation', id: thread })}>
            {read.data?.thread?.title || 'Open conversation'}
          </button>
        )}
        {!target.scope && threads.data && (
          <label>
            Conversation{' '}
            <select value={thread} onChange={(e) => open({ kind: 'message', scope: e.target.value })}>
              {threads.data.rows.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {read.status === 'loading' && thread ? (
          <p role="status">Loading…</p>
        ) : target.id ? (
          selected ? (
            <>
              <Facts row={{ ...retainedCommsMessage(selected, now) }} />
              <button onClick={talk}>Discuss with Art</button>
              {pin && <button onClick={pin}>Keep alongside other modules</button>}
            </>
          ) : (
            <p>Message unavailable.</p>
          )
        ) : (
          <>
            {rows.slice(-30).map((r) => (
              <p key={r.seq}>
                <button onClick={() => open({ kind: 'message', id: String(r.seq), scope: thread })}>
                  {r.sender} · {r.kind} · {new Date(r.at).toLocaleString()}
                </button>
              </p>
            ))}
            {!rows.length && <p>No messages available.</p>}
            {rows.length > 30 && (
              <button onClick={() => page([...cursors, rows[1].seq])}>Earlier messages</button>
            )}
            {cursors.length > 0 && <button onClick={() => page(cursors.slice(0, -1))}>Newer messages</button>}
          </>
        )}
      </section>
    </FieldContext.Provider>
  );
}
