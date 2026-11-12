import { aboutAttr } from './about';
import { BlockView, useEnv } from './blocks';
import { Split, Row, Empty } from './kit';
import type { Page } from './loom';
import './changes.css';

/** Changes owns the rows and the existing reader blocks; loom only arranges them. */
export function ChangesView({ page, unscoped }: { page: Page; unscoped?: string }) {
  const { ctx, go } = useEnv();
  const c = page.changes!;
  const q = ctx.query;
  const repo = q.repo ?? '', author = q.author ?? '';
  const group = c.groups.some((g) => g.id === q.group) ? q.group : c.rows.find((r) => r.id === c.selected)?.group ?? 'you';
  const filtered = c.rows.filter((r) => (!repo || r.repo === repo) && (!author || r.author === author));
  const shown = filtered.filter((r) => r.group === group);
  const navigate = (patch: Record<string, string>, selected = c.selected) => {
    const params = new URLSearchParams({ ...q, ...patch });
    for (const [k, v] of [...params]) if (!v) params.delete(k);
    go(`${ctx.source.base.replace(/\/$/, '')}${selected ? `/${selected}` : ''}${params.size ? `?${params}` : ''}`);
  };
  const folders = c.groups.map((g) => ({ ...g, count: filtered.filter((r) => r.group === g.id).length }));
  const filters = <div className="loom-changes__filters">
    {(['repo', 'author'] as const).map((key) => <label key={key}>{key === 'repo' ? 'Repository' : 'Author'}
      <select aria-label={key === 'repo' ? 'Repository' : 'Author'} value={key === 'repo' ? repo : author} onChange={(e) => navigate({ [key]: e.target.value }, '')}>
        <option value="">All {key === 'repo' ? 'repositories' : 'authors'}</option>
        {[...new Set(c.rows.map((r) => r[key]))].sort().map((v) => <option key={v}>{v}</option>)}
      </select></label>)}
  </div>;
  return <Split showZeroCounts label="Changes" className="loom-changes" folders={folders} folder={group}
    onFolder={(group) => navigate({ group }, '')} search={filters}
    narrow={<label className="loom-changes__group">Group<select aria-label="Group" value={group} onChange={(e) => navigate({ group: e.target.value }, '')}>
      {folders.map((g) => <option key={g.id} value={g.id}>{g.label} ({g.count})</option>)}
    </select></label>}
    listTitle={c.groups.find((g) => g.id === group)?.label} listMeta={shown.length}
    listTop={<div className="loom-changes__notices">{unscoped && <p>This piece shows the whole household, not only {unscoped}.</p>}
      {page.sections.flatMap((s) => s.blocks).map((b, i) => <BlockView key={i} b={b} />)}</div>}
    list={shown.length ? shown.map((r) => <Row {...aboutAttr({ ref: `github:${r.repo}#${r.number}`, page: `${ctx.source.base.replace(/^\//, "").replace(/\/$/, "")}/${r.id}`, label: r.title })} key={r.id}
      selected={r.id === c.selected} layout="stack" onClick={() => navigate({}, r.id)} title={r.title}
      meta={<>{r.repo}#{r.number}<br />{r.author} · {r.ago}</>} status={r.status} />) : <Empty title="No changes in this group." />}
    reader={c.reader ? <article className="loom-changes__read"><p className="loom-changes__meta">{c.reader.title}</p><h2 className="loom-split__head">{c.reader.intro}</h2>
      {c.reader.sections.map((s) => <section key={s.id}>{s.title && <h3>{s.title}</h3>}{s.blocks.map((b, i) => <BlockView key={i} b={b} />)}</section>)}
    </article> : null} open={!!c.selected} onBack={() => navigate({}, '')} backLabel="Changes" blank="Pick a change to read it" />;
}
