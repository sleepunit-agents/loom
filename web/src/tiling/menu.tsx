// The desktop's context menus (t-1925 E; docs/specs/desk-tiling.md, "Context menus"): a short list of what you can do
// with the thing under the pointer, or under focus with the Menu key or Shift+F10. In loom's look, keyboard-operable
// and never a trap: ↑ ↓ Home End move, Enter or Space chooses, Esc closes and gives focus back to where it was, Tab
// closes and lets focus move on, a press outside, a scroll or a resize closes it. In the desk's own chunk.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type MenuItem = { id: string; label: string; hint?: string; run: () => void };
export type MenuAt = { x: number; y: number; title: string; items: MenuItem[]; /** focus goes back here when it closes by Esc */ back: HTMLElement | null };

export function ContextMenu({ at, close }: { at: MenuAt; close: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  const shut = useRef(close);
  shut.current = close;
  // Inside the screen: flipped to the pointer's other side when it would run off an edge.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect(), m = 8;
    setPos({
      left: Math.max(m, at.x + r.width > innerWidth - m ? at.x - r.width : at.x),
      top: Math.max(m, at.y + r.height > innerHeight - m ? at.y - r.height : at.y),
    });
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [at]);
  useEffect(() => {
    const out = (e: Event) => { if (!box.current?.contains(e.target as Node)) shut.current(); };
    const gone = () => shut.current();
    addEventListener('pointerdown', out, true);
    addEventListener('wheel', gone, { passive: true });
    addEventListener('resize', gone);
    addEventListener('blur', gone);
    return () => { removeEventListener('pointerdown', out, true); removeEventListener('wheel', gone); removeEventListener('resize', gone); removeEventListener('blur', gone); };
  }, []);
  const items = () => [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const onKey = (e: React.KeyboardEvent) => {
    const all = items(), i = all.indexOf(document.activeElement as HTMLElement);
    const to = (n: number) => { e.preventDefault(); all[(n + all.length) % all.length]?.focus(); };
    if (e.key === 'ArrowDown') to(i + 1);
    else if (e.key === 'ArrowUp') to(i - 1);
    else if (e.key === 'Home') to(0);
    else if (e.key === 'End') to(all.length - 1);
    // Space chooses, as Enter does (a button's own Enter is the browser's)
    else if (e.key === ' ') { e.preventDefault(); (document.activeElement as HTMLElement | null)?.click(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); at.back?.focus({ preventScroll: true }); }
    // Tab never stays: the menu closes and focus moves on from where it was.
    else if (e.key === 'Tab') { close(); at.back?.focus({ preventScroll: true }); }
  };
  return createPortal(
    <div ref={box} className="loom-cmenu" role="menu" aria-label={at.title} style={{ left: pos.left, top: pos.top }} onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}>
      <p className="loom-cmenu__title" aria-hidden>{at.title}</p>
      {at.items.map((m) => (
        <button key={m.id} type="button" role="menuitem" tabIndex={-1} data-id={m.id}
          onClick={() => { close(); m.run(); }}>
          <span>{m.label}</span>{m.hint && <span className="loom-cmenu__hint">{m.hint}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
