// Activity (t-1972, Jonathan's approved design 2026-11-08: "let's run with it"): what happened in the household, built
// the way the Inbox and Knowledge are (split.tsx). Filters down the left (Who, Where, What, each with the shown day's
// count; several can be on, and they live in the address), the timeline in the middle (a day strip of activity per hour
// over entries grouped by day, times in a gutter), and the open entry's whole story on the right: what was asked, what
// was decided, the tasks and pull requests, where to read more, and a Comms run's steps. On a phone: a filter menu and
// the timeline; an entry opens over it. Its own chunk, loaded when it opens.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { AgentAvatar, BlockView, Link, Nothing, useEnv, type Mark } from './blocks';
import { fetchView } from './loom';
import { Split, type SplitFolder } from './split';
import { folded, groupLabel, isPlan, stepOf } from './steps';
import { plainThread } from './thread-plain';
import { tidy } from './tidy';
import './activity.css';
void import('./markdown');

type What = 'conversation' | 'work' | 'system';
type Entry = { id: string; agent: string; at: string; day: string; hour: number; title: string; line?: string; venue: string; where: string; what: What; owner?: true };
type Lnk = { label: string; href?: string; page?: string };
type Open = Entry & { asked: string[]; decided: string[]; story?: string; tasks: Lnk[]; prs: Lnk[]; links: Lnk[]; needs?: string;
  steps?: Array<{ label: string; state: string; tool: string }>; more: Array<{ id: string; at: string; title: string }> };
type Filters = { who: string[]; where: string[]; what: What[] };
export type ActivityData = { activity: { to: string; days: string[]; earlier?: string; entries: Entry[]; owner: { key: 'owner'; label: string }; venues: Record<string, string>;
  filters: Filters; day?: string; open?: Open; missing?: true } };

const WHAT: Array<[What, string, string]> = [['conversation', 'Conversations', 'message-circle'], ['system', 'System', 'cpu'], ['work', 'Work done', 'circle-check']];
const WHAT_ICON: Record<What, string> = { conversation: 'message-circle', work: 'circle-check', system: 'cpu' };
const NONE: Filters = { who: [], where: [], what: [] };
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayWord = (day: string, today: string) => {
  if (day === today) return 'Today';
  const d = new Date(`${day}T12:00:00`);
  const y = new Date(`${today}T12:00:00`); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
};
const hourWord = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
const same = (a: Filters, b: Filters) => JSON.stringify(a) === JSON.stringify(b);

/** The address for these filters, this entry and this day: what a reload or a link opens. */
function addressOf(f: Filters, e: string | null, day: string | null): string {
  const q = new URLSearchParams();
  if (f.who.length) q.set('who', f.who.join(','));
  if (f.where.length) q.set('where', f.where.join(','));
  if (f.what.length) q.set('what', f.what.join(','));
  if (day) q.set('day', day);
  if (e) q.set('e', e);
  const s = q.toString().replace(/%2C/g, ',').replace(/%7E/gi, '~');
  return s ? `/activity?${s}` : '/activity';
}

/** Whether an entry passes the filters: any of a group's, and every group that has one on. */
const passes = (e: Entry, f: Filters) => (!f.who.length || f.who.includes(e.agent) || (!!e.owner && f.who.includes('owner')))
  && (!f.where.length || f.where.includes(e.venue)) && (!f.what.length || f.what.includes(e.what));

