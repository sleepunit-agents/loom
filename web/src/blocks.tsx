// loom's blocks (src/ui/vocab.ts) drawn with 000h's components, by the rules in docs/specs/ui-app.md:
// a details holding a form opens as an editor, one holding a list or a table as a drawer; danger asks
// first; a table is rows of label and value on a phone; a block this app doesn't know is shown, not dropped.
import { Arrive } from './arrive';
import { Alert, AlertBody, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { Item, ItemContent, ItemDescription, ItemTitle, ItemTrailing } from '@/components/ui/item';
// Rare blocks' components load when a page has one: a link block (living link), a meter (progress).
const LivingLink = lazy(() => import('@/components/ui/living-link').then((m) => ({ default: m.LivingLink })));
const Progress = lazy(() => import('@/components/ui/progress').then((m) => ({ default: m.Progress })));
const CodeBlock = lazy(() => import('@/components/ui/code-block').then((m) => ({ default: m.CodeBlock })));

import { Checkbox } from '@/components/ui/checkbox';
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from '@/components/ui/pagination';
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from '@/components/ui/table';
const ChoiceSelect = lazy(() => import('./choice-select'));
import { Field as UiField, FieldDescription, FieldLabel } from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { createContext, useContext, useState, type ReactNode, lazy, Suspense } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { pageHref, type Block, type Button as Btn, type Ctx, type Field, type ListItem, type Tone } from './loom';

/** What a block needs from the page around it: where links go, how an action is sent, whether it's a phone. */
export interface Env {
  ctx: Ctx; send: (action: string, fields: Record<string, string>) => Promise<boolean>; go: (href: string) => void; wide: boolean;
  /** The same page, but links and actions belong to another source (an ask's or a tile's piece). */
  withSource: (source: Ctx['source']) => Env;
}
export const EnvContext = createContext<Env | null>(null);
const useEnv = () => useContext(EnvContext)!;

const DOT: Record<Tone, string> = { ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', muted: 'bg-neutral-400' };
const BADGE: Record<string, string> = { running: 'live', wanted: 'pending', starting: 'pending', failed: 'danger', lost: 'danger' };

export function Link({ page, href, children, className }: { page?: string; href?: string; children: ReactNode; className?: string }) {
  const { ctx, go } = useEnv();
  if (href) return <a className={className} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  if (page === undefined) return <span className={className}>{children}</span>;
  const to = pageHref(page, ctx.source);
  return <a className={className} href={to} onClick={(e) => { if (e.metaKey || e.ctrlKey || to === '#') return; e.preventDefault(); go(to); }}>{children}</a>;
}

// ---- actions ---------------------------------------------------------------------------------------

/** A button that sends its action; one that is danger (or says confirm) asks first. */
export function ActButton({ b, size = 'sm', full = false, onDone }: { b: Btn; size?: 'sm' | 'default'; full?: boolean; onDone?: () => void }) {
  const { send } = useEnv();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const fire = async () => { setBusy(true); await send(b.action, b.fields ?? {}); setBusy(false); onDone?.(); };
  const variant = b.tone === 'danger' ? 'danger' : b.tone === 'primary' ? 'default' : 'outline';
  return (
    <>
      <Button size={size} variant={variant} disabled={busy} className={full ? 'w-full' : undefined}
        onClick={() => (b.confirm || b.tone === 'danger' ? setAsking(true) : void fire())}>{b.label}</Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{b.label}?</AlertDialogTitle>
            <AlertDialogDescription>{b.confirm ?? 'This can\'t be undone from here.'}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void fire()}>{b.label}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---- forms -----------------------------------------------------------------------------------------

function FieldInput({ f, value, set, id }: { f: Field; value: string; set: (v: string) => void; id: string }) {
  if (f.kind === 'textarea') return <Textarea id={id} value={value} required={f.required} onChange={(e) => set(e.target.value)} />;
  if (f.kind === 'toggle') return <Switch id={id} checked={value === 'on' || value === 'true'} onCheckedChange={(c) => set(c ? 'on' : '')} />;
  // One box (000h's checkbox): "on" or "". Several: the ticked values, joined with commas.
  if (f.kind === 'check') return <Checkbox id={id} checked={value === 'on'} onCheckedChange={(c) => set(c === true ? 'on' : '')}>{f.hint ? null : f.label}</Checkbox>;
  if (f.kind === 'checks') {
    const on = new Set(value.split(',').filter(Boolean));
    return (
      <div id={id} role="group" aria-label={f.label} className="grid gap-2">{f.options?.map((o) => (
        <Checkbox key={o.value} checked={on.has(o.value)} onCheckedChange={(c) => {
          const next = new Set(on); if (c === true) next.add(o.value); else next.delete(o.value);
          set((f.options ?? []).map((x) => x.value).filter((v) => next.has(v)).join(','));
        }}>{o.label}</Checkbox>))}
      </div>
    );
  }
  // A few choices show at once (000h's radio chips); many go in a select.
  if (f.kind === 'choice' && (f.options?.length ?? 0) <= 5 && !f.options?.some((o) => o.swatch)) {
    return (
      <RadioGroup id={id} value={value || f.options?.[0]?.value || ''} onValueChange={set} className="flex flex-wrap gap-2">
        {f.options?.map((o) => <RadioGroupItem key={o.value || '_'} value={o.value} appearance="chip">{o.label}</RadioGroupItem>)}
      </RadioGroup>
    );
  }
  if (f.kind === 'choice') {
    return (
      <Suspense fallback={<Input id={id} value={f.options?.find((o) => o.value === value)?.label ?? ''} readOnly />}>
        <ChoiceSelect id={id} value={value} options={f.options ?? []} set={set} />
      </Suspense>
    );
  }
  return <Input id={id} type={f.kind === 'secret' ? 'password' : f.kind === 'number' ? 'number' : f.kind === 'date' ? 'date' : 'text'}
    autoComplete={f.kind === 'secret' ? 'off' : undefined} value={value} required={f.required} onChange={(e) => set(e.target.value)} />;
}

export function Form({ form, onDone, inDialog = false }: { form: Extract<Block, { type: 'form' }>; onDone?: () => void; inDialog?: boolean }) {
  const { send } = useEnv();
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(form.fields.map((f) => [f.name, f.value ?? ''])));
  const [busy, setBusy] = useState(false);
  const fields = (
    <div className={`grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 ${inDialog ? 'max-h-[52dvh] overflow-y-auto pr-1' : ''}`}>
      {form.fields.map((f) => (
        <UiField key={f.name} controlId={`${form.action}-${f.name}`}>
          <FieldLabel htmlFor={`${form.action}-${f.name}`}>{f.label}{f.required ? <span aria-hidden className="opacity-50"> *</span> : null}</FieldLabel>
          <FieldInput id={`${form.action}-${f.name}`} f={f} value={vals[f.name] ?? ''} set={(v) => setVals((s) => ({ ...s, [f.name]: v }))} />
          {f.hint && <FieldDescription>{f.hint}</FieldDescription>}
        </UiField>
      ))}
      {form.note && <p className="text-sm opacity-70">{form.note}</p>}
    </div>
  );
  const submit = <Button type="submit" disabled={busy}>{form.submit}</Button>;
  return (
    <form className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true);
      const ok = await send(form.action, { ...(form.hidden ?? {}), ...vals });
      setBusy(false); if (ok) onDone?.();
    }}>
      {!inDialog && form.title && <h4 className="font-medium">{form.title}</h4>}
      {fields}
      {inDialog ? <DialogFooter>{submit}</DialogFooter> : <div>{submit}</div>}
    </form>
  );
}

