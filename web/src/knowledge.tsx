import { aboutAttr } from './about';
// Knowledge, a reader with topics (t-1925, Jonathan's approved mock 2026-11-06): Recently verified and Due a check, the
// topic tree from the domains loom stores (music/norns, ours/homelab), the list with each page's freshness as a dot,
// and the reader: the page, when it was last verified, its sources, what cites it, and Still true / Check again.
// Narrow: chips, the list, then the reader slides in (split.tsx). Its own chunk, loaded when it opens.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { ActButton, BlockView, Link, Nothing } from './blocks';
import { fetchView } from './loom';
import { Split, type SplitFolder } from './split';
import './knowledge.css';
// A page's words are markdown (blocks.tsx prose): its renderer comes with this chunk, so a page never shows raw first.
void import('./markdown');

type Fresh = 'fresh' | 'aging' | 'due';
type Row = { slug: string; title: string; domain: string; updated: string; verified_at?: string; fresh: Fresh; by?: string; recent?: true };
type Open = Row & { body: string; sourcing?: string; sources: Array<{ claim: string; kind: string; locator?: string; href?: string }>;
  citedBy: Array<{ slug: string; title: string }>; checked?: { at: string; outcome: string; by?: string } };
export type KnowledgeData = { knowledge: { total: number; checkDays: number; recentDays: number; pages: Row[]; open?: Open }; topic?: string; q?: string; add?: { page: string; label: string } };

const FRESH_WORD: Record<Fresh, string> = { fresh: 'Fresh', aging: 'Getting old', due: 'Due a check' };
const date = (s?: string) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''; };
const leaf = (d: string) => d.split('/').pop() ?? d;

