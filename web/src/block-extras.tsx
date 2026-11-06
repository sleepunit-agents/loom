// The parts of blocks.tsx Home's first screen never draws, in their own chunk (web-app.test.ts, the first page's
// weight): the confirm a danger button asks (000h's alert dialog), a desktop's table and a long list's pages.
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { usePortalContainer } from '@/components/ui/portal-container';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from '@/components/ui/pagination';
import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Arrive } from './arrive';
import type { Button as Btn } from './loom';

/** A danger (or confirm) button's question, before it sends. In a tile (the tiled desktop) it's modal to its tile only,
 * which an alert dialog can't be (Radix's is always the screen's): a dialog with the alert's role and the same answers,
 * that a press outside doesn't close. */
export function Confirm({ b, open, onOpenChange, fire }: { b: Btn; open: boolean; onOpenChange: (o: boolean) => void; fire: () => void }) {
  const tile = usePortalContainer();
  if (tile) return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent role="alertdialog" appearance="confirmation" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader><DialogTitle>{b.label}?</DialogTitle>
          <DialogDescription>{b.confirm ?? 'This can\'t be undone from here.'}</DialogDescription></DialogHeader>
        <DialogFooter><DialogClose asChild><Button variant="secondary">Keep it</Button></DialogClose>
          <Button variant="danger" onClick={() => { onOpenChange(false); fire(); }}>{b.label}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{b.label}?</AlertDialogTitle>
          <AlertDialogDescription>{b.confirm ?? 'This can\'t be undone from here.'}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={fire}>{b.label}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Numbered pages (000h's pagination): the pages around this one, the first and the last; gaps as an ellipsis. */
export function Pager({ page, pages, shown, to, total }: { page: number; pages: number; shown: number[]; to: (p: number) => void; total?: number }) {
  return (
    <Pagination className="mt-2" aria-label="Pages of this list">
      <PaginationContent>
        <PaginationItem><PaginationPrevious disabled={page === 0} onClick={() => to(page - 1)} /></PaginationItem>
        {shown.map((p, i) => [
          i && p - shown[i - 1] > 1 ? <PaginationItem key={`e${p}`}><PaginationEllipsis /></PaginationItem> : null,
          <PaginationItem key={p}><PaginationLink isActive={p === page} aria-current={p === page ? 'page' : undefined} onClick={() => to(p)}>{p + 1}</PaginationLink></PaginationItem>,
        ])}
        <PaginationItem><PaginationNext disabled={page === pages - 1} onClick={() => to(page + 1)} /></PaginationItem>
      </PaginationContent>
      {total !== undefined && <p className="mt-1 text-xs opacity-60"><span className="loom-data">{total.toLocaleString()}</span> in all</p>}
    </Pagination>
  );
}

type Cell = string | { text: string; page?: string };
/** A desktop's table: 000h's table (its ledger look), rows as they come. */
export function WideTable({ columns, rows, cell }: { columns: string[]; rows: Cell[][]; cell: (c: Cell) => ReactNode }) {
  return (
    <TableContainer>
      <Table>
        <TableHeader><TableRow>{columns.map((c) => <TableHead key={c}>{c}</TableHead>)}</TableRow></TableHeader>
        <TableBody>{rows.map((r, n) => <Arrive as="tr" key={n} k={`tr:${JSON.stringify(r)}`} data-slot="table-row">{r.map((c, m) => <TableCell key={m} className="align-middle">{cell(c)}</TableCell>)}</Arrive>)}</TableBody>
      </Table>
    </TableContainer>
  );
}
