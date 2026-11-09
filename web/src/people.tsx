// The agreed contacts layout: a searchable directory beside the existing rich person page.
// Split measures the tile, keeps keyboard navigation, and replaces the list with a reader on phones.
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { BlockView, Link, useEnv } from './blocks';
import { fetchView, type Page } from './loom';
import { Split } from './split';
import './people.css';

export type PeopleData = { rows: { slug: string; name: string; meta?: string; badge?: string; kind: string }[];
  q: string; kind: string; selected?: string; open?: Page; conversations?: { title: string; href: string }[]; permissions?: string };
export function PeopleView({ data }: { data: PeopleData }) {
  const { go } = useEnv();
  const [q, setQ] = useState(data.q);
  const [kind, setKind] = useState(data.kind === 'agents' ? 'agent' : data.kind === 'people' ? 'person' : 'all');
  const [selected, setSelected] = useState(data.selected ?? null);
  const [page, setPage] = useState<Page | null>(data.open ?? null);
  const [extras, setExtras] = useState(data);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef(0);
  const load = async (slug: string) => {
    const n = ++request.current;
    setLoading(true); setError(false);
    const response = await fetchView(`/people?p=${encodeURIComponent(slug)}`).catch(() => null);
    if (n !== request.current) return;
    setLoading(false);
    const next = response?.data;
    if (next?.view === 'page' && next.people?.open && next.people.open.title !== 'Not found') { setPage(next.people.open); setExtras(next.people); }
    else { setPage(null); setError(true); }
  };
  // A live refresh or direct navigation can change the selected contact. Never leave an old response on a new one.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (data.selected) { ++request.current; setSelected(data.selected); setPage(data.open ?? null); setExtras(data); setLoading(false); setError(false); }
    else { ++request.current; setSelected(null); setPage(null); setLoading(false); setError(false); }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { ++request.current; }, []);
  const contactUrl = (slug?: string) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (kind !== 'all') params.set('kind', kind === 'agent' ? 'agents' : 'people');
    const query = params.toString();
    return `/people${slug ? `/${encodeURIComponent(slug)}` : ''}${query ? `?${query}` : ''}`;
  };
  const pick = (slug: string) => go(contactUrl(slug));
  const back = () => go(contactUrl());
  const needle = q.trim().toLocaleLowerCase();
  const shown = data.rows.filter((r) => (kind === 'all' || r.kind === kind) && `${r.name} ${r.meta ?? ''}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));
  return <Split className="loom-people" label="People" folders={[
    { id: 'all', label: 'Everyone', count: data.rows.length },
    { id: 'person', label: 'People', count: data.rows.filter((r) => r.kind === 'person').length },
    { id: 'agent', label: 'Agents', count: data.rows.filter((r) => r.kind === 'agent').length },
  ]} folder={kind === 'people' ? 'person' : kind === 'agents' ? 'agent' : kind} onFolder={setKind}
    search={<label className="loom-split__search"><Icon name="search" size="sm" /><input type="search" aria-label="Search people" placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} /></label>}
    listTitle="Contacts" listMeta={<>{shown.length} · <Link page="loom:new-person">Add a person</Link></>}
    list={shown.length ? shown.map((r, i) => <div key={r.slug}>
      {(i === 0 || shown[i - 1].name[0].toLocaleUpperCase() !== r.name[0].toLocaleUpperCase()) && <h3 className="loom-people__letter">{r.name[0].toLocaleUpperCase()}</h3>}
      <a href={contactUrl(r.slug)} data-split-row="" className="loom-people__row" aria-current={selected === r.slug ? 'true' : undefined} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); pick(r.slug); }}>
        <span className="loom-people__avatar" aria-hidden>{r.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('')}</span>
        <span className="loom-split__words"><span className="loom-split__title">{r.name}</span><span className="loom-people__meta">{r.meta || (r.kind === 'agent' ? 'Agent' : 'Person')}</span>{r.badge && <small>{r.badge}</small>}</span>
      </a></div>) : <p className="loom-split__empty">{data.rows.length ? 'No matching contacts.' : 'Nobody in the directory yet.'}</p>}
    reader={loading ? <div className="loom-split__blank"><Spinner label="Opening contact" /></div> : error ? <div className="loom-split__note" role="status">This contact could not be opened. <button type="button" onClick={() => selected && void load(selected)}>Try again</button></div>
      : page ? <div className="loom-people__detail">{page.sections.map((s) => <section key={s.id} data-section={s.id}>
        {s.title && <h2>{s.title}</h2>}{s.blocks.map((b, i) => <BlockView key={i} b={b} />)}
      </section>)}<section><h2>Conversations</h2>{extras.conversations?.length ? extras.conversations.map((c) => <p key={c.href}><Link href={c.href}>{c.title}</Link></p>) : <p className="loom-people__meta">No conversations of yours with this contact.</p>}</section>
      <section><h2>Access</h2><p className="loom-people__meta">{page.sections.some((s) => s.id === 'owns') ? 'Owner roles are shown above.' : 'Contact details do not grant access.'}</p>{extras.permissions && <Link href={extras.permissions}>Open Permissions</Link>}</section></div> : null}
    open={!!selected} onBack={back} backLabel="Contacts" blank="Choose a contact to see their relationships and contact details." />;
}
