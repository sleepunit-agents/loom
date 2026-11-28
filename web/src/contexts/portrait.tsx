import { useEffect, useRef } from 'react';
import { createPlayer, type IdleTiming } from './portrait-player';
import type { FaceState } from '../face-model';
import { motionQuery } from '../access';
import { checkSpriteLayout } from '../../../src/desk-sprite-layout';
import manifest from './manifest.json';
import sheet from './sheet.png';

const layout = checkSpriteLayout(manifest);
export function Portrait({ state, className = 'portrait', idleTiming }: {
  state: FaceState;
  className?: string;
  idleTiming?: IdleTiming;
}) {
  const node = useRef<HTMLSpanElement>(null),
    player = useRef<ReturnType<typeof createPlayer> | null>(null);
  useEffect(() => {
    const target = node.current!;
    const motion = motionQuery();
    let visible = false;
    const p = createPlayer(
      layout,
      'idle',
      (frame) => {
        target.style.backgroundPosition = -frame.frame * layout.cell[0] + 'px ' + -(frame.v?.row ?? 0) * layout.cell[1] + 'px';
        target.style.transform = frame.flip ? 'scaleX(-1)' : 'none';
      },
      {
        now: () => performance.now(),
        random: Math.random,
        setTimeout: (f, n) => window.setTimeout(f, n),
        clearTimeout: (id) => clearTimeout(id),
      },
      undefined,
      idleTiming,
    );
    player.current = p;
    const refresh = () => p.live(visible && !document.hidden && !motion.matches, false);
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
  }, [idleTiming]);
  useEffect(() => {
    player.current?.want(state);
  }, [state, idleTiming]);
  return (
    <span className={className} aria-hidden="true" data-state={state}>
      <span ref={node} style={{ backgroundImage: 'url(' + sheet + ')' }} />
    </span>
  );
}
