// The Inbox: its own chunk, loaded when it opens (it and its folder switch aren't on the first page).
import { useContext, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Arrive } from './arrive';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ActButton, EnvContext, Link, Nothing } from './blocks';
import type { Button as Btn, Chrome, Source } from './loom';
import { As, Mark } from './views';
import { plain } from './plain';

const useEnv = () => useContext(EnvContext)!;

type InboxItem = { key: string; kind: 'permission' | 'decision' | 'reply' | 'fyi' | 'answered'; attention: boolean; unread: boolean; text: string; meta?: string; at?: string; agent?: string; source: Source; sourceLabel?: string; page?: string; label?: string; actions?: Btn[]; outcome?: string };
const KIND: Record<InboxItem['kind'], string> = { permission: 'Permission', decision: 'Decision', reply: 'Reply', fyi: 'FYI', answered: 'Answered' };

export function InboxView({ items, folder, chrome }: { items: InboxItem[]; folder: string; chrome: Chrome }) {
  const { ctx } = useEnv();
  const [open, setOpen] = useState<InboxItem | null>(null);
  // The switch is this page's own: every item came with it, so it filters here, at once.
  const [show, setShow] = useState(folder === 'needs' ? 'needs' : 'all');
  const agents = ctx.agents ?? {};
  const name = (a?: string) => (a && agents[a]?.label) || (a ? a[0].toUpperCase() + a.slice(1) : '');
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
            {p.why && <span className="block truncate text-sm opacity-70">{p.why}</span>}
          </span>
          <Badge variant={i.attention ? 'pending' : 'default'} className="shrink-0">{p.ended ?? KIND[i.kind]}</Badge>
        </button>
      </Arrive>
    );
  };
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <ToggleGroup type="single" className="v-seg self-start justify-self-start" aria-label="Show" value={show} onValueChange={(f) => { if (f) setShow(f); }}>
        {[['needs', `Needs you${need.length ? ` · ${need.length}` : ''}`], ['all', 'Everything']].map(([f, l]) => <ToggleGroupItem key={f} value={f}>{l}</ToggleGroupItem>)}</ToggleGroup>
      {need.length > 0 && <Card className="min-w-0"><CardHeader><CardTitle>Needs you · {need.length}</CardTitle></CardHeader><CardContent><ul className="min-w-0 divide-y">{need.map(row)}</ul></CardContent></Card>}
      {need.length === 0 && show === 'needs' && <Nothing title="Nothing needs you" text={rest.length ? `${rest.length} answered and FYI in Everything.` : 'Asks from your agents land here.'} />}
      {show === 'all' && rest.length > 0 && <Card className="min-w-0"><CardHeader><CardTitle>Lately</CardTitle></CardHeader><CardContent><ul className="min-w-0 divide-y">{rest.map(row)}</ul></CardContent></Card>}
      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        {open && (
          <DrawerContent className="lg:mx-auto lg:max-w-xl">
            {(() => { const p = plain(open, name(open.agent)); return (<>
              <DrawerHeader><DrawerTitle>{p.title}</DrawerTitle><DrawerDescription>{[open.sourceLabel ?? open.source.id, name(open.agent), KIND[open.kind]].filter(Boolean).join(' · ')}</DrawerDescription></DrawerHeader>
              {p.why && p.why !== open.outcome && <p className="text-sm">{p.why}</p>}
              {open.meta && open.meta !== p.why && <p className="text-sm">{open.meta}</p>}
              {open.outcome && <p className="text-sm opacity-80">{open.outcome}</p>}
              {p.title !== open.text && <p className="break-words text-xs opacity-60">As asked: {open.text}</p>}
            </>); })()}
            <As source={open.source}>
              <div className="grid gap-2">
                {open.actions?.map((b) => <ActButton key={b.action + b.label} b={b} size="default" full onDone={() => setOpen(null)} />)}
                {open.page !== undefined && <Link page={open.page} className="text-center underline underline-offset-4">{open.label ?? 'Open it'}</Link>}
              </div>
            </As>
          </DrawerContent>
        )}
      </Drawer>
      {void chrome}
    </div>
  );
}