/** A form behind a button, opened as a focused editor. */
function EditorButton({ label, title, form, variant = 'outline' }: { label: string; title: string; form: Extract<Block, { type: 'form' }>; variant?: 'outline' | 'default' | 'ghost' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}>{label}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent appearance="editor" showCloseButton>
          <DialogHeader><DialogTitle>{title}</DialogTitle>{form.note && <DialogDescription>{form.note}</DialogDescription>}</DialogHeader>
          <Form form={{ ...form, note: undefined }} inDialog onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---- blocks ----------------------------------------------------------------------------------------

function Row({ i }: { i: ListItem }) {
  const env = useEnv();
  const agent = i.agent ? env.ctx.agents?.[i.agent] : undefined;
  // One row is 000h's item: its lead (a tone, an agent's avatar), title and description, and what's at the end.
  const body = (
    <ItemContent className="min-w-0 flex-1">
      <ItemTitle className="flex min-w-0 items-center gap-2">
        {i.tone && <span className={`size-2 shrink-0 rounded-full ${DOT[i.tone]}`} />}
        {agent && <AgentAvatar a={agent} size={20} />}
        <span className="truncate font-medium">{i.text}</span>
        {i.badge && <Badge variant={(BADGE[i.badge] ?? 'default') as 'default'}>{i.badge}</Badge>}
      </ItemTitle>
      {i.meta && <ItemDescription className="truncate">{i.meta}</ItemDescription>}
    </ItemContent>
  );
  return (
    <Arrive as="li" k={`li:${i.text}\0${i.badge ?? ''}\0${i.tone ?? ''}`} className="min-w-0">
      <Item as="div" className="flex min-h-11 w-full min-w-0 items-center gap-3 py-2.5">
        {i.page !== undefined || i.href ? <Link page={i.page} href={i.href} className="flex min-w-0 flex-1 items-center gap-2 no-underline">{body}{i.act ? null : <AnimatedIcon name="chevron-right" size="sm" />}</Link> : body}
        {i.act && <ItemTrailing><ActButton b={i.act} /></ItemTrailing>}
      </Item>
    </Arrive>
  );
}

/** Long tables and lists a page at a time (000h's pagination): PAGE_ROWS rows, then numbered pages. */
const PAGE_ROWS = 15;
/** Where a list or table that pages itself is (the piece serves one page; loom asks for ?<param>=<n>). */
type Pages = { param: string; at: number; count: number; total?: number };
function usePaged<T>(all: T[], served?: Pages): { rows: T[]; pager: ReactNode } {
  const { ctx, go } = useEnv();
  const [at, setAt] = useState(0);
  // The piece's own pages (0-based here), else ours over what it sent.
  const pages = served ? served.count : Math.ceil(all.length / PAGE_ROWS);
  const page = served ? served.at - 1 : Math.min(at, Math.max(0, pages - 1));
  const to = (p: number) => {
    if (!served) return setAt(p);
    const q = new URLSearchParams(Object.entries({ ...ctx.query, [served.param]: String(p + 1) }).filter(([, v]) => v !== ''));
    go(`${pageHref(ctx.path, ctx.source)}?${q}`);
  };
  if (pages <= 1) return { rows: all, pager: null };
  // The pages around this one, the first and the last; gaps as an ellipsis.
  const shown = [...new Set([0, page - 1, page, page + 1, pages - 1].filter((p) => p >= 0 && p < pages))].sort((x, y) => x - y);
  return {
    rows: served ? all : all.slice(page * PAGE_ROWS, (page + 1) * PAGE_ROWS),
    pager: (
      <Pagination className="mt-2" aria-label="Pages of this list">
        <PaginationContent>
          <PaginationItem><PaginationPrevious disabled={page === 0} onClick={() => to(page - 1)} /></PaginationItem>
          {shown.map((p, i) => [
            i && p - shown[i - 1] > 1 ? <PaginationItem key={`e${p}`}><PaginationEllipsis /></PaginationItem> : null,
            <PaginationItem key={p}><PaginationLink isActive={p === page} aria-current={p === page ? 'page' : undefined} onClick={() => to(p)}>{p + 1}</PaginationLink></PaginationItem>,
          ])}
          <PaginationItem><PaginationNext disabled={page === pages - 1} onClick={() => to(page + 1)} /></PaginationItem>
        </PaginationContent>
        {served?.total !== undefined && <p className="mt-1 text-xs opacity-60">{served.total.toLocaleString()} in all</p>}
      </Pagination>
    ),
  };
}

function ListBlock({ items, pages }: { items: ListItem[]; pages?: Pages }) {
  const { rows, pager } = usePaged(items, pages);
  if (!items.length) return <Nothing title="Nothing here yet" />;
  return <>{<ul className="min-w-0 divide-y">{rows.map((i, n) => <Row key={n} i={i} />)}</ul>}{pager}</>;
}

function TableBlock({ b }: { b: Extract<Block, { type: 'table' }> }) {
  const { wide } = useEnv();
  const { rows, pager } = usePaged(b.rows, (b as { pages?: Pages }).pages);
  const cell = (c: string | { text: string; page?: string }) => (typeof c === 'string' ? c : <Link page={c.page}>{c.text}</Link>);
  if (!b.rows.length) return <Nothing title="Nothing here yet" />;
  if (!wide) {
    return (
      <><ul className="divide-y">{rows.map((r, n) => (
        <Arrive as="li" key={n} k={`tr:${JSON.stringify(r)}`} className="grid gap-0.5 py-2.5">
          <span className="font-medium">{cell(r[0])}</span>
          <span className="text-sm opacity-70">{r.slice(1).map((c, m) => <span key={m}>{m ? ' · ' : ''}{cell(c)}</span>)}</span>
        </Arrive>))}
      </ul>{pager}</>
    );
  }
  // A desktop: 000h's table (its ledger look), rows as they come.
  return (
    <>
      <TableContainer>
        <Table>
          <TableHeader><TableRow>{b.columns.map((c) => <TableHead key={c}>{c}</TableHead>)}</TableRow></TableHeader>
          <TableBody>{rows.map((r, n) => <Arrive as="tr" key={n} k={`tr:${JSON.stringify(r)}`} data-slot="table-row">{r.map((c, m) => <TableCell key={m} className="align-top">{cell(c)}</TableCell>)}</Arrive>)}</TableBody>
        </Table>
      </TableContainer>
      {pager}
    </>
  );
}

/** A details, by what it holds: a form is an editor; a list or a table a drawer; anything else a drawer too. */
function DetailsBlock({ b }: { b: Extract<Block, { type: 'details' }> }) {
  const forms = b.blocks.filter((x) => x.type === 'form') as Extract<Block, { type: 'form' }>[];
  const [open, setOpen] = useState(false);
  if (forms.length === 1 && b.blocks.length === 1) return <EditorButton label={b.summary} title={forms[0].title ?? b.summary} form={forms[0]} />;
  const count = (b.blocks.find((x) => x.type === 'list' || x.type === 'table') as { items?: unknown[]; rows?: unknown[] } | undefined);
  const n = count?.items?.length ?? count?.rows?.length;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{b.summary}{n !== undefined ? ` · ${n}` : b.meta ? ` · ${b.meta}` : ''}</Button>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent className="lg:mx-auto lg:max-w-2xl">
          <DrawerHeader><DrawerTitle>{b.summary}</DrawerTitle>{b.meta && <DrawerDescription>{b.meta}</DrawerDescription>}</DrawerHeader>
          <div className="grid gap-3">{b.blocks.map((x, k) => (x.type === 'form'
            ? <EditorButton key={k} label={(x as { title?: string }).title ?? b.summary} title={(x as { title?: string }).title ?? b.summary} form={x as Extract<Block, { type: 'form' }>} variant="default" />
            : x.type === 'buttons' ? <div key={k} className="grid gap-2">{(x as Extract<Block, { type: 'buttons' }>).items.map((y) => <ActButton key={y.label} b={y} full size="default" onDone={() => setOpen(false)} />)}</div>
              : <BlockView key={k} b={x} />))}</div>
        </DrawerContent>
      </Drawer>
    </>
  );
}

