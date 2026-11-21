import { useLayoutEffect, useRef } from 'react';
import { reducedMotion } from '../access';
import type { Tile } from './router';
import type { Rect } from '../tiling/layout';
import { drawDissolve } from './window-dissolve';
import './window-motion.css';

const effects = ['matrix', 'hexagon', 'glitch', 'tv'] as const;

function dockOffset(host: HTMLElement, id: string, frame: HTMLElement) {
  const dock = host.closest('.next-shell')?.querySelector<HTMLElement>(`.next-dock [data-value="${CSS.escape(id)}"]`);
  if (!dock) return;
  const target = dock.getBoundingClientRect(), start = frame.getBoundingClientRect();
  if (!target.width || !target.height) return;
  const dx = target.left + target.width / 2 - start.left - start.width / 2;
  const dy = target.top + target.height / 2 - start.top - start.height / 2;
  return `${dx}px ${dy}px`;
}

/** Draw the departing frame separately so a closed screen releases its data and focus immediately. */
export function WindowExits({ boxes, phone, tiles, maximized }: { boxes: Record<string, Rect>; phone: boolean; tiles: Tile[]; maximized?: string }) {
  const layer = useRef<HTMLDivElement>(null);
  const previous = useRef(boxes);
  const sequence = useRef(0);
  const priorTiles = useRef(tiles);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = boxes;
    const oldTiles = priorTiles.current;
    priorTiles.current = tiles;
    const host = layer.current;
    if (!host?.isConnected || reducedMotion()) return;
    for (const child of Array.from(host.children)) {
      if (boxes[(child as HTMLElement).dataset.departed!]) child.remove();
    }
    for (const tile of oldTiles) {
      if (!tile.minimized || !boxes[tile.id] || phone) continue;
      const window = host.parentElement?.querySelector<HTMLElement>(`[data-tile="${CSS.escape(tile.id)}"]`);
      const offset = window && dockOffset(host, tile.id, window);
      if (window && offset) window.animate([{ translate: offset, scale: '.08' }, { translate: '0 0', scale: '1' }],
        { duration: 620, easing: 'cubic-bezier(.18,.72,.22,1)' });
    }
    for (const [id, box] of Object.entries(before)) {
      if (boxes[id]) continue;
      // A desktop window covered by a maximized neighbour is still open.
      if (maximized && tiles.some(tile => tile.id === id && !tile.minimized)) continue;
      const frame = document.createElement('div');
      frame.className = 'desk-window-exit';
      frame.dataset.departed = id;
      const effect = effects[sequence.current++ % effects.length];
      frame.dataset.effect = effect;
      if (!phone) Object.assign(frame.style, {
        left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px',
      });
      host.append(frame);
      const duration = parseFloat(getComputedStyle(frame).animationDuration) * 1000;
      if (effect === 'matrix' || effect === 'hexagon') drawDissolve(frame, effect, duration);
      if (tiles.some(tile => tile.id === id && tile.minimized)) {
        const offset = dockOffset(host, id, frame);
        if (offset) {
          frame.animate([{ translate: '0 0', scale: '1' }, { translate: '0 0', scale: '1', offset: .32 }, { translate: offset, scale: '.08' }],
            { duration, easing: 'ease-in', fill: 'both' });
        }
      }
      const remove = () => frame.remove();
      frame.addEventListener('animationend', event => { if (!event.pseudoElement) remove(); });
      frame.addEventListener('animationcancel', remove);
    }
  }, [boxes, phone, tiles, maximized]);
  return <div ref={layer} className="desk-window-exits" aria-hidden="true" inert />;
}