export function ActivityView({ data }: { data: ActivityData }) {
  const a = data.activity;
  const env = useEnv();
  const agents = (env.ctx.agents ?? {}) as Record<string, Mark>;
  const name = (x: string) => agents[x]?.label ?? x.replace(/^./, (c) => c.toUpperCase());
  const today = a.to;

  // The address is the state (?who= ?where= ?what= ?day= ?e=): shown at once, loom's answer for it lands behind.
  const [f, setF] = useState<Filters>(a.filters ?? NONE);
  const [sel, setSel] = useState<string | null>(a.open?.id ?? null);
  const [was, setWas] = useState(a);
  if (a !== was) {
    setWas(a);
    if (!same(a.filters ?? NONE, f)) setF(a.filters ?? NONE);
    const want = a.open?.id ?? null;
    // Back to an address with nothing open closes the reader; one that opens an entry opens it.
    if (want !== sel && (want || !a.missing)) setSel(want);
  }
  // Earlier days, asked for by "Earlier": kept beside loom's window, which is always the newest days.
  const [older, setOlder] = useState<Entry[]>([]);
  const [oldest, setOldest] = useState<string | undefined>(a.earlier);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const entries = useMemo(() => {
    const seen = new Set(a.entries.map((e) => e.id));
    return [...a.entries, ...older.filter((e) => !seen.has(e.id))];
  }, [a.entries, older]);
  const days = useMemo(() => [...new Set([...a.days, ...entries.map((e) => e.day)])].sort().reverse(), [a.days, entries]);
  const [day, setDay] = useState<string>(() => (a.day && days.includes(a.day) ? a.day : a.days[0]));

  const go = (nf: Filters, e: string | null, d: string | null = day === a.days[0] ? null : day) => env.go(addressOf(nf, e, d));
  const toggle = (id: string) => {
    let nf: Filters;
    if (id === 'all') nf = NONE;
    else {
      const [g, v] = id.split(':') as [keyof Filters, string];
      const now = f[g] as string[];
      nf = { ...f, [g]: now.includes(v) ? now.filter((x) => x !== v) : [...now, v].sort() };
    }
    setF(nf);
    go(nf, sel);
  };
  const isOn = (id: string) => (id === 'all' ? !f.who.length && !f.where.length && !f.what.length : (f[id.split(':')[0] as keyof Filters] as string[] | undefined)?.includes(id.split(':')[1]) ?? false);
  const pick = (id: string) => { setSel(id); go(f, id); };
  const back = () => { setSel(null); go(f, null); };

  const loadEarlier = async () => {
    if (!oldest || loadingOlder) return null;
    setLoadingOlder(true);
    const r = await fetchView(`/activity?to=${oldest}`).catch(() => null);
    setLoadingOlder(false);
    const more = (r?.data as unknown as ActivityData | undefined)?.activity;
    if (!more) return null;
    setOlder((o) => [...o, ...more.entries]);
    setOldest(more.earlier);
    return more.days;
  };

  // Today's counts (the shown day's), each item counted on its own.
  const onDay = entries.filter((e) => e.day === day);
  const n = (p: (e: Entry) => boolean) => onDay.filter(p).length;
  const whoItems = [...Object.keys(agents).map((x) => ({ id: `who:${x}`, label: name(x), count: n((e) => e.agent === x) })),
    { id: 'who:owner', label: a.owner.label, count: n((e) => !!e.owner) }].sort((x, y) => x.label.localeCompare(y.label));
  const venues = { ...a.venues };
  for (const e of entries) venues[e.venue] ??= e.venue.replace(/^./, (c) => c.toUpperCase());
  const whereItems = Object.entries(venues).map(([v, label]) => ({ id: `where:${v}`, label, count: n((e) => e.venue === v) })).sort((x, y) => x.label.localeCompare(y.label));
  const whatItems = WHAT.map(([w, label, icon]) => ({ id: `what:${w}`, label, icon, count: n((e) => e.what === w) }));
  const folders: SplitFolder[] = [
    { id: 'all', label: 'All activity', icon: 'activity', count: onDay.length },
    { heading: 'Who' }, ...whoItems,
    ...(whereItems.length ? [{ heading: 'Where' }, ...whereItems] : []),
    { heading: 'What' }, ...whatItems,
  ];
  const shown = entries.filter((e) => passes(e, f));
  const onCount = f.who.length + f.where.length + f.what.length;

  // The day strip: the shown day's activity per hour (the filters' entries), each hour a way to it.
  const hours = Array.from({ length: 24 }, (_, h) => shown.filter((e) => e.day === day && e.hour === h).length);
  const peak = Math.max(1, ...hours);
  const rowsRef = useRef<HTMLDivElement>(null);
  const jump = (d: string, h?: number) => {
    const box = rowsRef.current;
    if (!box) return;
    const el = box.querySelector<HTMLElement>(h === undefined ? `[data-day="${d}"]` : `[data-day="${d}"][data-hour="${h}"]`)
      ?? (h === undefined ? null : [...box.querySelectorAll<HTMLElement>(`[data-day="${d}"][data-split-row]`)].find((x) => Number(x.dataset.hour) < h));
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (el?.hasAttribute('data-split-row')) el.focus({ preventScroll: true });
  };
  const moveDay = async (by: number) => {
    const i = days.indexOf(day);
    let to: string | undefined = days[i - by];
    if (!to && by < 0) { const got = await loadEarlier(); to = got?.[0]; }
    if (!to) return;
    setDay(to);
    requestAnimationFrame(() => jump(to));
  };
  // A day asked for by address: the list starts there.
  useEffect(() => { if (a.day && a.day !== a.days[0]) requestAnimationFrame(() => jump(a.day!)); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const strip = (
    <div className="loom-act__strip" role="group" aria-label={`Activity per hour, ${dayWord(day, today)}`}>
      <div className="loom-act__strip-head">
        <button type="button" className="loom-act__day-step" aria-label="The day before" disabled={!oldest && days.indexOf(day) === days.length - 1} onClick={() => void moveDay(-1)}><Icon name="chevron-left" size="sm" /></button>
        <span className="loom-act__day">{dayWord(day, today)}</span>
        <button type="button" className="loom-act__day-step" aria-label="The day after" disabled={days.indexOf(day) <= 0} onClick={() => void moveDay(1)}><Icon name="chevron-right" size="sm" /></button>
        <span className="loom-act__day-count loom-data">{hours.reduce((s, x) => s + x, 0)} today</span>
      </div>
      <div className="loom-act__bars">
        {hours.map((c, h) => (
          <button key={h} type="button" className="loom-act__bar" data-none={c ? undefined : ''} disabled={!c} onClick={() => jump(day, h)}
            aria-label={`${hourWord(h)}: ${c} ${c === 1 ? 'entry' : 'entries'}`} title={`${hourWord(h)} · ${c}`}>
            <span style={{ height: `${c ? Math.max(14, (c / peak) * 100) : 6}%` }} />
          </button>
        ))}
      </div>
      <div className="loom-act__ticks loom-data" aria-hidden="true"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span /></div>
    </div>
  );

  // The phone's (and a narrow tile's) filters: one menu, the same toggles.
  const menu = (
    <details className="loom-act__menu">
      <summary><Icon name="funnel" size="sm" />{onCount ? `Filters · ${onCount} on` : 'Filter'}</summary>
      <div className="loom-act__menu-panel">
        {[['Who', whoItems], ['Where', whereItems], ['What', whatItems]].map(([h, items]) => (items as Array<{ id: string; label: string; count: number }>).length ? (
          <div key={h as string} role="group" aria-label={h as string}>
            <p className="loom-split__heading">{h as string}</p>
            {(items as Array<{ id: string; label: string; count: number }>).map((i) => (
              <button key={i.id} type="button" aria-pressed={isOn(i.id)} onClick={() => toggle(i.id)}>{i.label}<span className="loom-split__count">{i.count || ''}</span></button>
            ))}
          </div>) : null)}
        {onCount > 0 && <button type="button" className="loom-act__clear" onClick={() => toggle('all')}>Show everything</button>}
      </div>
    </details>
  );

  const byDay = days.map((d) => [d, shown.filter((e) => e.day === d)] as const).filter(([, es]) => es.length);
  const reading = sel && a.open?.id === sel ? a.open : null;
  const listTitle = onCount ? `${shown.length} of ${entries.length}` : 'Everything';
  return (
    <Split className="loom-act" label="Activity" folders={folders} folder="" isOn={isOn} onFolder={toggle} narrow={menu} listTop={strip}
      listTitle={listTitle} listMeta={onCount ? <button type="button" className="loom-act__clear-inline" onClick={() => toggle('all')}>Clear filters</button> : undefined}
      list={<div ref={rowsRef} className="loom-act__days">
        {byDay.length ? byDay.map(([d, es]) => (
          <section key={d} className="loom-act__group" aria-label={dayWord(d, today)}>
            <h3 className="loom-act__day-head" data-day={d}>{dayWord(d, today)}<span className="loom-data">{es.length}</span></h3>
            {es.map((e) => <Row key={e.id} e={e} mark={agents[e.agent]} who={name(e.agent)} current={sel === e.id} onPick={pick} />)}
          </section>
        )) : <div className="loom-split__empty"><Nothing title={onCount ? 'Nothing matches these filters' : 'Quiet'} text={onCount ? 'Try fewer filters, or an earlier day.' : 'Nothing happened in these days.'} /></div>}
        {oldest && <button type="button" className="loom-act__earlier" onClick={() => void loadEarlier()} disabled={loadingOlder}>
          {loadingOlder ? <Spinner size="sm" label="Loading earlier days" /> : <>Earlier: {dayWord(oldest, today)}</>}</button>}
      </div>}
      reader={reading ? <Reader key={reading.id} o={reading} mark={agents[reading.agent]} who={name(reading.agent)} onPick={pick} today={today} />
        : sel && a.missing && a.open === undefined && !entries.some((e) => e.id === sel) ? <p className="loom-split__note" role="status">That entry isn’t here any more.</p>
        : sel ? <div className="loom-split__blank"><Spinner size="lg" label="Opening it" /></div> : null}
      open={!!sel} onBack={back} backLabel="Activity" blank="Pick an entry to read it" />
  );
}

function Face({ e, mark, who }: { e: Entry; mark?: Mark; who: string }) {
  if (e.what !== 'conversation' || !mark) return <span className="loom-act__icon" data-what={e.what} role="img" aria-label={e.what === 'work' ? 'Work done' : e.what === 'system' ? 'System' : who}><Icon name={WHAT_ICON[e.what]} size="sm" /></span>;
  return <AgentAvatar a={mark} size={28} className="loom-act__face" />;
}

function Row({ e, mark, who, current, onPick }: { e: Entry; mark?: Mark; who: string; current: boolean; onPick: (id: string) => void }) {
  const p = plainThread(e.title);
  return (
    <button type="button" data-split-row="" data-day={e.day} data-hour={e.hour} className="loom-act__row" aria-current={current ? 'true' : undefined} onClick={() => onPick(e.id)}>
      <time className="loom-act__time loom-data" dateTime={e.at}>{clock(e.at)}</time>
      <Face e={e} mark={mark} who={who} />
      <span className="loom-split__words">
        <span className="loom-split__title">{tidy(p.title)}</span>
        {(e.line || p.detail) && <span className="loom-act__line">{tidy(e.line ?? p.detail ?? '')}</span>}
        <span className="loom-act__tags"><span className="loom-act__who">{who}</span><span className="loom-act__where" data-venue={e.venue}>{e.where}</span></span>
      </span>
    </button>
  );
}

function LinkOut({ l }: { l: Lnk }) {
  const { go } = useEnv();
  if (l.page) return <Link page={l.page} className="loom-split__chip">{l.label}</Link>;
  if (l.href?.startsWith('/')) return <a className="loom-split__chip" href={l.href} onClick={(ev) => { if (ev.metaKey || ev.ctrlKey) return; ev.preventDefault(); go(l.href!); }}>{l.label}</a>;
  return <a className="loom-split__chip" href={l.href} target="_blank" rel="noopener noreferrer">{l.label}<Icon name="external-link" size="sm" /></a>;
}

function Steps({ steps }: { steps: NonNullable<Open['steps']> }) {
  const cards = steps.map((s, i) => ({ seq: i, text: s.label, card: { tool: s.tool, state: s.state } }));
  const plan = cards.filter(isPlan).at(-1);
  const list = cards.filter((c) => !isPlan(c));
  const line = (c: typeof list[number]) => <li key={c.seq} data-step={stepOf(c)}><span className="loom-act__step-dot" aria-hidden="true" />{c.text}</li>;
  return (
    <section className="loom-act__steps" aria-label="Steps">
      <h3>Steps <span className="loom-data">{list.length}</span></h3>
      {plan && <p className="loom-act__plan loom-data">{plan.text}</p>}
      {folded(list).map((g) => ('few' in g
        ? <ol key={g.few[0].seq}>{g.few.map(line)}</ol>
        : <details key={g.many[0].seq}><summary className="loom-data">{groupLabel(g.many)} · {g.many.at(-1)!.text}</summary><ol>{g.many.map(line)}</ol></details>))}
    </section>
  );
}

function Reader({ o, mark, who, onPick, today }: { o: Open; mark?: Mark; who: string; onPick: (id: string) => void; today: string }) {
  const p = plainThread(o.title);
  return (
    <article className="loom-act__read" aria-labelledby={`act-${o.id}`}>
      <p className="loom-act__byline">
        <Face e={o} mark={mark} who={who} />
        <span>{who}{o.owner ? ' · with you' : ''}</span>
        <span className="loom-act__where" data-venue={o.venue}>{o.where}</span>
        <time className="loom-data" dateTime={o.at}>{dayWord(o.day, today)}, {clock(o.at)}</time>
      </p>
      <h2 id={`act-${o.id}`} className="loom-split__head">{tidy(p.title)}</h2>
      {p.chips.some((c) => !o.tasks.some((t) => t.label === c.label)) && <div className="loom-split__links">{p.chips.filter((c) => !o.tasks.some((t) => t.label === c.label)).map((c) => (c.page ? <Link key={c.label} page={c.page} className="loom-split__chip">{c.label}</Link> : <span key={c.label} className="loom-act__chip">{c.label}</span>))}</div>}
      {o.needs && <p className="loom-split__note" data-tone="needs"><Icon name="inbox" size="sm" />Needs you: {o.needs}</p>}
      {o.asked.length > 0 && <section aria-label="What was asked"><h3>What was asked</h3><ul>{o.asked.map((x, i) => <li key={i}>{tidy(x)}</li>)}</ul></section>}
      {o.story && <section aria-label="What happened"><h3>What happened</h3><div className="loom-act__story"><BlockView b={{ type: 'prose', text: o.story } as never} /></div></section>}
      {o.decided.length > 0 && <section aria-label="What was decided"><h3>{o.id.startsWith('e~') ? 'Shipped' : 'What was decided'}</h3><ul>{o.decided.map((x, i) => <li key={i}>{tidy(x)}</li>)}</ul></section>}
      {(o.tasks.length > 0 || o.prs.length > 0) && (
        <section aria-label="Tasks and pull requests"><h3>Tasks and pull requests</h3>
          <div className="loom-split__links">{o.tasks.map((t) => <LinkOut key={t.label} l={t} />)}{o.prs.map((x) => <LinkOut key={x.label} l={x} />)}</div></section>
      )}
      {o.steps && o.steps.length > 0 && <Steps steps={o.steps} />}
      {o.links.length > 0 && <section aria-label="Read more"><h3>Read more</h3><div className="loom-split__links">{o.links.map((l) => <LinkOut key={l.label} l={l} />)}</div></section>}
      {o.more.length > 0 && (
        <section aria-label="Earlier in this conversation"><h3>Earlier in this conversation</h3>
          <div className="loom-act__more">{o.more.map((m) => <button key={m.id} type="button" onClick={() => onPick(m.id)}><time className="loom-data" dateTime={m.at}>{new Date(m.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></button>)}</div></section>
      )}
    </article>
  );
}
