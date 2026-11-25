import { entityAddress } from './entities';
import { linkedEntity } from './entity-links';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useDataQuery } from '../data/graphql';
import { memberOperation } from '../data/operation';
import { newId } from '../data/id';
export interface Place {
  id: string;
  name: string;
  agent: string;
}
export interface Details {
  views: string[];
  focus: string;
  reason: string;
  origin: string;
  event: number;
  question?: string;
}
export interface Visit {
  place: string;
  serial: number;
  chat?: boolean;
  focus?: string;
}
export function kept(key: string) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}
export function keep(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Available in this session. */
  }
}
const InlineQuestion = lazy(async () => ({
  default: (await import('../pieces/comms/inline-question')).InlineQuestion,
}));
const prefix = 'Context · ';
type Row = { id: string; title: string; agent: string; member: string };
const directory =
  'query ContextRing($member:String!,$offset:Int!){rows:commsThreads(member:$member,limit:50,offset:$offset){id member agent title}}';
function Directory({
  member,
  offset,
  onPage,
}: {
  member: string;
  offset: number;
  onPage: (offset: number, rows: Row[]) => void;
}) {
  const feed = useDataQuery<{ rows: Row[] }>(directory, { member, offset });
  useEffect(() => {
    onPage(offset, feed.status === 'live' ? feed.data?.rows || [] : []);
  }, [feed.status, feed.data, offset, onPage]);
  return feed.status === 'live' && feed.data?.rows.length === 50 ? (
    <Directory member={member} offset={offset + 50} onPage={onPage} />
  ) : null;
}
export function Ring({
  member,
  agent,
  project,
  children,
}: {
  member: string;
  agent: string | null;
  project: string;
  children: (
    p: Place,
    active: boolean,
    visit: Visit | null,
    report: (id: string, d: Details) => void,
  ) => ReactNode;
}) {
  const [pages, setPages] = useState<Record<number, Row[]>>({});
  const onPage = useCallback(
    (offset: number, rows: Row[]) =>
      setPages((prev) => {
        const next = { ...prev, [offset]: rows };
        if (rows.length < 50) for (const k of Object.keys(next)) if (+k > offset) delete next[+k];
        return next;
      }),
    [],
  );
  const places: Place[] = [
    { id: 'loom', name: project, agent: agent || '' },
    ...Object.values(pages)
      .flat()
      .filter((r) => r.member === member && r.id.startsWith('th:ctx-'))
      .map((r) => ({
        id: r.id,
        name: r.title.startsWith(prefix) ? r.title.slice(prefix.length) : r.title,
        agent: r.agent,
      })),
  ];
  const address = () => new URL(location.href).searchParams.get('ctx') || 'loom';
  const [selected, select] = useState(address),
    [preview, peek] = useState(false),
    [adding, add] = useState(false),
    [name, setName] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<Record<string, Details>>({}),
    [visit, setVisit] = useState<Visit | null>(null);
  const pending = useRef<{ name: string; id: string } | null>(null),
    locked = useRef(false);
  const report = useCallback(
    (id: string, d: Details) =>
      setDetails((old) => (JSON.stringify(old[id]) === JSON.stringify(d) ? old : { ...old, [id]: d })),
    [],
  );
  const [quick, setQuick] = useState('');
  const [dismissed, dismiss] = useState<Record<string, string>>({});
  const notice = places.find(
    (p) =>
      p.id !== selected &&
      details[p.id]?.reason &&
      dismissed[p.id] !== (details[p.id].question || details[p.id].reason + details[p.id].event),
  );
  function choose(p: Place, chat = false, origin?: string) {
    const url = new URL(location.href);
    if (p.id === 'loom') url.searchParams.delete('ctx');
    else url.searchParams.set('ctx', p.id);
    const focus =
      origin ||
      details[p.id]?.focus ||
      kept('context-focus:' + member + ':' + p.id) ||
      (p.id === 'loom' ? 'decision' : 'context');
    url.hash = focus;
    history.pushState(null, '', url);
    select(p.id);
    setVisit({ place: p.id, serial: Date.now(), chat, focus });
    peek(false);
    add(false);
  }
  useEffect(() => {
    const back = () => {
      select(address());
      setVisit({ place: address(), serial: Date.now(), focus: location.hash.slice(1) });
      peek(false);
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  async function create() {
    const title = name.trim();
    if (!title || !agent || locked.current) return;
    if (places.some((p) => p.name.toLowerCase() === title.toLowerCase())) {
      setError('A context already has that name.');
      return;
    }
    locked.current = true;
    setBusy(true);
    setError('');
    if (pending.current?.name !== title) pending.current = { name: title, id: 'th:ctx-' + newId() };
    try {
      await memberOperation(
        'comms.open',
        { agent, thread: pending.current.id, title: prefix + title },
        pending.current.id.slice(7),
      );
      pending.current = null;
      setName('');
      add(false);
    } catch {
      setError('Could not confirm creation. Retry with the same name.');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Directory member={member} offset={0} onPage={onPage} />
      <div
        className="contextChrome"
        onMouseLeave={() => peek(false)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) peek(false);
        }}
      >
        <header>
          <nav
            aria-label="Contexts"
            onKeyDown={(e) => {
              if (e.key === 'Escape') peek(false);
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const p =
                  places[
                    (places.findIndex((p) => p.id === selected) +
                      (e.key === 'ArrowRight' ? 1 : places.length - 1)) %
                      places.length
                  ];
                choose(p);
                document.getElementById('tab-' + p.id)?.focus();
              }
            }}
          >
            {places.map((p) => (
              <button
                key={p.id}
                id={'tab-' + p.id}
                aria-current={p.id === selected ? 'page' : undefined}
                onMouseEnter={() => peek(true)}
                onFocus={() => peek(true)}
                onClick={() => (p.id === selected ? peek(true) : choose(p))}
              >
                {p.name}
                {details[p.id]?.reason && <i className="attentionDot" aria-label={details[p.id].reason} />}
              </button>
            ))}
          </nav>
          <button
            className="plus"
            aria-label="New context"
            disabled={!agent}
            onClick={() => {
              peek(false);
              add(true);
            }}
          >
            +
          </button>
          <button
            className="ringChat"
            onClick={() => {
              peek(false);
              setVisit({ place: selected, serial: Date.now(), chat: true });
            }}
          >
            Chat
          </button>
        </header>
        {preview && !adding && (
          <div className="contextPreviews">
            {places.map((p) => (
              <button key={p.id} onClick={() => choose(p)}>
                <div className="miniSpace" aria-hidden="true">
                  <i />
                  {(details[p.id]?.views || []).map((v) => (
                    <i key={v} />
                  ))}
                </div>
                <strong>{p.name}</strong>
                <span>{details[p.id]?.views.join(' · ') || 'Conversation'}</span>
                {details[p.id]?.reason && <small>{details[p.id].reason}</small>}
              </button>
            ))}
          </div>
        )}
        {adding && (
          <form
            className="newContext"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label>
              New context
              <input maxLength={48} value={name} autoFocus onChange={(e) => setName(e.target.value)} />
            </label>
            <button disabled={busy || !name.trim()}>Create context</button>
            <button type="button" onClick={() => add(false)}>
              Cancel
            </button>
            {error && <p role="alert">{error}</p>}
          </form>
        )}
      </div>
      {notice && (
        <div role="status" className="crossDing">
          <strong>{notice.name}</strong> · {details[notice.id].reason}{' '}
          <button onClick={() => choose(notice, true, details[notice.id].origin)}>Show me</button>
          {details[notice.id].question && (
            <button onClick={() => setQuick(details[notice.id].question!)}>Answer here</button>
          )}
          {quick && quick === details[notice.id].question && (
            <Suspense fallback="Opening question…">
              <InlineQuestion
                id={quick}
                go={(path) => {
                  const target = linkedEntity(path);
                  if (target) choose(notice, false, entityAddress(target));
                }}
                contextWorkspace
                writable
                readVisible
              />
            </Suspense>
          )}
          <button
            aria-label="Dismiss notification"
            onClick={() =>
              dismiss({
                ...dismissed,
                [notice.id]:
                  details[notice.id].question || details[notice.id].reason + details[notice.id].event,
              })
            }
          >
            ×
          </button>
        </div>
      )}
      {places.map((p) => (
        <div key={p.id} hidden={p.id !== selected}>
          {children(p, p.id === selected, visit?.place === p.id ? visit : null, report)}
        </div>
      ))}
      {!places.some((p) => p.id === selected) && (
        <p role="status">
          Context unavailable. <button onClick={() => choose(places[0])}>Return to Loom</button>
        </p>
      )}
    </>
  );
}