/** Pills that set one query value on this page, and an optional search over them (?q=), the other choices kept. */
function Filters({ b }: { b: Extract<Block, { type: 'filters' }> }) {
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
      <nav aria-label="Filter" className="flex flex-wrap gap-2">{b.options.map((o) => (
        <Button key={o.value || '_'} size="sm" variant={o.value === current ? 'default' : 'outline'} aria-current={o.value === current || undefined}
          onClick={() => go(to({ ...ctx.query, [b.param]: o.value }))}>{o.label}</Button>))}</nav>
    </div>
  );
}

/** A link block (000h's living link): one of the page's own, or another site's. */
function PageLink({ l }: { l: Extract<Block, { type: 'link' }> }) {
  const { ctx, go } = useEnv();
  const plain = <Link page={l.page} href={l.href} className="underline underline-offset-4">{l.text}</Link>;
  if (l.href) return <Suspense fallback={plain}><LivingLink href={l.href} target="_blank" rel="noopener noreferrer">{l.text}</LivingLink></Suspense>;
  const to = pageHref(l.page ?? '', ctx.source);
  return <Suspense fallback={plain}><LivingLink href={to} direction="forward" onClick={(e: React.MouseEvent) => { if (e.metaKey || e.ctrlKey || to === '#') return; e.preventDefault(); go(to); }}>{l.text}</LivingLink></Suspense>;
}

