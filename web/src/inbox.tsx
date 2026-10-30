// The Inbox: its own chunk, loaded when it opens (it and its folder switch aren't on the first page).
import { useContext, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Button } from '@/components/ui/button';
import { Arrive } from './arrive';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ActButton, EnvContext, Link, Nothing } from './blocks';
import type { Button as Btn, Chrome, Source } from './loom';
import { As, Mark } from './views';
import { bits, plain } from './plain';
import { tidy } from './tidy';

const useEnv = () => useContext(EnvContext)!;

type InboxItem = { key: string; kind: 'permission' | 'decision' | 'reply' | 'fyi' | 'answered'; attention: boolean; unread: boolean; text: string; meta?: string; at?: string; expires?: string; agent?: string; source: Source; sourceLabel?: string; page?: string; label?: string; actions?: Btn[]; outcome?: string };
const KIND: Record<InboxItem['kind'], string> = { permission: 'Permission', decision: 'Decision', reply: 'Reply', fyi: 'FYI', answered: 'Answered' };

export function InboxView({ items, folder, chrome }: { items: InboxItem[]; folder: string; chrome: Chrome }) {
  const { ctx } = useEnv();
  const [open, setOpen] = useState<InboxItem | null>(null);
  // The switch is this page's own: every item came with it, so it filters here, at once.
  const [show, setShow] = useState(folder === 'needs' ? 'needs' : 'all');
  const agents = ctx.agents ?? {};
  const name = (a?: string) => (a && agents[a]?.label) || (a ? a[0].toUpperCase() + a.slice(1) : '');
  const tasks = items.find((i) => i.source.id === 'tasks')?.source ?? { id: 'tasks', base: '/p/tasks/' };
  const need = items.filter((i) => i.attention);
  const rest = items.filter((i) => !i.attention);
  const row = (i: InboxItem) => {
    const p = plain(i, name(i.agent));
    return (
      <Arrive as="li" key={i.key} k={`in:${i.key}\0${i.kind}`} className="min-w-0">
        <button className="flex w-full min-w-0 items-start gap-3 py-3 text-left" onClick={() => setOpen(i)}>
          {i.agent && agents[i.agent] ? <Mark a={agents[i.agent]} size={28} /> : <span className="size-7 shrink-0" />}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">{i.unread && <span className="size-2 shrink-0 rounded-full bg-[var(--loom-accent,#2563eb)]" />}
              <span className={`truncate ${i.unread ? 'font-semibold' : 'font-medium'}`}>{p.title}</span></span>
            {(p.why ?? i.outcome) && <span className="block truncate text-sm opacity-70">{tidy(p.why ?? i.outcome ?? '')}</span>}
          </span>
          <Badge variant={i.attention ? 'pending' : 'default'} className="shrink-0">{p.ended ?? KIND[i.kind]}</Badge>
        </button>
      </Arrive>
    );
  };
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <ToggleGroup type="single" className="self-start justify-self-start" aria-label="Show" value={show} onValueChange={(f) => { if (f) setShow(f); }}>
        {[['needs', `Needs you${need.length ? ` · ${need.length}` : ''}`], ['all', 'Everything']].map(([f, l]) => <ToggleGroupItem key={f} value={f}>{l}</ToggleGroupItem>)}</ToggleGroup>
      {need.length > 0 && <Card className="min-w-0"><CardHeader><CardTitle>Needs you · {need.length}</CardTitle></CardHeader><CardContent><ul className="min-w-0 divide-y">{need.map(row)}</ul></CardContent></Card>}
      {need.length === 0 && show === 'needs' && <Nothing title="Nothing needs you" text={rest.length ? `${rest.length} answered and FYI in Everything.` : 'Asks from your agents land here.'} />}
      {show === 'all' && rest.length > 0 && <Card className="min-w-0"><CardHeader><CardTitle>Lately</CardTitle></CardHeader><CardContent><ul className="min-w-0 divide-y">{rest.map(row)}</ul></CardContent></Card>}
      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        {open && <ItemSheet i={open} who={name(open.agent)} mark={open.agent ? agents[open.agent] : undefined} tasks={tasks} onDone={() => setOpen(null)} />}
      </Drawer>
      {void chrome}
    </div>
  );
}

const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
function when(at?: string): string | undefined {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return undefined;
  const m = Math.round((Date.now() - t) / 60000);
  const ago = m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  return `${new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${ago}`;
}

/** An item, opened (Jonathan, 2026-10-29: "we should be presenting enough here that open it is unnecessary"): who
 * asked and where, what for (its tasks and pull requests a tap away), and how it was answered, laid out; a way to its
 * own page only when it has one (an item whose page is its piece's front page has nowhere more to go). */
function ItemSheet({ i, who, mark, tasks, onDone }: { i: InboxItem; who: string; mark?: { label: string; bg: string; fg: string }; tasks: Source; onDone: () => void }) {
  const p = plain(i, who);
  const from = cap(i.sourceLabel ?? i.source.id);
  const facts: [string, React.ReactNode][] = [];
  const asked = when(i.at);
  if (asked) facts.push([i.kind === 'fyi' ? 'When' : 'Asked', asked]);
  if (p.answer) facts.push(['Answer', [p.answer.verdict, p.answer.by && `by ${p.answer.by}`, p.answer.for && `for ${p.answer.for}`].filter(Boolean).join(' ')]);
  else if (i.outcome) facts.push(['Answer', i.outcome]);
  const left = i.expires ? when(i.expires) : undefined;
  if (left && i.attention) facts.push(['Until', left.split(' · ')[0]]);
  const why = tidy(p.why ?? (i.kind !== 'answered' ? i.meta : undefined) ?? '') || undefined;
  const own = i.page !== undefined && i.page !== '';
  return (
    <DrawerContent className="lg:mx-auto lg:max-w-xl">
      <DrawerHeader className="flex-col items-stretch gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {mark ? <Mark a={mark} size={36} /> : null}
          <DrawerDescription className="min-w-0 truncate text-sm">{[who, from].filter(Boolean).join(' · ')}</DrawerDescription>
          <Badge variant={i.attention ? 'pending' : 'default'} className="ml-auto shrink-0">{p.ended ?? KIND[i.kind]}</Badge>
        </div>
        <DrawerTitle className="mb-0 text-left leading-snug">{p.head}</DrawerTitle>
        {p.subject && <code className="self-start break-all rounded-lg bg-[color:var(--v-beige)] px-2 py-1 text-sm">{p.subject}</code>}
      </DrawerHeader>
      <div className="grid gap-5 py-2">
        {why && (
          <section className="grid gap-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide opacity-60">{i.kind === 'fyi' ? 'Details' : 'Why'}</h3>
            <p className="break-words leading-relaxed">{bits(why).map((b, n) => b.t === 'text' ? <span key={n}>{b.s}</span>
              : b.t === 'task' ? <As key={n} source={tasks}><Link page={`task/${b.id}`} className="font-medium underline underline-offset-4">{b.id}</Link></As>
              : b.t === 'pr' ? <Link key={n} href={`https://github.com/${b.repo}/pull/${b.n}`} className="font-medium underline underline-offset-4">{b.repo}#{b.n}</Link>
              : <code key={n} className="break-all rounded bg-[color:var(--v-beige)] px-1 text-[0.9em]">{b.s}</code>)}</p>
          </section>
        )}
        {facts.length > 0 && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm">
            {facts.map(([k, v]) => [<dt key={`${k}k`} className="opacity-60">{k}</dt>, <dd key={`${k}v`} className="min-w-0">{v}</dd>])}
          </dl>
        )}
      </div>
      <As source={i.source}>
        <DrawerFooter className="flex-col-reverse items-stretch sm:flex-row sm:items-center">
          <DrawerClose asChild><Button variant="outline">Close</Button></DrawerClose>
          {own && !i.actions?.length && <Button asChild variant="outline"><Link page={i.page}>{i.label ?? `Open in ${from}`}</Link></Button>}
          {i.actions?.map((b) => <ActButton key={b.action + b.label} b={b} size="default" onDone={onDone} />)}
        </DrawerFooter>
      </As>
    </DrawerContent>
  );
}
