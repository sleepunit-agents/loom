// loom's page as an app (docs/specs/ui-app.md): every page is the JSON loom answers for its path.
// A phone gets a top bar and 000h's dock at the bottom (four tabs and More); a desktop the dock as a rail.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgentState } from '@/components/ui/agent-state';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dock, type DockItem } from '@/components/ui/dock';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Spinner } from '@/components/ui/spinner';
import { ThemeToggle, type ThemeMode } from '@/components/ui/theme-toggle';
import { Toast, ToastAction, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from '@/components/ui/toast';
import { act, fetchView, type ActResult, type AgentHead, type Chrome, type Ctx, type Flash, type Page, type View } from './loom';
import { BlockView, EnvContext, type Env } from './blocks';

const ICON: Record<string, string> = {
  Today: 'house', Home: 'house', Inbox: 'inbox', Places: 'layout-grid', Find: 'search', Setup: 'settings', Mind: 'brain', People: 'users',
  Knowledge: 'book-open', Bridges: 'messages-square', Clock: 'alarm-clock', Fuel: 'fuel', Houses: 'container', Secrets: 'key-round',
  Boxes: 'server', Subscriptions: 'credit-card', Tasks: 'list-checks', More: 'ellipsis',
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
  const tabs: Tab[] = [
    { label: 'Home', href: s.home, current: s.tab === 'home' },
    { label: 'Inbox', href: '/inbox', current: location.pathname === '/inbox', count: s.asks },
    ...places,
    { label: 'Setup', href: '/setup', current: s.tab === 'setup' || settings.some((p) => p.current) },
  ];
  return { tabs, more: settings };
}

export default function App() {
  const wide = useWide();
  const [url, setUrl] = useState(() => location.pathname + location.search);
  const [data, setData] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<Note[]>([]);
  const [more, setMore] = useState(false);
  const [mode, setMode] = useState<ThemeMode>(() => (localStorage.getItem('loom-mode') as ThemeMode) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  useEffect(() => { document.documentElement.dataset.mode = mode; try { localStorage.setItem('loom-mode', mode); } catch { /* private window */ } }, [mode]);

  const say = useCallback((n: Omit<Note, 'id'>) => setNotes((x) => [...x, { ...n, id: Date.now() + Math.random() }]), []);

  const load = useCallback(async (to: string, push: boolean) => {
    setLoading(true);
    const r = await fetchView(to).catch(() => ({ status: 0 } as { status: number; data?: View; redirect?: string }));
    setLoading(false);
    if (r.redirect || r.status === 401) { location.href = to; return; }   // signed out: loom's own sign-in page
    if (!r.data) { setError(`loom answered ${r.status || 'nothing'} for ${to}`); return; }
    if (push && to !== location.pathname + location.search) history.pushState(null, '', to);
    setError(null); setData(r.data); setUrl(to);
    const flash = r.data.chrome?.flash;
    if (flash) say(flash);
    window.scrollTo({ top: 0 });
  }, [say]);

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

  const send = useCallback(async (action: string, fields: Record<string, string>, actUrl?: string): Promise<boolean> => {
    if (!ctx || !chrome) return false;
    const r: ActResult = await act(ctx, chrome.csrf, action, fields, actUrl);
    say({ ok: r.ok, message: r.message, from: r.from, undo: r.undo });
    if (r.go) go(r.go); else if (r.ok) void load(url, false);
    return r.ok;
  }, [ctx, chrome, say, go, load, url]);

  const env: Env | null = ctx ? { ctx, send, go, wide } : null;
  const nav = chrome ? tabsOf(chrome, head) : { tabs: [], more: [] };
  const phoneTabs = nav.tabs.length > 5 ? [...nav.tabs.slice(0, 4), { label: 'More', href: '#more', current: nav.tabs.slice(4).some((t) => t.current) }] : nav.tabs;
  const moreTabs = [...(nav.tabs.length > 5 ? nav.tabs.slice(4) : []), ...nav.more];
  const dockItems = (list: Tab[]): DockItem[] => list.map((t) => ({
    value: t.href, label: t.label, icon: <AnimatedIcon name={icon(t.label)} active={t.current} />,
    ...(t.count ? { badge: <span className="text-[10px] font-semibold">{t.count}</span> } : {}),
  }));
  const current = (list: Tab[]) => list.find((t) => t.current)?.href ?? '';
  const pick = (href: string) => (href === '#more' ? setMore(true) : go(href));
  const title = data?.view === 'page' ? data.page.title : head?.label ?? (data?.view === 'dashboard' ? (data.dashboard as { label?: string }).label : 'loom');

  return (
    <ToastProvider swipeDirection={wide ? 'right' : 'down'}>
      <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]" data-mode={mode}
        style={accent ? ({ '--loom-accent': accent.bg, '--loom-on-accent': accent.fg } as React.CSSProperties) : undefined}>
        {wide && chrome && (
          <aside className="sticky top-0 h-dvh w-60 overflow-y-auto border-r px-3 py-6">
            <a href="/" onClick={(e) => { e.preventDefault(); go('/'); }} className="mb-4 block px-2 text-lg font-semibold">loom</a>
            <Dock variant="rail" items={dockItems([...nav.tabs, ...nav.more])} value={current([...nav.tabs, ...nav.more])} onValueChange={pick} aria-label="Pages" />
          </aside>
        )}
        <div className="min-w-0">
          <header className="sticky top-0 z-20 border-b backdrop-blur [padding-top:env(safe-area-inset-top)]" style={{ background: 'color-mix(in oklab, var(--v-canvas) 84%, transparent)' }}>
            <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
              {chrome?.shell?.back ? (
                <Button size="sm" variant="ghost" onClick={() => go(chrome.shell!.back!.href)}><AnimatedIcon name="chevron-left" size="sm" /> {chrome.shell.back.label}</Button>
              ) : accent ? (
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl text-lg font-semibold" style={{ background: accent.bg, color: accent.fg }}>{accent.label[0]}</span>
              ) : null}
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-lg font-semibold leading-tight">{title}</h1>
                {head?.sub && <p className="truncate text-sm opacity-70">{head.sub}</p>}
              </div>
              {loading && <Spinner />}
              {accent && <AgentState status={accent.asks ? 'needs-input' : 'idle'} size="sm" label={accent.asks ? `${accent.asks} waiting` : 'Ready'} description={accent.sub} />}
              <ThemeToggle mode={mode} onModeChange={setMode} showLabel={false} />
            </div>
          </header>

          <main className="mx-auto max-w-5xl px-4 pb-44 pt-5 lg:pb-10">
            {error && <Card><CardContent className="py-6"><p>{error}</p><Button className="mt-3" variant="outline" onClick={() => { location.href = `${url}${url.includes('?') ? '&' : '?'}ui=classic`; }}>Open the classic page</Button></CardContent></Card>}
            {!error && data && env && (
              <EnvContext.Provider value={env}>
                {data.view === 'page' ? <PageView page={data.page} unscoped={data.unscoped} /> : <NotYet kind={data.view} url={url} />}
              </EnvContext.Provider>
            )}
            {!error && data && !env && <NotYet kind={data.view} url={url} />}
          </main>

          {!wide && chrome && <div aria-hidden className="pointer-events-none fixed inset-x-0 bottom-0 z-20 h-44" style={{ background: 'linear-gradient(to top, var(--v-canvas) 45%, transparent)' }} />}
          {!wide && chrome && (
            <nav className="fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 [padding-bottom:calc(env(safe-area-inset-bottom)_+_8px)]">
              <Dock variant="shelf" items={dockItems(phoneTabs)} value={current(phoneTabs)} onValueChange={pick} aria-label="Pages" />
            </nav>
          )}
        </div>
      </div>

      <Drawer open={more} onOpenChange={setMore}>
        <DrawerContent>
          <DrawerHeader><DrawerTitle>More</DrawerTitle>{head && <DrawerDescription>{head.label}'s other pages</DrawerDescription>}</DrawerHeader>
          <div className="grid grid-cols-2 gap-2">
            {moreTabs.map((t) => <Button key={t.href} variant="secondary" className="h-14 justify-start gap-3" onClick={() => { setMore(false); go(t.href); }}><AnimatedIcon name={icon(t.label)} /> {t.label}</Button>)}
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
              <Button variant="ghost" className="justify-start gap-3" onClick={() => { setMore(false); go('/'); }}><AnimatedIcon name="house" /> The household</Button>
            </div>
          )}
          <Button variant="ghost" onClick={() => { location.href = `${url}${url.includes('?') ? '&' : '?'}ui=classic`; }}>Back to the classic page</Button>
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
        {page.intro && <p className="opacity-80">{page.intro}</p>}
        {main.map(card)}
      </div>
      {side.length > 0 && <aside className="grid min-w-0 content-start gap-4">{side.map(card)}</aside>}
    </div>
  );
}

/** A kind of page step 3 draws (Home, the Inbox, an agent's Today, the sheets): until then, the classic one. */
function NotYet({ kind, url }: { kind: string; url: string }) {
  return (
    <Card><CardContent className="grid gap-3 py-6">
      <p>The app doesn't draw this page yet ({kind}).</p>
      <Button variant="outline" onClick={() => { location.href = `${url}${url.includes('?') ? '&' : '?'}ui=classic`; }}>Open it the classic way</Button>
    </CardContent></Card>
  );
}
