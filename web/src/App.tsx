// loom's page as an app (docs/specs/ui-app.md): every page is the JSON loom answers for its path.
// A phone gets a top bar and 000h's dock at the bottom (four tabs and More); a desktop the dock as a rail.
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
// An agent's state beside its name (a desktop's alone): its own chunk.
import { AnimatedIcon } from '@/components/ui/animated-icon';
// The ground (contour field), on its own (ground.tsx).
const Contours = lazy(() => import('./ground').then((m) => ({ default: m.Contours })));
const Depth = lazy(() => import('./ground').then((m) => ({ default: m.Depth })));
// The More drawer's menu (000h's navigation menu) loads when it opens.
// The More drawer (its menu, 000h's drawer) loads the first time it opens; it stays mounted for its closing motion.
const MoreSheet = lazy(() => import('./more-sheet'));
// The rail is a desktop's alone: a phone never draws it, so never loads it.
const LoomSidebar = lazy(() => import('./sidebar').then((m) => ({ default: m.LoomSidebar })));
// The account's page (passkeys' controls: WebAuthn, push) loads with that page only.
const AccountView = lazy(() => import('./account').then((m) => ({ default: m.AccountView })));
const PushAsk = lazy(() => import('./passkeys').then((m) => ({ default: m.PushAsk })));
import { ArrivalContext, arriveOnce, type Arrivals } from './arrive';
import { Boundary, Callout, iconFor } from './safe';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dock, type DockItem } from '@/components/ui/dock';
import { Spinner } from '@/components/ui/spinner';
import { refreshEvery, type Showing } from './refresh';
// The toasts load with the first one (toasts.tsx).
const Toasts = lazy(() => import('./toasts'));
import type { Note } from './toasts';
import { act, fetchView, type ActResult, type AgentHead, type Chrome, type Ctx, type Page, type View } from './loom';
import { AgentAvatar, BlockView, EnvContext, type Env } from './blocks';
import { type Ground, DashboardView, HouseHomeView, type Mode } from './views';
import { placesOf, settingsOf } from './nav';
import { AppHeader, AppTile, oneLine } from './app-header';
import { Skeleton, StateCard } from './states';
import { MeAvatar, nameOf } from './account-button';
const InboxView = lazy(() => import('./inbox').then((m) => ({ default: m.InboxView })));
// The sheets (Scope, Places, Find, Setup, Appearance) load when one opens.
const SheetView = lazy(() => import('./sheets').then((m) => ({ default: m.SheetView })));
// Find, over whatever you're in (find.tsx): loads the first time it opens.
const FindOverlay = lazy(() => import('./find'));
const FindPanel = lazy(() => import('./find').then((m) => ({ default: m.FindPanel })));
import { noteRecent } from './recent';
import { TintContext, tintsOf } from './tint';
import { sectionRing } from './tones';
import { keep, LookContext, savePrefs, shownLook, wearLook, type Look, type Prefs } from './look';

const ICON: Record<string, string> = {
  Today: 'house', Home: 'house', Inbox: 'inbox', Places: 'layout-grid', Find: 'search', Setup: 'settings', Mind: 'brain', People: 'users',
  Knowledge: 'book-open', Bridges: 'messages-square', Clock: 'alarm-clock', Fuel: 'fuel', Houses: 'container', Secrets: 'key-round',
  Boxes: 'server', Subscriptions: 'credit-card', Tasks: 'list-checks', More: 'ellipsis', Activity: 'activity', Machine: 'cpu', Approvals: 'shield-check',
  Appearance: 'palette', Passkeys: 'fingerprint-pattern', Members: 'users-round', Pieces: 'puzzle', Account: 'circle-user-round',
};
// A piece's own icon (its manifest's tab.icon) first, then loom's for that name.
const iconsOf = (chrome?: Chrome) => {
  const own = Object.fromEntries((chrome?.shell?.pieces ?? []).filter((p) => p.icon).map((p) => [p.label, p.icon!]));
  return (label: string) => own[label] ?? ICON[label] ?? 'circle';
};

