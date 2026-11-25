import { useState, useSyncExternalStore } from 'react';
import { call, useRecords, type Call, type LiveRecord } from '../data';
import type { EntityTarget } from './entities';
import { Facts, FieldContext, type FieldFocus } from './entity-facts';
interface Effect extends LiveRecord {
  title: string;
  kind: string;
  state: string;
}
function Receipt({ request }: { request: Call }) {
  const result = useSyncExternalStore(request.subscribe, request.getSnapshot);
  return (
    <p role="status">
      {result.pending
        ? 'Releasing…'
        : result.result?.ok
          ? 'Released'
          : result.result?.message || 'Release unavailable.'}
    </p>
  );
}
export function Effects({
  target,
  open,
  talk,
  quote,
}: {
  target: EntityTarget;
  open(t: EntityTarget): void;
  talk(): void;
  quote: FieldFocus['quote'];
}) {
  const feed = useRecords<Effect>('core.effect');
  const [request, setRequest] = useState<Call>();
  const selected = feed.status === 'live' ? feed.records.find((r) => r.id === target.id) : undefined;
  return (
    <FieldContext.Provider value={{ target, open, quote }}>
      <section className="module core entityModule">
        <h1>Held outside work</h1>
        {feed.status !== 'live' ? (
          <p role="status">{feed.status === 'loading' ? 'Loading…' : 'Held work unavailable.'}</p>
        ) : target.id ? (
          selected ? (
            <>
              <Facts
                row={{ id: selected.id, title: selected.title, kind: selected.kind, state: selected.state }}
              />
              <button onClick={talk}>Discuss with Art</button>
              {selected.state === 'due' && (
                <button onClick={() => setRequest(call('core.releaseEffect', { id: selected.id }))}>
                  Release this item
                </button>
              )}
              {request && <Receipt request={request} />}
            </>
          ) : (
            <p>Record unavailable.</p>
          )
        ) : (
          <ul>
            {feed.records.map((row) => (
              <li key={row.id}>
                <button onClick={() => open({ kind: 'effect', id: row.id })}>{row.title}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </FieldContext.Provider>
  );
}
