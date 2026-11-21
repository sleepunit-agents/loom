import { useLayoutEffect, useRef } from 'react';
import { reducedMotion } from '../access';
import type { Tile } from './router';
import type { Rect } from '../tiling/layout';
import './window-motion.css';

const effects = ['matrix', 'hexagon', 'glitch', 'tv'] as const;

/** Draw the departing frame separately so a closed screen releases its data and focus immediately. */
export function WindowExits({ boxes, phone, tiles, maximized }: { boxes: Record<string, Rect>; phone: boolean; tiles: Tile[]; maximized?: string }) {
  const layer = useRef<HTMLDivElement>(null);
  const previous = useRef(boxes);
  const sequence = useRef(0);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = boxes;
    const host = layer.current;
    if (!host?.isConnected || reducedMotion()) return;
    for (const child of Array.from(host.children)) {
      if (boxes[(child as HTMLElement).dataset.departed!]) child.remove();
    }
    for (const [id, box] of Object.entries(before)) {
      if (boxes[id]) continue;
      // A desktop window covered by a maximized neighbour is still open.
      if (maximized && tiles.some(tile => tile.id === id && !tile.minimized)) continue;
      const frame = document.createElement('div');
      frame.className = 'desk-window-exit';
      frame.dataset.departed = id;
      frame.dataset.effect = effects[sequence.current++ % effects.length];
      if (!phone) Object.assign(frame.style, {
        left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px',
      });
      host.append(frame);
      if (tiles.some(tile => tile.id === id && tile.minimized)) {
        const dock = host.closest('.next-shell')?.querySelector<HTMLElement>(`.next-dock [data-value="${CSS.escape(id)}"]`);
        if (dock) {
          const target = dock.getBoundingClientRect(), start = frame.getBoundingClientRect();
          const dx = target.left + target.width / 2 - start.left - start.width / 2;
          const dy = target.top + target.height / 2 - start.top - start.height / 2;
          frame.animate([{ translate: '0 0', scale: '1' }, { translate: `${dx}px ${dy}px`, scale: '.08' }],
            { duration: parseFloat(getComputedStyle(frame).animationDuration) * 1000, easing: 'ease-in', fill: 'both' });
        }
      }
      const remove = () => frame.remove();
      frame.addEventListener('animationend', event => { if (!event.pseudoElement) remove(); });
      frame.addEventListener('animationcancel', remove);
    }
  }, [boxes, phone, tiles, maximized]);
  return <div ref={layer} className="desk-window-exits" aria-hidden="true" inert />;
}
