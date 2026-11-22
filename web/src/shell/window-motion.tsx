import { useLayoutEffect, useRef } from 'react';
import { reducedMotion } from '../access';
import type { Tile } from './router';
import type { Rect } from '../tiling/layout';
import { flushSync } from 'react-dom';
import { animateDissolve } from './window-dissolve';
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

/** Capture only the outgoing tile. The router releases the interactive screen in the update callback. */
export function useDeparture(ground: React.RefObject<HTMLDivElement | null>, remove: (id: string, minimize?: boolean) => void) {
  const sequence = useRef(0);
  const active = useRef<ViewTransition | null>(null);
  useLayoutEffect(() => () => active.current?.skipTransition(), []);
  return (id: string, minimize = false) => {
    if (!document.startViewTransition || reducedMotion()) { remove(id, minimize); return; }
    const tile = ground.current?.querySelector<HTMLElement>(`[data-tile="${CSS.escape(id)}"]`);
    if (!tile) { remove(id, minimize); return; }
    // A second click can arrive before the browser has captured the first one.
    if (tile.style.viewTransitionName) return;
    active.current?.skipTransition();
    const effect = effects[sequence.current++ % effects.length];
    const root = document.documentElement;
    const bounds = tile.getBoundingClientRect();
    const offset = minimize && dockOffset(tile, id, tile);
    tile.style.viewTransitionName = 'loom-departure';
    root.dataset.departure = effect;
    const transition = document.startViewTransition(() => {
      tile.style.viewTransitionName = '';
      if (tile.isConnected && tile.dataset.tile === id) flushSync(() => remove(id, minimize));
    });
    active.current = transition;
    const animations: Animation[] = [];
    const cancelOnInteraction = () => transition.skipTransition();
    document.addEventListener('pointerdown', cancelOnInteraction, true);
    document.addEventListener('keydown', cancelOnInteraction, true);
    void transition.ready.then(() => {
      const duration = effect === 'tv' ? 680 : effect === 'glitch' ? 720 : 800;
      if (effect === 'matrix' || effect === 'hexagon') animations.push(...animateDissolve(effect, bounds.width, bounds.height, duration));
      if (offset) animations.push(root.animate([{translate:'0 0',scale:'1'}, {translate:'0 0',scale:'1',offset:.32}, {translate:offset,scale:'.08'}],
        {duration,easing:'ease-in',fill:'both',pseudoElement:'::view-transition-image-pair(loom-departure)'}));
    }, () => {});
    void transition.finished.finally(() => {
      for (const animation of animations) animation.cancel();
      document.removeEventListener('pointerdown', cancelOnInteraction, true);
      document.removeEventListener('keydown', cancelOnInteraction, true);
      if (active.current === transition) { active.current = null; delete root.dataset.departure; }
    });
  };
}

export function useDockRestore(ground: React.RefObject<HTMLDivElement | null>, boxes: Record<string, Rect>, phone: boolean, tiles: Tile[]) {
  const priorTiles = useRef(tiles);
  useLayoutEffect(() => {
    const oldTiles = priorTiles.current;
    priorTiles.current = tiles;
    const host = ground.current;
    if (!host?.isConnected || reducedMotion()) return;
    for (const tile of oldTiles) {
      if (!tile.minimized || !boxes[tile.id] || phone) continue;
      const window = host.querySelector<HTMLElement>(`[data-tile="${CSS.escape(tile.id)}"]`);
      const offset = window && dockOffset(host, tile.id, window);
      if (window && offset) window.animate([{ translate: offset, scale: '.08' }, { translate: '0 0', scale: '1' }],
        { duration: 620, easing: 'cubic-bezier(.18,.72,.22,1)' });
    }
  }, [ground, boxes, phone, tiles]);
}
