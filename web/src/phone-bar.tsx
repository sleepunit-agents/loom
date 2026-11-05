// Neon Noir's bar on a phone (Jonathan, 2026-11-04, t-1849): the phone's own status bar is right above it, so it reads
// as part of it. The page's name, small, under the phone's clock on the left (it replaces the big icon-and-title header
// there); LOOM//OS and the needs-you count under the status icons on the right; between them a slow ticker of what's
// going on. No clock of its own: the phone shows one. Wider screens keep the status bar and the big header (App.tsx).
//
// The ticker (his rules): only its middle moves, the needs-you count never scrolls away; it moves only when its words
// don't fit, slowly (TICK_PX_S); it stops while it's touched and while the tab is hidden; under reduced motion it stands
// still, cut short with an ellipsis.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Shell } from './loom';

/** How fast the ticker moves, in CSS pixels a second (his "slow, ~20-30 px/s"). */
export const TICK_PX_S = 24;
/** The space between the end of the words and their start again, as it loops (CSS px; neon.css .loom-tick__line). */
const TICK_GAP = 40;

/** A tile's value that's only a time of day (the Clock piece's): the phone already shows the time. */
const isTime = (s: string) => /^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(s.trim());
const TONE_FIRST: Record<string, number> = { bad: 0, warn: 1 };

/** What the ticker says, from what the shell already has: how many agents, what each is up to, and each place's
 * tile (trouble first). Words, never colours alone. */
export function tickerParts(shell: Shell): { text: string; tone?: string }[] {
  const n = shell.agents.length;
  const places = shell.pieces.filter((p) => p.stat && !isTime(p.stat))
    .map((p, i) => ({ p, i })).sort((a, b) => (TONE_FIRST[a.p.tone ?? ''] ?? 2) - (TONE_FIRST[b.p.tone ?? ''] ?? 2) || a.i - b.i);
  return [
    { text: `${n} agent${n === 1 ? '' : 's'}` },
    ...shell.agents.map((a) => ({ text: a.sub ? `${a.label} ${a.sub}` : a.label })),
    ...places.map(({ p }) => ({ text: `${p.label} ${p.stat}`, tone: p.tone === 'bad' || p.tone === 'warn' ? p.tone : undefined })),
  ];
}

const reducedQ = '(prefers-reduced-motion: reduce)';
function useReduced() {
  const [r, set] = useState(() => matchMedia(reducedQ).matches);
  useEffect(() => { const m = matchMedia(reducedQ); const f = () => set(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return r;
}

/** The ticker: still when its words fit (or motion is reduced), else a slow loop; held while touched or hidden. */
export function Ticker({ live, parts }: { live: boolean; parts: { text: string; tone?: string }[] }) {
  const box = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLSpanElement>(null);
  const reduced = useReduced();
  // The loop's length in seconds while it runs; 0 while its words fit (or it mustn't move).
  const [run, setRun] = useState(0);
  const [held, setHeld] = useState(false);
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const key = parts.map((p) => p.text).join('\0');
  useLayoutEffect(() => {
    const b = box.current, l = line.current;
    if (!b || !l) return;
    const measure = () => {
      // The words' own width: while it runs, a line carries the gap after it.
      const words = l.scrollWidth - (l.dataset.gap !== undefined ? TICK_GAP : 0);
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
    <span ref={copy ? undefined : line} className="loom-tick__line" data-gap={run ? '' : undefined} aria-hidden={copy || undefined}>
      <span className="loom-tick__live" data-off={live ? undefined : ''}>{live ? 'live' : 'offline'}</span>
      {parts.map((p, i) => <span key={i} className="loom-tick__part" data-tone={p.tone}>{p.text}</span>)}
    </span>
  );
  const release = () => setHeld(false);
  return (
    <div ref={box} className="loom-tick loom-data" data-run={run ? '' : undefined} data-paused={held || hidden ? '' : undefined}
      style={run ? ({ '--tick-s': `${run}s` } as React.CSSProperties) : undefined}
      onPointerDown={() => setHeld(true)} onPointerUp={release} onPointerCancel={release} onPointerLeave={release}>
      <span className="loom-tick__track">{words(false)}{run > 0 && words(true)}</span>
    </div>
  );
}

/** The bar itself: the page's name (in its app's colour, or its agent's), the ticker, LOOM//OS, and the count. */
export function PhoneBar({ title, color, crumb, go, shell, offline }: {
  title: string; color: string; crumb?: { label: string; href: string }; go: (href: string) => void; shell: Shell; offline: boolean;
}) {
  const asks = shell.asks;
  return (
    <div className="loom-pbar">
      <div className="loom-pbar__name" style={{ color }}>
        {crumb && (
          <button type="button" className="loom-pbar__back" aria-label={`Back to ${crumb.label}`} onClick={() => go(crumb.href)}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 6l-6 6 6 6" /></svg>
          </button>
        )}
        <h1>{title}</h1>
      </div>
      <Ticker live={!offline} parts={tickerParts(shell)} />
      <span className="loom-pbar__brand" aria-label="loom">LOOM<i aria-hidden>//</i>OS</span>
      {asks > 0 && (
        <a href="/inbox" className="loom-pbar__needs loom-data" aria-label={`${asks} need${asks === 1 ? 's' : ''} you`}
          onClick={(e) => { e.preventDefault(); go('/inbox'); }}>{asks}</a>
      )}
    </div>
  );
}
