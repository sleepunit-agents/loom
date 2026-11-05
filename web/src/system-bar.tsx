// Neon Noir's system bar on a screen that has none of its own (Jonathan, 2026-11-05: "since we don't have the built in
// top bar from the phone, let's add one here where we put clock and some kind of status icons"): a thin bar over the
// phone's bar (phone-bar.tsx), where a phone's own status bar would be, across the page's column (App.tsx).
//
// loom's clock on the left, small and bold: loom's time (its latest answer's Date, carried forward a minute at a time)
// in loom's zone (uiTimeZone, the one every page says a time in), not the device's. On the right a few monochrome
// glyphs, each meaning something real from what the shell already has: whether loom is reached, how many agents are at
// work, the boxes, the nightly backup. Each says itself in words: an aria-label, and the same words as a tooltip on
// hover or keyboard focus (neon.css .loom-sys__tip). Dimmed means "look at this", and the words say why.
// Up to four; fewer when loom has nothing to say: no Boxes glyph without the Boxes piece, and the backup only to a
// household owner (an agent owner never sees its target or errors). Not on iOS's home-screen app (an iPad draws its own
// status bar there, clock and all).
import { useEffect, useState } from 'react';
import { loomNow, type Shell } from './loom';

/** The time in loom's zone, as a phone's status bar has it: "9:41", no AM or PM. */
export function clockText(ms: number, tz?: string, fallback = ''): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hourCycle: 'h12' }).formatToParts(new Date(ms));
    const t = parts.filter((p) => p.type === 'hour' || p.type === 'minute' || p.type === 'literal').map((p) => p.value).join('').trim();
    if (tz) return t;
  } catch { /* a zone this browser doesn't know: the page's own time, below */ }
  // An older loom (no zone): its clock as the page said it, the time alone.
  return /\d{1,2}:\d{2}/.exec(fallback)?.[0] ?? '';
}

/** loom's clock (loom.ts loomNow: the device's, set by loom's latest answer), turned over on the minute. */
function useLoomMinute(): number {
  const [now, set] = useState(loomNow);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const next = () => { t = setTimeout(() => { set(loomNow()); next(); }, 60_000 - (loomNow() % 60_000) + 50); };
    next();
    // A tab woken from sleep has a stale minute: catch up at once.
    const wake = () => { if (document.visibilityState === 'visible') set(loomNow()); };
    document.addEventListener('visibilitychange', wake);
    return () => { clearTimeout(t); document.removeEventListener('visibilitychange', wake); };
  }, []);
  return now;
}

const G = { width: 15, height: 15, viewBox: '0 0 16 16', 'aria-hidden': true } as const;

/** A connection's bars: all four lit when loom answers; offline, one bar and the rest as outlines. */
function Signal({ live }: { live: boolean }) {
  return (
    <svg {...G}>
      {[0, 1, 2, 3].map((i) => {
        const h = 4 + i * 3, x = 1 + i * 3.75, on = live || i === 0;
        return <rect key={i} x={x} y={14 - h} width={2.6} height={h} rx={0.7} fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={on ? 0 : 0.9} />;
      })}
    </svg>
  );
}
/** A rack of boxes. */
const Boxes = () => (
  <svg {...G} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round">
    <rect x={2} y={2.5} width={12} height={4.5} rx={1} /><rect x={2} y={9} width={12} height={4.5} rx={1} />
    <circle cx={4.75} cy={4.75} r={0.6} fill="currentColor" stroke="none" /><circle cx={4.75} cy={11.25} r={0.6} fill="currentColor" stroke="none" />
  </svg>
);
/** Two heads: agents. */
const Agents = () => (
  <svg {...G} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
    <circle cx={6} cy={5.5} r={2.5} /><path d="M1.75 13.5a4.25 4.25 0 0 1 8.5 0" /><path d="M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12 9.6a4.25 4.25 0 0 1 2.25 3.9" />
  </svg>
);
/** A copy going up: the nightly backup. */
const Backup = () => (
  <svg {...G} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 12.5h-.25a3 3 0 0 1-.4-5.97A4.25 4.25 0 0 1 12.1 6a2.75 2.75 0 0 1-.35 6.5H11.5" /><path d="M8 13.5V8.25M5.9 10.25 8 8.1l2.1 2.15" />
  </svg>
);

type Item = { key: string; label: string; glyph: React.ReactNode; count?: string; dim?: boolean; href?: string };

/** The Boxes piece: the runtime (its id, /p/runtime; /p/box before the catalog renamed it). */
const BOXES = ['/p/runtime', '/p/box'];

/** What each glyph says: only what the shell knows. Agents always; Boxes when its piece is installed; the backup to a household owner. */
export function statusItems(shell: Shell, offline: boolean): Item[] {
  const items: Item[] = [{ key: 'signal', glyph: <Signal live={!offline} />, dim: offline,
    label: offline ? 'Offline: can’t reach loom, showing a saved copy' : 'Live: connected to loom' }];
  const n = shell.agents.length, working = shell.agents.filter((a) => a.working).length;
  items.push({ key: 'agents', glyph: <Agents />, count: String(working), href: shell.home,
    label: working === 0 ? `No agent at work right now (${n} in all)` : working === n ? `${n === 1 ? 'The agent is' : `All ${n} agents are`} at work`
      : `${working} of ${n} agents at work` });
  const boxes = shell.pieces.find((p) => BOXES.includes(p.href));
  if (boxes) {
    const n = /\d+/.exec(boxes.stat ?? '')?.[0];
    const alerts = boxes.alerts ?? 0;
    const trouble = alerts > 0 || boxes.tone === 'bad' || boxes.tone === 'warn';
    const what = boxes.stat?.trim() || 'Boxes';
    items.push({ key: 'boxes', glyph: <Boxes />, count: n, dim: trouble, href: boxes.href,
      label: alerts ? `${what}: ${alerts} alert${alerts === 1 ? '' : 's'}` : trouble ? `${what}: something needs a look` : `${what}, all quiet` });
  }
  const b = shell.backup;
  if (b) {
    items.push({ key: 'backup', glyph: <Backup />, dim: b.tone !== 'ok', href: b.href,
      label: b.tone === 'ok' ? `Last good backup ${b.text}` : b.tone === 'bad' ? `Backup ${b.text}` : `Backup: ${b.text}` });
  }
  return items;
}

export function SystemBar({ shell, clock, offline, go }: { shell: Shell; clock: { text: string; tz?: string }; offline: boolean; go: (href: string) => void }) {
  // Turned over each minute; and each answer from loom re-renders the bar, so the time is read again with its latest Date.
  useLoomMinute();
  const time = clockText(loomNow(), clock.tz, clock.text);
  return (
    <div className="loom-sys">
      <span className="loom-sys__clock">{time}</span>
      <span className="loom-sys__icons" role="group" aria-label="Status">
        {statusItems(shell, offline).map((it) => {
          const inner = <>{it.glyph}{it.count && <span className="loom-sys__n loom-data" aria-hidden>{it.count}</span>}<span className="loom-sys__tip" aria-hidden>{it.label}</span></>;
          return it.href ? (
            <a key={it.key} href={it.href} className="loom-sys__icon" data-k={it.key} data-dim={it.dim ? '' : undefined} aria-label={it.label}
              onClick={(e) => { e.preventDefault(); go(it.href!); }}>{inner}</a>
          ) : (
            <span key={it.key} role="img" tabIndex={0} className="loom-sys__icon" data-k={it.key} data-dim={it.dim ? '' : undefined} aria-label={it.label}>{inner}</span>
          );
        })}
      </span>
    </div>
  );
}
