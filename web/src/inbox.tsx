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

const useEnv = () => useContext(EnvContext)!;

type InboxItem = { key: string; kind: 'permission' | 'decision' | 'reply' | 'fyi' | 'answered'; attention: boolean; unread: boolean; text: string; meta?: string; at?: string; agent?: string; source: Source; sourceLabel?: string; page?: string; label?: string; actions?: Btn[]; outcome?: string };
const KIND: Record<InboxItem['kind'], string> = { permission: 'Permission', decision: 'Decision', reply: 'Reply', fyi: 'FYI', answered: 'Answered' };

export function InboxView({ items, folder, chrome }: { items: InboxItem[]; folder: string; chrome: Chrome }) {
  const { go, ctx } = useEnv();
  const [open, setOpen] = useState<InboxItem | null>(null);
  const agents = ctx.agents ?? {};
  const need = items.filter((i) => i.attention);
  const rest = items.filter((i) => !i.attention);
  const row = (i: InboxItem) => (
    <Arrive as="li" key={i.key} k={`in:${i.key}\0${i.kind}`}>
      <button className="flex w-full min-w-0 items-start gap-3 py-3 text-left" onClick={() => setOpen(i)}>
        {i.agent && agents[i.agent] ? <Mark a={agents[i.agent]} size={28} /> : <span className="size-7" />}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">{i.unread && <span className="size-2 shrink-0 rounded-full bg-[var(--loom-accent,#2563eb)]" />}
            <span className={`truncate ${i.unread ? 'font-semibold' : 'font-medium'}`}>{i.text}</span></span>
          <span className="block truncate text-sm opacity-70">{i.outcome ?? i.meta ?? ''}</span>
        </span>
        <Badge variant={i.attention ? 'pending' : 'default'}>{KIND[i.kind]}</Badge>
      </button>
    </Arrive>
  );
  return (
    <div className="grid gap-4">
      <ToggleGroup type="single" className="v-seg self-start" aria-label="Inbox folder" value={folder} onValueChange={(f) => { if (f) go(`/inbox${f === 'needs' ? '' : `?folder=${f}`}`); }}>
        {[['needs', 'Needs you'], ['all', 'Everything']].map(([f, l]) => <ToggleGroupItem key={f} value={f}>{l}</ToggleGroupItem>)}</ToggleGroup>
      {need.length > 0 && <Card><CardHeader><CardTitle>Needs you · {need.length}</CardTitle></CardHeader><CardContent><ul className="divide-y">{need.map(row)}</ul></CardContent></Card>}
      {need.length === 0 && <Nothing title="Nothing needs you" text="Asks from your agents land here." />}
      {rest.length > 0 && <Card><CardHeader><CardTitle>Lately</CardTitle></CardHeader><CardContent><ul className="divide-y">{rest.map(row)}</ul></CardContent></Card>}
      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        {open && (
          <DrawerContent className="lg:mx-auto lg:max-w-xl">
            <DrawerHeader><DrawerTitle>{open.text}</DrawerTitle><DrawerDescription>{[open.sourceLabel ?? open.source.id, open.agent].filter(Boolean).join(' · ')}</DrawerDescription></DrawerHeader>
            {open.meta && <p className="text-sm">{open.meta}</p>}
            {open.outcome && <p className="text-sm opacity-80">{open.outcome}</p>}
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
