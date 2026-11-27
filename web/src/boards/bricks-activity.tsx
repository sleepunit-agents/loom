/** The `activity` brick: the household timeline the desktop's Activity app shows, read with its selections
 * (memory/queries.ts): what the member may see and the household's day and time zone (memoryActivityAccess), the
 * three-day windows Activity reads (memoryActivity), and, big, one opened entry (memoryActivityEntry). A row names
 * its agent as a chip and any ticket its words name; an opened entry names its tickets and pull requests as chips.
 * It changes nothing. Which entry is open is state of the drawn brick. */
import { useState } from 'react';
import { memoryQueries } from '../memory/queries';
import { useMemoryQuery } from '../memory/query';
import { Reply } from '../pair/reply';
import { safeHref, type ActivityEntry, type ActivityLink } from '../pieces/activity/model';
import { Chip, Loading, Unavailable, ticketChip, type Params } from './brick-kit';
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
const Link = ({ label, href }: ActivityLink) => { const safe = safeHref(href); return safe ? <a className="underline" href={safe} target="_blank" rel="noopener noreferrer">{label}</a> : <span>{label}</span>; };

function Opened({ id, zone }: { id: string; zone: string }) {
  const read = useMemoryQuery(memoryQueries.activityEntry(id));
  const e = read.value;
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !e) return <p className="text-muted-foreground">This entry is no longer available.</p>;
  const tickets = [...new Set(e.tasks.map(ticketOf).filter((t): t is string => !!t))];
  const otherTasks = e.tasks.filter((t) => !ticketOf(t));
  return (
    <dl data-entry={id}>
      {e.needs && <div><dt>Needs you</dt><dd>{e.needs}</dd></div>}
      {e.asked.length > 0 && <div><dt>What was asked</dt><dd>{e.asked.map((s, i) => <span key={i} className="block">{s}</span>)}</dd></div>}
      {e.story && <div><dt>What happened</dt><dd><Reply words={e.story} /></dd></div>}
      {e.decided.length > 0 && <div><dt>{e.id.startsWith('e~') ? 'Shipped' : 'What was decided'}</dt><dd>{e.decided.map((s, i) => <span key={i} className="block">{s}</span>)}</dd></div>}
      {e.tasks.length + e.prs.length > 0 && <div><dt>Tasks and pull requests</dt><dd className="board-line">
        {tickets.map((t) => <span key={t}>{ticketChip(t)}</span>)}
        {otherTasks.map((t, i) => <Link key={'t' + i} {...t} />)}
        {e.prs.map((p, i) => { const change = changeOf(p); return change ? <Chip key={'p' + i} place={{ brick: 'pull', params: { change } }}>{p.label}</Chip> : <Link key={'p' + i} {...p} />; })}
      </dd></div>}
      {!!e.steps?.length && <div><dt>Steps · {e.steps.length}</dt><dd>{e.steps.slice(-8).map((s, i) => <span key={i} className="block">{s.label} · {s.state === 'running' ? 'running' : s.state === 'error' ? 'failed' : 'done'}</span>)}</dd></div>}
      {e.links.length > 0 && <div><dt>Read more</dt><dd className="board-line">{e.links.map((l, i) => <Link key={i} {...l} />)}</dd></div>}
      <div><dt>When</dt><dd className="text-muted-foreground">{new Date(e.at).toLocaleString([], { timeZone: zone })}{e.owner ? ' · with you' : ''}</dd></div>
    </dl>
  );
}

export function Activity({ params, form }: { params: Params; form: Form }) {
  const days = Number(params.days) || 1, count = windowsFor(days);
  const access = useMemoryQuery(memoryQueries.activityAccess());
  const may = access.status === 'live' ? access.value : undefined;
  const to = (i: number) => (may?.allowed && i < count && may.windows[i] ? memoryQueries.activity(may.windows[i]) : undefined);
  // Ten is the most a range needs. A window that is not needed asks nothing.
  const windows = [useMemoryQuery(to(0)), useMemoryQuery(to(1)), useMemoryQuery(to(2)), useMemoryQuery(to(3)), useMemoryQuery(to(4)),
    useMemoryQuery(to(5)), useMemoryQuery(to(6)), useMemoryQuery(to(7)), useMemoryQuery(to(8)), useMemoryQuery(to(9))].slice(0, count);
  const [open, setOpen] = useState('');
  if (access.status === 'loading') return <Loading />;
  if (access.status !== 'live' || !may?.allowed) return <Unavailable what="activity" />;
  if (windows.some((w) => w.status === 'offline' || w.status === 'denied')) return <Unavailable what="activity" />;
  const records = windows.flatMap((w) => (w.value ? [w.value] : []));
  if (!records.length && windows.some((w) => w.status === 'loading')) return <Loading />;
  const zone = may.timezone;
  const kept = new Set([...new Set(records.flatMap((w) => w.days))].sort().reverse().slice(0, days));
  const entries = [...new Map(records.flatMap((w) => w.entries).map((e) => [e.id, e])).values()].filter((e) => kept.has(e.day))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));
  const range = days === 1 ? 'today' : `in ${days} days`;
  const total = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} ${range}`;
  if (form === 'compact') return <p className="board-brief">{total}{entries[0] ? ` · latest from ${entries[0].agent}: ${entries[0].title}` : ''}</p>;
  const time = (at: string) => new Date(at).toLocaleTimeString([], { timeZone: zone, hour: 'numeric', minute: '2-digit' });
  const big = form === 'primary', cap = big ? 80 : 5, shown = entries.slice(0, cap);
  const row = (e: ActivityEntry) => (
    <li key={e.id}>
      <div className="board-line">
        <span className="text-muted-foreground">{big ? time(e.at) : `${e.day.slice(5)} ${time(e.at)}`}</span>
        {agentChip(e.agent)}
        {big ? <button type="button" className="board-action" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? '' : e.id)}>{e.title}</button> : <span>{e.title}</span>}
        {e.what !== 'conversation' && <span className="board-state">{e.what === 'work' ? 'Work done' : 'System'}</span>}
        {ticketsIn(`${e.title} ${e.line ?? ''}`).map((t) => <span key={t}>{ticketChip(t)}</span>)}
      </div>
      {big && <p className="text-muted-foreground">{e.where}{e.owner ? ' · with you' : ''}{e.line ? ' · ' + e.line : ''}</p>}
      {big && open === e.id && <Opened id={e.id} zone={zone} />}
    </li>
  );
  return (
    <>
      <p className="board-line"><span>{total}</span></p>
      {big && records.some((w) => w.conversations !== 'available') && <p role="status" className="text-muted-foreground">Conversations and digests {records.some((w) => w.conversations === 'error') ? 'couldn’t load' : 'are not available yet'}.</p>}
      {big && records.some((w) => w.episodes !== 'available') && <p role="status" className="text-muted-foreground">Some episode stores {records.some((w) => w.episodes === 'error') ? 'couldn’t load' : 'are not available'}.</p>}
      {big && records.some((w) => w.truncated) && <p role="status" className="text-muted-foreground">Showing the newest 600 entries per window.</p>}
      {big
        ? [...kept].sort().reverse().map((day) => { const rows = shown.filter((e) => e.day === day); return rows.length ? <section key={day} aria-label={day}><h3>{day}</h3><ol className="board-notes">{rows.map(row)}</ol></section> : null; })
        : <ol className="board-notes">{shown.map(row)}</ol>}
      {entries.length > cap && <p className="text-muted-foreground">and {entries.length - cap} more</p>}
      {!entries.length && <p className="text-muted-foreground">Quiet</p>}
    </>
  );
}
