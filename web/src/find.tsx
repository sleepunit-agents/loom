// Find, as an overlay over whatever you're in (Jonathan, 2026-11-03: "Find as an overlay, spotlight-style, on desktop
// and phone"): it searches as you type, with no submit; before you type it offers where you've been lately, the
// household's people and agents, and the apps. Arrow keys move, Enter opens, Esc puts you back. ⌘K or the side's
// search on a desktop; on a phone, the search pill over the dock on Home and Places (App.tsx FindPill). /find draws
// the same panel as a page, for an old link. Its own chunk: it loads when Find first opens.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Primitive from '@radix-ui/react-dialog';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Spinner } from '@/components/ui/spinner';
import { iconFor } from './safe';
import { AgentAvatar } from './blocks';
import type { Chrome } from './loom';
import { ACCOUNT, placesOf, settingsOf } from './nav';
import { readRecent } from './recent';
import { AppTile } from './app-header';
import { nameTint } from './tint';

type Found = Record<string, { label: string; href: string; agent?: string }[]>;
type Row = { key: string; label: string; href: string; sub?: string; lead: ReactNode };
type Group = { label: string; rows: Row[] };

const Tile = ({ label, icon }: { label: string; icon: string }) => <AppTile label={label} icon={icon} size={36} />;


export function FindPanel({ chrome, icon, go, autoFocus = true, onClose }: {
  chrome: Chrome; icon: (label: string) => string; go: (href: string) => void; autoFocus?: boolean; onClose?: () => void;
}) {
  const s = chrome.shell;
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const [people, setPeople] = useState<{ label: string; href: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const open = (href: string) => { onClose?.(); go(href); };

  // The household's people, for before you type (loom's /find answers them with no words).
  useEffect(() => {
    const c = new AbortController();
    fetch('/find', { headers: { accept: 'application/json' }, credentials: 'same-origin', signal: c.signal })
      .then((r) => r.json()).then((d) => setPeople((d?.suggest?.people as { label: string; href: string }[]) ?? [])).catch(() => {});
    return () => c.abort();
  }, []);

  // Results as you type: loom's search (knowledge, people, memories, what's waiting), asked a beat after the last key.
  const needle = q.trim().toLowerCase();
  useEffect(() => {
    if (!needle) { setFound(null); setBusy(false); return; }
    const c = new AbortController();
    setBusy(true);
    const t = setTimeout(() => {
      fetch(`/find?q=${encodeURIComponent(needle)}`, { headers: { accept: 'application/json' }, credentials: 'same-origin', signal: c.signal })
        .then((r) => r.json()).then((d) => { setFound((d?.found as Found) ?? {}); setBusy(false); }).catch(() => {});
    }, 140);
    return () => { clearTimeout(t); c.abort(); };
  }, [needle]);

  const groups = useMemo<Group[]>(() => {
    if (!s) return [];
    const apps = [...placesOf(s), { label: 'Setup', href: '/setup' }, ...settingsOf(s), ...ACCOUNT]
      .filter((p, n, all) => all.findIndex((x) => x.href === p.href) === n);
    const app = (p: { label: string; href: string; stat?: string }): Row => ({ key: p.href, label: p.label, href: p.href, sub: p.stat, lead: <Tile label={p.label} icon={icon(p.label)} /> });
    const agent = (a: (typeof s.agents)[number]): Row => ({ key: a.href, label: a.label, href: a.href, sub: a.sub ?? 'Agent', lead: <AgentAvatar a={a} size={36} className="shrink-0" /> });
    const person = (p: { label: string; href: string }): Row => ({ key: p.href, label: p.label, href: p.href, sub: 'Person',
      lead: <span className="loom-app-tile grid size-9 shrink-0 place-items-center rounded-full font-semibold" data-tint={nameTint(p.label)}>{p.label[0]?.toUpperCase()}</span> });
    if (!needle) {
      const recent = readRecent().filter((r) => r.href !== location.pathname + location.search).slice(0, 5).map((r): Row => {
        const ag = s.agents.find((a) => r.href === a.href || r.href.startsWith(`${a.href}/`));
        return { key: `r:${r.href}`, label: r.label, href: r.href, sub: ag && r.label !== ag.label ? ag.label : undefined,
          lead: ag ? <AgentAvatar a={ag} size={36} className="shrink-0" /> : <Tile label={r.label} icon={icon(r.label) === 'circle' ? 'history' : icon(r.label)} /> };
      });
      return [
        { label: 'Recent', rows: recent },
        { label: 'People', rows: [...s.agents.map(agent), ...people.filter((p) => !s.agents.some((a) => a.label === p.label)).slice(0, 6).map(person)] },
        { label: 'Apps', rows: apps.map(app) },
      ].filter((g) => g.rows.length);
    }
    const has = (l: string) => l.toLowerCase().includes(needle);
    const f = found ?? {};
    const lead = (name: string, label: string) => <Tile label={label} icon={name} />;
    return [
      { label: 'Go to', rows: [...s.agents.filter((a) => has(a.label)).map(agent), ...apps.filter((p) => has(p.label) || (p.href === '/account' && has('passkeys sign out'))).map(app)] },
      { label: 'Waiting on you', rows: (f.do ?? []).map((x) => ({ key: `d:${x.href}:${x.label}`, label: x.label, href: x.href, lead: lead('inbox', 'Inbox') })) },
      { label: 'People', rows: (f.people ?? []).filter((p) => !s.agents.some((a) => a.label === p.label)).map(person) },
      { label: 'Knowledge', rows: (f.knowledge ?? []).map((x) => ({ key: x.href, label: x.label, href: x.href, lead: lead('book-open', 'Knowledge') })) },
      { label: 'Memories', rows: (f.memories ?? []).map((x) => {
        const ag = s.agents.find((a) => a.id === x.agent);
        return { key: x.href, label: x.label, href: x.href, sub: ag?.label, lead: lead('brain', 'Mind') };
      }) },
    ].filter((g) => g.rows.length);
  }, [s, needle, found, people, icon]);

  const rows = groups.flatMap((g) => g.rows);
  useEffect(() => setSel(0), [needle, found]);
  useEffect(() => { list.current?.querySelector('[data-selected]')?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((n) => Math.min(rows.length - 1, n + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((n) => Math.max(0, n - 1)); }
    else if (e.key === 'Enter' && rows[sel]) { e.preventDefault(); open(rows[sel].href); }
  };
  let n = -1;
  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <label className="loom-find-field flex items-center gap-3 border-b px-4">
        <AnimatedIcon name={iconFor('search')} size="sm" />
        <input autoFocus={autoFocus} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key} placeholder="Find anything" aria-label="Find anything"
          role="combobox" aria-expanded aria-controls="loom-find-list" aria-activedescendant={rows[sel] ? `loom-find-${sel}` : undefined}
          enterKeyHint="go" autoComplete="off" spellCheck={false} className="h-14 min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:opacity-60" />
        {busy && <Spinner size="sm" />}
        {onClose && <button type="button" onClick={onClose} className="loom-find-esc rounded-lg px-2 py-1 text-xs font-medium opacity-70 hover:opacity-100">
          <span className="max-lg:hidden">esc</span><span className="lg:hidden">Cancel</span></button>}
      </label>
      <div ref={list} id="loom-find-list" role="listbox" aria-label="Results" className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-3">
        {groups.map((g) => (
          <div key={g.label} role="group" aria-label={g.label} className="pt-3">
            <p className="loom-find-group px-3 pb-1 text-[11px] font-semibold uppercase tracking-[.1em] opacity-60">{g.label}</p>
            {g.rows.map((r) => { n += 1; const i = n; return (
              <button key={r.key} id={`loom-find-${i}`} type="button" role="option" aria-selected={i === sel} data-selected={i === sel ? '' : undefined}
                onMouseMove={() => setSel(i)} onClick={() => open(r.href)}
                className="loom-find-row flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left">
                {r.lead}
                <span className="grid min-w-0 flex-1 leading-tight"><span className="truncate font-medium">{r.label}</span>{r.sub && <span className="truncate text-xs opacity-60">{r.sub}</span>}</span>
              </button>
            ); })}
          </div>
        ))}
        {needle && !busy && found && rows.length === 0 && (
          <div className="grid justify-items-center gap-1 px-4 py-10 text-center">
            <AnimatedIcon name={iconFor('search-x')} />
            <p className="font-medium">Nothing for “{q.trim()}”</p><p className="text-sm opacity-70">Try fewer words, or another name.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Find over the app you're in: a panel from the top, the page dimmed behind it. */
export default function FindOverlay({ open, onOpenChange, ...rest }: { open: boolean; onOpenChange: (o: boolean) => void; chrome: Chrome; icon: (label: string) => string; go: (href: string) => void }) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="loom-find-scrim fixed inset-0 z-50" />
        <Primitive.Content aria-describedby={undefined} className="loom-find fixed inset-x-0 top-0 z-50 mx-auto grid max-h-[min(80dvh,640px)] w-full overflow-hidden lg:top-[12vh] lg:w-[min(640px,calc(100%-48px))]"
          onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).querySelector('input')?.focus(); }}>
          <Primitive.Title className="sr-only">Find</Primitive.Title>
          {open && <FindPanel {...rest} onClose={() => onOpenChange(false)} />}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
