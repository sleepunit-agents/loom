// A big screen (1024 px and wider, in a household): the tiled desktop (tiling/tiles.tsx, docs/specs/desk-tiling.md), the
// only desktop there is, and its boot. Home is the agents (desk-agents.tsx, docs/specs/agent-desk.md).
//
// Its own chunk, loaded only on a screen this wide (App.tsx): a phone never fetches it.
import { useEffect, useRef, useState } from 'react';
import './desk.css';
import type { Shell } from './loom';
import { reducedMotion } from './access';
export type { DeskHomeData } from './desk-agents';
export { TileDesk } from './tiling/tiles';

// ---- the boot ----------------------------------------------------------------------------------

/** How long the boot stands before it leaves by itself, and how long it takes to leave (desk.css .loom-boot's fade). */
const BOOT_MS = 2200;
const BOOT_FADE_MS = 250;
/** When its last line (the licence) is up: every line is in by then, however many agents the household has. */
const BOOT_LINES_MS = 1100;

/** A name as a licence has it: "Jonathan Barket" → "Jonathan B."; one word stays as it is. */
const initialled = (name: string) => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '';
  const first = w[0][0].toUpperCase() + w[0].slice(1);
  return w.length > 1 ? `${first} ${w[w.length - 1][0].toUpperCase()}.` : first;
};

type BootLine = { k: string; v: string; tone?: 'ok' | 'warn' };

/** What the boot says: only what the shell has. The link, the household and how each agent is (loom's own words for
 * it), the apps in its dock, what needs you, and the licence line, which is the one joke. */
function bootLines(shell: Shell, offline: boolean): BootLine[] {
  const n = shell.agents.length;
  const apps = shell.pieces.length;
  const shown = shell.agents.filter((a) => a.sub).slice(0, 5);
  const more = n - shown.length;
  return [
    { k: 'link', v: offline ? 'offline · saved copy' : 'live', tone: offline ? 'warn' : 'ok' },
    { k: 'household', v: `${n} agent${n === 1 ? '' : 's'}` },
    ...shown.map((a) => ({ k: a.label.toLowerCase(), v: a.sub! })),
    ...(more > 0 && shown.length ? [{ k: `+${more} more`, v: '' }] : []),
    { k: 'apps', v: String(apps) },
    { k: 'needs you', v: String(shell.asks), ...(shell.asks ? { tone: 'warn' as const } : {}) },
    { k: 'validating LOOM//OS™ license', v: 'compliant', tone: 'ok' },
  ];
}

/**
 * A desktop's boot (Jonathan, the prototype's power-on): once a session, never under reduced motion (App.tsx decides,
 * and runs the app's own arrival after it), a couple of seconds of a machine coming up. Its chatter is what loom has;
 * the licence line is the joke. Any key or tap skips it, and a tap that skips it presses nothing under it. It never takes
 * focus, and a screen reader doesn't hear it.
 */
export function DeskBoot({ shell, offline, onDone }: { shell: Shell; offline: boolean; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  // Who it's licensed to: the household owner's name as People has it ("Jonathan Barket"), as Find asks for it; until
  // that answers, the name loom's shell has.
  const [name, setName] = useState(shell.owner);
  useEffect(() => {
    const c = new AbortController();
    fetch('/find', { headers: { accept: 'application/json' }, credentials: 'same-origin', signal: c.signal }).then((r) => r.json())
      .then((d: { suggest?: { people?: { label: string; href: string }[] } }) => {
        const me = d.suggest?.people?.find((p) => p.href === `/people/${shell.owner}`);
        if (me?.label) setName(me.label);
      }).catch(() => {});
    return () => c.abort();
  }, [shell.owner]);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    let t2: ReturnType<typeof setTimeout> | undefined;
    const leave = () => { setLeaving(true); t2 = setTimeout(() => done.current(), BOOT_FADE_MS); };
    const t1 = setTimeout(leave, BOOT_MS);
    const skip = (e: Event) => { if (e.type === 'pointerdown') e.preventDefault(); clearTimeout(t1); if (!t2) leave(); };
    addEventListener('keydown', skip, true); addEventListener('pointerdown', skip, true);
    return () => { clearTimeout(t1); clearTimeout(t2); removeEventListener('keydown', skip, true); removeEventListener('pointerdown', skip, true); };
  }, []);
  const lines = bootLines(shell, offline);
  const step = (BOOT_LINES_MS - 350) / Math.max(1, lines.length - 1);
  return (
    <div className="loom-boot" data-leaving={leaving || undefined} aria-hidden="true">
      <div className="loom-boot__panel">
        <p className="loom-boot__brand">LOOM<i>//</i>OS<sup>™</sup></p>
        <p className="loom-boot__lic">licensed to {initialled(name)}</p>
        <ol className="loom-boot__log">
          {lines.map((l, i) => (
            <li key={i} style={{ '--at': `${Math.round(350 + i * step)}ms` } as React.CSSProperties}>
              <span className="loom-boot__k">{l.k}</span><span className="loom-boot__dots" /><span className="loom-boot__v" data-tone={l.tone}>{l.v}</span></li>
          ))}
        </ol>
        <p className="loom-boot__skip">any key to skip</p>
      </div>
    </div>
  );
}

/** Whether a desktop boots now: not yet this session (nor the app's arrival), and motion allowed (access.ts). Marked at
 * once, so a reload in the middle of it doesn't boot again. */
export function bootsNow(): boolean {
  if (reducedMotion()) return false;
  try {
    if (sessionStorage.getItem('loom-arrived') || sessionStorage.getItem('loom-booted')) return false;
    sessionStorage.setItem('loom-booted', '1');
    return true;
  } catch { return false; }
}
