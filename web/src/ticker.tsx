import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motionQuery, reducedMotion } from './access';
export type TickPart = { text: string; tone?: string; href?: string };
const TICK_PX_S = 24;
const TICK_GAP = 40;

function useReduced() {
  const [r, set] = useState(reducedMotion);
  useEffect(() => { const m = motionQuery(); const f = () => set(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return r;
}

/** The ticker: still when its words fit (or motion is reduced), else a slow loop; held while touched or hidden. */
export function Ticker({ live, parts, go }: { live: boolean; parts: TickPart[]; /** opens an item's app */ go?: (href: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLSpanElement>(null);
  const reduced = useReduced();
  // The loop's length in seconds while it runs; 0 while its words fit (or it mustn't move).
  const [run, setRun] = useState(0);
  // Its words fit the room (they stand in its middle, on a desktop's one bar); not while they run or are cut short.
  const [fits, setFits] = useState(true);
  const running = useRef(false);
  running.current = run > 0;
  const [held, setHeld] = useState(false);
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const key = parts.map((p) => p.text).join('\0');
  useLayoutEffect(() => {
    const b = box.current, l = line.current;
    if (!b || !l) return;
    const measure = () => {
      // The words' own width: while it runs, a line carries the gap after it.
      const words = l.scrollWidth - (running.current ? TICK_GAP : 0);
      setFits(words <= b.clientWidth + 1);
      setRun(!reduced && words > b.clientWidth + 1 ? Math.round(((words + TICK_GAP) / TICK_PX_S) * 10) / 10 : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(b);
    // Its typeface arriving changes the words' width, not the box's.
    let on = true;
    void document.fonts?.ready.then(() => { if (on) measure(); });
    return () => { on = false; ro.disconnect(); };
  }, [key, reduced]);
  useEffect(() => {
    const f = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, []);
  const words = (copy: boolean) => (
    <span ref={copy ? undefined : line} className="loom-tick__line" aria-hidden={copy || undefined}>
      <span className="loom-tick__live" data-off={live ? undefined : ''}>{live ? 'live' : 'offline'}</span>
      {parts.map((p, i) => (go && p.href
        // The copy that follows it round is the same words again: out of the tab order, and not read twice.
        ? <a key={i} href={p.href} className="loom-tick__part" data-tone={p.tone} tabIndex={copy ? -1 : undefined}
            onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); go(p.href!); }}>{p.text}</a>
        : <span key={i} className="loom-tick__part" data-tone={p.tone}>{p.text}</span>))}
    </span>
  );
  const release = () => setHeld(false);
  return (
    <div ref={box} className="loom-tick loom-data" data-run={run ? '' : undefined} data-fits={fits && !run ? '' : undefined} data-paused={held || hidden ? '' : undefined}
      style={run ? ({ '--tick-s': `${run}s`, '--tick-gap': `${TICK_GAP}px` } as React.CSSProperties) : undefined}
      onPointerDown={() => setHeld(true)} onPointerUp={release} onPointerCancel={release} onPointerLeave={release}>
      <span className="loom-tick__track">{words(false)}{run > 0 && words(true)}</span>
    </div>
  );
}

