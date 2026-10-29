// A desktop's side of the page, as 000h's own docs have it (Jonathan, 2026-10-29): one panel down the whole side,
// loom's mark and name at the top, Find under it (⌘K), the pages in groups, and who's signed in at the bottom.
import { useEffect, useRef, useState } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroupLabel, SidebarHeader, SidebarMenuBadge, SidebarMenuButton, SidebarMenuLabel } from '@/components/ui/sidebar';
import type { AgentHead, AgentView, Chrome } from './loom';
import { iconFor } from './safe';
import { AgentAvatar } from './blocks';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Kbd } from '@/components/ui/kbd';

type Item = { label: string; href: string; current: boolean; count?: number };

export function LoomSidebar({ chrome, head, agent, go, icon }: {
  chrome: Chrome; head?: AgentHead; agent?: AgentView; go: (href: string) => void; icon: (label: string) => string;
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
  const mark = (a: { label: string; bg: string; fg: string }) => <AgentAvatar a={a} size={24} className="shrink-0" />;
  const groups: { label?: string; items: React.ReactNode[] }[] = [];
  if (s) {
    const places = [...s.core, ...s.pieces.filter((p) => p.kind !== 'setting')].filter((p) => p.href !== '/inbox');
    const settings = s.pieces.filter((p) => p.kind === 'setting');
    // The same swap as a phone's dock (Jonathan, 2026-10-29): on an agent's pages the side is that agent's: its mark
    // with a back chevron first (the household), then its tabs, then the other agents to switch to. On the household's,
    // the settings pieces fold into Setup, so the side never needs to scroll.
    if (head && agent) {
      groups.push({ items: [(
        <SidebarMenuButton key="#back" href="/" label={`${agent.label}: back to the household`} className="loom-side-back"
          onClick={(e) => { e.preventDefault(); go('/'); }}>
          <span className="relative grid size-8 shrink-0 place-items-center rounded-[10px] text-sm font-semibold" style={{ background: agent.bg, color: agent.fg }}>
            {agent.label[0]}
            <span className="absolute -left-1.5 -top-1.5 grid size-[18px] place-items-center rounded-full border-2 border-[var(--v-paper)] bg-[var(--v-text)] text-[color:var(--v-canvas)]">
              <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 6l-6 6 6 6" /></svg>
            </span>
          </span>
          <SidebarMenuLabel className="grid leading-tight"><span className="truncate font-semibold">{agent.label}</span><span className="text-xs opacity-70">The household</span></SidebarMenuLabel>
        </SidebarMenuButton>
      )] });
      groups.push({ items: head.tabs.map((t) => row(t)) });
      const others = s.agents.filter((a) => a.id !== agent.id);
      if (others.length) groups.push({ label: 'Switch to', items: others.map((a) => row({ label: a.label, href: a.href, current: false, count: a.asks }, mark(a))) });
    } else {
      groups.push({ items: [row({ label: 'Home', href: s.home, current: s.tab === 'home' }), row({ label: 'Inbox', href: '/inbox', current: location.pathname === '/inbox', count: s.asks })] });
      if (places.length) groups.push({ label: 'Places', items: places.map((p) => row(p)) });
      groups.push({ label: 'Agents', items: s.agents.map((a) => row({ label: a.label, href: a.href, current: false, count: a.asks }, mark(a))) });
      groups.push({ items: [row({ label: 'Setup', href: '/setup', current: s.tab === 'setup' || settings.some((p) => p.current) })] });
    }
  }
  return (
    <Sidebar aria-label="loom" className="loom-side sticky top-3 m-3 mr-0 h-[calc(100dvh-24px)] w-[16.5rem] overflow-hidden">
      <SidebarHeader className="mb-4 justify-start gap-3 px-1">
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
        <Kbd>{mac ? '⌘' : 'Ctrl'} K</Kbd>
      </button>
      <SidebarContent className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 py-2">
        {groups.map((g, n) => (
          <div key={n} className="grid gap-[2px] pb-3">
            {g.label && <SidebarGroupLabel>{g.label}</SidebarGroupLabel>}
            {g.items}
          </div>
        ))}
      </SidebarContent>
      <SidebarFooter className="border-t pt-3">
        {s && <AccountMenu owner={s.owner} sub={s.household ? 'Owner' : 'Signed in'} csrf={chrome.csrf} go={go} />}
      </SidebarFooter>
    </Sidebar>
  );
}

/** Who's signed in, at the foot of the side: a button that opens their menu (Setup, Passkeys, Sign out) above it. */
function AccountMenu({ owner, sub, csrf, go }: { owner: string; sub: string; csrf: string; go: (href: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const out = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('pointerdown', away); addEventListener('keydown', key);
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => { removeEventListener('pointerdown', away); removeEventListener('keydown', key); };
  }, [open]);
  const item = (label: string, iconName: string, run: () => void) => (
    <button type="button" role="menuitem" className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm hover:bg-[var(--v-beige)] focus-visible:bg-[var(--v-beige)] focus-visible:outline-none"
      onClick={() => { setOpen(false); run(); }}><AnimatedIcon name={iconFor(iconName)} size="sm" />{label}</button>
  );
  return (
    <div ref={box} className="relative">
      {open && (
        <div role="menu" aria-label="Account" className="loom-menu absolute inset-x-0 bottom-[calc(100%+8px)] z-10 grid gap-0.5 rounded-2xl border p-1.5"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            e.preventDefault();
            const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
            const at = items.indexOf(document.activeElement as HTMLElement);
            items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
          }}>
          {item('Setup', 'settings', () => go('/setup'))}
          {item('Passkeys', 'key-round', () => go('/passkeys'))}
          <div className="my-1 border-t" />
          {item('Sign out', 'log-out', () => out.current?.submit())}
        </div>
      )}
      <form ref={out} method="post" action="/logout" hidden><input type="hidden" name="_csrf" value={csrf} /></form>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 rounded-2xl p-1.5 text-left hover:bg-[var(--v-beige)]">
        <Avatar variant="pink" className="size-9 shrink-0"><AvatarFallback>{owner[0]?.toUpperCase()}</AvatarFallback></Avatar>
        <span className="grid min-w-0 flex-1 leading-tight"><span className="truncate text-sm font-medium">{owner}</span><span className="text-xs opacity-70">{sub}</span></span>
        <AnimatedIcon name={iconFor('chevrons-up-down')} size="sm" />
      </button>
    </div>
  );
}