function useWide() {
  const q = '(min-width: 1024px)';
  const [wide, set] = useState(() => matchMedia(q).matches);
  useEffect(() => { const m = matchMedia(q); const f = () => set(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return wide;
}

type Tab = { label: string; href: string; current: boolean; count?: number };

/** The tabs of this page: an agent's own (its head), else the household's. */
function tabsOf(chrome: Chrome, head: AgentHead | undefined): { tabs: Tab[]; more: Tab[] } {
  if (head) return { tabs: head.tabs, more: [] };
  const s = chrome.shell;
  if (!s) return { tabs: chrome.nav.map((n) => ({ ...n })), more: [] };
  const places = placesOf(s);
  const settings = s.pieces.filter((p) => p.kind === 'setting');
  const home = { label: 'Home', href: s.home, current: s.tab === 'home' };
  const inbox = { label: 'Inbox', href: '/inbox', current: location.pathname === '/inbox', count: s.asks };
  const setup = { label: 'Setup', href: '/setup', current: s.tab === 'setup' || s.tab === 'appearance' || settings.some((p) => p.current) };
  // A phone (docs/specs/ui-app.md): Home, Inbox, Places, Find, More. Places is where you go regularly; More is the
  // house's settings and Setup (Jonathan, 2026-10-31: "places holds the things you actually go to regularly, ... the
  // others"), both a launcher like a phone's home screen. A desktop's rail: all of it.
  // Find isn't a tab (Jonathan, 2026-11-03: "on phone, Find feels different from the dock's apps"): it's the search
  // pill over the dock on Home and Places, and an overlay (find.tsx). The dock's last place is the member's avatar.
  const phone: Tab[] = [home, inbox, { label: 'Places', href: '/places', current: s.tab === 'places' || places.some((p) => p.current) },
    { label: 'More', href: '/setup', current: setup.current }];
  return matchMedia('(min-width: 1024px)').matches
    ? { tabs: [home, inbox, ...places, setup], more: settings }
    : { tabs: phone, more: [] };
}

export default function App() {
  const wide = useWide();
  const [vw, setVw] = useState(() => innerWidth);
  useEffect(() => { const f = () => setVw(innerWidth); addEventListener('resize', f); return () => removeEventListener('resize', f); }, []);
  const [url, setUrl] = useState(() => location.pathname + location.search);
  const [data, setData] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A page with no copy kept yet: its header and its shape (states.tsx Skeleton) until it lands. `pending` is where to.
  const [waiting, setWaiting] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | undefined>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [more, setMore] = useState(false);
  const [moreAsked, setMoreAsked] = useState(false);
  const [finding, setFinding] = useState(false);
  // Appearance: the system's by default (Auto); Light or Dark is a choice in the Appearance app, kept by loom for the person (look.ts).
  const [mode, setModeState] = useState<Mode>(() => { try { return (localStorage.getItem('loom-mode') as Mode) || 'auto'; } catch { return 'auto'; } });
  // The ground: the depth background's contours by default (Jonathan: "its rad"); the contour field or the plain wash
  // are a choice in the Appearance app, kept by loom for the person.
  const [ground, setGroundState] = useState<Ground>(() => { try { const g = localStorage.getItem('loom-ground'); return g === 'wash' || g === 'contours' ? g : 'depth'; } catch { return 'depth'; } });
  const setGround = (g: Ground) => { setGroundState(g); keep('loom-ground', g); save({ ground: g }); };
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  // What the first page leaves out (forms, details, the More drawer, a table's pages) is fetched once the browser is
  // idle a moment after it, so the first tap on one doesn't wait on the network.
  useEffect(() => {
    const warm = () => { void import('./form'); void import('./details'); void import('./block-extras'); void import('./more-sheet'); };
    // Late enough not to share the network with the first screen's own (its faces, its ground).
    const t = setTimeout(() => ('requestIdleCallback' in window ? requestIdleCallback(warm, { timeout: 4000 }) : warm()), 2500);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => { const m = matchMedia('(prefers-color-scheme: dark)'); const f = () => setSystemDark(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  // The look (look.ts): Neon Noir unless the person chose 000h. Neon is dark only; Light or Dark is 000h's.
  const [look, setLookState] = useState<Look>(shownLook);
  const effective = look === 'neon' ? 'dark' : mode === 'auto' ? (systemDark ? 'dark' : 'light') : mode;
  useEffect(() => { document.documentElement.dataset.mode = effective; }, [effective]);
  useEffect(() => { wearLook(look); }, [look]);
  // A choice is the person's: saved to loom (every device they sign in on gets it), and this device keeps a copy.
  const csrf = useRef('');
  // loom's version of the person's choices this tab has (look.ts Prefs.at): only a newer one is applied.
  const heard = useRef(0);
  const save = (p: Prefs) => { if (csrf.current) void savePrefs(csrf.current, p).then((at) => { if (at) heard.current = Math.max(heard.current, at); }); };
  const setMode = (m: Mode) => { setModeState(m); keep('loom-mode', m); save({ mode: m }); };
  const setLook = (l: Look) => { setLookState(l); keep('loom-look', l); save({ look: l }); };
  // Sound (sound.ts): off unless the person turns it on; its chunk loads only then.
  const [sound, setSoundState] = useState(() => { try { return localStorage.getItem('loom-sound') === 'on'; } catch { return false; } });
  const soundOn = useRef(sound);
  soundOn.current = sound;
  const setSound = (on: boolean) => { setSoundState(on); keep('loom-sound', on ? 'on' : 'off'); save({ sound: on }); };

  // eslint-disable-line react-hooks/exhaustive-deps

  // One toast per outcome: an action that lands on another page says it, and that page's one-time flash says it again.
  const chimed = useRef({ message: '', at: 0 });
  const say = useCallback((n: Omit<Note, 'id'>) => {
    // One chime per outcome, as one toast: the page it lands on saying it again is the same outcome.
    if (n.ok && soundOn.current && !(chimed.current.message === n.message && Date.now() - chimed.current.at < 5000)) {
      chimed.current = { message: n.message, at: Date.now() };
      void import('./sound').then((m) => m.chime('done'));
    }
    setNotes((x) => (x.some((y) => y.message === n.message && y.ok === n.ok && Date.now() - y.id < 5000)
    ? x : [...x, { ...n, id: Date.now() + Math.random() }])); }, []);

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
      setWaiting(!have); setPending(have ? null : to);
    }
    const r = await fetchView(to, have?.etag).catch(() => ({ status: 0 } as { status: number; data?: View; redirect?: string; savedAt?: string; etag?: string }));
    if (!quiet && showing.current === to) setWaiting(false);
    if (showing.current !== to) {   // another page was asked for meanwhile: keep this answer for later, show nothing
      if (r.data && r.etag && !r.redirect && !r.savedAt) kept.current.set(to, { etag: r.etag, data: { ...r.data, chrome: { ...r.data.chrome, flash: undefined } } });
      return;
    }
    if (r.status === 304) return;   // nothing new: what's shown is current
    if ((quiet || have) && !r.data && !r.redirect) return;   // a refresh that missed keeps what's shown
    if (!r.data && (r.redirect || r.status === 401)) { location.href = r.redirect ?? '/login'; return; }   // signed out: loom's own sign-in page
    if (r.redirect) { to = r.redirect; if (!push || have) history.replaceState(null, '', to); }   // loom moved it (/mind → an agent's Mind): show where it landed
    if (!r.data) {
      if (push && to !== location.pathname + location.search) history.pushState(null, '', to);
      setSavedAt(undefined); setUrl(to);
      setError(r.status ? 'server' : 'offline');
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

  // A page that stays fresh is fetched again in place (the classic page's data-live), as often as refresh.ts says: a
  // page's own refresh as it asked, live or not; never while a sheet, an editor or a field is in use, or hidden.
  const every = refreshEvery(data as Showing | null, live);
  useEffect(() => {
    if (!every) return;
    const t = setInterval(() => {
      const busy = document.hidden || document.querySelector('[role="dialog"],[role="alertdialog"]') || (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName));
      if (!busy) void load(location.pathname + location.search, false, true);
    }, every * 1000);
    return () => clearInterval(t);
  }, [every]); 

  useEffect(() => { const f = () => void load(location.pathname + location.search, false, true); addEventListener('online', f); return () => removeEventListener('online', f); }, [load]);
  useEffect(() => { void load(url, false); const f = () => void load(location.pathname + location.search, false); addEventListener('popstate', f); return () => removeEventListener('popstate', f); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // ⌘K / Ctrl-K: Find, from anywhere.
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setFinding((o) => !o); } };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);
  const go = useCallback((href: string) => {
    const u = new URL(href, location.href);
    // Find is an overlay over the page you're in, not a page of its own (find.tsx).
    if (u.origin === location.origin && u.pathname === '/find' && !u.search) { setFinding(true); return; }
    if (u.origin !== location.origin || u.pathname.startsWith('/app/') || /^\/(login|logout)/.test(u.pathname)) { location.href = href; return; }
    void load(u.pathname + u.search, true);
  }, [load]);

  const chrome = data?.chrome;
  // loom's copy of the person's Appearance wins once a page lands, and this device's copy follows it. Only a newer
  // version than this tab has (its `at`) is applied: an answer that was already on its way when a choice was made, or
  // that landed before the choice's own save came back, carries an older one and doesn't undo it.
  useEffect(() => {
    if (chrome?.csrf) csrf.current = chrome.csrf;
    const p = chrome?.prefs;
    if (!p?.at || p.at <= heard.current) return;
    heard.current = p.at;
    if (p.look) { setLookState(p.look); keep('loom-look', p.look); }
    if (p.mode) { setModeState(p.mode); keep('loom-mode', p.mode); }
    if (p.ground) { setGroundState(p.ground); keep('loom-ground', p.ground); }
    if (p.sound !== undefined) { setSoundState(p.sound); keep('loom-sound', p.sound ? 'on' : 'off'); }
  }, [chrome]);
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
  const icon = useMemo(() => iconsOf(chrome), [chrome]);
  // Each app's one colour (tint.ts): its tile, its dock tile, its header and its page's accents.
  const tint = useMemo(() => tintsOf(chrome?.shell?.pieces), [chrome]);
  // A phone's dock: the first tab, the one you're on, and the next ones in order, four in all; the rest in More.
  // A phone's dock never scrolls (Jonathan, 2026-10-29): as many tiles as the width holds, the one you're on always
  // among them, the rest under More (…). On an agent's pages the dock swaps (his "dock swap" board): the agent's
  // mark with a back chevron on the left, the household a tap away, and its own tabs on the right in its colour.
  const agentDock = !!head && !!accent;
  // The household's dock ends with who's signed in (Jonathan, 2026-11-03): their avatar, past a divider, opens their
  // account. It isn't a page among the others, so it takes its own place and never folds into More.
  const meTile = !agentDock && chrome?.shell ? chrome.shell.owner : null;
  const room = agentDock ? Math.max(3, Math.floor((vw - 52) / 60) - 1) : Math.max(4, Math.floor((vw - 40 - (meTile ? 58 : 0)) / 60));
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
    value: t.href, label: t.label, icon: <AnimatedIcon name={iconFor(icon(t.label))} active={t.current} />, ...(agentDock ? {} : { tint: tint(t.label) }),
    ...(t.count ? { badge: <span className="loom-data text-[10px] font-semibold">{t.count}</span> } : {}),
  }));
  const current = (list: Tab[]) => list.find((t) => t.current)?.href ?? '';
  const pick = (href: string) => (href === '#more' ? (setMoreAsked(true), setMore(true)) : href === '#back' ? go('/') : go(href));
  const me: DockItem | null = meTile ? { value: '/account', label: nameOf(meTile), icon: <span className="loom-back-mark" aria-hidden>{nameOf(meTile)[0]}</span> } : null;
  const accountOpen = data?.view === 'passkeys';
  const backTile: DockItem | null = agentDock && accent ? {
    value: '#back', label: 'Back',
    icon: <span className="loom-back-mark" aria-hidden><AgentAvatar a={accent} size={36} state={accent.asks ? 'needs-input' : 'idle'} /></span>,
    badge: <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 6l-6 6 6 6" /></svg>,
  } : null;
  // A profile leads with the name itself, big: the page's own title would say it twice (the trail keeps it).
  const profileLeads = (data?.view === 'page' && (data.page as Page).sections[0]?.blocks[0]?.type === 'profile')
    || (data?.view === 'dashboard' && !!(data.dashboard as { agent?: AgentHead }).agent?.id);
  // A page that didn't open has no title of its own: not the last page's, still standing over the reason.
  const title = error || waiting ? '' : data?.view === 'page' || data?.view === 'passkeys' ? (data.page as Page).title : head?.label ?? (data?.view === 'dashboard' ? (data.dashboard as { label?: string }).label
    : data?.view === 'inbox' ? 'Inbox' : data?.view === 'sheet' ? (data.which === 'setup' && !wide ? 'More' : String(data.which).replace(/^./, (c) => c.toUpperCase())) : 'Home');

  // The header (app-header.tsx): the app's icon tile (or the agent's mark, or its way back), the title, one line.
  const shellPlaces = chrome?.shell ? [...placesOf(chrome.shell), ...settingsOf(chrome.shell), ...chrome.shell.core] : [];
  const placeAt = (at: string) => shellPlaces.find((p) => at === p.href) ?? shellPlaces.find((p) => p.href !== '/' && at.startsWith(`${p.href}/`));
  // On its way, or not opened: the header still says which app (a place's name), not the last page's title.
  const path = (waiting && pending ? pending : url).split('?')[0];
  const place = placeAt(path);
  const shownTitle = title || ((error || waiting) && place ? place.label : '');
  const intro = !error && data?.view === 'page' ? (data.page as Page).intro : undefined;
  const context = error || waiting ? undefined : head?.sub ?? (place && path === place.href ? (place as { stat?: string }).stat : undefined) ?? oneLine(intro)
    ?? (data?.view === 'inbox' && chrome?.shell?.asks ? `${chrome.shell.asks} need${chrome.shell.asks === 1 ? 's' : ''} you` : undefined);
  const tileLabel = data?.view === 'passkeys' ? 'Account' : data?.view === 'sheet' && data.which === 'setup' ? 'Setup' : data?.view === 'inbox' ? 'Inbox'
    : path === '/' ? 'Home' : place?.label ?? chrome?.shell?.back?.label ?? title;
  // An app's page wears its colour (tint.ts) past its tile: the header's and the page's accents (buttons, switches,
  // selection: 000h's --v-pink) take it, as an agent's pages take the agent's. Not the dock or the side: they're the shell's.
  const appTint = !accent && data?.view !== 'passkeys' && tileLabel ? tint(tileLabel) : undefined;
  const appAccent = appTint && appTint !== 'pink' ? appTint : undefined;
  const headLead = accent && chrome?.shell?.household && !chrome.shell.back ? (
    // An agent's own pages: its mark, with a chevron, is the way back to the household.
    <button type="button" aria-label="Back to the household" onClick={() => go('/')} className="-ml-1 flex shrink-0 items-center gap-0.5 rounded-2xl p-1 hover:bg-[color:var(--v-beige)]">
      <AnimatedIcon name={iconFor('chevron-left')} size="sm" />
      {profileLeads ? <span className="pr-2 text-sm">The household</span> : <AgentAvatar a={accent} size={40} state={accent.asks ? 'needs-input' : 'idle'} />}
    </button>
  ) : accent ? <AgentAvatar a={accent} size={44} className="shrink-0" state={accent.asks ? 'needs-input' : 'idle'} />
    : data?.view === 'passkeys' && chrome?.shell ? <MeAvatar name={chrome.shell.owner} size={44} className="shrink-0" />
    : (shownTitle || error) && icon(tileLabel || "") !== "circle" ? <AppTile label={tileLabel || "loom"} icon={icon(tileLabel || "")} /> : undefined;

  // The app's arrival, once a session: the first time a page with its header has landed (arrive.tsx arriveOnce).
  const arrived = useRef(false);
  useLayoutEffect(() => {
    if (arrived.current || !data || waiting) return;
    arrived.current = true;
    // Its sound only when it runs (never under reduced motion), and only if the person turned Sound on.
    if (arriveOnce(document.querySelector<HTMLElement>('.loom-top h1')) && soundOn.current) void import('./sound').then((m) => m.chime('boot'));
  }, [data, waiting]);

  // Where you've been, for Find's Recent: each page that opened, by its title.
  useEffect(() => { if (!error && data && title && url !== '/') noteRecent(title, url); }, [url, title, error, data]);
  const pill = !wide && !error && !waiting && !!chrome?.shell && !agentDock && ['home', 'places'].includes(chrome.shell.tab);

  return (
    <LookContext.Provider value={look}><TintContext.Provider value={tint}>
      <div className={`relative isolate min-h-dvh ${chrome ? 'lg:grid lg:grid-cols-[17.25rem_minmax(0,1fr)]' : ''}`} data-mode={effective} data-accent={accent ? accentOf(accent.bg) : undefined}
        style={accent ? ({ '--loom-accent': accent.bg, '--loom-on-accent': accent.fg } as React.CSSProperties) : undefined}>
        {/* 000h's wash (its docs' page): soft pools of pink, blue and yellow behind everything, fixed as the page scrolls. */}
        <span aria-hidden className="loom-wash pointer-events-none fixed inset-0 -z-10" />
        {ground === 'contours' && <Suspense fallback={null}><Contours /></Suspense>}
        {ground === 'depth' && <Suspense fallback={null}><Depth /></Suspense>}
        {wide && chrome && <Suspense fallback={null}><LoomSidebar chrome={chrome} head={head} agent={accent} go={go} icon={icon} /></Suspense>}
        <div className="min-w-0">
          {/* No top bar (as 000h's own pages), a phone too: the trail and the page's title head the page and scroll away
              with it (Jonathan, 2026-10-29: "do the same thing we have on desktop there. it can scroll no problem"). */}
          <header className="loom-top [padding-top:calc(env(safe-area-inset-top)_+_1rem)] lg:pt-8" data-accent={appAccent}>
            <div className="mx-auto max-w-5xl px-4 py-3">
              {look === 'neon' && chrome?.shell && <StatusBar shell={chrome.shell} clock={chrome.clock} offline={!!savedAt} />}
              <AppHeader where={url} title={shownTitle ?? ""} go={go} crumb={chrome?.shell?.back} context={profileLeads ? undefined : context} more={intro}
                lead={profileLeads && !(accent && chrome?.shell?.household) ? undefined : headLead}
                actions={accent && wide && !profileLeads && accent.asks ? <span className="text-sm opacity-70">{accent.asks} waiting on you</span> : undefined} />
            </div>
          </header>

          <main aria-busy={waiting || undefined} className="mx-auto max-w-5xl px-4 pb-44 pt-5 lg:pb-10" data-accent={appAccent}>
            {waiting && <Skeleton />}
            {savedAt && <Callout tone="warn" icon="cloud-off" role="status" className="mb-4" title="Can’t reach loom">
              This is how it looked at <span className="loom-data">{new Date(savedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>. Actions wait for a connection.</Callout>}
            {!waiting && error && (error === 'offline'
              ? <StateCard icon="cloud-off" tint="blue" title="Can’t reach loom" text="This page isn’t saved on this device yet. It opens as soon as there’s a connection."
                  action={{ label: 'Try again', onClick: () => void load(location.pathname + location.search, false) }} />
              : <StateCard icon="triangle-alert" tint="yellow" title={`${place?.label ?? 'This page'} didn’t load`} text="loom had trouble opening it. Try again, or come back in a minute."
                  action={{ label: 'Try again', onClick: () => void load(location.pathname + location.search, false) }} />)}
            {/* Home and the Inbox ask a device that could get Your call and doesn't (passkeys.tsx PushAsk). */}
            {!waiting && !error && data?.chrome && ['house-home', 'home', 'inbox'].includes(data.view) && (
              <Suspense fallback={null}><PushAsk csrf={data.chrome.csrf} /></Suspense>
            )}
            {!waiting && !error && data && env && (
              <ArrivalContext.Provider value={arrivals}><EnvContext.Provider value={env}><Boundary where={url}>
                {data.view === 'page' ? <PageView page={data.page} unscoped={data.unscoped} />
                  : data.view === 'house-home' ? <HouseHomeView home={data.home as never} />
                  : data.view === 'dashboard' ? <DashboardView d={data.dashboard as never} now={data.now as number} />
                  : data.view === 'home' ? <><DashboardView d={{ label: 'Home', asks: data.asks as never, tiles: data.tiles as never, thread: [] }} now={Date.now()} /><div className="mt-4"><PageView page={data.page as Page} /></div></>
                  : data.view === 'inbox' ? <Suspense fallback={<Spinner appearance="orbit" />}><InboxView key={String(data.open ?? '')} items={data.items as never} folder={data.folder as string} open={data.open as string | undefined} chrome={data.chrome} github={data.github as string | undefined} /></Suspense>
                  : data.view === 'passkeys' ? <Suspense fallback={<Spinner appearance="orbit" />}>
                    <AccountView me={(data.me as { name: string; role: string }) ?? { name: chrome?.shell?.owner ?? 'owner', role: 'Signed in' }} csrf={data.chrome.csrf}
                      add={data.add as never} reload={() => void load(url, false, true)}><PageView page={data.page as Page} /></AccountView></Suspense>
                  : data.view === 'sheet' && data.which === 'find' ? <Suspense fallback={<Spinner appearance="orbit" />}>
                    <div className="loom-find loom-find-page grid h-[min(70dvh,640px)] overflow-hidden"><FindPanel chrome={data.chrome} icon={icon} go={go} /></div></Suspense>
                  : data.view === 'sheet' ? <Suspense fallback={<Spinner appearance="orbit" />}><SheetView which={data.which as string} chrome={data.chrome} icon={icon} mode={mode} setMode={setMode} ground={ground} setGround={setGround} look={look} setLook={setLook} sound={sound} setSound={setSound} /></Suspense>
                  : <NotYet kind={data.view} url={url} />}
              </Boundary></EnvContext.Provider></ArrivalContext.Provider>
            )}
            {!waiting && !error && data && !env && <NotYet kind={data.view} url={url} />}
          </main>

          {!wide && chrome && <div aria-hidden className="pointer-events-none fixed inset-x-0 bottom-0 z-20 h-44" style={{ background: 'linear-gradient(to top, var(--v-canvas) 45%, transparent)' }} />}
          {pill && (
            // A phone's Find (as a phone's home screen has its Search over the dock): on the launch screens, Home and
            // Places, a pill just above the dock that opens Find over the page. Not a tile: it isn't a place you go.
            <button type="button" onClick={() => setFinding(true)} className="loom-find-pill fixed inset-x-0 z-40 mx-auto flex h-9 w-fit items-center gap-2 rounded-full px-4 text-sm font-medium [bottom:calc(var(--dock-h)_+_28px_+_env(safe-area-inset-bottom))]">
              <AnimatedIcon name={iconFor('search')} size="sm" />Find</button>
          )}
          {!wide && chrome && (
            <nav className="loom-dock-bar fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 [padding-bottom:calc(env(safe-area-inset-bottom)_+_8px)]">
              <Dock key={agentDock ? `agent:${accent?.id}` : 'household'} variant="shelf" className={agentDock ? 'loom-agent-dock' : me ? 'loom-me-dock' : undefined}
                items={backTile ? [backTile, ...dockItems(phoneTabs)] : me ? [...dockItems(phoneTabs), me] : dockItems(phoneTabs)}
                value={accountOpen && me ? '/account' : current(phoneTabs)} onValueChange={pick}
                aria-label={agentDock ? `${accent?.label}'s pages` : 'Pages'} />
            </nav>
          )}
        </div>
      </div>

      {moreAsked && <Suspense fallback={null}><MoreSheet open={more} onOpenChange={setMore} here={head?.label} pages={moreTabs} agents={chrome?.shell?.agents ?? []} icon={icon}
        go={(href) => { setMore(false); go(href); }} /></Suspense>}

      {chrome && finding && <Suspense fallback={null}><FindOverlay open={finding} onOpenChange={setFinding} chrome={chrome} icon={icon} go={go} /></Suspense>}

      {notes.length > 0 && <Suspense fallback={null}><Toasts notes={notes} wide={wide} dismiss={(id) => setNotes((x) => x.filter((y) => y.id !== id))}
        undo={ctx && chrome ? (n) => void act({ ...ctx, path: n.undo!.path, query: {} }, chrome.csrf, n.undo!.action, n.undo!.fields ?? {}, n.undo!.act).then((r) => { say(r); void load(url, false); }) : undefined} /></Suspense>}
    </TintContext.Provider></LookContext.Provider>
  );
}

/**
 * Neon Noir's status bar (Terminal HUD's borrow): LOOM//OS, whether loom is reached, how many agents and how many things
 * need you, and the clock. Words, not colours: the dot's glow is the same either way and the word says which.
 */
function StatusBar({ shell, clock, offline }: { shell: NonNullable<Chrome['shell']>; clock: string; offline: boolean }) {
  const n = shell.agents.length;
  return (
    <div className="loom-status">
      <span className="loom-status__brand" aria-label="loom">LOOM<i aria-hidden>//</i>OS</span>
      <span className="loom-status__live" data-off={offline || undefined}>{offline ? 'offline' : 'live'}</span>
      <span className="loom-status__what loom-data">{n} agent{n === 1 ? '' : 's'}{shell.asks ? ` · ${shell.asks} need${shell.asks === 1 ? 's' : ''} you` : ''}</span>
      {/* loom's clock (the household's time zone, as every page says it), from the page's last answer: the time alone. */}
      <span className="loom-data ml-auto">{/\d{1,2}:\d{2}(\s?[AP]M)?/.exec(clock)?.[0] ?? clock}</span>
    </div>
  );
}

/** An agent's accent: the 000h family nearest its mark (loom's MARKS: Lilac, Plum, Pine, Mustard, Denim, Coral). */
const ACCENT: Record<string, string> = { '#b8a6ff': 'blue', '#7a2e4f': 'pink', '#2f6b5a': 'olive', '#e3b341': 'yellow', '#3d5a99': 'blue', '#f09a7a': 'pink' };
const accentOf = (bg: string) => ACCENT[bg.toLowerCase()] ?? 'pink';


const FoldCard = lazy(() => import('./fold'));

function PageView({ page, unscoped }: { page: Page; unscoped?: string }) {
  const main = page.sections.filter((s) => !s.side);
  const side = page.sections.filter((s) => s.side);
  const card = (s: Page['sections'][number]) => (s.fold ? (
    // Its title while its chunk loads, so the page doesn't jump.
    <Suspense key={s.id} fallback={<Card className={sectionRing(s)}><CardHeader className="pb-6"><CardTitle>{s.title}</CardTitle></CardHeader></Card>}><FoldCard s={s} /></Suspense>
  ) : (
    <Card key={s.id} className={sectionRing(s)}>
      {s.title && <CardHeader><CardTitle>{s.title}</CardTitle></CardHeader>}
      <CardContent className="grid min-w-0 gap-4">{s.blocks.map((b, n) => <BlockView key={n} b={b} />)}</CardContent>
    </Card>
  ));
  return (
    // A side column only when the page has something for it: an empty one made every piece page a third thinner than the Inbox.
    <div className={`grid grid-cols-[minmax(0,1fr)] gap-4 ${side.length ? 'lg:grid-cols-[minmax(0,1fr)_20rem]' : ''}`}>
      <div className="grid min-w-0 content-start gap-4">
        {unscoped && <p className="text-sm opacity-70">This piece shows the whole household, not only {unscoped}.</p>}
        {page.sections.length === 0 && (page.title === 'Not found'
          ? <StateCard quiet icon="map-pin-off" tint="pink" title="There’s no page here" text="It may have moved, or it was never there." />
          : <StateCard quiet icon="sparkles" app={page.title} title={`Nothing in ${page.title} yet`} text="When there’s something to show, it’ll be here." />)}
        {main.map(card)}
      </div>
      {side.length > 0 && <aside className="grid min-w-0 content-start gap-4">{side.map(card)}</aside>}
    </div>
  );
}

/** A kind of page this version of the app doesn't know (a newer loom): said, not blank. */
function NotYet({ kind, url }: { kind: string; url: string }) {
  void kind; void url;
  return <StateCard icon="refresh-cw" tint="olive" title="This page needs a newer app" text="loom has been updated. Reload to get the new version." action={{ label: 'Reload', onClick: () => location.reload() }} />;
}