/** An agent's mark as 000h's avatar: its initial on its colour, rounded. */
export function AgentAvatar({ a, size = 40, shape = 'rounded', className, style }: { a: { label: string; bg: string; fg: string }; size?: number; shape?: 'circle' | 'rounded' | 'pebble'; className?: string; style?: React.CSSProperties }) {
  return (
    <Avatar shape={shape} className={className} aria-label={a.label}
      style={{ '--c': a.bg, color: a.fg, width: size, height: size, fontSize: Math.round(size * 0.42), boxShadow: 'none', ...style } as React.CSSProperties}>
      <AvatarFallback>{a.label[0]}</AvatarFallback>
    </Avatar>
  );
}

/** An empty collection says so (000h's empty), never a blank. */
export function Nothing({ title, text, children }: { title: string; text?: string; children?: ReactNode }) {
  return (
    <Empty className="loom-empty grid justify-items-center gap-2 rounded-2xl border border-dashed px-4 py-8 text-center">
      <EmptyTitle className="text-base">{title}</EmptyTitle>{text && <EmptyDescription className="text-sm">{text}</EmptyDescription>}{children}
    </Empty>
  );
}

export function BlockView({ b }: { b: Block }) {
  switch (b.type) {
    case 'text': { const t = b as Extract<Block, { type: 'text' }>; return <p className={t.tone === 'muted' ? 'text-sm opacity-70' : ''}>{t.text}</p>; }
    case 'prose': return <div className="prose whitespace-pre-wrap">{(b as { text: string }).text}</div>;
    case 'callout': { const c = b as Extract<Block, { type: 'callout' }>;
      return <Alert variant={c.tone === 'bad' ? 'danger' : c.tone === 'warn' ? 'warn' : c.tone === 'ok' ? 'ok' : 'info'}>
        <AlertBody>{c.title && <AlertTitle>{c.title}</AlertTitle>}<AlertDescription>{c.text}</AlertDescription></AlertBody></Alert>; }
    case 'list': return <ListBlock items={(b as Extract<Block, { type: 'list' }>).items} pages={(b as { pages?: Pages }).pages} />;
    case 'table': return <TableBlock b={b as Extract<Block, { type: 'table' }>} />;
    case 'kv': return (
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {(b as Extract<Block, { type: 'kv' }>).items.map((i) => [<dt key={`${i.label}k`} className="opacity-70">{i.label}</dt>,
          <Arrive as="dd" key={`${i.label}v`} k={`kv:${i.label}\0${i.value}`} className="min-w-0 [overflow-wrap:anywhere]">{i.page !== undefined ? <Link page={i.page}>{i.value}</Link> : i.value}</Arrive>])}
      </dl>);
    case 'stats': return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{(b as Extract<Block, { type: 'stats' }>).items.map((s) => (
        <Arrive key={s.label} k={`st:${s.label}\0${s.value}`} className="rounded-[var(--r-card)]"><Card lift={s.page !== undefined} className="gap-0 p-0">
          <Link page={s.page} className="block p-4 no-underline"><span className="block text-xs opacity-60">{s.label}</span>
          <span className="block text-xl font-semibold">{s.value}</span>{s.detail && <span className="block text-xs opacity-60">{s.detail}</span>}</Link></Card></Arrive>))}</div>);
    case 'meter': return (
      <div className="grid gap-3">{(b as Extract<Block, { type: 'meter' }>).items.map((m) => (
        <div key={m.label} className="grid gap-1"><div className="flex justify-between text-sm"><span>{m.label}</span><span className="opacity-70">{Math.round(m.value * 100)}%</span></div>
          <Suspense fallback={<div className="h-2 rounded-full bg-black/10" />}><Progress value={Math.round(Math.min(1, m.value) * 100)} aria-label={m.label} /></Suspense>
          {m.detail && <p className="text-xs opacity-60">{m.detail}</p>}</div>))}</div>);
    case 'status': return (
      <ul className="grid gap-2">{(b as Extract<Block, { type: 'status' }>).items.map((s) => (
        <Arrive as="li" key={s.label} k={`ss:${s.label}\0${s.text ?? ''}\0${s.tone ?? ''}`} className="flex items-center gap-2 text-sm"><span className={`size-2 rounded-full ${DOT[s.tone ?? 'muted']}`} /><span className="font-medium">{s.label}</span>
          <span className="opacity-70">{s.text}</span>{s.meta && <span className="ml-auto text-xs opacity-60">{s.meta}</span>}</Arrive>))}</ul>);
    case 'link': return <PageLink l={b as Extract<Block, { type: 'link' }>} />;
    case 'code': { const text = (b as { text: string }).text;
      return <Suspense fallback={<pre className="overflow-x-auto rounded-xl p-3 text-xs">{text}</pre>}><CodeBlock code={text} /></Suspense>; }
    case 'buttons': return <div className="flex flex-wrap gap-2">{(b as Extract<Block, { type: 'buttons' }>).items.map((x) => <ActButton key={x.action + x.label} b={x} />)}</div>;
    case 'form': return <Form form={b as Extract<Block, { type: 'form' }>} />;
    case 'details': return <DetailsBlock b={b as Extract<Block, { type: 'details' }>} />;
    case 'filters': return <Filters b={b as Extract<Block, { type: 'filters' }>} />;
    default: return <p className="text-sm opacity-60">(a {b.type} block this app can't draw yet)</p>;
  }
}
