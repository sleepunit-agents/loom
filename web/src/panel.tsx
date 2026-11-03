// A panel block: settings as an app's panel (Jonathan, 2026-11-03: "app panels, not web forms"). Each row says what the
// setting is now, in words, and holds one control: a switch that applies at once, a segmented control that applies at
// once, an edit that opens a sheet with a few fields, a sheet of detail, a link, or a button. Its own chunk.
import { useState, type ReactNode } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ActButton, BlockView, Link, Who, useEnv } from './blocks';
import Form from './form';
import { tidy } from './tidy';
import type { Block, PanelRow, Tone } from './loom';

const DOT: Record<Tone, string> = { ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', muted: 'bg-neutral-400' };

/** A sheet: a bottom drawer on a phone, a centred editor on a desktop. */
export function Sheet({ open, set, title, note, children }: { open: boolean; set: (o: boolean) => void; title: string; note?: string; children: ReactNode }) {
  const { wide } = useEnv();
  if (wide) {
    return (
      <Dialog open={open} onOpenChange={set}>
        <DialogContent appearance="editor" showCloseButton>
          <DialogHeader><DialogTitle>{title}</DialogTitle>{note && <DialogDescription>{note}</DialogDescription>}</DialogHeader>
          {children}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Drawer open={open} onOpenChange={set}>
      <DrawerContent>
        <DrawerHeader className="flex-col"><DrawerTitle>{title}</DrawerTitle>{note && <DrawerDescription>{note}</DrawerDescription>}</DrawerHeader>
        <div className="grid max-h-[70dvh] min-w-0 grid-cols-[minmax(0,1fr)] gap-3 overflow-y-auto px-4 pb-6">{children}</div>
      </DrawerContent>
    </Drawer>
  );
}

/** A switch that applies at once, and goes back if the piece says no. */
function RowToggle({ r }: { r: PanelRow }) {
  const { send } = useEnv();
  const t = r.toggle!;
  const [on, setOn] = useState(t.on);
  const [busy, setBusy] = useState(false);
  return (
    <Switch aria-label={r.label} checked={on} disabled={busy} onCheckedChange={async (c) => {
      setOn(c); setBusy(true);
      const ok = await send(t.action, { ...(t.fields ?? {}), on: c ? 'on' : '' });
      setBusy(false); if (!ok) setOn(!c);
    }} />
  );
}

/** A segmented control that applies at once. */
function RowChoice({ r }: { r: PanelRow }) {
  const { send } = useEnv();
  const c = r.choice!;
  const [value, setValue] = useState(c.value);
  const [busy, setBusy] = useState(false);
  return (
    <ToggleGroup type="single" className={c.options.length > 3 ? undefined : 'v-seg'} aria-label={r.label} value={value} disabled={busy} onValueChange={async (v) => {
      if (!v || v === value) return;
      const was = value; setValue(v); setBusy(true);
      const ok = await send(c.action, { ...(c.fields ?? {}), [c.name]: v });
      setBusy(false); if (!ok) setValue(was);
    }}>
      {c.options.map((o) => <ToggleGroupItem key={o.value} value={o.value}>{o.label}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}

function Row({ r }: { r: PanelRow }) {
  const { wide } = useEnv();
  const [open, setOpen] = useState(false);
  const taps = !!(r.edit || r.sheet);
  // The row's words: its label, its value in a sentence, a line of detail. Never cut: a value wraps.
  const words = (
    <span className="grid min-w-0 flex-1 gap-0.5 text-left">
      <span className="flex min-w-0 items-center gap-2">
        {r.tone && <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[r.tone]}`} />}
        {r.agent && <Who agent={r.agent} size={20} />}
        <span className="font-medium [overflow-wrap:anywhere]">{tidy(r.label)}</span>
      </span>
      {r.value && <span className="text-sm opacity-75 [overflow-wrap:anywhere]">{tidy(r.value)}</span>}
      {r.detail && <span className="text-xs opacity-60 [overflow-wrap:anywhere]">{tidy(r.detail)}</span>}
    </span>
  );
  // A segmented control sits under its words on a phone (it needs the width), beside them on a desktop.
  const inline = r.choice && !wide;
  let body: ReactNode;
  if (r.page !== undefined || r.href) {
    body = <Link page={r.page} href={r.href} className="flex min-h-12 w-full min-w-0 items-center gap-3 py-3 no-underline">{words}<AnimatedIcon name="chevron-right" size="sm" /></Link>;
  } else if (taps) {
    body = (
      <button type="button" className="flex min-h-12 w-full min-w-0 items-center gap-3 py-3 text-left" onClick={() => setOpen(true)} aria-haspopup="dialog">
        {words}{r.edit && <span className="text-sm opacity-60">Edit</span>}<AnimatedIcon name="chevron-right" size="sm" />
      </button>
    );
  } else {
    body = (
      <div className={`flex min-h-12 w-full min-w-0 gap-3 py-3 ${inline ? 'flex-col items-stretch' : 'items-center'}`}>
        {words}
        {r.toggle && <RowToggle r={r} />}
        {r.choice && <RowChoice r={r} />}
        {r.act && <ActButton b={r.act} />}
      </div>
    );
  }
  return (
    <li className="min-w-0">
      {body}
      {r.edit && (
        <Sheet open={open} set={setOpen} title={r.edit.title ?? r.label} note={r.edit.note}>
          <Form form={{ type: 'form', action: r.edit.action, submit: r.edit.submit ?? 'Save', fields: r.edit.fields, hidden: r.edit.hidden }} inDialog={wide} onDone={() => setOpen(false)} />
        </Sheet>
      )}
      {r.sheet && (
        <Sheet open={open} set={setOpen} title={r.sheet.title ?? r.label}>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">{r.sheet.blocks.map((b, k) => <BlockView key={k} b={b} />)}</div>
        </Sheet>
      )}
    </li>
  );
}

export default function Panel({ b }: { b: Extract<Block, { type: 'panel' }> }) {
  const { wide } = useEnv();
  return (
    <div className="grid gap-2" data-slot="panel">
      {b.title && <h4 className="text-sm font-medium opacity-70">{b.title}</h4>}
      <ul className="min-w-0 divide-y rounded-[var(--r-card-sm)] bg-[var(--card-2)] px-4">{b.rows.map((r, n) => <Row key={`${r.label}\0${n}`} r={r} />)}</ul>
      {b.action && <div className="pt-1"><ActButton b={b.action} size="default" full={!wide} /></div>}
    </div>
  );
}

/** A status screen's headline: its state in a word or two, big, with a shape as well as a colour (never colour alone). */
export function Health({ b }: { b: Extract<Block, { type: 'health' }> }) {
  const icon = b.tone === 'ok' ? 'check' : b.tone === 'bad' ? 'x' : b.tone === 'warn' ? 'alert-triangle' : 'minus';
  const ring: Record<Tone, string> = { ok: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', warn: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    bad: 'bg-red-500/15 text-red-700 dark:text-red-300', muted: 'bg-neutral-500/15 opacity-80' };
  return (
    <div className="flex items-center gap-4" data-slot="health" data-tone={b.tone} role="status">
      <span className={`grid size-14 shrink-0 place-items-center rounded-full ${ring[b.tone]}`}><AnimatedIcon name={icon} size="lg" /></span>
      <span className="grid min-w-0 gap-0.5">
        <span className="text-2xl font-semibold leading-tight [overflow-wrap:anywhere]">{tidy(b.text)}</span>
        {b.detail && <span className="text-sm opacity-70 [overflow-wrap:anywhere]">{tidy(b.detail)}</span>}
      </span>
    </div>
  );
}

/** A tile's small trend: a line over its numbers, oldest first. Drawn for the eye; its last value is in the tile's words. */
export function Spark({ values, tone }: { values: number[]; tone?: Tone }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - lo) / span) * 24}`).join(' ');
  const stroke = tone === 'bad' ? 'var(--v-danger, #c0392b)' : tone === 'warn' ? 'var(--v-yellow-deep, #b8860b)' : 'currentColor';
  return (
    <svg aria-hidden viewBox="0 0 100 30" preserveAspectRatio="none" className="mt-2 h-7 w-full opacity-70">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
