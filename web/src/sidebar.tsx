// A desktop's side of the page, as 000h's own docs have it (Jonathan, 2026-10-29): one panel down the whole side,
// loom's mark and name at the top, Find under it (⌘K), the pages in groups, and who's signed in at the bottom.
import { useEffect } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroupLabel, SidebarHeader, SidebarMenuBadge, SidebarMenuButton, SidebarMenuLabel } from '@/components/ui/sidebar';
import type { AgentHead, AgentView, Chrome } from './loom';
import { iconFor } from './safe';
import { Appearance, type Mode } from './views';

type Item = { label: string; href: string; current: boolean; count?: number };

export function LoomSidebar({ chrome, head, agent, go, icon, mode, setMode }: {
  chrome: Chrome; head?: AgentHead; agent?: AgentView; go: (href: string) => void; icon: (label: string) => string;
  mode: Mode; setMode: (m: Mode) => void;
}) {
  const s = chrome.shell;
  // ⌘K / Ctrl-K: Find, from anywhere.
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); go('/find'); } };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, [go]);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const row = (t: Item, lead?: React.ReactNode) => (
    <SidebarMenuButton key={t.href} href={t.href} isActive={t.current} onClick={(e) => { e.preventDefault(); go(t.href); }}>
      {lead ?? <AnimatedIcon name={iconFor(icon(t.label))} size="sm" active={t.current} />}
      <SidebarMenuLabel>{t.label}</SidebarMenuLabel>
      {t.count ? <SidebarMenuBadge>{t.count}</SidebarMenuBadge> : null}
    </SidebarMenuButton>
  );
  const mark = (a: { label: string; bg: string; fg: string }) => (
    <span className="grid size-6 shrink-0 place-items-center rounded-lg text-xs font-semibold" style={{ background: a.bg, color: a.fg }}>{a.label[0]}</span>
  );
  const groups: { label?: string; items: React.ReactNode[] }[] = [];
  if (s) {
    const places = [...s.core, ...s.pieces.filter((p) => p.kind !== 'setting')].filter((p) => p.href !== '/inbox');
    const settings = s.pieces.filter((p) => p.kind === 'setting');
    if (head && agent) {
      groups.push({ label: agent.label, items: head.tabs.map((t) => row(t)) });
      groups.push({ items: [row({ label: 'The household', href: '/', current: false }, <AnimatedIcon name={iconFor('house')} size="sm" />)] });
    } else {
      groups.push({ items: [row({ label: 'Home', href: s.home, current: s.tab === 'home' }), row({ label: 'Inbox', href: '/inbox', current: location.pathname === '/inbox', count: s.asks })] });
      if (places.length) groups.push({ label: 'Places', items: places.map((p) => row(p)) });
    }
    if (s.agents.length > 1 || !head) groups.push({ label: 'Agents', items: s.agents.map((a) => row({ label: a.label, href: a.href, current: a.current && !!head, count: a.asks }, mark(a))) });
    if (!head) groups.push({ label: 'Setup', items: [row({ label: 'Setup', href: '/setup', current: s.tab === 'setup' }), ...settings.map((p) => row(p))] });
  }
  return (
    <Sidebar aria-label="loom" className="loom-side sticky top-3 m-3 mr-0 h-[calc(100dvh-24px)] w-[16.5rem] overflow-hidden">
      <SidebarHeader className="flex items-center gap-3 px-1">
        <a href="/" onClick={(e) => { e.preventDefault(); go('/'); }} className="flex min-w-0 items-center gap-3 no-underline">
          <img src="/icons/loom-192.png" alt="" width={40} height={40} className="size-10 shrink-0 rounded-[12px]" />
          <span className="grid min-w-0 leading-tight">
            <span className="text-lg font-semibold">loom</span>
            <span className="truncate text-xs opacity-70">{s?.household ? `${s.owner}'s household` : (s?.owner ?? chrome.agent)}</span>
          </span>
        </a>
      </SidebarHeader>
      <button type="button" onClick={() => go('/find')} className="loom-search mx-1 flex h-11 items-center gap-3 rounded-2xl border px-3 text-left text-sm">
        <AnimatedIcon name={iconFor('search')} size="sm" /><span className="flex-1 opacity-80">Find anything</span>
        <kbd className="rounded-md border px-1.5 text-[11px] opacity-70">{mac ? '⌘' : 'Ctrl'} K</kbd>
      </button>
      <SidebarContent className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 py-2">
        {groups.map((g, n) => (
          <div key={n} className="grid gap-[2px] pb-3">
            {g.label && <SidebarGroupLabel>{g.label}</SidebarGroupLabel>}
            {g.items}
          </div>
        ))}
      </SidebarContent>
      <SidebarFooter className="gap-3 border-t pt-3">
        <Appearance mode={mode} setMode={setMode} />
        {s && (
          <div className="flex items-center gap-3 px-1">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--v-pink)] text-sm font-semibold text-[color:var(--v-on-accent)]">{s.owner[0]?.toUpperCase()}</span>
            <span className="grid min-w-0 flex-1 leading-tight"><span className="truncate text-sm font-medium">{s.owner}</span>
              <a href="/passkeys" onClick={(e) => { e.preventDefault(); go('/passkeys'); }} className="text-xs opacity-70 no-underline hover:underline">Passkeys</a></span>
            <form method="post" action="/logout"><input type="hidden" name="_csrf" value={chrome.csrf} />
              <button type="submit" aria-label="Sign out" title="Sign out" className="grid size-9 place-items-center rounded-full hover:bg-[var(--v-beige)]"><AnimatedIcon name={iconFor('log-out')} size="sm" /></button></form>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
