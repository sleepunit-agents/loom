// A details block (blocks.tsx), by what it holds: a form is an editor; a list or a table a drawer; anything else a
// drawer too. Its own chunk, with 000h's drawer: Home's first screen has none (web-app.test.ts, the first page's weight).
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { ActButton, BlockView } from './blocks';
import { EditorButton } from './form';
import type { Block } from './loom';

/** A details, by what it holds: a form is an editor; a list or a table a drawer; anything else a drawer too. */
export default function DetailsBlock({ b }: { b: Extract<Block, { type: 'details' }> }) {
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
          <DrawerHeader className="flex-col"><DrawerTitle>{b.summary}</DrawerTitle>{b.meta && <DrawerDescription>{b.meta}</DrawerDescription>}</DrawerHeader>
          <div className="grid gap-3">{b.blocks.map((x, k) => (x.type === 'form'
            ? <EditorButton key={k} label={(x as { title?: string }).title ?? b.summary} title={(x as { title?: string }).title ?? b.summary} form={x as Extract<Block, { type: 'form' }>} variant="default" />
            : x.type === 'buttons' ? <div key={k} className="grid gap-2">{(x as Extract<Block, { type: 'buttons' }>).items.map((y) => <ActButton key={y.label} b={y} full size="default" onDone={() => setOpen(false)} />)}</div>
              : <BlockView key={k} b={x} />))}</div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
