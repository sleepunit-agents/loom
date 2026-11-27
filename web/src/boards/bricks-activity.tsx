/** The `activity` brick: the household timeline the desktop's Activity app shows, read with its selections
 * (memory/queries.ts): what the member may see and the household's day and time zone (memoryActivityAccess), the
 * three-day windows Activity reads (memoryActivity), and, big, one opened entry (memoryActivityEntry). A row names
 * its agent as a chip and any ticket its words name; an opened entry names its tickets and pull requests as chips.
 * It changes nothing. Which entry is open is state of the drawn brick, and so are Activity's filters (who, where,
 * what: its own groups and its own rule, `passes`), which the big form has as buttons and no parameter holds. */
import { useState } from 'react';
import { memoryQueries } from '../memory/queries';
import { useMemoryQuery } from '../memory/query';
import { Reply } from '../pair/reply';
import { VENUES, passes, safeHref, type ActivityEntry, type ActivityLink, type Filters } from '../pieces/activity/model';
import { Action, Actions, Chip, Fact, Facts, Lead, Loading, Note, Row, Rows, Section, Unavailable, ticketChip, type Params } from './brick-kit';
import type { Form } from './layout';

/** How many of Activity's three-day windows hold a range of days. */
export const windowsFor = (days: number) => (days <= 3 ? 1 : days <= 9 ? 3 : 10);
const agentId = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,119}$/;
const agentChip = (agent: string) => agentId.test(agent) ? <Chip place={{ brick: 'agent', params: { agent } }}>{agent}</Chip> : <span>{agent}</span>;
const ticketsIn = (text: string) => [...new Set(text.match(/\bt-[1-9]\d*\b/g) ?? [])];
/** The ticket a link Activity made leads to (src/task-route.ts), or nothing. */
const ticketOf = (link: ActivityLink) => /\/task\/(t-[1-9]\d*)$/.exec(link.href ?? '')?.[1] ?? (/^t-[1-9]\d*$/.test(link.label) ? link.label : undefined);
/** The change a pull request's link names, as loom writes a change's id (github:owner/repo#number), or nothing. */
export function changeOf(link: ActivityLink): string | undefined {
  const href = link.href ?? '';
  const hub = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:[/?#]|$)/.exec(href);
  let id = hub ? `github:${hub[1]}/${hub[2]}#${hub[3]}`.toLowerCase() : undefined;
  if (!id && href.startsWith('/p/work/changes/change/')) try { id = decodeURIComponent(href.slice('/p/work/changes/change/'.length)); } catch { /* not an id */ }
  return id && id.length <= 120 && /^github:[a-z0-9._-]+\/[a-z0-9._-]+#[1-9]\d*$/.test(id) ? id : undefined;
}
const Link = ({ label, href }: ActivityLink) => { const safe = safeHref(href); return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{label}</a> : <span>{label}</span>; };

/** A log is read by the clock: the hour and minute in the household's zone, under the day it happened. */
const clock = (at: string, zone: string) => new Date(at).toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
/** A household day (YYYY-MM-DD) in words: "Fri, Nov 13". */
const dayWord = (day: string) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const stepWord = (state: string) => (state === 'running' ? 'running' : state === 'error' ? 'failed' : 'done');

function Opened({ id, zone }: { id: string; zone: string }) {
  const read = useMemoryQuery(memoryQueries.activityEntry(id));
  const e = read.value;
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !e) return <Note>This entry is no longer available.</Note>;
  const tickets = [...new Set(e.tasks.map(ticketOf).filter((t): t is string => !!t))];
  const otherTasks = e.tasks.filter((t) => !ticketOf(t));
  return (
    <div className="board-activity-entry" data-entry={id}>
      <Facts>
        {e.needs && <Fact wide label="Needs you">{e.needs}</Fact>}
        {e.asked.length > 0 && <Fact wide label="What was asked">{e.asked.map((s, i) => <span key={i} className="block">{s}</span>)}</Fact>}
        {e.story && <Fact wide label="What happened"><Reply words={e.story} /></Fact>}
        {e.decided.length > 0 && <Fact wide label={e.id.startsWith('e~') ? 'Shipped' : 'What was decided'}>{e.decided.map((s, i) => <span key={i} className="block">{s}</span>)}</Fact>}
        {e.tasks.length + e.prs.length > 0 && (
          <Fact wide label="Tasks and pull requests">
            <span className="board-meta">
              {tickets.map((t) => <span key={t}>{ticketChip(t)}</span>)}
              {otherTasks.map((t, i) => <Link key={'t' + i} {...t} />)}
              {e.prs.map((p, i) => { const change = changeOf(p); return change ? <Chip key={'p' + i} place={{ brick: 'pull', params: { change } }}>{p.label}</Chip> : <Link key={'p' + i} {...p} />; })}
            </span>
          </Fact>
        )}
        {!!e.steps?.length && <Fact wide label={`Steps · ${e.steps.length}`}>{e.steps.slice(-8).map((s, i) => <span key={i} className="block">{s.label} · {stepWord(s.state)}</span>)}</Fact>}
        {e.links.length > 0 && <Fact wide label="Read more"><span className="board-meta">{e.links.map((l, i) => <Link key={i} {...l} />)}</span></Fact>}
        <Fact label="When"><span className="board-note">{dayWord(e.day)}, {clock(e.at, zone)}{e.owner ? ' · with you' : ''}</span></Fact>
      </Facts>
    </div>
  );
}

