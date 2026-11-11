import { useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import './drawer-split.css';

export type SplitDrawer = { id: string; open: boolean; toggle: () => void };

/** Two panes when the reader fits; otherwise its list opens as a modal drawer. Width is the app's own box. */
export function useDrawerSplit({ twoFrom, active, resetKey }: { twoFrom: number; active: boolean; resetKey: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [one, setOne] = useState(false);
  const [open, setOpen] = useState(false);
  const id = useId();
  useLayoutEffect(() => {
    const el = box.current;
    if (!active || !el) return;
    const fit = (w: number) => setOne(w > 0 && w < twoFrom);
    fit(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => fit(e.borderBoxSize?.[0]?.inlineSize ?? el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [active, twoFrom]);
  useEffect(() => { setOpen(false); }, [resetKey, one, active]);
  return { box, one, close: () => setOpen(false), drawer: active && one ? { id, open, toggle: () => setOpen((o) => !o) } : undefined };
}

export function SplitDrawerButton({ id, open, toggle, label }: SplitDrawer & { label: string }) {
  return <button type="button" className="loom-drawer-split__button" onClick={toggle} aria-label={label} aria-expanded={open} aria-controls={id} data-drawer-btn="">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 6h16M4 12h16M4 18h16" /></svg>
  </button>;
}

const focusable = (el: HTMLElement | null): HTMLElement[] => [...(el?.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],area[href],[tabindex],[contenteditable="true"]') ?? [])]
  .filter((node) => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[inert]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden');

function Drawer({ id, label, onClose, children }: { id: string; label: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const all = focusable(panel.current);
    (all.find((el) => el.matches('[aria-current="true"][data-split-row]')) ?? all[0] ?? panel.current)?.focus();
    const box = panel.current?.closest('.loom-drawer-split');
    return () => { queueMicrotask(() => { box?.querySelector<HTMLElement>('[data-drawer-btn]')?.focus(); }); };
  }, []);
  return <div className="loom-drawer-split__drawer" id={id} role="dialog" aria-modal="true" aria-label={label} onKeyDown={(e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab' || !panel.current) return;
    const all = focusable(panel.current);
    if (!all.length) { e.preventDefault(); panel.current.focus(); return; }
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (i < 0) { e.preventDefault(); all[0].focus(); return; }
    if (e.shiftKey && i <= 0) { e.preventDefault(); all[all.length - 1].focus(); }
    else if (!e.shiftKey && i === all.length - 1) { e.preventDefault(); all[0].focus(); }
  }}>
    <div ref={panel} tabIndex={-1} className="loom-drawer-split__panel">{children}</div>
    <button type="button" className="loom-drawer-split__scrim" aria-label={`Close ${label.toLowerCase()}`} tabIndex={-1} onClick={onClose} />
  </div>;
}

/** Reader stays in the same React slot on every resize, preserving its draft and live state. */
export function DrawerSplit({ layout, label, list, reader, blank, className = '', ...props }: HTMLAttributes<HTMLDivElement> & {
  layout: ReturnType<typeof useDrawerSplit>; label: string; list: ReactNode; reader: ReactNode | null; blank: ReactNode;
}) {
  const shown = layout.one && reader && layout.drawer?.open;
  return <div {...props} ref={layout.box} className={`loom-drawer-split ${className}`} data-one={layout.one ? '' : undefined}>
    {layout.one && reader ? null : <div className="loom-drawer-split__list">{list}</div>}
    <div className="loom-drawer-split__reader" hidden={!reader && layout.one} inert={shown ? true : undefined}>{reader ?? blank}</div>
    {shown && <Drawer id={layout.drawer!.id} label={label} onClose={layout.close}>{list}</Drawer>}
  </div>;
}
