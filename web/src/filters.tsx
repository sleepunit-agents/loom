// A filters block: 000h's toggle group of the choices, and a search over them (?q=). Its own chunk.
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useEnv } from './blocks';
import { pageHref, type Block } from './loom';

export default function Filters({ b }: { b: Extract<Block, { type: 'filters' }> }) {
  const { ctx, go } = useEnv();
  const here = pageHref(ctx.path, ctx.source);
  const to = (q: Record<string, string>) => { const s = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '')).toString(); return here + (s ? `?${s}` : ''); };
  const [q, setQ] = useState(ctx.query.q ?? '');
  const current = ctx.query[b.param] ?? '';
  return (
    <div className="grid gap-3">
      {b.search !== undefined && (
        <form role="search" onSubmit={(e) => { e.preventDefault(); go(to({ ...ctx.query, q })); }}>
          <Input type="search" placeholder={b.search} aria-label={b.search} value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
      )}
      <ToggleGroup type="single" aria-label="Filter" value={current || '_'} onValueChange={(v) => { if (v) go(to({ ...ctx.query, [b.param]: v === '_' ? '' : v })); }}>
        {b.options.map((o) => <ToggleGroupItem key={o.value || '_'} value={o.value || '_'}>{o.label}</ToggleGroupItem>)}</ToggleGroup>
    </div>
  );
}
