// A master/detail app (t-1925; docs/specs/ui-app.md, "Master/detail"): folders, a list, and the open item beside it,
// the way a mail client is laid out. The Inbox and Knowledge are drawn with it; any app whose page is "pick one of
// many, then read it" can be.
//
// It sizes itself to its own box, not the screen (a tile can be any width): three panes when there's room (folders |
// list | reader), two (the list with the folders as chips over it | reader), or one (chips and the list; the open item
// slides over the list with a way back), the way mail is on a phone. The reader is the widest pane.
//
// Keys: ↑ and ↓ move through the list (and open the next item where the reader is beside it); Enter opens one; Escape
// in a one-pane reader goes back to the list, and focus comes back to the row it opened from.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '@/components/ui/icon';
import './split.css';

export type SplitFolder = { id: string; label: string; count?: number; icon?: string; loud?: boolean; sub?: boolean } | { heading: string };
export type SplitMode = 'three' | 'two' | 'one';

/** The widths it changes at: its own box's, in px. */
export const SPLIT_THREE_FROM = 900;
export const SPLIT_TWO_FROM = 640;

const modeFor = (w: number): SplitMode => (w >= SPLIT_THREE_FROM ? 'three' : w >= SPLIT_TWO_FROM ? 'two' : 'one');

/** The pane mode for an element's width, kept current as it's resized. */
export function useSplitMode(): [React.RefObject<HTMLDivElement | null>, SplitMode] {
  const box = useRef<HTMLDivElement>(null);
  // Before it's measured: what the screen suggests (a phone is one pane), so the first draw is rarely wrong.
  const [mode, setMode] = useState<SplitMode>(() => modeFor(typeof innerWidth === 'number' ? Math.min(innerWidth, 1200) : 1200));
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = (w: number) => { if (w > 0) setMode(modeFor(w)); };
    fit(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => fit(e.borderBoxSize?.[0]?.inlineSize ?? el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [box, mode];
}

const isFolder = (f: SplitFolder): f is Extract<SplitFolder, { id: string }> => 'id' in f;

export function Split({ label, folders, folder, onFolder, isOn, narrow, listTop, search, listTitle, listMeta, list, reader, open, onBack, backLabel, blank, className, showZeroCounts = false }: {
  /** The app's name: the landmarks say it ("Inbox folders", "Inbox list"). */
  label: string;
  showZeroCounts?: boolean;
  folders: SplitFolder[];
  folder: string;
  onFolder: (id: string) => void;
  /** Filters, not folders (Activity's): several can be on at once, each a toggle (aria-pressed) instead of the one current. */
  isOn?: (id: string) => boolean;
  /** In two and one pane, this in place of the chips (Activity's filter menu). */
  narrow?: ReactNode;
  /** Over the rows, under the list's heading (Activity's day strip): stays put while the rows scroll. */
  listTop?: ReactNode;
  /** A search field (or any control) over the folders. */
  search?: ReactNode;
  listTitle: ReactNode;
  listMeta?: ReactNode;
  /** The rows: buttons carrying `data-split-row` (and `aria-current` on the open one), so the keys can move through them. */
  list: ReactNode;
  /** The open item, drawn whole; null when nothing is open. */
  reader: ReactNode | null;
  /** Something is open (one pane: the reader is over the list). */
  open: boolean;
  /** Back to the list (one pane). */
  onBack: () => void;
  backLabel: string;
  /** What the reader says with nothing open, where it's beside the list. */
  blank?: ReactNode;
  className?: string;
}) {
  const [box, mode] = useSplitMode();
  const listRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const over = mode === 'one' && open;
  // The row an item was opened from, to go back to.
  const from = useRef<HTMLElement | null>(null);

  // One pane: opening an item takes focus into the reader; going back returns it to the row.
  useEffect(() => {
    if (mode !== 'one') return;
    // A neighbouring tile opening can narrow this app to one pane. That layout change must not
    // focus its reader and steal the active tile (and address) from the app just opened.
    const tile = box.current?.closest('.loom-tile');
    if (tile && !tile.hasAttribute('data-focused')) return;
    if (over) { readerRef.current?.focus({ preventScroll: true }); readerRef.current?.scrollTo?.({ top: 0 }); }
    else if (from.current?.isConnected) from.current.focus({ preventScroll: false });
  }, [over, mode]);

  const rows = () => [...(listRef.current?.querySelectorAll<HTMLElement>('[data-split-row]') ?? [])];
  const onListKey = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = rows();
    if (!all.length) return;
    e.preventDefault();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = all[Math.max(0, Math.min(all.length - 1, at < 0 ? 0 : at + (e.key === 'ArrowDown' ? 1 : -1)))];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
    // Beside the reader, moving is reading (a mail client's): the row it lands on opens.
    if (mode !== 'one') next.click();
  }, [mode]);
  const onListClick = (e: React.MouseEvent) => { const r = (e.target as HTMLElement).closest<HTMLElement>('[data-split-row]'); if (r) from.current = r; };

  const items = folders.filter(isFolder);
  const nav = (
    <nav className="loom-split__nav" aria-label={`${label} folders`}>
      {search}
      <ul>
        {folders.map((f, n) => isFolder(f) ? (
          <li key={f.id}>
            <button type="button" className="loom-split__folder" data-sub={f.sub || undefined}
              {...(isOn ? { 'aria-pressed': isOn(f.id) } : { 'aria-current': f.id === folder ? 'true' as const : undefined })} onClick={() => onFolder(f.id)}>
              {f.icon && <Icon name={f.icon} size="sm" />}
              <span className="loom-split__folder-name">{f.label}</span>
              {f.count !== undefined && (showZeroCounts || f.count > 0) && <span className="loom-split__count" data-loud={f.loud || undefined}>{f.count}</span>}
            </button>
          </li>
        ) : <li key={`h${n}`} className="loom-split__heading">{f.heading}</li>)}
      </ul>
    </nav>
  );
  const chips = (
    <div className="loom-split__chips" role="group" aria-label={`${label} folders`}>
      {items.map((f) => (
        <button key={f.id} type="button" aria-pressed={isOn ? isOn(f.id) : f.id === folder} onClick={() => onFolder(f.id)}>
          {f.label}{f.count !== undefined && (showZeroCounts || f.count > 0) && <span className="loom-split__count" data-loud={f.loud || undefined}>{f.count}</span>}
        </button>
      ))}
    </div>
  );
  const listPane = (
    <section className="loom-split__list" aria-label={`${label} list`} inert={over || undefined}>
      {mode !== 'three' && <div className="loom-split__top">{search}{narrow ?? chips}</div>}
      <header className="loom-split__list-head"><h2>{listTitle}</h2>{listMeta !== undefined && <span>{listMeta}</span>}</header>
      {listTop}
      <div className="loom-split__rows" ref={listRef} onKeyDown={onListKey} onClickCapture={onListClick}>{list}</div>
    </section>
  );
  return (
    <div ref={box} className={`loom-split ${className ?? ''}`} data-mode={mode} data-open={open || undefined}>
      {mode === 'three' && nav}
      {listPane}
      {(mode !== 'one' || open) && (
        <section ref={readerRef} tabIndex={-1} className="loom-split__reader" aria-label={`${label}: the open item`}
          onKeyDown={(e) => { if (mode === 'one' && e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onBack(); } }}>
          {mode === 'one' && (
            <button type="button" className="loom-split__back" onClick={onBack}><Icon name="chevron-left" size="sm" />{backLabel}</button>
          )}
          {reader ?? <div className="loom-split__blank">{blank}</div>}
        </section>
      )}
    </div>
  );
}
