// The launcher (t-1925 G; the app mockups Jonathan approved 2026-11-06): every app in one grid, grouped as loom's own
// list is (nav.ts launcherOf): Work, People & agents, Library, System, Look & feel, Pieces. It replaces More and Setup
// on a desktop. The dock's last key opens it, and so does Ctrl+Shift+Space (⌘⇧Space on a Mac): ⌘Space is Spotlight's
// on a Mac and Ctrl+Space switches the input language on Windows, Linux and a Mac with two keyboards, so the browser
// never sees either reliably. Search has focus at once and filters as you type; Enter opens the first match, Esc
// closes, the arrow keys move between apps. Each tile says its live state under its name. Opening one adds it to the
// tiling (or focuses it). Its own chunk: it loads the first time it opens.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Primitive from '@radix-ui/react-dialog';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { iconFor } from './safe';
import { AgentAvatar } from './blocks';
import { AppIcon } from './app-icon';
import { useTint } from './tint';
import { markColor } from './look';
import './faceframe.css';
import { firstMatch, launcherOf, launchFilter, type LaunchApp } from './launch-list';
import type { Shell } from './loom';
import './launcher.css';

const DOT: Record<string, string> = { warn: 'var(--loom-warn)', bad: 'var(--loom-bad)', muted: 'var(--loom-muted)' };


export default function Launcher({ open, onOpenChange, shell, icon, launch, look, motion }: {
  open: boolean; onOpenChange: (o: boolean) => void; shell: Shell; icon: (label: string) => string;
  /** Open an app (a tile on the desktop). */ launch: (href: string) => void; look?: string; motion?: string;
}) {
  const tint = useTint();
  const [q, setQ] = useState('');
  useEffect(() => { if (open) setQ(''); }, [open]);
  const all = useMemo(() => launcherOf(shell, { look, motion }), [shell, look, motion]);
  const shown = useMemo(() => launchFilter(all, q), [all, q]);
  const flat = shown.flatMap((s) => s.apps);
  const first = q.trim() ? firstMatch(flat, q) : undefined;
  const body = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const go = (href: string) => { onOpenChange(false); launch(href); };

  // The arrow keys between apps: across a row, and up or down to the nearest app in the row above or below (measured,
  // so it follows the grid however it wraps). Down from the search field is the first app.
  const move = (e: React.KeyboardEvent) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const tiles = [...(body.current?.querySelectorAll<HTMLButtonElement>('.loom-lapp') ?? [])];
    if (!tiles.length) return;
    const at = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) { if (e.key === 'ArrowDown') { e.preventDefault(); tiles[0].focus(); } return; }
    e.preventDefault();
    if (e.key === 'Home') return tiles[0].focus();
    if (e.key === 'End') return tiles[tiles.length - 1].focus();
    if (e.key === 'ArrowLeft') return tiles[Math.max(0, at - 1)].focus();
    if (e.key === 'ArrowRight') return tiles[Math.min(tiles.length - 1, at + 1)].focus();
    const r = tiles[at].getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const down = e.key === 'ArrowDown';
    const rows = tiles.filter((t) => { const b = t.getBoundingClientRect(); return down ? b.top > r.top + r.height / 2 : b.bottom < r.top + r.height / 2; });
    if (!rows.length) { if (!down) field.current?.focus(); return; }
    const rowTop = down ? Math.min(...rows.map((t) => t.getBoundingClientRect().top)) : Math.max(...rows.map((t) => t.getBoundingClientRect().top));
    const row = rows.filter((t) => Math.abs(t.getBoundingClientRect().top - rowTop) < 4);
    row.sort((a, b) => Math.abs(a.getBoundingClientRect().left + a.getBoundingClientRect().width / 2 - cx) - Math.abs(b.getBoundingClientRect().left + b.getBoundingClientRect().width / 2 - cx));
    row[0].focus();
  };

  const tile = (a: LaunchApp) => {
    const t = a.agent ? undefined : tint(a.label);
    return (
      <button key={a.href} type="button" className="loom-lapp" data-first={a === first || undefined} data-tint={t}
        aria-label={`${a.label}${a.sub ? `, ${a.sub}` : ''}`} onClick={() => go(a.href)}>
        {a.agent ? (() => { const ag = shell.agents.find((x) => x.id === a.agent)!; return (
          <span className="loom-lapp__face loom-faceframe" style={{ '--c': markColor(ag.bg) } as React.CSSProperties}><AgentAvatar a={ag} size={48} state={ag.asks ? 'needs-input' : 'idle'} /></span>); })()
          : <span className="loom-lapp__ico loom-launch-tile" data-tint={t}><AppIcon label={a.label} name={iconFor(a.icon ?? icon(a.label))} /></span>}
        {a.count ? <span className="loom-lapp__badge loom-data" aria-hidden>{a.count}</span> : null}
        {a.tone && a.tone !== 'ok' && DOT[a.tone] ? <span className="loom-lapp__dot" style={{ background: DOT[a.tone] }} aria-hidden /> : null}
        <span className="loom-lapp__nm">{a.label}</span>
        <span className="loom-lapp__sub loom-data" aria-hidden>{a.sub ?? ''}</span>
      </button>
    );
  };

  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="loom-lscrim" />
        <Primitive.Content className="loom-launcher" aria-describedby={undefined} onKeyDown={move}
          onOpenAutoFocus={(e) => { e.preventDefault(); field.current?.focus(); }}>
          <div className="loom-launcher__head">
            <Primitive.Title className="loom-launcher__title">Apps</Primitive.Title>
            <label className="loom-launcher__field">
              <AnimatedIcon name={iconFor('search')} size="sm" />
              <input ref={field} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type to find an app" aria-label="Find an app" autoComplete="off" spellCheck={false}
                aria-controls="loom-launcher-apps"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const f = firstMatch(flat, q); if (f) go(f.href); } }} />
            </label>
            <button type="button" className="loom-launcher__me" onClick={() => go('/account')}>
              <span className="loom-letter" aria-hidden>{(shell.owner || '?')[0].toUpperCase()}</span>
              <span className="grid text-left leading-tight"><span>{shell.owner[0].toUpperCase() + shell.owner.slice(1)}</span><span className="loom-data loom-launcher__me-sub">Account</span></span>
            </button>
          </div>
          <div ref={body} id="loom-launcher-apps" className="loom-launcher__body">
            {shown.length ? shown.map((s) => (
              <section key={s.name} className="loom-lsec" aria-label={s.name}>
                <h3 className="loom-lsec__name">{s.name}</h3>
                <div className="loom-lgrid">{s.apps.map(tile)}</div>
              </section>
            )) : <p className="loom-launcher__none" role="status">No app called “{q.trim()}”.</p>}
          </div>
          <div className="loom-launcher__foot" aria-hidden>
            <span><kbd>Enter</kbd> opens the first match</span><span><kbd>←↑↓→</kbd> move</span><span><kbd>Esc</kbd> closes</span>
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
