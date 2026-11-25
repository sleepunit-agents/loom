import { useEffect, useRef } from 'react';
import { createPlayer } from '../pixel-face';
import type { FaceState } from '../face';
import { checkSpriteLayout } from '../../../src/desk-sprite-layout';
import manifest from './manifest.json';
import sheet from './sheet.png';

const layout = checkSpriteLayout(manifest);
export function Portrait({ state }: { state: FaceState }) {
  const node = useRef<HTMLSpanElement>(null),
    player = useRef<ReturnType<typeof createPlayer> | null>(null);
  useEffect(() => {
    const target = node.current!;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    const p = createPlayer(
      layout,
      'idle',
      (frame) => {
        target.style.backgroundPosition = -frame.frame * 56 + 'px ' + -(frame.v?.row ?? 10) * 84 + 'px';
        target.style.transform = frame.flip ? 'scaleX(-1)' : 'none';
      },
      {
        now: () => performance.now(),
        random: Math.random,
        setTimeout: (f, n) => window.setTimeout(f, n),
        clearTimeout: (id) => clearTimeout(id),
      },
    );
    player.current = p;
    const refresh = () => p.live(visible && !document.hidden && !motion.matches);
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      refresh();
    });
    observer.observe(target);
    document.addEventListener('visibilitychange', refresh);
    motion.addEventListener('change', refresh);
    return () => {
      p.dispose();
      player.current = null;
      observer.disconnect();
      document.removeEventListener('visibilitychange', refresh);
      motion.removeEventListener('change', refresh);
    };
  }, []);
  useEffect(() => {
    player.current?.want(state);
  }, [state]);
  return (
    <span className="portrait" aria-hidden="true" data-state={state}>
      <span ref={node} style={{ backgroundImage: 'url(' + sheet + ')' }} />
    </span>
  );
}
