// Neon Noir's bar on a phone (Jonathan, 2026-11-04, t-1849): the phone's own status bar is right above it, so it reads
// as part of it. The page's name, small, under the phone's clock on the left (it replaces the big icon-and-title header
// there); LOOM//OS and the needs-you count under the status icons on the right; between them a slow ticker of what's
// going on. No clock of its own: the phone shows one. From 640 px the same bar sits under loom's own system bar
// (system-bar.tsx, Jonathan 2026-11-05); on a desktop (1024 px and wider) it's one line with loom's clock and glyphs in
// it (its `clock` and `status`; Jonathan, 2026-11-06), where the ticker has the most room.
//
// The ticker (his rules): only its middle moves, the needs-you count never scrolls away; it moves only when its words
// don't fit, slowly (TICK_PX_S); it stops while it's touched and while the tab is hidden; under reduced motion it stands
// still, cut short with an ellipsis.
import { lazy, Suspense, Fragment, useEffect, useState } from 'react';
const PageInfoDrawer = lazy(() => import('./page-info-drawer'));
import { buzz, HapticLabel, useHaptics } from './haptic';
import { loomNow, type Shell } from './loom';
import { placeWords } from './system-bar';
import { Ticker, type TickPart } from './ticker';
export { Ticker, type TickPart } from './ticker';

/** A tile's value that's only a time of day (the Clock piece's): the phone already shows the time. */
const isTime = (s: string) => /^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(s.trim());
const TONE_FIRST: Record<string, number> = { bad: 0, warn: 1 };

/** What the ticker says, from what the shell already has: how many agents, what each is up to, and each place's
 * tile (trouble first: Tasks, Boxes, Bridges and the rest say what they have there). Words, never colours alone. Each
 * opens its app: the agents Home, an agent its window, a place its own page. */
export function tickerParts(shell: Shell, now = loomNow(), offline = false): TickPart[] {
  const n = shell.agents.length;
  const places = shell.pieces.filter((p) => p.stat && !isTime(p.stat))
    .map((p, i) => ({ p, i })).sort((a, b) => (TONE_FIRST[a.p.tone ?? ''] ?? 2) - (TONE_FIRST[b.p.tone ?? ''] ?? 2) || a.i - b.i);
  return [
    { text: `${n} agent${n === 1 ? '' : 's'}`, href: '/' },
    ...shell.agents.map((a) => {
      const d = a.activity;
      const fresh = !offline && !a.activityUnavailable && d && Date.parse(d.observedAt) <= now && Date.parse(d.expiresAt) > now;
      return { text: `${a.label} · ${fresh ? `${d.action}${d.where ? ` · ${d.where}` : ''}` : 'Activity unavailable'}`, href: fresh && d.href ? d.href : `/a/${a.id}` };
    }),
    ...places.map(({ p }) => ({ text: placeWords(p.label, p.stat!), tone: p.tone === 'bad' || p.tone === 'warn' ? p.tone : undefined, href: p.href })),
  ];
}

/** What a page says about itself: its one line, then its longer intro (when that says more than the line). */
export type PageInfo = { line?: string; more?: string };

/** The page's name, and when the page says something about itself, the way to read it (Jonathan, 2026-11-05: "I like
 * the idea of the helper icon thing but right now it's also wasting vertical space"): the name is the button (44 px tall to a finger, looks/looks.css, in a 24 px bar), a small ⓘ
 * after it (looks/looks.css: drawn, so it's not part of the name), and it opens a sheet with the page's line and its intro. Without either, a plain name. */
function PageName({ title, info, where, chat }: { title: string; info?: PageInfo; where: string; chat?: () => void }) {
  const haptics = useHaptics();
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  useEffect(() => setOpen(false), [where]);
  const line = info?.line?.trim() || undefined;
  // The intro past its line: a page's line is often its intro's first sentence, said once.
  const full = info?.more?.trim();
  const more = (full && line && full.startsWith(line) ? full.slice(line.length).trim() : full) || undefined;
  if (!line && !more && !chat) return <h1>{title}</h1>;
  return (
    <>
      <h1>
        <button type="button" className="loom-pbar__info relative" aria-label={`About ${title}`} aria-haspopup="dialog" aria-expanded={open}
          onClick={() => { buzz(haptics, true); setUsed(true); setOpen(true); }}>
          <span className="loom-pbar__title">{title}</span>
          <HapticLabel on={haptics} />
        </button>
      </h1>
      {used && <Suspense fallback={null}><PageInfoDrawer open={open} onOpenChange={setOpen} title={title} line={line} more={more} chat={chat ? () => { setOpen(false); chat(); } : undefined} /></Suspense>}
    </>
  );
}

/** The bar itself: the page's name (in its app's colour, or its agent's; the way to its info when it has some), the
 * ticker, LOOM//OS, and the count. */
export function PhoneBar({ title, color, crumb, onBack, go, shell, offline, info, where, clock, status, chat }: {
  title: string; color: string; crumb?: { label: string; href: string }; go: (href: string) => void; shell: Shell; offline: boolean;
  info?: PageInfo; where: string;
  /** Chat about this page (about.ts), on a phone: in the page name's sheet. */
  chat?: () => void;
  /** The chevron goes back in the app's history (App.tsx, trail.ts) rather than to `crumb.href` as a new page. */
  onBack?: () => void;
  /** A desktop's one line (Jonathan, 2026-11-06): loom's clock before the name, the status glyphs after LOOM//OS
   * (system-bar.tsx SysClock, SysIcons). A phone's own bar has neither: the phone shows its own. */
  clock?: React.ReactNode; status?: React.ReactNode;
}) {
  const [tickNow, setTickNow] = useState(loomNow);
  useEffect(() => { const id = window.setInterval(() => setTickNow(loomNow()), 1000); return () => window.clearInterval(id); }, []);
  const asks = shell.asks;
  // A desktop's one line: its two sides as wide as each other, so the ticker stands in the middle of the screen
  // (docs/specs/agent-desk.md, "The ticker"); a phone's, the name, the ticker and LOOM//OS in a row.
  const one = !!(clock || status);
  const Side = one ? 'div' : Fragment;
  return (
    <div className={one ? 'loom-pbar loom-pbar--one' : 'loom-pbar'}>
      <Side {...(one ? { className: 'loom-pbar__side loom-pbar__side--l' } : {})}>
      {clock}
      {clock && <span className="loom-pbar__sep loom-pbar__sep--clock" aria-hidden>·</span>}
      <div className="loom-pbar__name" style={{ color }}>
        {crumb && (
          <button type="button" className="loom-pbar__back" aria-label={`Back to ${crumb.label}`} onClick={() => (onBack ? onBack() : go(crumb.href))}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 6l-6 6 6 6" /></svg>
          </button>
        )}
        <PageName title={title} info={info} where={where} chat={chat} />
      </div>
      </Side>
      <Ticker live={!offline} parts={tickerParts(shell, tickNow, offline || !navigator.onLine)} go={go} />
      <Side {...(one ? { className: 'loom-pbar__side loom-pbar__side--r' } : {})}>
      <span className="loom-pbar__brand" aria-label="loom">LOOM<i aria-hidden>//</i>OS</span>
      {status && <span className="loom-pbar__sep loom-pbar__sep--status" aria-hidden>·</span>}
      {status}
      {asks > 0 && (
        <a href="/inbox" className="loom-pbar__needs loom-data" aria-label={`${asks} need${asks === 1 ? 's' : ''} you`}
          onClick={(e) => { e.preventDefault(); go('/inbox'); }}>{asks}</a>
      )}
      </Side>
    </div>
  );
}
