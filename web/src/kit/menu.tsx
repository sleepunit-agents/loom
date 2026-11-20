import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '../components/ui/button';

/** A small menu (Comms' More and New, Tasks' More): a quiet button that shows a short column of actions under it. A disclosure (a button with
 * `aria-expanded` and the group it controls), so Tab walks into its actions. Escape, a press outside and focus
 * leaving all close it; Escape and choosing an action put focus back on the button. */
export function Menu({ label, name, disabled, children }: {
  /** The button's words ("More", "New") and its accessible name, which begins with them. */
  label: string; name: string; disabled?: boolean;
  /** The actions. `close()` closes and returns focus to the button; `close(false)` closes and leaves focus where the action sends it. */
  children(close: (refocus?: boolean) => void): ReactNode;
}) {
  const [open, setOpen] = useState(false), id = useId();
  const root = useRef<HTMLSpanElement>(null), button = useRef<HTMLButtonElement>(null);
  const close = (refocus = true) => { setOpen(false); if (refocus) button.current?.focus?.(); };
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const outside = (event: Event) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <span ref={root} className="loom-kit-menu"
    onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}
    onBlur={event => { if (open && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <Button ref={button} aria-label={name} aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => setOpen(value => !value)}>{label}</Button>
    {open && <div id={id} className="loom-kit-menu__box" role="group" aria-label={name}>{children(close)}</div>}
  </span>;
}
