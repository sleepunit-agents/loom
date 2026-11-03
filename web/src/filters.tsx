// A filters block: 000h's toggle group of the choices, and a search over them (?q=); and fields drawn with it. Its own chunk.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useEnv } from './blocks';
import { pageHref, type Block, type Field } from './loom';

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

// A field drawn with the same toggle group (forms: a segmented control, or chips like the days of a week).
export function Chips({ f, value, set, id }: { f: Field; value: string; set: (v: string) => void; id: string }) {
  // A number with − and +, within its bounds, and its unit beside it ("14 days").
  if (f.kind === 'stepper') {
    const n = value === '' ? (f.min ?? 0) : Number(value);
    const step = f.step ?? 1;
    const clamp = (x: number) => Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, Math.round(x / step) * step));
    return (
      <div id={id} role="group" aria-label={f.label} className="flex items-center gap-3">
        <Button type="button" size="sm" variant="outline" aria-label={`Fewer ${f.unit ?? ''}`.trim()} disabled={f.min !== undefined && n <= f.min} onClick={() => set(String(clamp(n - step)))}>−</Button>
        <output aria-live="polite" className="min-w-16 text-center text-lg font-semibold tabular-nums">{n}{f.unit ? <span className="ml-1 text-sm font-normal opacity-70">{f.unit}</span> : null}</output>
        <Button type="button" size="sm" variant="outline" aria-label={`More ${f.unit ?? ''}`.trim()} disabled={f.max !== undefined && n >= f.max} onClick={() => set(String(clamp(n + step)))}>+</Button>
      </div>
    );
  }
  if (f.kind === 'segmented') {
    return (
      <ToggleGroup id={id} type="single" className="v-seg" aria-label={f.label} value={value || f.options?.[0]?.value || ''} onValueChange={(v) => { if (v) set(v); }}>
        {f.options?.map((o) => <ToggleGroupItem key={o.value} value={o.value}>{o.label}</ToggleGroupItem>)}
      </ToggleGroup>
    );
  }
  const on = value.split(',').filter(Boolean);
  return (
    <ToggleGroup id={id} type="multiple" aria-label={f.label} value={on} onValueChange={(v: string[]) => set((f.options ?? []).map((x) => x.value).filter((x) => v.includes(x)).join(','))}>
      {f.options?.map((o) => <ToggleGroupItem key={o.value} value={o.value} aria-label={o.detail ?? o.label}>{o.label}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}