const none: Filters = { who: [], where: [], what: [] };
/** Activity's three kinds of entry, in its menu's order and words. */
const kinds = [['conversation', 'Conversations'], ['system', 'System'], ['work', 'Work done']] as const;
/** The venues Activity's menu always lists; any other an entry holds is added under its own name. */
const listedVenues = ['comms', 'discord', 'slack', 'terminal', 'wakes'];

export function Activity({ params, form }: { params: Params; form: Form }) {
  const days = Number(params.days) || 1, count = windowsFor(days);
  const access = useMemoryQuery(memoryQueries.activityAccess());
  const may = access.status === 'live' ? access.value : undefined;
  const to = (i: number) => (may?.allowed && i < count && may.windows[i] ? memoryQueries.activity(may.windows[i]) : undefined);
  // Ten is the most a range needs. A window that is not needed asks nothing.
  const windows = [useMemoryQuery(to(0)), useMemoryQuery(to(1)), useMemoryQuery(to(2)), useMemoryQuery(to(3)), useMemoryQuery(to(4)),
    useMemoryQuery(to(5)), useMemoryQuery(to(6)), useMemoryQuery(to(7)), useMemoryQuery(to(8)), useMemoryQuery(to(9))].slice(0, count);
  const [open, setOpen] = useState('');
  const [filtering, setFiltering] = useState(false), [filters, setFilters] = useState<Filters>(none);
  if (access.status === 'loading') return <Loading />;
  if (access.status !== 'live' || !may?.allowed) return <Unavailable what="activity" />;
  if (windows.some((w) => w.status === 'offline' || w.status === 'denied')) return <Unavailable what="activity" />;
  const records = windows.flatMap((w) => (w.value ? [w.value] : []));
  if (!records.length && windows.some((w) => w.status === 'loading')) return <Loading />;
  const zone = may.timezone;
  const kept = new Set([...new Set(records.flatMap((w) => w.days))].sort().reverse().slice(0, days));
  // The filters are the big form's; the small forms show everything.
  const entries = [...new Map(records.flatMap((w) => w.entries).map((e) => [e.id, e])).values()].filter((e) => kept.has(e.day) && (form !== 'primary' || passes(e, filters)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));
  const all = [...new Map(records.flatMap((w) => w.entries).map((e) => [e.id, e])).values()].filter((e) => kept.has(e.day));
  const range = days === 1 ? 'today' : `in ${days} days`;
  const on = filters.who.length + filters.where.length + filters.what.length > 0;
  const total = `${on ? `${entries.length} of ${all.length}` : entries.length} ${(on ? all : entries).length === 1 ? 'entry' : 'entries'} ${range}`;
  if (form === 'compact') return <p className="board-brief">{total}{entries[0] ? ` · latest from ${entries[0].agent}: ${entries[0].title}` : ''}</p>;
  const big = form === 'primary', cap = big ? 80 : 3, shown = entries.slice(0, cap);
  const kindWord = (e: ActivityEntry) => (e.what === 'work' ? 'Work done' : e.what === 'system' ? 'System' : '');
  const row = (e: ActivityEntry) => (
    <Row key={e.id}
      title={big ? <button type="button" className="board-activity-open" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? '' : e.id)}>{e.title}</button> : e.title}
      meta={big
        ? <>{agentChip(e.agent)} <span>{e.where}{e.owner ? ' · with you' : ''}{e.line ? ' · ' + e.line : ''}</span>{ticketsIn(`${e.title} ${e.line ?? ''}`).map((t) => <span key={t}> {ticketChip(t)}</span>)}</>
        : <>{e.agent}{kindWord(e) && ' · ' + kindWord(e)} · {days === 1 ? clock(e.at, zone) : `${dayWord(e.day)}, ${clock(e.at, zone)}`}</>}
      end={big ? <>{kindWord(e) && <span>{kindWord(e)}</span>}<span className="board-time">{clock(e.at, zone)}</span></> : undefined}>
      {big && open === e.id ? <Opened id={e.id} zone={zone} /> : undefined}
    </Row>
  );
  const tally = (test: (e: ActivityEntry) => boolean) => all.filter(test).length;
  const venues: Record<string, string> = Object.fromEntries(listedVenues.map((v) => [v, VENUES[v]]));
  for (const e of all) venues[e.venue] ??= e.venue;
  const groups: { label: string; key: keyof Filters; items: { id: string; label: string; count: number }[] }[] = [
    { label: 'Who', key: 'who', items: [...may.agents.map((agent) => ({ id: agent, label: agent, count: tally((e) => e.agent === agent) })), { id: 'owner', label: may.owner ?? 'Owner', count: tally((e) => !!e.owner) }].sort((a, b) => a.label.localeCompare(b.label)) },
    { label: 'Where', key: 'where', items: Object.entries(venues).map(([id, label]) => ({ id, label, count: tally((e) => e.venue === id) })).sort((a, b) => a.label.localeCompare(b.label)) },
    { label: 'What', key: 'what', items: kinds.map(([id, label]) => ({ id, label, count: tally((e) => e.what === id) })) },
  ];
  const toggle = (key: keyof Filters, id: string) => setFilters((f) => ({ ...f, [key]: f[key].includes(id) ? f[key].filter((x) => x !== id) : [...f[key], id].sort() }));
  return (
    <>
      <Lead>{total}</Lead>
      {big && all.length > 0 && (
        <Actions>
          <button type="button" className="board-action" data-kind="quiet" aria-expanded={filtering} onClick={() => setFiltering(!filtering)}>Filter activity</button>
          {on && <Action kind="quiet" onClick={() => setFilters(none)}>Show everything</Action>}
        </Actions>
      )}
      {big && filtering && (
        <div className="board-form">
          {groups.map((g) => (
            <div key={g.key} className="board-choice" role="group" aria-label={g.label}>
              <span className="board-choice-label">{g.label}</span>
              <span className="board-seg">{g.items.map((i) => <button type="button" key={i.id} aria-pressed={filters[g.key].includes(i.id)} onClick={() => toggle(g.key, i.id)}>{i.label} · {i.count}</button>)}</span>
            </div>
          ))}
        </div>
      )}
      {big && records.some((w) => w.conversations !== 'available') && <p role="status" className="board-note">Conversations and digests {records.some((w) => w.conversations === 'error') ? 'couldn’t load' : 'are not available yet'}.</p>}
      {big && records.some((w) => w.episodes !== 'available') && <p role="status" className="board-note">Some episode stores {records.some((w) => w.episodes === 'error') ? 'couldn’t load' : 'are not available'}.</p>}
      {big && records.some((w) => w.truncated) && <p role="status" className="board-note">Showing the newest 600 entries per window.</p>}
      {big
        ? [...kept].sort().reverse().map((day) => { const rows = shown.filter((e) => e.day === day); return rows.length ? <Section key={day} title={dayWord(day)} count={rows.length}><Rows>{rows.map(row)}</Rows></Section> : null; })
        : shown.length > 0 && <Rows>{shown.map(row)}</Rows>}
      {entries.length > cap && <Note>and {entries.length - cap} more</Note>}
      {!entries.length && <Note>{big && on ? 'Nothing matches these filters. Try fewer filters or more days.' : 'Quiet'}</Note>}
    </>
  );
}
