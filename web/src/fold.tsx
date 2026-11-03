// A section that folds (docs/extensions.md, `fold`): its own chunk, so a page without one never loads it.
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { BlockView } from './blocks';
import type { Page } from './loom';
import '@/styles/cojeev/collapsible.css';

const ring = (s: Page['sections'][number]) => (s.tone === 'bad' ? 'ring-1 ring-red-400' : s.tone === 'warn' ? 'ring-1 ring-amber-400' : undefined);

/** Whether a folding section is open: the viewer's last say on this page, else the piece's (`fold`). */
const foldKey = (id: string) => `loom:fold:${location.pathname}:${id}`;
function foldOpen(s: Page['sections'][number]): boolean {
  try { const v = localStorage.getItem(foldKey(s.id)); if (v === '1' || v === '0') return v === '1'; } catch { /* no storage: the piece's say */ }
  return s.fold === 'open';
}

/** A section that folds under its title (000h's collapsible), its count or state in the title as the piece wrote it. */
export default function FoldCard({ s }: { s: Page['sections'][number] }) {
  const [open, setOpen] = useState(() => foldOpen(s));
  const toggle = (v: boolean) => { setOpen(v); try { localStorage.setItem(foldKey(s.id), v ? '1' : '0'); } catch { /* this visit only */ } };
  return (
    <Card className={ring(s)}>
      <Collapsible open={open} onOpenChange={toggle}>
        {/* Folded, the title is all there is: no room kept below it for a body that isn't there. */}
        <CardHeader className={open ? undefined : 'mb-0'}>
          <CollapsibleTrigger className="-my-2 flex w-full justify-between text-left" style={{ color: "var(--v-text)" }}>
            <CardTitle>{s.title}</CardTitle>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent><CardContent className="grid min-w-0 gap-4">{s.blocks.map((b, n) => <BlockView key={n} b={b} />)}</CardContent></CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