export function KnowledgeView({ data }: { data: KnowledgeData }) {
  const k = data.knowledge;
  const [q, setQ] = useState(data.q ?? '');
  // A topic asked for by address (?topic=) when it's one of the domains; else the open page's own domain; else all.
  const [f, setF] = useState(() => (data.topic && k.pages.some((r) => r.domain === data.topic || r.domain.startsWith(`${data.topic}/`)) ? `t:${data.topic}`
    : k.open ? `t:${k.open.domain}` : 'all'));
  const [sel, setSel] = useState<string | null>(k.open?.slug ?? null);
  const [open, setOpen] = useState<Open | null>(k.open ?? null);
  const [loading, setLoading] = useState(false);
  const asked = useRef<string | null>(null);

  // The page whole, from loom: asked for when picked, and again when loom's answer for the list changes (a Still true).
  const load = async (slug: string) => {
    asked.current = slug;
    setLoading(true);
    const r = await fetchView(`/knowledge?p=${encodeURIComponent(slug)}`).catch(() => null);
    if (asked.current !== slug) return;
    setLoading(false);
    const o = (r?.data as unknown as KnowledgeData | undefined)?.knowledge?.open;
    setOpen(o ?? null);
  };
  // Not on the first answer: it already carried the page asked for by its address.
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } if (sel && open?.slug === sel) void load(sel); }, [k]);   // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (slug: string) => { setSel(slug); if (open?.slug !== slug) { setOpen(null); void load(slug); } };

  const recent = (r: Row) => !!r.recent;
  // The topic tree, as the mock has it: each domain's first part, and under it each domain whole (gear/elektron).
  const tree = useMemo(() => {
    const tops = new Map<string, { n: number; kids: Map<string, number> }>();
    for (const p of k.pages) {
      const [a, ...rest] = p.domain.split('/');
      const t = tops.get(a) ?? { n: 0, kids: new Map() };
      t.n++;
      if (rest.length) t.kids.set(p.domain, (t.kids.get(p.domain) ?? 0) + 1);
      tops.set(a, t);
    }
    return [...tops].sort((x, y) => y[1].n - x[1].n);
  }, [k.pages]);
  const inF = (id: string, r: Row) => id === 'all' ? true : id === 'recent' ? recent(r) : id === 'due' ? r.fresh === 'due'
    : r.domain === id.slice(2) || r.domain.startsWith(`${id.slice(2)}/`);
  const folders: SplitFolder[] = [
    { id: 'all', label: 'All pages', icon: 'book-open', count: k.total },
    { id: 'recent', label: 'Recently verified', icon: 'circle-check', count: k.pages.filter(recent).length },
    { id: 'due', label: 'Due a check', icon: 'triangle-alert', count: k.pages.filter((r) => r.fresh === 'due').length, loud: true },
    ...(tree.length ? [{ heading: 'Topics' }] : []),
    ...tree.flatMap(([top, t]) => [{ id: `t:${top}`, label: top, icon: 'folder', count: t.n },
      ...[...t.kids].sort((x, y) => y[1] - x[1]).map(([kid, n]) => ({ id: `t:${kid}`, label: kid.slice(top.length + 1), count: n, sub: true }))]),
  ];
  const needle = q.trim().toLowerCase();
  const hits = k.pages.filter((r) => (needle ? `${r.title} ${r.domain}`.toLowerCase().includes(needle) : inF(f, r)));
  // Due a check: the longest unchecked first. Elsewhere, loom's order (newest first).
  const shown = f === 'due' && !needle ? [...hits].sort((a, b) => Date.parse(a.verified_at ?? a.updated) - Date.parse(b.verified_at ?? b.updated)) : hits;
  const label = needle ? `Matching “${q.trim()}”` : f === 'all' ? 'All pages' : f === 'recent' ? 'Recently verified' : f === 'due' ? 'Due a check' : f.slice(2);
  const reading = sel ? (open && open.slug === sel ? open : null) : null;
  const search = (
    <label className="loom-split__search"><Icon name="search" size="sm" />
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${k.total.toLocaleString()} pages`} aria-label="Search knowledge" /></label>
  );
  return (
    <Split className="loom-kn" label="Knowledge" folders={folders} folder={needle ? '' : f} onFolder={(id) => { setF(id); setQ(''); }} search={search}
      listTitle={label} listMeta={<>{`${shown.length} page${shown.length === 1 ? '' : 's'}`}{data.add && <> · <Link page={data.add.page} className="loom-kn__add">{data.add.label}</Link></>}</>}
      list={shown.length ? shown.map((r) => (
        <button {...aboutAttr({ ref: `knowledge:${r.slug}`, page: `knowledge/${r.slug}`, label: r.title })} key={r.slug} type="button" data-split-row="" className="loom-kn__row" aria-current={sel === r.slug ? 'true' : undefined} onClick={() => pick(r.slug)}>
          <span className="loom-kn__dot" data-fresh={r.fresh} role="img" aria-label={FRESH_WORD[r.fresh]} />
          <span className="loom-split__words"><span className="loom-split__title">{r.title}</span>
            <span className="loom-kn__meta loom-data">{r.verified_at ? `verified ${date(r.verified_at)}` : `written ${date(r.updated)}`} · {leaf(r.domain)}</span></span>
        </button>))
        : <div className="loom-split__empty"><Nothing title={needle ? `Nothing matches “${q.trim()}”` : k.total ? 'Nothing here' : 'No knowledge yet'}
          text={k.total ? undefined : 'Facts your agents learn land here.'}><Link page="loom:new-fact" className="underline">Add a fact</Link></Nothing></div>}
      reader={reading ? <Reader p={reading} onPick={pick} checkDays={k.checkDays} />
        : sel && loading ? <div className="loom-split__blank"><Spinner size="lg" label="Opening the page" /></div>
        : sel ? <p className="loom-split__note" role="status">That page isn’t here any more.</p> : null}
      open={!!sel} onBack={() => setSel(null)} backLabel={label}
      blank={<span>Pick a page to read<br /><Link page="loom:new-fact" className="loom-split__chip mt-4">Add a fact</Link></span>} />
  );
}

function Reader({ p, onPick, checkDays }: { p: Open; onPick: (slug: string) => void; checkDays: number }) {
  const parts = p.domain.split('/');
  const verifiedBy = p.checked?.outcome === 'confirmed' || p.checked?.outcome === 'corrected' ? p.checked.by : undefined;
  return (
    <article className="loom-kn__read" aria-labelledby={`kn-${p.slug}`}>
      <nav className="loom-kn__crumb loom-data" aria-label="Topic">{parts.map((x, n) => <span key={n}>{x}</span>)}</nav>
      <h2 id={`kn-${p.slug}`} className="loom-split__head">{p.title}</h2>
      <p className="loom-kn__fresh">
        <span className="loom-kn__pill" data-fresh={p.fresh}><span className="loom-kn__dot" data-fresh={p.fresh} />{FRESH_WORD[p.fresh]}</span>
        <span className="loom-data">{p.verified_at ? `verified ${date(p.verified_at)}${verifiedBy ? ` by ${verifiedBy}` : ''}` : `written ${date(p.updated)}, not verified yet`}</span>
        <span className="loom-data loom-kn__quiet">{p.checked?.outcome === 'stale' ? `asked to be checked again ${date(p.checked.at)}` : `pages are re-checked every ${checkDays} days`}</span>
      </p>
      <div className="loom-kn__body"><BlockView b={{ type: 'prose', text: p.body || '(No words yet.)' } as never} /></div>
      {p.sources.length > 0 && (
        <section className="loom-kn__sources" aria-label="Sources">
          <h3>Sources</h3>
          <dl>{p.sources.map((s, n) => (
            <div key={n}><dt className="loom-data">{s.kind}</dt>
              <dd>{s.claim}{s.locator && <> · {s.href ? <a href={s.href} target="_blank" rel="noopener noreferrer" className="underline">{s.locator}</a> : <span className="loom-data">{s.locator}</span>}</>}</dd></div>))}
          </dl>
        </section>
      )}
      {p.citedBy.length > 0 && (
        <section aria-label="Cited by">
          <h3 className="loom-kn__h3">Cited by</h3>
          <div className="loom-split__links">{p.citedBy.map((c) => <button key={c.slug} type="button" className="loom-split__chip" onClick={() => onPick(c.slug)}>{c.title}</button>)}</div>
        </section>
      )}
      <div className="loom-split__buttons">
        <ActButton b={{ action: 'knowledge-verify', label: 'Still true', tone: 'primary', fields: { slug: p.slug } }} size="default" />
        <ActButton b={{ action: 'knowledge-recheck', label: 'Check again', fields: { slug: p.slug } }} size="default" />
      </div>
      <p className="loom-kn__quiet">{p.sourcing ? `Sourcing: ${p.sourcing}. ` : ''}{p.by ? `Written by ${p.by}.` : ''}</p>
    </article>
  );
}
