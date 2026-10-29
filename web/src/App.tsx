// loom's page as an app (docs/specs/ui-app.md): every page is the JSON loom answers for its path.
// A phone gets a top bar and 000h's dock at the bottom (four tabs and More); a desktop the dock as a rail.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentState } from '@/components/ui/agent-state';
import { AnimatedIcon } from '@/components/ui/animated-icon';
// Passkeys' controls (WebAuthn, push) load with that page only.
const PasskeyAdd = lazy(() => import('./passkeys').then((m) => ({ default: m.PasskeyAdd })));
const PushSwitch = lazy(() => import('./passkeys').then((m) => ({ default: m.PushSwitch })));
import { ArrivalContext, type Arrivals } from './arrive';
import { LoomSidebar } from './sidebar';
import { Boundary, iconFor } from './safe';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dock, type DockItem } from '@/components/ui/dock';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Spinner } from '@/components/ui/spinner';
import { Toast, ToastAction, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from '@/components/ui/toast';
import { act, fetchView, type ActResult, type AgentHead, type Chrome, type Ctx, type Flash, type Page, type View } from './loom';
import { BlockView, EnvContext, Nothing, type Env } from './blocks';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Appearance, DashboardView, HouseHomeView, InboxView, SheetView, type Mode } from './views';

const ICON: Record<string, string> = {
  Today: 'house', Home: 'house', Inbox: 'inbox', Places: 'layout-grid', Find: 'search', Setup: 'settings', Mind: 'brain', People: 'users',
  Knowledge: 'book-open', Bridges: 'messages-square', Clock: 'alarm-clock', Fuel: 'fuel', Houses: 'container', Secrets: 'key-round',
  Boxes: 'server', Subscriptions: 'credit-card', Tasks: 'list-checks', More: 'ellipsis', Activity: 'activity', Machine: 'cpu', Approvals: 'shield-check',
};
const icon = (label: string) => ICON[label] ?? 'circle';

