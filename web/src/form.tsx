// A form block and the editor a details holding one opens (blocks.tsx): 000h's fields, radio chips, switches,
// checkboxes and dialog. Its own chunk: Home's first screen draws no form (web-app.test.ts, the first page's weight).
import { lazy, Suspense, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field as UiField, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useEnv } from './blocks';
import type { Block, Field } from './loom';
const ChoiceSelect = lazy(() => import('./choice-select'));
const Chips = lazy(() => import('./filters').then((m) => ({ default: m.Chips })));


function FieldInput({ f, value, set, id }: { f: Field; value: string; set: (v: string) => void; id: string }) {
  if (f.kind === 'textarea') return <Textarea id={id} value={value} required={f.required} onChange={(e) => set(e.target.value)} />;
  if (f.kind === 'toggle') return <Switch id={id} checked={value === 'on' || value === 'true'} onCheckedChange={(c) => set(c ? 'on' : '')} />;
  // A segmented control: one of a few, side by side.
  if (f.kind === 'segmented') return <Suspense fallback={<Input id={id} value={value} readOnly />}><Chips f={f} value={value} set={set} id={id} /></Suspense>;
  if (f.kind === 'stepper') return <Suspense fallback={<Input id={id} value={value} readOnly />}><Chips f={f} value={value} set={set} id={id} /></Suspense>;
  // One box (000h's checkbox): "on" or "". Several: the ticked values, joined with commas.
  if (f.kind === 'check') return <Checkbox id={id} checked={value === 'on'} onCheckedChange={(c) => set(c === true ? 'on' : '')}>{f.hint ? null : f.label}</Checkbox>;
  if (f.kind === 'checks') {
    const on = new Set(value.split(',').filter(Boolean));
    // A few short choices (the days of a week) are chips in a row, any number pressed.
    if ((f.options?.length ?? 0) <= 7 && f.options?.every((o) => o.label.length <= 4)) return <Suspense fallback={null}><Chips f={f} value={value} set={set} id={id} /></Suspense>;
    return (
      <div id={id} role="group" aria-label={f.label} className="grid gap-2">{f.options?.map((o) => (
        <Checkbox key={o.value} checked={on.has(o.value)} onCheckedChange={(c) => {
          const next = new Set(on); if (c === true) next.add(o.value); else next.delete(o.value);
          set((f.options ?? []).map((x) => x.value).filter((v) => next.has(v)).join(','));
        }}>{o.label}</Checkbox>))}
      </div>
    );
  }
  // A time of day (Jonathan, 2026-10-30: "and the time picker"): the device's own picker, which shows it as its owner
  // reads time (2:30 PM here); "HH:MM" on the wire. Several: a row each, a way to drop one, and one to add another.
  if (f.kind === 'time') {
    const times = value ? value.split(',').map((t) => t.trim()) : [''];
    const put = (next: string[]) => set(next.filter(Boolean).join(','));
    return (
      <div id={id} role="group" aria-label={f.label} className="grid gap-2">
        {times.map((t, n) => (
          <div key={n} className="flex items-center gap-2">
            <Input type="time" aria-label={times.length > 1 ? `${f.label} ${n + 1}` : f.label} value={t} required={f.required && n === 0} className="w-40"
              onChange={(e) => { const next = [...times]; next[n] = e.target.value; put(next.length ? next : ['']); if (!e.target.value && times.length === 1) set(''); }} />
            {f.multiple && times.length > 1 && <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${t || 'this time'}`} onClick={() => put(times.filter((_, i) => i !== n))}>Remove</Button>}
          </div>
        ))}
        {f.multiple && times.every(Boolean) && times.length < 12 && (
          <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => set([...times, ''].join(','))}>Add a time</Button>
        )}
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

export default function Form({ form, onDone, inDialog = false }: { form: Extract<Block, { type: 'form' }>; onDone?: () => void; inDialog?: boolean }) {
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
      // A time row added and left empty isn't sent: "07:17," is "07:17".
      const clean = Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, form.fields.find((f) => f.name === k)?.kind === 'time' ? v.split(',').map((t) => t.trim()).filter(Boolean).join(',') : v]));
      const ok = await send(form.action, { ...(form.hidden ?? {}), ...clean });
      setBusy(false); if (ok) onDone?.();
    }}>
      {!inDialog && form.title && <h4 className="font-medium">{form.title}</h4>}
      {fields}
      {inDialog ? <DialogFooter>{submit}</DialogFooter> : <div>{submit}</div>}
    </form>
  );
}

/** A form behind a button, opened as a focused editor. */
export function EditorButton({ label, title, form, variant = 'outline' }: { label: string; title: string; form: Extract<Block, { type: 'form' }>; variant?: 'outline' | 'default' | 'ghost' }) {
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
