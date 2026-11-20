// A phone's item context action, independent of native contextmenu support.
import { aboutOf, chatAbout, type About } from './about';

export function phoneRowAbout(root: HTMLElement): () => void {
  const doc = root.ownerDocument;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let press: { id: number; x: number; y: number; row: Element; about: About } | undefined;
  let held: Element | undefined, heldPointer: number | undefined, activeTouch: number | undefined;
  let touch = false, until = 0;
  const cancel = () => { clearTimeout(timer); timer = undefined; press = undefined; };
  const reset = () => { cancel(); held = undefined; heldPointer = activeTouch = undefined; touch = false; until = 0; };
  const busy = () => !!doc.querySelector('[role="dialog"], [role="alertdialog"]');
  const rowOf = (target: EventTarget | null) => target instanceof Element && !target.closest('input, textarea, select, [contenteditable]') ? target.closest('[data-about]') : null;
  // Capture fresh intent even if a dialog stops its pointerdown from bubbling.
  const fresh = (e: PointerEvent) => {
    cancel();
    if (e.isPrimary) { reset(); touch = e.pointerType === 'touch'; activeTouch = touch ? e.pointerId : undefined; }
  };
  const open = (row: Element, about: About) => {
    cancel(); held = row; heldPointer = activeTouch;
    until = heldPointer === undefined ? Date.now() + 500 : 0;
    doc.getSelection()?.removeAllRanges();
    chatAbout(about);
  };
  const down = (e: PointerEvent) => {
    if (e.defaultPrevented || e.pointerType !== 'touch' || !e.isPrimary || e.button !== 0 || busy() || !(e.target instanceof Node) || !root.contains(e.target)) return;
    const row = rowOf(e.target), about = aboutOf(row);
    if (!row || !about) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, row, about };
    timer = setTimeout(() => { const p = press; if (p && p.row.isConnected && !busy()) open(p.row, p.about); else cancel(); }, 450);
  };
  const move = (e: PointerEvent) => { if (press?.id === e.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) cancel(); };
  const release = (e: PointerEvent) => {
    cancel();
    if (activeTouch === e.pointerId) activeTouch = undefined;
    if (heldPointer === e.pointerId) { heldPointer = undefined; until = Date.now() + 500; }
  };
  // Native gestures can cancel the pointer stream before the finger actually lifts.
  const touchEnd = (e: TouchEvent) => { if (!e.touches.length && held) { activeTouch = heldPointer = undefined; until = Date.now() + 500; } };
  const context = (e: MouseEvent) => {
    if (e.defaultPrevented || !(e.target instanceof Node) || !root.contains(e.target)) return;
    const row = rowOf(e.target);
    if (row && row === held && (heldPointer !== undefined || Date.now() < until)) { e.preventDefault(); return; }
    if (!touch || busy()) return;
    const about = aboutOf(row);
    if (row && about) { e.preventDefault(); open(row, about); }
  };
  // A release click may be retargeted onto the newly opened dialog outside root.
  const click = (e: MouseEvent) => { if (heldPointer !== undefined || Date.now() < until) { e.preventDefault(); e.stopImmediatePropagation(); } };
  doc.addEventListener('pointerdown', fresh, true);
  doc.addEventListener('pointerdown', down);
  doc.addEventListener('pointermove', move, { passive: true });
  doc.addEventListener('pointerup', release); doc.addEventListener('pointercancel', release);
  doc.addEventListener('touchend', touchEnd, { passive: true }); doc.addEventListener('touchcancel', touchEnd, { passive: true });
  doc.addEventListener('scroll', cancel, true); doc.addEventListener('contextmenu', context);
  doc.addEventListener('click', click, true); doc.addEventListener('visibilitychange', reset);
  return () => {
    reset();
    doc.removeEventListener('pointerdown', fresh, true); doc.removeEventListener('pointerdown', down);
    doc.removeEventListener('pointermove', move); doc.removeEventListener('pointerup', release); doc.removeEventListener('pointercancel', release);
    doc.removeEventListener('touchend', touchEnd); doc.removeEventListener('touchcancel', touchEnd);
    doc.removeEventListener('scroll', cancel, true); doc.removeEventListener('contextmenu', context);
    doc.removeEventListener('click', click, true); doc.removeEventListener('visibilitychange', reset);
  };
}