function useWide() {
  const q = '(min-width: 1024px)';
  const [wide, set] = useState(() => matchMedia(q).matches);
  useEffect(() => { const m = matchMedia(q); const f = () => set(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return wide;
}

type Note = { id: number; ok: boolean; message: string; from?: string; undo?: Flash['undo'] };
type Tab = { label: string; href: string; current: boolean; count?: number };

/** The tabs of this page: an agent's own (its head), else the household's. */
function tabsOf(chrome: Chrome, head: AgentHead | undefined): { tabs: Tab[]; more: Tab[] } {
  if (head) return { tabs: head.tabs, more: [] };
  const s = chrome.shell;
  if (!s) return { tabs: chrome.nav.map((n) => ({ ...n })), more: [] };
  const places = [...s.core, ...s.pieces.filter((p) => p.kind !== 'setting')];
  const settings = s.pieces.filter((p) => p.kind === 'setting');
  const home = { label: 'Home', href: s.home, current: s.tab === 'home' };
  const inbox = { label: 'Inbox', href: '/inbox', current: location.pathname === '/inbox', count: s.asks };
  const setup = { label: 'Setup', href: '/setup', current: s.tab === 'setup' || settings.some((p) => p.current) };
  // A phone (docs/specs/ui-app.md): Home, Inbox, Places, Find, and More (Setup and every place). A desktop's rail: all of it.
  const phone: Tab[] = [home, inbox, { label: 'Places', href: '/places', current: s.tab === 'places' || places.some((p) => p.current) },
    { label: 'Find', href: '/find', current: s.tab === 'find' }];
  return matchMedia('(min-width: 1024px)').matches
    ? { tabs: [home, inbox, ...places.filter((p) => p.href !== '/inbox'), setup], more: settings }
    : { tabs: phone, more: [setup, ...places.filter((p) => p.href !== '/inbox'), ...settings] };
}

export default function App() {
  const wide = useWide();
  const [vw, setVw] = useState(() => innerWidth);
  useEffect(() => { const f = () => setVw(innerWidth); addEventListener('resize', f); return () => removeEventListener('resize', f); }, []);
  const [url, setUrl] = useState(() => location.pathname + location.search);
  const [data, setData] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A page with no copy kept yet: the last one dims under Orbit until it lands.
  const [waiting, setWaiting] = useState(false);
  const [savedAt, setSavedAt] = useState<string | undefined>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [more, setMore] = useState(false);
  // Appearance: the system's by default (Auto); Light or Dark is a choice in Setup and More, kept in this browser.
  const [mode, setModeState] = useState<Mode>(() => { try { return (localStorage.getItem('loom-mode') as Mode) || 'auto'; } catch { return 'auto'; } });
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => { const m = matchMedia('(prefers-color-scheme: dark)'); const f = () => setSystemDark(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  const effective = mode === 'auto' ? (systemDark ? 'dark' : 'light') : mode;
  useEffect(() => { document.documentElement.dataset.mode = effective; }, [effective]);
  const setMode = (m: Mode) => { setModeState(m); try { localStorage.setItem('loom-mode', m); } catch { /* private window */ } };

  // eslint-disable-line react-hooks/exhaustive-deps

  const say = useCallback((n: Omit<Note, 'id'>) => setNotes((x) => [...x, { ...n, id: Date.now() + Math.random() }]), []);

  // The last copy of each page this tab has seen, and its fingerprint: a page opens at once from it while loom is
  // asked behind it, and a 304 ("nothing new") leaves it as it is (Jonathan, 2026-10-29: "this site is sloooow").
  const kept = useRef(new Map<string, { etag?: string; data: View }>());
  const showing = useRef(url);
  const load = useCallback(async (to: string, push: boolean, quiet = false) => {
    const have = kept.current.get(to);
    if (!quiet) {
      showing.current = to;
      if (have) {
        if (push && to !== location.pathname + location.search) history.pushState(null, '', to);
        setError(null); setData(have.data); setUrl(to); setSavedAt(undefined); window.scrollTo({ top: 0 });
      }
      setLoading(true);
      setWaiting(!have);
    }
    const r = await fetchView(to, have?.etag).catch(() => ({ status: 0 } as { status: number; data?: View; redirect?: string; savedAt?: string; etag?: string }));
    if (!quiet && showing.current === to) setWaiting(false);
    if (showing.current !== to) {   // another page was asked for meanwhile: keep this answer for later, show nothing
      if (r.data && r.etag && !r.redirect && !r.savedAt) kept.current.set(to, { etag: r.etag, data: { ...r.data, chrome: { ...r.data.chrome, flash: undefined } } });
      return;
    }
    setLoading(false);
    if (r.status === 304) return;   // nothing new: what's shown is current
    if ((quiet || have) && !r.data && !r.redirect) return;   // a refresh that missed keeps what's shown
    if (!r.data && (r.redirect || r.status === 401)) { location.href = r.redirect ?? '/login'; return; }   // signed out: loom's own sign-in page
    if (r.redirect) { to = r.redirect; if (!push || have) history.replaceState(null, '', to); }   // loom moved it (/mind → an agent's Mind): show where it landed
    if (!r.data) {
      if (push && to !== location.pathname + location.search) history.pushState(null, '', to);
      setSavedAt(undefined); setUrl(to);
      setError(r.status ? `loom answered ${r.status} for ${to}` : 'Can’t reach loom, and this page isn’t saved on this device. It opens when there’s a connection.');
      return;
    }
    // A one-time message (?_flash=, after a form's post) is shown once, then leaves the address.
    const once = /[?&]_flash=/.test(to);
    if (once) { const u = new URL(to, location.href); u.searchParams.delete('_flash'); to = u.pathname + u.search; if (!push) history.replaceState(null, '', to); }
    if (push && to !== location.pathname + location.search) history.pushState(null, '', to);
    showing.current = to;
    setError(null); setData(r.data); setUrl(to); setSavedAt(r.savedAt);
    if (r.etag && !r.savedAt) kept.current.set(to, { etag: r.etag, data: { ...r.data, chrome: { ...r.data.chrome, flash: undefined } } });
    const flash = r.data.chrome?.flash;
    if (flash) say(flash);
    if (!quiet && !have) window.scrollTo({ top: 0 });
  }, [say]);

  // What's new arrives (arrive.tsx): what this page showed at its last answer, against what it shows now.
  const shown = useRef<{ url: string; data: View | null; keys: Set<string> }>({ url: '', data: null, keys: new Set() });
  const arrivals: Arrivals = { before: shown.current.url === url && shown.current.data !== null ? shown.current.keys : null, now: new Set() };
  useEffect(() => { shown.current = { url, data, keys: arrivals.now }; });   // after every draw

  // Live (src/ui/live.ts): loom says "something changed" and this page asks again, with its fingerprint (a 304
  // when nothing it shows moved). While the stream is open, the timer below is only a slow fallback.
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!('EventSource' in window)) return;
    const es = new EventSource('/events');
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.addEventListener('change', () => { if (!document.hidden) void load(showing.current, false, true); });
    const back = () => { if (!document.hidden) void load(showing.current, false, true); };
    document.addEventListener('visibilitychange', back);
    return () => { es.close(); document.removeEventListener('visibilitychange', back); };
  }, [load]);

  // A page that stays fresh is fetched again in place (the classic page's data-live): page.refresh seconds, or 20 for a
  // page without a form, and Home, Today and the Inbox; never while a sheet, an editor or a field is in use, or hidden.
  const every = !data ? 0 : data.view === 'page' ? (data.page.refresh ?? (JSON.stringify(data.page).includes('"type":"form"') ? 0 : 20))
    : data.view === 'sheet' ? 0 : 20;
  useEffect(() => {
    if (!every) return;
    const t = setInterval(() => {
      const busy = document.hidden || document.querySelector('[role="dialog"],[role="alertdialog"]') || (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName));
      if (!busy) void load(location.pathname + location.search, false, true);
    }, (live ? Math.max(every, 60) : every) * 1000);
    return () => clearInterval(t);
  }, [every, live]); 

  useEffect(() => { const f = () => void load(location.pathname + location.search, false, true); addEventListener('online', f); return () => removeEventListener('online', f); }, [load]);
  useEffect(() => { void load(url, false); const f = () => void load(location.pathname + location.search, false); addEventListener('popstate', f); return () => removeEventListener('popstate', f); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const go = useCallback((href: string) => {
    const u = new URL(href, location.href);
    if (u.origin !== location.origin || u.pathname.startsWith('/app/') || /^\/(login|logout)/.test(u.pathname)) { location.href = href; return; }
    void load(u.pathname + u.search, true);
  }, [load]);

  const chrome = data?.chrome;
  const ctx = (data && 'ctx' in data ? data.ctx : undefined) as Ctx | undefined;
  const head = data?.view === 'page' ? data.head : data?.view === 'dashboard' ? (data.dashboard as { agent?: AgentHead }).agent : undefined;
  const accent = useMemo(() => {
    const agentId = /^\/a\/([a-z][a-z0-9-]*)/.exec(url)?.[1];
    return agentId ? chrome?.shell?.agents.find((a) => a.id === agentId) : undefined;
  }, [url, chrome]);

  const send = useCallback(async (action: string, fields: Record<string, string>, on?: Ctx): Promise<boolean> => {
    const c = on ?? ctx;
    if (!c || !chrome) return false;
    const r: ActResult = await act(c, chrome.csrf, action, fields);
    say({ ok: r.ok, message: r.message, from: r.from, undo: r.undo });
    if (r.go) go(r.go); else if (r.ok) void load(url, false);
    return r.ok;
  }, [ctx, chrome, say, go, load, url]);

  // Pages without a ctx of their own (the household's home, a sheet) act and link as loom itself.
  const baseCtx: Ctx | null = ctx ?? (chrome ? { source: { id: 'loom', base: '/' }, path: url.replace(/^\//, '').split('?')[0], query: {}, csrf: chrome.csrf,
    agents: Object.fromEntries((chrome.shell?.agents ?? []).map((a) => [a.id, { label: a.label, bg: a.bg, fg: a.fg }])) } : null);
  // Acting as another source (an ask's or a tile's piece, an Inbox item's), the page to come back to is still this one:
  // it goes as loom's own link (loom:inbox?i=…), or the piece reads it as one of its pages and lands on its Not found.
  // (An agent's page is loom's too, under /a/<agent>/: loom:a/art, loom:a/art/mind.)
  const backAs = (c: Ctx) => (c.source.id !== 'loom' || c.path.startsWith('loom:') ? c.path
    : `loom:${(c.source.base.slice(1) + c.path).replace(/\/$/, '')}`);
  const envFor = (c: Ctx): Env => ({ ctx: c, send: (a, f) => send(a, f, c), go, wide, withSource: (source) => envFor({ ...c, source, path: backAs(c) }) });
  const env: Env | null = baseCtx ? envFor(baseCtx) : null;
  const nav = chrome ? tabsOf(chrome, head) : { tabs: [], more: [] };
  // A phone's dock: the first tab, the one you're on, and the next ones in order, four in all; the rest in More.
  // A phone's dock never scrolls (Jonathan, 2026-10-29): as many tiles as the width holds, the one you're on always
  // among them, the rest under More (…). On an agent's pages the dock swaps (his "dock swap" board): the agent's
  // mark with a back chevron on the left, the household a tap away, and its own tabs on the right in its colour.
  const agentDock = !!head && !!accent;
  const room = agentDock ? Math.max(3, Math.floor((vw - 52) / 60) - 1) : Math.max(4, Math.floor((vw - 40) / 60));
  const onPhone = (() => {
    if (nav.tabs.length <= room && !nav.more.length) return nav.tabs;
    const keep = nav.tabs.slice(0, room - 1);
    const cur = nav.tabs.find((t) => t.current);
    if (cur && !keep.includes(cur)) keep[keep.length - 1] = cur;
    return nav.tabs.filter((t) => keep.includes(t));
  })();
  const phoneTabs = onPhone.length < nav.tabs.length || nav.more.length ? [...onPhone, { label: 'More', href: '#more', current: false }] : nav.tabs;
  const moreTabs = [...nav.tabs.filter((t) => !onPhone.includes(t)), ...nav.more];
  const dockItems = (list: Tab[]): DockItem[] => list.map((t) => ({
    value: t.href, label: t.label, icon: <AnimatedIcon name={iconFor(icon(t.label))} active={t.current} />,
    ...(t.count ? { badge: <span className="text-[10px] font-semibold">{t.count}</span> } : {}),
  }));
  const current = (list: Tab[]) => list.find((t) => t.current)?.href ?? '';
  const pick = (href: string) => (href === '#more' ? setMore(true) : href === '#back' ? go('/') : go(href));
  const backTile: DockItem | null = agentDock && accent ? {
    value: '#back', label: 'Back',
    icon: <span className="loom-back-mark" aria-hidden>{accent.label[0]}</span>,
    badge: <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 6l-6 6 6 6" /></svg>,
  } : null;
  const title = data?.view === 'page' || data?.view === 'passkeys' ? (data.page as Page).title : head?.label ?? (data?.view === 'dashboard' ? (data.dashboard as { label?: string }).label
    : data?.view === 'inbox' ? 'Inbox' : data?.view === 'sheet' ? String(data.which).replace(/^./, (c) => c.toUpperCase()) : 'Home');

  return (
    <ToastProvider swipeDirection={wide ? 'right' : 'down'}>
      <div className="relative isolate min-h-dvh lg:grid lg:grid-cols-[17.25rem_minmax(0,1fr)]" data-mode={effective} data-accent={accent ? accentOf(accent.bg) : undefined}
        style={accent ? ({ '--loom-accent': accent.bg, '--loom-on-accent': accent.fg } as React.CSSProperties) : undefined}>
        {/* 000h's wash (its docs' page): soft pools of pink, blue and yellow behind everything, fixed as the page scrolls. */}
        <span aria-hidden className="loom-wash pointer-events-none fixed inset-0 -z-10" />
        {wide && chrome && <LoomSidebar chrome={chrome} head={head} agent={accent} go={go} icon={icon} />}
        <div className="min-w-0">
          <header className="loom-top sticky top-0 z-20 border-b backdrop-blur [padding-top:env(safe-area-inset-top)] lg:border-0 lg:pt-3">
            <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
              {chrome?.shell?.back ? null : accent && chrome?.shell?.household ? (
                // An agent's own pages: its mark, with a chevron, is the way back to the household.
                <button type="button" aria-label="Back to the household" onClick={() => go('/')} className="-ml-1 flex shrink-0 items-center gap-0.5 rounded-2xl p-1 hover:bg-[color:var(--v-beige)]">
                  <AnimatedIcon name={iconFor("chevron-left")} size="sm" />
                  <span className="grid size-9 place-items-center rounded-xl text-lg font-semibold" style={{ background: accent.bg, color: accent.fg }}>{accent.label[0]}</span>
                </button>
              ) : accent ? (
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl text-lg font-semibold" style={{ background: accent.bg, color: accent.fg }}>{accent.label[0]}</span>
              ) : null}
              <div className="min-w-0 flex-1">
                {chrome?.shell?.back && (
                  // Where this page sits (000h's breadcrumb): the page it's under, then this one.
                  <Breadcrumb aria-label="You are here" className="[&_[data-slot=breadcrumb-page]]:text-lg [&_[data-slot=breadcrumb-page]]:font-semibold"><BreadcrumbList>
                    <BreadcrumbItem><BreadcrumbLink href={chrome.shell.back.href} onClick={(e) => { e.preventDefault(); go(chrome.shell!.back!.href); }}>{chrome.shell.back.label}</BreadcrumbLink></BreadcrumbItem>
                    <BreadcrumbSeparator /><BreadcrumbItem><BreadcrumbPage>{title}</BreadcrumbPage></BreadcrumbItem>
                  </BreadcrumbList></Breadcrumb>
                )}
                <h1 className={chrome?.shell?.back ? 'sr-only' : 'truncate text-lg font-semibold leading-tight'}>{title}</h1>
                {head?.sub && <p className="truncate text-sm opacity-70">{head.sub}</p>}
              </div>
              {loading && <Spinner appearance="relay" aria-label="Loading" />}
              {accent && wide && <AgentState status={accent.asks ? 'needs-input' : 'idle'} size="sm" label={accent.asks ? `${accent.asks} waiting` : 'Ready'} description={accent.sub} />}
            </div>
          </header>

          {waiting && <div className="pointer-events-none fixed inset-0 z-10 grid place-items-center lg:pl-[17.25rem]" aria-hidden><Spinner appearance="orbit" className="scale-[2.2]" /></div>}
          <main aria-busy={waiting || undefined} className={`mx-auto max-w-5xl px-4 pb-44 pt-5 transition-opacity duration-300 lg:pb-10 ${waiting ? 'opacity-35' : ''}`}>
            {savedAt && <p role="status" className="mb-4 rounded-2xl border px-4 py-3 text-sm">Can’t reach loom: this is how it looked at {new Date(savedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}. Actions wait for a connection.</p>}
            {error && <Card><CardContent className="py-6"><p>{error}</p>{navigator.onLine && <Button className="mt-3" variant="outline" onClick={() => location.reload()}>Try again</Button>}</CardContent></Card>}
            {!error && data && env && (
              <ArrivalContext.Provider value={arrivals}><EnvContext.Provider value={env}><Boundary where={url}>
                {data.view === 'page' ? <PageView page={data.page} unscoped={data.unscoped} />
                  : data.view === 'house-home' ? <HouseHomeView home={data.home as never} />
                  : data.view === 'dashboard' ? <DashboardView d={data.dashboard as never} now={data.now as number} />
                  : data.view === 'home' ? <><DashboardView d={{ label: 'Home', asks: data.asks as never, tiles: data.tiles as never, thread: [] }} now={Date.now()} /><div className="mt-4"><PageView page={data.page as Page} /></div></>
                  : data.view === 'inbox' ? <InboxView items={data.items as never} folder={data.folder as string} chrome={data.chrome} />
                  : data.view === 'passkeys' ? <div className="grid gap-4"><PageView page={data.page as Page} /><Suspense fallback={<Spinner appearance="orbit" />}><PasskeyAdd add={data.add as never} reload={() => void load(url, false, true)} />
                    <PushSwitch csrf={data.chrome.csrf} /></Suspense></div>
                  : data.view === 'sheet' ? <SheetView which={data.which as string} chrome={data.chrome} q={(data.q as string) ?? ''} found={data.found as never} mode={mode} setMode={setMode} />
                  : <NotYet kind={data.view} url={url} />}
              </Boundary></EnvContext.Provider></ArrivalContext.Provider>
            )}
            {!error && data && !env && <NotYet kind={data.view} url={url} />}
          </main>

          {!wide && chrome && <div aria-hidden className="pointer-events-none fixed inset-x-0 bottom-0 z-20 h-44" style={{ background: 'linear-gradient(to top, var(--v-canvas) 45%, transparent)' }} />}
          {!wide && chrome && (
            <nav className="fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 [padding-bottom:calc(env(safe-area-inset-bottom)_+_8px)]">
              <Dock key={agentDock ? `agent:${accent?.id}` : 'household'} variant="shelf" className={agentDock ? 'loom-agent-dock' : undefined}
                items={backTile ? [backTile, ...dockItems(phoneTabs)] : dockItems(phoneTabs)} value={current(phoneTabs)} onValueChange={pick}
                aria-label={agentDock ? `${accent?.label}'s pages` : 'Pages'} />
            </nav>
          )}
        </div>
      </div>

      <Drawer open={more} onOpenChange={setMore}>
        <DrawerContent>
          <DrawerHeader><DrawerTitle>More</DrawerTitle>{head && <DrawerDescription>{head.label}'s other pages</DrawerDescription>}</DrawerHeader>
          <div className="grid grid-cols-2 gap-2">
            {moreTabs.map((t) => <Button key={t.href} variant="secondary" className="h-14 justify-start gap-3" onClick={() => { setMore(false); go(t.href); }}><AnimatedIcon name={iconFor(icon(t.label))} /> {t.label}</Button>)}
          </div>
          {chrome?.shell && chrome.shell.agents.length > 1 && (
            <div className="grid gap-2">
              <p className="text-sm opacity-70">Agents</p>
              {chrome.shell.agents.map((a) => (
                <Button key={a.id} variant="ghost" className="justify-start gap-3" onClick={() => { setMore(false); go(a.href); }}>
                  <span className="grid size-7 place-items-center rounded-lg text-xs font-semibold" style={{ background: a.bg, color: a.fg }}>{a.label[0]}</span>{a.label}
                  {a.asks ? <span className="ml-auto text-xs opacity-70">{a.asks} waiting</span> : null}
                </Button>
              ))}
              <Button variant="ghost" className="justify-start gap-3" onClick={() => { setMore(false); go('/'); }}><AnimatedIcon name={iconFor("house")} /> The household</Button>
            </div>
          )}
          <div className="grid gap-2"><p className="text-sm opacity-70">Appearance</p><Appearance mode={mode} setMode={setMode} /></div>
        </DrawerContent>
      </Drawer>

      {notes.map((n) => (
        <Toast key={n.id} variant={n.ok ? 'default' : 'danger'} duration={n.undo ? 8000 : 4000} onOpenChange={(o) => !o && setNotes((x) => x.filter((y) => y.id !== n.id))}>
          <div className="grid gap-0.5"><ToastTitle>{n.from ? `${n.from}: ` : ''}{n.ok ? 'Done' : 'Not done'}</ToastTitle><ToastDescription>{n.message}</ToastDescription></div>
          {n.undo && ctx && chrome && (
            <ToastAction altText={n.undo.label ?? 'Undo'} onClick={() => void act({ ...ctx, path: n.undo!.path, query: {} }, chrome.csrf, n.undo!.action, n.undo!.fields ?? {}, n.undo!.act).then((r) => { say(r); void load(url, false); })}>
              {n.undo.label ?? 'Undo'}</ToastAction>
          )}
        </Toast>
      ))}
      <ToastViewport className="[bottom:calc(var(--dock-h)_+_24px_+_env(safe-area-inset-bottom))] lg:bottom-6" />
    </ToastProvider>
  );
}

/** An agent's accent: the 000h family nearest its mark (loom's MARKS: Lilac, Plum, Pine, Mustard, Denim, Coral). */
const ACCENT: Record<string, string> = { '#b8a6ff': 'blue', '#7a2e4f': 'pink', '#2f6b5a': 'olive', '#e3b341': 'yellow', '#3d5a99': 'blue', '#f09a7a': 'pink' };
const accentOf = (bg: string) => ACCENT[bg.toLowerCase()] ?? 'pink';

function PageView({ page, unscoped }: { page: Page; unscoped?: string }) {
  const main = page.sections.filter((s) => !s.side);
  const side = page.sections.filter((s) => s.side);
  const card = (s: Page['sections'][number]) => (
    <Card key={s.id} className={s.tone === 'bad' ? 'ring-1 ring-red-400' : s.tone === 'warn' ? 'ring-1 ring-amber-400' : undefined}>
      {s.title && <CardHeader><CardTitle>{s.title}</CardTitle></CardHeader>}
      <CardContent className="grid min-w-0 gap-4">{s.blocks.map((b, n) => <BlockView key={n} b={b} />)}</CardContent>
    </Card>
  );
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid min-w-0 content-start gap-4">
        {unscoped && <p className="text-sm opacity-70">This piece shows the whole household, not only {unscoped}.</p>}
        {page.sections.length === 0 && (page.title === 'Not found'
          ? <Nothing title="There’s no page here" text="It may have moved, or it was never there." />
          : <Nothing title={`${page.title} has nothing yet`} text="When there’s something to show, it’ll be here." />)}
        {page.intro && <p className="opacity-80">{page.intro}</p>}
        {main.map(card)}
      </div>
      {side.length > 0 && <aside className="grid min-w-0 content-start gap-4">{side.map(card)}</aside>}
    </div>
  );
}

/** A kind of page this version of the app doesn't know (a newer loom): said, not blank. */
function NotYet({ kind, url }: { kind: string; url: string }) {
  return (
    <Card><CardContent className="grid gap-3 py-6">
      <p>The app doesn't draw this page yet ({kind}).</p>
      <Button variant="outline" onClick={() => location.reload()}>Reload</Button>{void url}
    </CardContent></Card>
  );
}
