import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';
import './doing.css';

/** What an agent is doing now, as the server says it (src/runtime/job-summary.ts, `doing`): the parts of a
 * phrase, each already limited to what this viewer may read. The words are put together here and nowhere else. */
export type DoingKind = 'terminal' | 'discord' | 'slack' | 'loom' | 'handoff' | 'trigger' | 'wake' | 'task' | 'job' | 'private';
export interface DoingItem {
  id: string; kind: DoingKind | string; title: string | null; with: string | null; place: string | null;
  direct: 'person' | 'group' | string | null; ref: string | null; machine: string | null; since: string; state: string; href: string | null;
}
const fields = 'more items { id kind title with place direct ref machine since state href }';
export const doingQuery = `query DeskDoing($agent: String!) { agentDoing(agent: $agent) { ${fields} } }`;
/** Everything, for the agent's own page. */
export const doingAllQuery = `query DeskDoingAll($agent: String!) { agentDoing(agent: $agent, limit: 100) { ${fields} } }`;
type Data = { agentDoing: { items: DoingItem[]; more: number } | null };
export interface DoingReading { status: DataQuerySnapshot<unknown>['status']; items: DoingItem[]; more: number }

export function doingReading(query: DataQuerySnapshot<Data>): DoingReading {
  const none = (status: DoingReading['status']): DoingReading => ({ status, items: [], more: 0 });
  if (query.status !== 'live') return none(query.status);
  const doing = query.data?.agentDoing;
  if (!query.data) return none('loading');
  if (!doing || !Array.isArray(doing.items) || !Number.isSafeInteger(doing.more) || doing.more < 0
    || doing.items.some(item => typeof item?.id !== 'string' || typeof item.kind !== 'string' || typeof item.since !== 'string')) return none('offline');
  return { status: 'live', items: doing.items, more: doing.more };
}
/** One request for one agent's card. `all` asks for the whole list, for the agent's own page. */
export function useDoing(agent: string, all = false): DoingReading {
  const query = useDataQuery<Data>(all ? doingAllQuery : doingQuery, { agent });
  return useMemo(() => doingReading(query), [query]);
}
/** A card that says what its agent is doing in more than one place (its state word, its list) reads once, here. */
export function WithDoing({ agent, onChange, children }: { agent: string; onChange?(): void; children(doing: DoingReading): ReactNode }) {
  const doing = useDoing(agent), previous = useRef(doing);
  useLayoutEffect(() => { if (previous.current !== doing) { previous.current = doing; onChange?.(); } }, [doing, onChange]);
  return <>{children(doing)}</>;
}

const venues: Record<string, string> = { discord: 'Discord', slack: 'Slack' };
const fallbackName = (id: string) => id ? id[0].toUpperCase() + id.slice(1) : id;
/** The sentence for one thing, from its parts. `name` gives a display name for a member's or an agent's id. */
export function doingPhrase(item: DoingItem, name: (id: string) => string = fallbackName): string {
  const who = item.with ? name(item.with) : '';
  switch (item.kind) {
    case 'terminal': return item.title ? `At a terminal on ${item.title}` : 'At a terminal';
    case 'discord': case 'slack': {
      const on = `Talking on ${venues[item.kind]}`;
      return who ? `${on} with ${who}` : item.direct === 'group' ? `${on} in a group direct message`
        : item.direct ? `${on} in a direct message` : item.place ? `${on} in ${item.place}` : `${on} in a channel`;
    }
    case 'loom': return who ? `Talking with ${who} in loom` : 'Talking in loom';
    case 'handoff': return [who ? `Taking a hand-off from ${who}` : 'Taking a hand-off', item.title].filter(Boolean).join(' · ');
    case 'trigger': return item.title ? `Running ${item.title}` : 'Running a trigger';
    case 'wake': return item.title ? `On a wake · ${item.title}` : 'On a wake';
    case 'task': return [`Working on ${item.title || 'a task'}`, item.ref].filter(Boolean).join(' · ');
    case 'private': return 'In a private conversation';
    default: return item.title || 'Running a job';
  }
}
/** A two-letter mark per kind: drawn in mono, so every look has it and it reads at a pill's size. */
const marks: Record<string, string> = { terminal: '>_', discord: 'DC', slack: 'SL', loom: 'LM', handoff: 'HO', trigger: 'TP', wake: 'WK', task: 'TK', job: 'JB', private: '··' };
const clock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' });
/** "2:15 PM" today, "Nov 18, 2:15 PM" before. */
export function sinceWord(since: string, now = Date.now()): string {
  const at = new Date(since);
  if (!Number.isFinite(at.getTime())) return '';
  const time = clock.format(at).replace(/ /g, ' ');
  return day.format(at) === day.format(new Date(now)) ? time : `${day.format(at)}, ${time}`;
}
/** The quiet line: the state when it is not simply running, where it runs, and since when. */
export function doingMeta(item: DoingItem, now = Date.now()): string {
  const since = sinceWord(item.since, now);
  return [item.state === 'queued' ? 'Queued' : item.state === 'starting' ? 'Starting' : '', item.machine ? `on ${item.machine}` : '', since ? `since ${since}` : ''].filter(Boolean).join(' · ');
}

/** The lead of an agent's card: one pill per thing it is doing, each opening what it names. Compact (the rail,
 * a folded card) leaves the quiet line to the pill's title. */
export function Doing({ doing, name, names, go, compact = false }: {
  doing: DoingReading; name: string; names?: ReadonlyMap<string, string>; go(path: string): void; compact?: boolean;
}) {
  const named = (id: string) => names?.get(id) ?? fallbackName(id);
  if (doing.status !== 'live') return <p className="desk-doing-quiet" role="status">{doing.status === 'loading' ? 'Checking…' : 'Can’t tell what it is doing right now.'}</p>;
  if (!doing.items.length) return <p className="desk-doing-quiet">Nothing right now.</p>;
  return <ul className="desk-doing" data-compact={compact || undefined} aria-label={`What ${name} is doing`}>
    {doing.items.map(item => {
      const phrase = doingPhrase(item, named), meta = doingMeta(item);
      const inside = <><span className="desk-doing-mark" aria-hidden="true">{marks[item.kind] ?? marks.job}</span>
        <span className="desk-doing-words"><span className="desk-doing-phrase">{phrase}</span>{!compact && meta && <span className="desk-doing-meta">{meta}</span>}</span></>;
      const href = item.href;
      return <li key={`${item.kind}:${item.id}`} data-kind={item.kind}>{href
        ? <a className="desk-doing-pill" href={href} title={compact ? meta : undefined} onClick={event => {
          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); go(href);
        }}>{inside}</a>
        : <span className="desk-doing-pill" title={compact ? meta : undefined}>{inside}</span>}</li>;
    })}
    {doing.more > 0 && <li className="desk-doing-more">+{doing.more} more</li>}
  </ul>;
}
