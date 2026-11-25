import { useLayoutEffect, useState } from 'react';
import { useDataQuery } from '../data/graphql';
import {
  entities,
  entityGroups,
  entityKey,
  tableWhere,
  type EntityKind,
  type EntityTarget,
} from './entities';

import { useDeadline } from '../pieces/comms/use-deadline';
import { recordQuote } from './record-quote';
import { Facts, FieldContext } from './entity-facts';
import { Effects } from './effects';
import { Messages } from './messages';
import { NewConversation } from './new-conversation';
import { MachineAccess } from './machine-access';
import { Related } from './related';
import { RichDetail, hasDetail } from './entity-detail';
type Row = Record<string, unknown>;
const pageSize = 30;
type ModuleProps = {
  companion?: boolean;
  pin?(): void;
  quote(words: string): void;
  target: EntityTarget;
  open(t: EntityTarget): void;
  talk(): void;
};
export function EntityModule(props: ModuleProps) {
  if (props.target.kind === 'effect')
    return (
      <>
        <TypePicker {...props} />
        <Effects {...props} />
      </>
    );
  return props.target.kind === 'message' ? (
    <>
      <TypePicker {...props} />
      <Messages {...props} />
    </>
  ) : (
    <Collection {...props} />
  );
}
function TypePicker({ target, open, companion }: ModuleProps) {
  if (companion) return null;
  return (
    <label>
      Show{' '}
      <select
        aria-label="Entity type"
        value={target.kind}
        onChange={(e) => open({ kind: e.target.value as EntityKind })}
      >
        {Object.entries(entityGroups).map(([group, kinds]) => (
          <optgroup key={group} label={group}>
            {kinds
              .filter(
                (k) =>
                  k !== 'effect' || document.documentElement.dataset.staging === 'true' || target.kind === k,
              )
              .map((k) => (
                <option key={k} value={k}>
                  {entities[k].label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
function Collection(props: ModuleProps) {
  const { target, open, talk, quote, pin, companion } = props;
  const spec = entities[target.kind];
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const usesAgent = target.kind === 'job' || target.kind === 'machineJob' || target.kind === 'post';
  const [range, setRange] = useState(() =>
    target.kind === 'usage' && /^\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}$/.test(target.scope || '')
      ? { from: target.scope!.split('~')[0], to: target.scope!.split('~')[1] }
      : {
          from: new Date(Date.now() - 86400000 * 7).toISOString().slice(0, 10),
          to: new Date().toISOString().slice(0, 10),
        },
  );
  const [archived, setArchived] = useState(false);
  const roster = useDataQuery<{ agents: { id: string }[] }>('{agents{id}}', {}, { pause: !usesAgent });
  const [selectedAgent, selectAgent] = useState('');
  const agent = selectedAgent || target.scope || roster.data?.agents?.[0]?.id;
  const paged = !!spec.table || target.kind === 'conversation' || target.kind === 'question';
  const thread = target.kind === 'conversation';
  const inbox = target.kind === 'question';
  const [activityDay, setActivityDay] = useState(
    target.kind === 'activity' ? target.scope || 'recent' : 'recent',
  );
  const [postCursors, setPostCursors] = useState<string[]>([]);
  const dates = useDataQuery<{ memoryActivityAccess: { windows: string[] } | null }>(
    '{memoryActivityAccess{windows}}',
    {},
    { pause: target.kind !== 'activity' || !!target.id },
  );
  const validRange =
    Number.isFinite(Date.parse(range.from)) &&
    Number.isFinite(Date.parse(range.to)) &&
    range.from <= range.to;
  let query = spec.query;
  let vars: Record<string, unknown> = {};
  if (spec.table) {
    vars = {
      where: tableWhere(spec, target.id, search),
      offset: target.id ? 0 : page * pageSize,
      limit: target.id ? 1 : pageSize + 1,
    };
  } else if (thread || inbox) {
    if (target.id) {
      query = thread
        ? 'query ById($id:String!){rows:commsThread(id:$id){id title agent member project pinned archivedAt working}}'
        : 'query ById($id:String!){rows:inboxItem(id:$id){id source sourceId state agent}}';
      vars = { id: target.id };
    } else {
      query = thread
        ? 'query Threads($offset:Int!,$search:String!,$archived:Boolean!){rows:commsThreads(offset:$offset,limit:31,search:$search,archived:$archived){id title agent working}}'
        : 'query Inbox($offset:Int!,$search:String!){rows:inboxItems(folder:"all",offset:$offset,limit:31,search:$search){id source sourceId state agent}}';
      vars = { offset: page * pageSize, search, ...(thread ? { archived } : {}) };
    }
  } else if (target.kind === 'post') {
    query =
      'query Posts($agent:String!,$id:String,$before:String!){rows:agentActivityFeed(agent:$agent,thread:$id,before:$before,limit:31){thread title latest{id at words}}}';
    vars = { agent, id: target.id, before: postCursors.at(-1) || '0' };
  } else if (target.kind === 'job' && target.id) {
    query =
      'query Job($agent:String!,$id:String!){rows:jobHistory(agent:$agent,id:$id){id agent title brief state box model queuedAt claimedAt endedAt}}';
    vars = { agent, id: target.id };
  } else if (usesAgent) vars = { agent };
  else if (target.kind === 'activity') {
    query =
      'query Activity($to:String!){rows:memoryActivity(to:$to){entries{id agent title line at venue where what expires}}}';
    vars = { to: activityDay };
  } else if (target.kind === 'usage' && validRange) {
    vars = {
      from: new Date(range.from).toISOString(),
      to: new Date(Date.parse(range.to) + 86400000).toISOString(),
    };
  }
  const read = useDataQuery<Row>(query, vars, {
    pause: (usesAgent && !agent) || (target.kind === 'usage' && !validRange),
  });
  const path = target.kind === 'device' ? ['rows', 'notifications', 'devices'] : spec.path;
  const data = path.reduce<unknown>((r, k) => (r && typeof r === 'object' ? (r as Row)[k] : null), read.data);
  const singleton = target.kind === 'account' || target.kind === 'household';
  let rows =
    (((thread || inbox) && target.id) || singleton) && data
      ? [data as Row]
      : Array.isArray(data)
        ? (data as Row[])
        : [];
  if (target.kind === 'memory') {
    const memoryRows = new Map<string, Row>();
    for (const project of rows)
      for (const section of project.sections as { key: string; items: { ref: string; title: string }[] }[]) {
        if (section.key === 'memories')
          for (const item of section.items) {
            const id = project.agent + ':' + item.ref;
            memoryRows.set(id, { id, title: item.title });
          }
      }
    rows = [...memoryRows.values()];
  }
  const expiry = (r: Row) => (typeof r.expires === 'number' ? r.expires : Infinity);
  const now = useDeadline(
    target.kind === 'activity'
      ? rows.map((r) => (Number.isFinite(expiry(r)) ? new Date(expiry(r)).toISOString() : null))
      : [],
  );
  if (target.kind === 'activity') rows = rows.filter((r) => expiry(r) > now);
  const id = (r: Row) => entityKey(spec, r);
  const title = (r: Row) => String(spec.title.map((k) => r[k]).find((v) => v != null && v !== '') ?? id(r));
  const selected = target.id ? rows.find((r) => id(r) === target.id) : undefined;
  const lookup = Boolean(
    target.id && !selected && read.status === 'live' && spec.table && spec.searchFields?.length,
  );
  const alternatives = useDataQuery<{ rows: Row[] }>(
    spec.query,
    { where: tableWhere(spec, undefined, target.id || ''), offset: 0, limit: 10 },
    { pause: !lookup },
  );
  const suggestions =
    target.id && !selected
      ? spec.table
        ? alternatives.data?.rows || []
        : rows.filter((r) => title(r).toLowerCase().includes(target.id!.toLowerCase())).slice(0, 10)
      : [];
  const excerpt =
    selected && !target.part && ['conversation', 'question', 'approval'].includes(target.kind)
      ? recordQuote(selected)
      : '';
  useLayoutEffect(() => {
    if (!excerpt) return;
    quote(excerpt);
    return () => quote('');
  }, [excerpt, quote]);
  const matches = paged
    ? rows
    : rows.filter((r) => (title(r) + ' ' + id(r)).toLowerCase().includes(search.toLowerCase()));
  const offset = paged || target.kind === 'post' ? 0 : page * pageSize;
  return (
    <FieldContext.Provider value={{ target, open, quote }}>
      <section className={'module entityModule ' + (companion ? 'near' : 'core')}>
        <TypePicker {...props} />
        {usesAgent && roster.data && (
          <label>
            Agent{' '}
            <select
              value={agent || ''}
              onChange={(e) => {
                selectAgent(e.target.value);
                setPage(0);
              }}
            >
              {roster.data.agents.map((a) => (
                <option key={a.id}>{a.id}</option>
              ))}
            </select>
          </label>
        )}
        {target.kind === 'activity' && !target.id && dates.data?.memoryActivityAccess && (
          <label>
            Activity through{' '}
            <select
              value={activityDay}
              onChange={(e) => {
                setActivityDay(e.target.value);
                setPage(0);
              }}
            >
              <option value="recent">Most recent</option>
              {dates.data.memoryActivityAccess.windows.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </label>
        )}
        {thread && !target.id && <NewConversation open={(id) => open({ kind: 'conversation', id })} />}
        {thread && !target.id && (
          <label>
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => {
                setArchived(e.target.checked);
                setPage(0);
              }}
            />
            Archived conversations
          </label>
        )}
        {target.kind === 'usage' && (
          <div>
            <label>
              From{' '}
              <input
                type="date"
                value={range.from}
                onChange={(e) => setRange({ ...range, from: e.target.value })}
              />
            </label>
            <label>
              Through{' '}
              <input
                type="date"
                value={range.to}
                onChange={(e) => setRange({ ...range, to: e.target.value })}
              />
            </label>
          </div>
        )}
        {!target.id && (!spec.table || (spec.searchFields?.length ?? 0) > 0) && (
          <input
            aria-label={'Find ' + spec.label.toLowerCase()}
            placeholder="Find a record…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        )}
        {read.status !== 'live' || (!target.id && !Array.isArray(data) && (!singleton || !data)) ? (
          <p role="status">
            {target.kind === 'usage' && !validRange
              ? 'Choose a valid date range.'
              : usesAgent && roster.status === 'live' && !agent
                ? 'No agent available.'
                : read.status === 'loading'
                  ? 'Loading…'
                  : 'These records are unavailable.'}
          </p>
        ) : target.id ? (
          <>
            {!companion && (
              <button onClick={() => open({ kind: target.kind })}>All {spec.label.toLowerCase()}</button>
            )}
            {suggestions.length > 0 ? (
              <>
                <h2>Choose a matching record</h2>
                {suggestions.map((r) => (
                  <button key={id(r)} onClick={() => open({ ...target, id: id(r) })}>
                    {title(r)} · {id(r)}
                  </button>
                ))}
              </>
            ) : selected || hasDetail(target.kind) ? (
              <>
                <h1>{selected ? title(selected) : target.id}</h1>
                {target.part && (
                  <button onClick={() => open({ ...target, part: undefined })}>Back to record</button>
                )}
                <div className="entityActions">
                  <button onClick={talk}>Discuss with Art</button>
                  {pin && <button onClick={pin}>Keep alongside other modules</button>}
                </div>
                {hasDetail(target.kind) ? (
                  <RichDetail target={{ ...target, id: target.id }} />
                ) : (
                  <Facts row={selected!} />
                )}
                <Related target={target} />
                {target.kind === 'box' && selected && <MachineAccess target={target} row={selected} />}
              </>
            ) : (
              <p>Record unavailable.</p>
            )}
          </>
        ) : (
          <>
            <h1>{spec.label}</h1>
            <ul>
              {matches.slice(offset, offset + pageSize).map((r) => (
                <li key={id(r)}>
                  <button
                    onClick={() =>
                      open({
                        kind: target.kind,
                        id: id(r),
                        scope: usesAgent
                          ? agent
                          : target.kind === 'usage'
                            ? range.from + '~' + range.to
                            : undefined,
                      })
                    }
                  >
                    {title(r)}
                  </button>
                </li>
              ))}
            </ul>
            {!matches.length && <p>No matching records.</p>}
            <div>
              {target.kind === 'post' && postCursors.length > 0 && (
                <button onClick={() => setPostCursors(postCursors.slice(0, -1))}>Newer activities</button>
              )}
              {page > 0 && <button onClick={() => setPage(page - 1)}>Previous</button>}
              {matches.length > offset + pageSize && (
                <button
                  onClick={() =>
                    target.kind === 'post'
                      ? setPostCursors([...postCursors, String((rows[pageSize - 1].latest as Row).id)])
                      : setPage(page + 1)
                  }
                >
                  Next
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </FieldContext.Provider>
  );
}
