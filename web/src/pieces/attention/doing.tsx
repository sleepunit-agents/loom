import { briefTime } from '../../kit/time';
import { useHouseholdZone } from '../../data/zone';
import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';
import './doing.css';

/** What an agent is doing now, as the server says it (src/runtime/job-summary.ts, `doing`): the parts of a
 * phrase, each already limited to what this viewer may read. The words are put together here and nowhere else. */
export type DoingKind = 'terminal' | 'discord' | 'slack' | 'loom' | 'handoff' | 'trigger' | 'wake' | 'task' | 'job' | 'private';
export interface DoingItem {
  id: string; kind: DoingKind | string; title: string | null; with: string | null; place: string | null;
  direct: 'person' | 'group' | string | null; ref: string | null; machine: string | null; since: string; state: string; href: string | null;
  /** The task a job's conversation was filed for (its id is `ref`), and when an unended job was last heard from if that is too long ago. */
  task?: string | null; quietSince?: string | null;
}
const fields = 'more claimed items { id kind title with place direct ref task quietSince machine since state href }';
export const doingQuery = `query DeskDoing($agent: String!) { agentDoing(agent: $agent) { ${fields} } }`;
/** Everything, for the agent's own page. */
export const doingAllQuery = `query DeskDoingAll($agent: String!) { agentDoing(agent: $agent, limit: 100) { ${fields} } }`;
type Data = { agentDoing: { items: DoingItem[]; more: number; claimed?: number } | null };
/** `more`: pills the cap cut. `claimed`: tasks the agent has in progress that are no pill (claimed, and not touched lately). */
export interface DoingReading { status: DataQuerySnapshot<unknown>['status']; items: DoingItem[]; more: number; claimed: number }

export function doingReading(query: DataQuerySnapshot<Data>): DoingReading {
  const none = (status: DoingReading['status']): DoingReading => ({ status, items: [], more: 0, claimed: 0 });
  if (query.status !== 'live') return none(query.status);
  const doing = query.data?.agentDoing;
  if (!query.data) return none('loading');
  if (!doing || !Array.isArray(doing.items) || !Number.isSafeInteger(doing.more) || doing.more < 0
    || doing.items.some(item => typeof item?.id !== 'string' || typeof item.kind !== 'string' || typeof item.since !== 'string')) return none('offline');
  return { status: 'live', items: doing.items, more: doing.more, claimed: Number.isSafeInteger(doing.claimed) && doing.claimed! > 0 ? doing.claimed! : 0 };
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
    // The machine by its name where this viewer may read it, then the harness and folder: never a stored label.
    case 'terminal': return [`At a terminal${item.machine ? ` on ${item.machine}` : ''}`, item.title].filter(Boolean).join(' · ');
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
/** The quiet line: a state that is not simply running, the task a job is about, where it runs, and since when.
 * A task says when it was last touched; a job nothing has been heard from says so instead of "since". */
export function doingMeta(item: DoingItem, zone?: string, now = Date.now()): string {
  const since = briefTime(item.since, zone, now), quiet = item.quietSince ? briefTime(item.quietSince, zone, now) : '';
  return [item.state === 'queued' ? 'Queued' : item.state === 'starting' ? 'Starting' : '',
    item.kind !== 'task' && item.ref ? [item.ref, item.task].filter(Boolean).join(' · ') : '',
    item.machine && item.kind !== 'terminal' ? `on ${item.machine}` : '',
    quiet ? `no word since ${quiet}` : !since ? '' : item.kind === 'task' ? `touched ${since}` : `since ${since}`].filter(Boolean).join(' · ');
}
/** The Tasks app on one agent's tasks in progress. */
export const claimedPath = (agent: string) => `/p/work/backlog?folder=progress&assignee=${encodeURIComponent(agent)}`;

/** The lead of an agent's card: one pill per thing it is doing, each opening what it names. Compact (the rail,
 * a folded card) leaves the quiet line to the pill's title. */
export function Doing({ doing, name, agent, names, go, compact = false, label }: {
  doing: DoingReading; name: string; /** The agent's id: with it, the tasks it has only claimed are one quiet line under the pills (never on a compact card). */ agent?: string; names?: ReadonlyMap<string, string>; go(path: string): void; compact?: boolean; label?: string;
}) {
  const zone = useHouseholdZone();
  const named = (id: string) => names?.get(id) ?? fallbackName(id);
  if (doing.status !== 'live') return <p className="desk-doing-quiet" role="status">{doing.status === 'loading' ? 'Checking…' : 'Can’t tell what it is doing right now.'}</p>;
  const opens = (href: string) => (event: { button?: number; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; preventDefault(): void }) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); go(href);
  };
  const claimed = !compact && agent && doing.claimed > 0 ? <a className="desk-doing-claimed" href={claimedPath(agent)} onClick={opens(claimedPath(agent))}>
    {doing.claimed} {doing.claimed === 1 ? 'task' : 'tasks'} in progress ›</a> : null;
  if (!doing.items.length) return <><p className="desk-doing-quiet">Nothing right now.</p>{claimed}</>;
  return <><ul className="desk-doing" data-compact={compact || undefined} aria-label={label ?? `What ${name} is doing`}>
    {doing.items.map(item => {
      const phrase = doingPhrase(item, named), meta = doingMeta(item, zone);
      const inside = <><span className="desk-doing-mark" aria-hidden="true">{marks[item.kind] ?? marks.job}</span>
        <span className="desk-doing-words"><span className="desk-doing-phrase">{phrase}</span>{!compact && meta && <span className="desk-doing-meta">{meta}</span>}</span></>;
      const href = item.href;
      return <li key={`${item.kind}:${item.id}`} data-kind={item.kind} data-quiet={item.quietSince ? '' : undefined}>{href
        ? <a className="desk-doing-pill" href={href} title={compact ? meta : undefined} onClick={opens(href)}>{inside}</a>
        : <span className="desk-doing-pill" title={compact ? meta : undefined}>{inside}</span>}</li>;
    })}
    {doing.more > 0 && <li className="desk-doing-more">+{doing.more} more</li>}
  </ul>{claimed}</>;
}
