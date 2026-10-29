// loom's blocks (src/ui/vocab.ts) drawn with 000h's components, by the rules in docs/specs/ui-app.md:
// a details holding a form opens as an editor, one holding a list or a table as a drawer; danger asks
// first; a table is rows of label and value on a phone; a block this app doesn't know is shown, not dropped.
import { createContext, useContext, useState, type ReactNode } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { pageHref, type Block, type Button as Btn, type Ctx, type Field, type ListItem, type Tone } from './loom';

/** What a block needs from the page around it: where links go, how an action is sent, whether it's a phone. */
export interface Env { ctx: Ctx; send: (action: string, fields: Record<string, string>) => Promise<boolean>; go: (href: string) => void; wide: boolean }
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
  if (f.kind === 'choice') {
    return (
      <Select value={value === '' ? '_' : value} onValueChange={(v) => set(v === '_' ? '' : v)}>
        <SelectTrigger id={id} className="w-full min-w-0 [&>span]:truncate"><SelectValue /></SelectTrigger>
        <SelectContent>{f.options?.map((o) => <SelectItem key={o.value || '_'} value={o.value || '_'}>{o.label}</SelectItem>)}</SelectContent>
      </Select>
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
        <div key={f.name} className="grid gap-1.5">
          <Label htmlFor={`${form.action}-${f.name}`}>{f.label}</Label>
          <FieldInput id={`${form.action}-${f.name}`} f={f} value={vals[f.name] ?? ''} set={(v) => setVals((s) => ({ ...s, [f.name]: v }))} />
          {f.hint && <p className="text-xs opacity-60">{f.hint}</p>}
        </div>
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
  const body = (
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-2">
        {i.tone && <span className={`size-2 shrink-0 rounded-full ${DOT[i.tone]}`} />}
        {i.agent && env.ctx.agents?.[i.agent] && <span className="grid size-5 shrink-0 place-items-center rounded-md text-[10px] font-semibold"
          style={{ background: env.ctx.agents[i.agent].bg, color: env.ctx.agents[i.agent].fg }}>{env.ctx.agents[i.agent].label[0]}</span>}
        <span className="truncate font-medium">{i.text}</span>
        {i.badge && <Badge variant={(BADGE[i.badge] ?? 'default') as 'default'}>{i.badge}</Badge>}
      </span>
      {i.meta && <span className="block truncate text-sm opacity-70">{i.meta}</span>}
    </span>
  );
  return (
    <li className="flex min-h-11 items-center gap-3 py-2.5">
      {i.page !== undefined || i.href ? <Link page={i.page} href={i.href} className="flex min-w-0 flex-1 items-center gap-2">{body}{i.act ? null : <AnimatedIcon name="chevron-right" size="sm" />}</Link> : body}
      {i.act && <ActButton b={i.act} />}
    </li>
  );
}

function TableBlock({ b }: { b: Extract<Block, { type: 'table' }> }) {
  const { wide } = useEnv();
  const cell = (c: string | { text: string; page?: string }) => (typeof c === 'string' ? c : <Link page={c.page}>{c.text}</Link>);
  if (!wide) {
    return (
      <ul className="divide-y">{b.rows.map((r, n) => (
        <li key={n} className="grid gap-0.5 py-2.5">
          <span className="font-medium">{cell(r[0])}</span>
          <span className="text-sm opacity-70">{r.slice(1).map((c, m) => <span key={m}>{m ? ' · ' : ''}{cell(c)}</span>)}</span>
        </li>))}
      </ul>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-left opacity-60">{b.columns.map((c) => <th key={c} className="py-2 pr-4 font-medium">{c}</th>)}</tr></thead>
        <tbody className="divide-y">{b.rows.map((r, n) => <tr key={n}>{r.map((c, m) => <td key={m} className="py-2 pr-4 align-top">{cell(c)}</td>)}</tr>)}</tbody>
      </table>
    </div>
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

export function BlockView({ b }: { b: Block }) {
  switch (b.type) {
    case 'text': { const t = b as Extract<Block, { type: 'text' }>; return <p className={t.tone === 'muted' ? 'text-sm opacity-70' : ''}>{t.text}</p>; }
    case 'prose': return <div className="prose whitespace-pre-wrap">{(b as { text: string }).text}</div>;
    case 'callout': { const c = b as Extract<Block, { type: 'callout' }>;
      return <div className={`rounded-2xl border p-4 ${c.tone === 'bad' ? 'border-red-300 bg-red-50 dark:bg-red-950/30' : c.tone === 'warn' ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/30' : 'opacity-90'}`}>
        {c.title && <p className="font-medium">{c.title}</p>}<p className="text-sm">{c.text}</p></div>; }
    case 'list': return <ul className="divide-y">{(b as Extract<Block, { type: 'list' }>).items.map((i, n) => <Row key={n} i={i} />)}</ul>;
    case 'table': return <TableBlock b={b as Extract<Block, { type: 'table' }>} />;
    case 'kv': return (
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {(b as Extract<Block, { type: 'kv' }>).items.map((i) => [<dt key={`${i.label}k`} className="opacity-70">{i.label}</dt>,
          <dd key={`${i.label}v`} className="min-w-0 [overflow-wrap:anywhere]">{i.page !== undefined ? <Link page={i.page}>{i.value}</Link> : i.value}</dd>])}
      </dl>);
    case 'stats': return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{(b as Extract<Block, { type: 'stats' }>).items.map((s) => (
        <Link key={s.label} page={s.page} className="rounded-2xl border p-3"><span className="block text-xs opacity-60">{s.label}</span>
          <span className="block text-xl font-semibold">{s.value}</span>{s.detail && <span className="block text-xs opacity-60">{s.detail}</span>}</Link>))}</div>);
    case 'meter': return (
      <div className="grid gap-3">{(b as Extract<Block, { type: 'meter' }>).items.map((m) => (
        <div key={m.label}><div className="flex justify-between text-sm"><span>{m.label}</span><span className="opacity-70">{Math.round(m.value * 100)}%</span></div>
          <div className="mt-1 h-2 rounded-full bg-black/10 dark:bg-white/10"><div className={`h-2 rounded-full ${m.tone === 'bad' ? 'bg-red-500' : m.tone === 'warn' ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, m.value * 100)}%` }} /></div>
          {m.detail && <p className="text-xs opacity-60">{m.detail}</p>}</div>))}</div>);
    case 'status': return (
      <ul className="grid gap-2">{(b as Extract<Block, { type: 'status' }>).items.map((s) => (
        <li key={s.label} className="flex items-center gap-2 text-sm"><span className={`size-2 rounded-full ${DOT[s.tone ?? 'muted']}`} /><span className="font-medium">{s.label}</span>
          <span className="opacity-70">{s.text}</span>{s.meta && <span className="ml-auto text-xs opacity-60">{s.meta}</span>}</li>))}</ul>);
    case 'link': { const l = b as Extract<Block, { type: 'link' }>; return <Link page={l.page} href={l.href} className="underline underline-offset-4">{l.text}</Link>; }
    case 'code': return <pre className="overflow-x-auto rounded-xl bg-neutral-900 p-3 text-xs text-neutral-100">{(b as { text: string }).text}</pre>;
    case 'buttons': return <div className="flex flex-wrap gap-2">{(b as Extract<Block, { type: 'buttons' }>).items.map((x) => <ActButton key={x.action + x.label} b={x} />)}</div>;
    case 'form': return <Form form={b as Extract<Block, { type: 'form' }>} />;
    case 'details': return <DetailsBlock b={b as Extract<Block, { type: 'details' }>} />;
    default: return <p className="text-sm opacity-60">(a {b.type} block this app can't draw yet: open the classic page to see it)</p>;
  }
}
