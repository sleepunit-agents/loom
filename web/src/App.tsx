// loom's page as an app (docs/specs/ui-app.md): every page is the JSON loom answers for its path.
// A phone gets a top bar and 000h's dock at the bottom (four tabs and More); a desktop the dock as a rail.
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
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
import { usePage, hasKept } from './page';
// The toasts load with the first one (toasts.tsx).
const Toasts = lazy(() => import('./toasts'));
import type { Note } from './toasts';
import { act, type ActResult, type AgentHead, type Chrome, type Ctx, type Page, type View } from './loom';
import { AgentAvatar, BlockView, EnvContext, type Env } from './blocks';
import { type Ground, DashboardView, HouseHomeView } from './views';
import { placesOf, settingsOf } from './nav';
import { AppHeader, AppTile, oneLine } from './app-header';
import { PhoneBar } from './phone-bar';
import { SystemBar } from './system-bar';
import { Skeleton, StateCard } from './states';
import { MeAvatar, nameOf } from './account-button';
const InboxView = lazy(() => import('./inbox').then((m) => ({ default: m.InboxView })));
// Comms (docs/specs/comms.md): its own chunk, loaded only when it opens.
const CommsView = lazy(() => import('./comms').then((m) => ({ default: m.CommsView })));
// A big screen (desk.tsx): the desktop's own chunk, asked for at once on a screen that wide (so it's
// here by the time the first page is), and never on a phone.
let desk$: typeof import('./desk') | null = null;
const deskChunk = () => import('./desk').then((m) => (desk$ = m));
if (matchMedia('(min-width: 1024px)').matches) void deskChunk();
// The sheets (Scope, Places, Find, Setup, Appearance) load when one opens.
const SheetView = lazy(() => import('./sheets').then((m) => ({ default: m.SheetView })));
// Find, over whatever you're in (find.tsx): loads the first time it opens.
const FindOverlay = lazy(() => import('./find'));
const FindPanel = lazy(() => import('./find').then((m) => ({ default: m.FindPanel })));
import { noteRecent } from './recent';
import * as trail from './trail';
import { InSide } from './side';
import { AppIcon, PixelIconsContext } from './app-icon';
import { TintContext, tintsOf } from './tint';
import { sectionRing } from './tones';
import { useGestures } from './gestures';
import { canMove, moveTo, scrub, type Move } from './transitions';
import { DockSwap } from './dock-swap';
import { buzz, HapticLabel, HapticsContext, warmHaptics } from './haptic';
import { allowZoom } from './immersion';
import { keptFollow, wearContrast, wearMotion, type Follow } from './access';
import { keep, lookOf, markColor, modeOf, PixelContext, savePrefs, shownLook, wearLook, type Look, type Prefs } from './look';

const ICON: Record<string, string> = {
  Today: 'house', Home: 'house', Inbox: 'inbox', Places: 'layout-grid', Find: 'search', Setup: 'settings', Mind: 'brain', People: 'users',
  Knowledge: 'book-open', Bridges: 'messages-square', Clock: 'alarm-clock', Fuel: 'fuel', Houses: 'container', Secrets: 'key-round',
  Boxes: 'server', Subscriptions: 'credit-card', Tasks: 'list-checks', More: 'ellipsis', Activity: 'activity', Machine: 'cpu', Approvals: 'shield-check',
  Appearance: 'palette', Accessibility: 'accessibility', Passkeys: 'fingerprint-pattern', Members: 'users-round', Pieces: 'puzzle', Account: 'circle-user-round', Projects: 'folder-kanban', Comms: 'radio-tower',
};
// A piece's own icon (its manifest's tab.icon) first, then loom's for that name.
const iconsOf = (chrome?: Chrome) => {
  const own = Object.fromEntries((chrome?.shell?.pieces ?? []).filter((p) => p.icon).map((p) => [p.label, p.icon!]));
  return (label: string) => own[label] ?? ICON[label] ?? 'circle';
};

function useMedia(q: string) {
  const [on, set] = useState(() => matchMedia(q).matches);
  useEffect(() => { const m = matchMedia(q); const f = () => set(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, [q]);
  return on;
}
const useWide = () => useMedia('(min-width: 1024px)');
/** Where a page's side sections stand (docs/extensions.md, "Pages"): 1280 px and wider, a column of their own (a desktop
 * window's right-hand one, else beside the page); narrower, folded together at the top of the page. 1280, not the old
 * Lately's 1600: the common laptop widths (1280 to 1536) get the column, and a window there still leaves the page about
 * 860 px, wider than its rows need. Below it, the page would be squeezed under 700. */
const SIDE_COLUMN = '(min-width: 1280px)';

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
  const setup = { label: 'Setup', href: '/setup', current: s.tab === 'setup' || s.tab === 'appearance' || s.tab === 'accessibility' || settings.some((p) => p.current) };
  // A phone (docs/specs/ui-app.md): Home, Inbox, Places, Find, More. Places is where you go regularly; More is the
  // house's settings and Setup (Jonathan, 2026-10-31: "places holds the things you actually go to regularly, ... the
  // others"), both a launcher like a phone's home screen. A desktop's rail: all of it.
  // Find isn't a tab (Jonathan, 2026-11-03: "on phone, Find feels different from the dock's apps"): it's the search
  // pill over the dock on Home and Places, and an overlay (find.tsx). The dock's last place is the member's avatar.
  // Comms, for a member who owns an agent (docs/specs/comms.md): beside the Inbox, with its unread threads.
  const comms = s.core.find((p) => p.href === '/comms');
  // After Places, so a narrow phone keeps Places in its dock (Comms is in More there); from about 430 px it's a key.
  const phone: Tab[] = [home, inbox, { label: 'Places', href: '/places', current: s.tab === 'places' || places.some((p) => p.current && p.href !== '/comms') },
    ...(comms ? [{ ...comms, current: location.pathname.startsWith('/comms') }] : []),
    { label: 'More', href: '/setup', current: setup.current }];
  return matchMedia('(min-width: 1024px)').matches
    ? { tabs: [home, inbox, ...places, setup], more: settings }
    : { tabs: phone, more: [] };
}

export default function App() {
  const wide = useWide();
  const sideWide = useMedia(SIDE_COLUMN);
  const [vw, setVw] = useState(() => innerWidth);
  useEffect(() => { const f = () => setVw(innerWidth); addEventListener('resize', f); return () => removeEventListener('resize', f); }, []);
  const [notes, setNotes] = useState<Note[]>([]);
  const [more, setMore] = useState(false);
  const [moreAsked, setMoreAsked] = useState(false);
  const [finding, setFinding] = useState(false);
  // The ground: the depth background's contours by default (Jonathan: "its rad"); the contour field or the plain wash
  // are a choice in the Appearance app, kept by loom for the person.
  const [ground, setGroundState] = useState<Ground>(() => { try { const g = localStorage.getItem('loom-ground'); return g === 'wash' || g === 'contours' ? g : 'depth'; } catch { return 'depth'; } });
  const setGround = (g: Ground) => { setGroundState(g); keep('loom-ground', g); save({ ground: g }); };
  // What the first page leaves out (forms, details, the More drawer, a table's pages) is fetched once the browser is
  // idle a moment after it, so the first tap on one doesn't wait on the network.
  useEffect(() => {
    const warm = () => { void import('./form'); void import('./details'); void import('./block-extras'); void import('./more-sheet'); };
    // Late enough not to share the network with the first screen's own (its faces, its ground).
    const t = setTimeout(() => ('requestIdleCallback' in window ? requestIdleCallback(warm, { timeout: 4000 }) : warm()), 2500);
    return () => clearTimeout(t);
  }, []);
  // The look (look.ts): Neon Noir unless the person chose Low Light or Daylight; each is light or dark of its own.
  const [look, setLookState] = useState<Look>(shownLook);
  const effective = modeOf(look);
  useEffect(() => { wearLook(look); }, [look]);
  // A choice is the person's: saved to loom (every device they sign in on gets it), and this device keeps a copy.
  const csrf = useRef('');
  // loom's version of the person's choices this tab has (look.ts Prefs.at): only a newer one is applied.
  const heard = useRef(0);
  const save = (p: Prefs) => { if (csrf.current) void savePrefs(csrf.current, p).then((at) => { if (at) heard.current = Math.max(heard.current, at); }); };
  const setLook = (l: Look) => { setLookState(l); keep('loom-look', l); save({ look: l }); };
  // Sound (sound.ts): off unless the person turns it on; its chunk loads only then.
  const [sound, setSoundState] = useState(() => { try { return localStorage.getItem('loom-sound') === 'on'; } catch { return false; } });
  const soundOn = useRef(sound);
  soundOn.current = sound;
  // Pixel faces (pixel-face.tsx), where an agent has a sheet: on unless the person turns them off.
  const [pixel, setPixelState] = useState(() => { try { return localStorage.getItem('loom-pixel') !== 'off'; } catch { return true; } });
  const setPixel = (on: boolean) => { setPixelState(on); keep('loom-pixel', on ? 'on' : 'off'); save({ pixel: on }); };
  // Pixel icons (app-icon.tsx), where the household has a set: off unless the person turns them on (Jonathan, 2026-11-05:
  // he wants to live with them first).
  const [pixIcons, setPixIconsState] = useState(() => { try { return localStorage.getItem('loom-icons') === 'on'; } catch { return false; } });
  const setPixIcons = (on: boolean) => { setPixIconsState(on); keep('loom-icons', on ? 'on' : 'off'); save({ icons: on }); };
  const setSound = (on: boolean) => { setSoundState(on); keep('loom-sound', on ? 'on' : 'off'); save({ sound: on }); };
  // Haptics (haptic.tsx): on unless the person turns them off; their chunk loads once the first page is up, while on.
  const [haptics, setHapticsState] = useState(() => { try { return localStorage.getItem('loom-haptics') !== 'off'; } catch { return true; } });
  const setHaptics = (on: boolean) => { setHapticsState(on); keep('loom-haptics', on ? 'on' : 'off'); save({ haptics: on }); if (on) buzz(true); };
  useEffect(() => { if (!haptics || navigator.maxTouchPoints < 1) return; const t = setTimeout(warmHaptics, 1500); return () => clearTimeout(t); }, [haptics]);
  // Accessibility (sheets.tsx AccessibilityApp). Allow zoom (immersion.ts): off unless the person turns it on, for anyone
  // who needs to zoom to read.
  const [zoom, setZoomState] = useState(() => { try { return localStorage.getItem('loom-zoom') === 'on'; } catch { return false; } });
  const setZoom = (on: boolean) => { setZoomState(on); keep('loom-zoom', on ? 'on' : 'off'); save({ zoom: on }); };
  useEffect(() => { allowZoom(zoom); }, [zoom]);
  // Reduce motion and Higher contrast (access.ts): follow the phone unless the person chooses; worn on <html>.
  const [motion, setMotionState] = useState<Follow>(() => keptFollow('loom-motion'));
  const setMotion = (v: Follow) => { setMotionState(v); keep('loom-motion', v); save({ motion: v }); };
  useEffect(() => { wearMotion(motion); }, [motion]);
  const [contrast, setContrastState] = useState<Follow>(() => keptFollow('loom-contrast'));
  const setContrast = (v: Follow) => { setContrastState(v); keep('loom-contrast', v); save({ contrast: v }); };
  useEffect(() => { wearContrast(contrast); }, [contrast]);

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

  // The page (page.ts): what's shown, loaded and kept current, its address the browser's.
  const { url, data, error, waiting, pending, savedAt, showing, load } = usePage(location.pathname + location.search, say);

  // What's new arrives (arrive.tsx): what this page showed at its last answer, against what it shows now.
  const shown = useRef<{ url: string; data: View | null; keys: Set<string> }>({ url: '', data: null, keys: new Set() });
  const arrivals: Arrivals = { before: shown.current.url === url && shown.current.data !== null ? shown.current.keys : null, now: new Set() };
  useEffect(() => { shown.current = { url, data, keys: arrivals.now }; });   // after every draw

  // How a page change moves (transitions.ts): by the dock's order between its own pages, else a push into a page and a
  // pop back out of one. What it's read against is the page shown (set as each one draws, below).
  const moveFrom = useRef<{ pages: string[]; path: string; active: number; crumb?: string }>({ pages: [], path: '/', active: -1 });
  const moveFor = (to: string, back = false): Move | undefined => {
    const { pages, path, active, crumb } = moveFrom.current;
    if (to === path) return undefined;
    const here = pages.indexOf(path), b = pages.indexOf(to);
    if (here >= 0 && b >= 0) return b > here ? 'right' : 'left';
    // Back up: the crumb, a page this one is under, the dock's own key for where you are, or the browser's Back.
    if (back || to === crumb || path.startsWith(to === '/' ? '/' : `${to}/`) || (b >= 0 && b === active)) return 'pop';
    if (b >= 0 && active >= 0) return b > active ? 'right' : 'left';
    return 'push';
  };
  const showWith = (how: Move | undefined, to: string, push: boolean) => moveTo(how, () => flushSync(() => { void load(to, push); }));
  // Each app's own history (trail.ts): the app the page shown is in (set as each one draws, below), how the next page
  // is being reached, and where to scroll it to once it's drawn (Back, Forward, or a minimized window opened again).
  const appKeyRef = useRef<string | undefined>(undefined);
  const intent = useRef<{ how: trail.How; url: string } | null>(null);
  const restoreTo = useRef<trail.Visit | null>(null);
  const scrolled = () => (deskNow.current && mainRef.current ? mainRef.current.scrollTop : scrollY);
  useEffect(() => {
    void load(url, false);
    const f = () => {
      // The browser's Back or Forward: the page it leaves is still the one shown. Its history and the app's agree when
      // it lands on the app's page before or after this one, and that page comes back where it was.
      const to = location.pathname + location.search;
      trail.keepTop(appKeyRef.current, showing.current, scrolled());
      intent.current = { how: 'pop', url: to };
      const near = [trail.step(appKeyRef.current, -1), trail.step(appKeyRef.current, 1)].find((p) => p?.url === to);
      if (near) restoreTo.current = near;
      void showWith(moveFor(location.pathname, true), to, false);
    };
    addEventListener('popstate', f); return () => removeEventListener('popstate', f);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // Whether this is a desktop, for go (worked out below): read when it runs.
  const deskNow = useRef(false);
  // ⌘K / Ctrl-K: Find, from anywhere.
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setFinding((o) => !o); } };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);
  const go = useCallback((href: string, o?: { how?: 'back' | 'forward' }) => {
    const u = new URL(href, location.href);
    // Find is an overlay over the page you're in, not a page of its own (find.tsx).
    if (u.origin === location.origin && u.pathname === '/find' && !u.search) { setFinding(true); return; }
    if (u.origin !== location.origin || u.pathname.startsWith('/app/') || /^\/(login|logout)/.test(u.pathname)) { location.href = href; return; }
    // Leaving a page: how far down it was, for Back to come back to; and how the next one is reached (trail.ts).
    trail.keepTop(appKeyRef.current, location.pathname + location.search, scrolled());
    intent.current = { how: o?.how ?? 'go', url: u.pathname + u.search };
    // A desktop (desk.css): the window grows out of its dock key on the way into an app, and back into it on the way home.
    if (deskNow.current && desk$?.deskGo(location.pathname, u.pathname, () => flushSync(() => { void load(u.pathname + u.search, true); }))) return;
    showWith(moveFor(u.pathname, o?.how === 'back'), u.pathname + u.search, true);
  }, [load]);   // eslint-disable-line react-hooks/exhaustive-deps

  const chrome = data?.chrome;
  // loom's copy of the person's Appearance wins once a page lands, and this device's copy follows it. Only a newer
  // version than this tab has (its `at`) is applied: an answer that was already on its way when a choice was made, or
  // that landed before the choice's own save came back, carries an older one and doesn't undo it. Before the page that
  // carried it paints (a layout effect): a device that has never been told draws it the person's way, and Reduce motion
  // is worn at once, so the arrival (below) never runs for someone who turned motion down elsewhere.
  useLayoutEffect(() => {
    if (chrome?.csrf) csrf.current = chrome.csrf;
    const p = chrome?.prefs;
    if (!p?.at || p.at <= heard.current) return;
    heard.current = p.at;
    // A look loom kept from before Low Light and Daylight (000h) comes across as the nearest one (look.ts lookOf).
    if (p.look) { const l = lookOf(p.look, p.mode); setLookState(l); keep('loom-look', l); }
    if (p.ground) { setGroundState(p.ground); keep('loom-ground', p.ground); }
    if (p.sound !== undefined) { setSoundState(p.sound); keep('loom-sound', p.sound ? 'on' : 'off'); }
    if (p.pixel !== undefined) { setPixelState(p.pixel); keep('loom-pixel', p.pixel ? 'on' : 'off'); }
    if (p.icons !== undefined) { setPixIconsState(p.icons); keep('loom-icons', p.icons ? 'on' : 'off'); }
    if (p.haptics !== undefined) { setHapticsState(p.haptics); keep('loom-haptics', p.haptics ? 'on' : 'off'); }
    if (p.zoom !== undefined) { setZoomState(p.zoom); keep('loom-zoom', p.zoom ? 'on' : 'off'); }
    if (p.motion) { setMotionState(p.motion); keep('loom-motion', p.motion); wearMotion(p.motion); }
    if (p.contrast) { setContrastState(p.contrast); keep('loom-contrast', p.contrast); wearContrast(p.contrast); }
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
  // The household's pixel icons, while the person wears them (app-icon.tsx): none, and every app keeps its line icon.
  const pixIconSet = useMemo(() => (pixIcons && chrome?.shell?.icons ? chrome.shell.icons : null), [pixIcons, chrome]);
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
    value: t.href, label: t.label, icon: <>{agentDock
      // An agent's own dock wears the agent's colour, not an app's tint (looks.css): the pixel ramps are the apps' tints,
      // so its keys keep their line icons.
      ? <AnimatedIcon name={iconFor(icon(t.label))} active={t.current} />
      : <AppIcon label={t.href === '/setup' ? 'Setup' : t.label} name={iconFor(icon(t.label))} active={t.current} lit={t.current} />}<HapticLabel on={haptics} /></>, ...(agentDock ? {} : { tint: tint(t.label) }),
    ...(t.count ? { badge: <span className="loom-data text-[10px] font-semibold">{t.count}</span> } : {}),
  }));
  const current = (list: Tab[]) => list.find((t) => t.current)?.href ?? '';
  const me: DockItem | null = meTile ? { value: '/account', label: nameOf(meTile), icon: <span className="loom-back-mark" aria-hidden>{nameOf(meTile)[0]}</span> } : null;
  const accountOpen = data?.view === 'passkeys';
  const lit = accountOpen && me ? '/account' : current(phoneTabs);
  // A desktop's window and the household key it's open under (desk.tsx): its open key, or a double-click on its strip,
  // minimizes it, kept where it is; that key opens it there again; Close and Esc close it, forgetting. Home always
  // goes to the desktop (minimizing what's open, as a desktop's "show desktop" does). An agent's own dock is its own.
  const deskKey = () => deskNow.current && !agentDock && location.pathname !== '/' && lit && new URL(lit, location.href).pathname !== '/' ? lit : undefined;
  const minimize = () => {
    const key = deskKey();
    if (key) trail.minimize(key, { url: location.pathname + location.search, top: scrolled() });
    go('/');
  };
  const closeWindow = () => { trail.forget(deskKey()); go('/'); };
  const pick = (href: string) => {
    buzz(haptics, true);
    if (href === '#more') { setMoreAsked(true); setMore(true); return; }
    if (href === '#back') { go('/'); return; }
    if (deskNow.current && !agentDock && desk$) {
      const home = new URL(href, location.href).pathname === '/';
      if (location.pathname !== '/' && (href === deskKey() || home)) { minimize(); return; }
      const was = home ? undefined : trail.restore(href);
      if (was) { restoreTo.current = was; go(was.url); return; }
    }
    go(href);
  };
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
    : data?.view === 'inbox' ? 'Inbox' : data?.view === 'comms' ? 'Comms' : data?.view === 'sheet' ? (data.which === 'setup' && !wide ? 'More' : String(data.which).replace(/^./, (c) => c.toUpperCase())) : 'Home');

  // The header (app-header.tsx): the app's icon tile (or the agent's mark, or its way back), the title, one line.
  const shellPlaces = chrome?.shell ? [...placesOf(chrome.shell), ...settingsOf(chrome.shell), ...chrome.shell.core] : [];
  const placeAt = (at: string) => shellPlaces.find((p) => at === p.href) ?? shellPlaces.find((p) => p.href !== '/' && at.startsWith(`${p.href}/`));
  // On its way, or not opened: the header still says which app (a place's name), not the last page's title.
  const path = (waiting && pending ? pending : url).split('?')[0];
  const place = placeAt(path);
  const shownTitle = title || ((error || waiting) && place ? place.label : '');
  // A sheet (Accessibility) can carry an intro too, as a page does.
  const intro = error ? undefined : data?.view === 'page' ? (data.page as Page).intro : data?.view === 'sheet' ? (data.intro as string | undefined) : undefined;
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
  // A desktop's boot (desk.tsx DeskBoot): with the arrival, once a session, never under reduced motion.
  const [booting, setBooting] = useState(false);
  useLayoutEffect(() => {
    if (arrived.current || !data || waiting) return;
    arrived.current = true;
    // Its sound only when it runs (never under reduced motion), and only if the person turned Sound on.
    // loom's word on Sound first: on a device that has no copy yet, the page that just landed is the first to say it.
    const soundNow = data.chrome?.prefs?.sound ?? soundOn.current;
    // A desktop boots first, once a session and only with motion allowed; the arrival (its power-on) runs as it ends.
    if (desk && desk$?.bootsNow()) { setBooting(true); return; }
    if (arriveOnce(document.querySelector<HTMLElement>('.loom-top h1')) && soundNow) void import('./sound').then((m) => m.chime('boot'));
  }, [data, waiting]);

  // A desktop's page scrolls inside its own space (desk.css): a new page opens at its top.
  const mainRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (mainRef.current) mainRef.current.scrollTop = 0; }, [url]);
  // ... unless it's a minimized window opened again (pick, above), or a page come back to with Back or Forward: back
  // where it was, once its page is drawn. A desktop's window scrolls inside itself, a phone's page the whole screen.
  useLayoutEffect(() => {
    const r = restoreTo.current;
    if (!r || waiting) return;
    restoreTo.current = null;
    if (url !== r.url) return;
    if (deskNow.current && mainRef.current) mainRef.current.scrollTop = r.top; else scrollTo({ top: r.top });
  }, [url, waiting, data]);
  // Where you've been, for Find's Recent: each page that opened, by its title.
  useEffect(() => { if (!error && data && title && url !== '/') noteRecent(title, url); }, [url, title, error, data]);
  // The phone's bar at every width (phone-bar.tsx). On a phone it merges with the phone's own status bar; wider,
  // there's none, so loom draws one over it (system-bar.tsx; Jonathan, 2026-11-05). A page with no shell keeps the big header.
  const phoneBar = !!chrome?.shell;
  // 1024 px and wider, in a household (desk.tsx): a desktop. Home is widgets on the ground, the dock sits at the
  // bottom centre (no rail), and every other page fills the space between the bars and the dock. 1024 is where the rail
  // took over from the phone's dock before: below it the phone's layout (its dock, its gestures) is unchanged.
  const desk = wide && !!chrome?.shell?.household;
  useLayoutEffect(() => { deskNow.current = desk; });
  // Every page but Home is in the window; Home never is, even one that didn't load (it says so on the desktop).
  const inWindow = desk && path !== '/';

  // The app the page shown is in, for its own history (trail.ts): on a desktop the dock key its window is open under,
  // as minimizing keys it; an agent's pages are that agent's; else the place it's under.
  const appKey = path === '/' ? undefined : desk && !agentDock && lit && lit.split('?')[0] !== '/' ? lit
    : accent ? `/a/${accent.id}` : place?.href ?? `/${path.split('/')[1]}`;
  useLayoutEffect(() => { if (!waiting) appKeyRef.current = appKey; });
  const [, setMoved] = useState(0);
  useEffect(() => {
    if (error || waiting || !data || !appKey) return;
    const i = intent.current;
    const mine = i?.url === url;
    if (mine) intent.current = null;
    if (trail.note(appKey, url, mine ? i!.how : 'go', title || undefined)) setMoved((n) => n + 1);
  }, [url, data, waiting, error, appKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Back and Forward in the app's history: to the page as it was left (its query, how far down).
  const move = (by: -1 | 1) => {
    const p = trail.step(appKeyRef.current, by);
    if (!p) return;
    restoreTo.current = p;
    go(p.url, { how: by < 0 ? 'back' : 'forward' });
  };
  const back = chrome?.shell?.back;
  const pathOf = (h: string) => h.split('?')[0];
  // A window's trail (desk.tsx): the app, then the page this one is under, then this one. A crumb goes to that page as
  // it was last left in this app's history (the list with its filters), else to its start.
  // An agent's pages start at the agent.
  const top = place ?? (accent ? { label: accent.label, href: `/a/${accent.id}` } : undefined);
  const crumbs = inWindow ? [...(top && top.href !== path ? [top] : []),
    ...(back && pathOf(back.href) !== path && pathOf(back.href) !== top?.href ? [back] : [])]
    .map((c) => ({ label: c.label, href: trail.lastAt(appKey, pathOf(c.href))?.url ?? c.href })) : [];
  // A phone's back chevron (phone-bar.tsx), on a page under another: the page before this one in the same app, as it
  // was left; opened from somewhere else (a link, Find, the Inbox), the page it's under, as before. A desktop's window
  // has its own Back, so its bar has no chevron.
  const prevHere = back && !inWindow ? trail.step(appKey, -1) : undefined;
  const phoneCrumb = inWindow ? undefined : prevHere ? { label: prevHere.label ?? back!.label, href: prevHere.url } : back;
  // Where the page's side sections stand (SIDE_COLUMN): a desktop window's own right-hand column at 1280 and wider,
  // beside the page wider than that elsewhere, else folded at its top.
  const [sideEl, setSideEl] = useState<HTMLElement | null>(null);
  const pageSide = !!(data as { page?: Page } | null)?.page?.sections?.some(isSide);
  const sideAt: SideAt = !sideWide ? 'fold' : inWindow ? (pageSide ? { el: sideEl } : 'fold') : 'column';
  // The desktop's chunk (desk.tsx), once it's here; asked for when a screen becomes a desktop (a look changed).
  const [D, setD] = useState(desk$);
  useEffect(() => { if (desk && !D) void deskChunk().then(setD); }, [desk, D]);
  const deskBar = phoneBar && vw >= 640;
  const pill = !wide && !error && !waiting && !!chrome?.shell && !agentDock && ['home', 'places'].includes(chrome.shell.tab);
  // A phone's gestures (gestures.ts): sideways between the dock's own pages, in its order; up from the dock for Find.
  const dockPages = !agentDock ? nav.tabs.map((t) => t.href).filter((h) => !h.startsWith('#')) : [];
  const hereIndex = dockPages.indexOf(path);
  const activeTab = dockPages.indexOf(current(phoneTabs)), crumbHref = chrome?.shell?.back?.href;
  useLayoutEffect(() => { moveFrom.current = { pages: dockPages, path, active: activeTab, crumb: crumbHref }; });
  // A swipe's page, shown under the finger (gestures.ts begin): its address only once the swipe commits; run back,
  // the page it left is shown again.
  const begin = (href: string, how: Move) => {
    if (!canMove()) return null;
    const from = location.pathname + location.search;
    const vt = showWith(how, href, false);
    if (!vt) return null;
    const held = scrub(vt);
    return { at: held.at, end: async (commit: boolean) => {
      if (commit && location.pathname + location.search !== href) history.pushState(null, '', href);
      return held.end(commit, () => flushSync(() => { void load(from, false); }));
    } };
  };
  // The dock's next and last pages are fetched a moment after one lands, so a swipe opens on the page, not its shape.
  useEffect(() => {
    if (wide || hereIndex < 0) return;
    const t = setTimeout(() => { for (const n of [dockPages[hereIndex - 1], dockPages[hereIndex + 1]]) if (n && !hasKept(n)) void load(n, false, true); }, 1200);
    return () => clearTimeout(t);
  }, [wide, hereIndex, dockPages.join(' ')]);   // eslint-disable-line react-hooks/exhaustive-deps
  useGestures(!wide && !!chrome?.shell, {
    pages: dockPages, here: error ? -1 : hereIndex, sub: !!chrome?.shell?.back, go, find: () => setFinding(true),
    busy: () => finding || more || !!document.querySelector('[role="dialog"],[role="alertdialog"]'), buzz: () => buzz(haptics), begin,
  });

  return (
    <PixelContext.Provider value={pixel}><PixelIconsContext.Provider value={pixIconSet}><HapticsContext.Provider value={haptics}><TintContext.Provider value={tint}>
      <div className={`relative isolate min-h-dvh ${desk ? 'loom-desk' : chrome ? 'lg:grid lg:grid-cols-[17.25rem_minmax(0,1fr)]' : ''}`} data-mode={effective} data-accent={accent ? accentOf(accent.bg) : undefined}
        style={accent ? ({ '--loom-accent': accent.bg, '--loom-on-accent': accent.fg, '--loom-accent-lit': markColor(accent.bg) } as React.CSSProperties) : undefined}>
        {/* 000h's wash (its docs' page): soft pools of pink, blue and yellow behind everything, fixed as the page scrolls. */}
        <span aria-hidden className="loom-wash pointer-events-none fixed inset-0 -z-10" />
        {ground === 'contours' && <Suspense fallback={null}><Contours /></Suspense>}
        {ground === 'depth' && <Suspense fallback={null}><Depth /></Suspense>}
        {wide && !desk && chrome && <Suspense fallback={null}><LoomSidebar chrome={chrome} head={head} agent={accent} go={go} icon={icon} /></Suspense>}
        <div className="loom-page-clip min-w-0">
          {/* No top bar (as 000h's own pages), a phone too: the trail and the page's title head the page and scroll away
              with it (Jonathan, 2026-10-29: "do the same thing we have on desktop there. it can scroll no problem"). */}
          {phoneBar && chrome?.shell ? (
            // Neon: one small bar right under the phone's own (phone-bar.tsx), the page's name in it, and nothing under
            // it: the page's line and its intro are behind the name (Jonathan, 2026-11-05). The Inbox's "N need you" is
            // the bar's own count already, so it isn't info there. Wider than a phone, loom's system bar over it.
            <header className={`loom-top loom-top--bar${deskBar ? ' loom-top--desk' : ''}`} data-accent={appAccent}>
              <div className="mx-auto max-w-5xl px-4">
                {/* Wider than a phone: loom's own status bar over it, across the page's column, so its clock sits over
                    the page's name and its glyphs over LOOM//OS and the count, as a phone's do (system-bar.tsx). */}
                {deskBar && <SystemBar shell={chrome.shell} clock={{ text: chrome.clock, tz: chrome.tz }} offline={!!savedAt} go={go} />}
                <PhoneBar title={shownTitle ?? ''} go={go} crumb={phoneCrumb} onBack={prevHere ? () => move(-1) : undefined} shell={chrome.shell} offline={!!savedAt} where={url}
                  info={{ line: profileLeads || data?.view === 'inbox' ? undefined : context, more: intro }}
                  color={accent ? markColor(accent.bg) : `var(--loom-tint-${tint(tileLabel || 'Home')})`} />
              </div>
            </header>
          ) : (
          <header className="loom-top [padding-top:calc(env(safe-area-inset-top)_+_1rem)] lg:pt-8" data-accent={appAccent}>
            <div className="mx-auto max-w-5xl px-4 py-3">
              <AppHeader where={url} title={shownTitle ?? ""} go={go} crumb={chrome?.shell?.back} context={profileLeads ? undefined : context} more={intro}
                lead={profileLeads && !(accent && chrome?.shell?.household) ? undefined : headLead}
                actions={accent && wide && !profileLeads && accent.asks ? <span className="text-sm opacity-70">{accent.asks} waiting on you</span> : undefined} />
            </div>
          </header>
          )}

          <Wrap on={inWindow && !!D} wrap={(page) => D && (
            <D.DeskWindow url={url} waiting={waiting} go={go} close={closeWindow} minimize={minimize} title={shownTitle || place?.label || ''}
              crumbs={crumbs} back={trail.step(appKey, -1)} forward={trail.step(appKey, 1)} move={move}
              side={sideWide ? { has: pageSide, el: setSideEl, app: appKey, under: top?.href } : undefined}
              tint={accent ? markColor(accent.bg) : `var(--loom-tint-${appTint ?? 'pink'})`}
              lead={accent ? <AgentAvatar a={accent} size={22} /> : <AppIcon label={tileLabel || ''} name={iconFor(icon(tileLabel || ''))} size="sm" lit />}>{page}</D.DeskWindow>
          )}>
          <main ref={mainRef} aria-busy={waiting || undefined} className={desk ? 'loom-desk-main' : 'mx-auto max-w-5xl px-4 pb-44 pt-5 lg:pb-10'} data-accent={appAccent}>
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
              <ArrivalContext.Provider value={arrivals}><EnvContext.Provider value={env}><SideAtContext.Provider value={sideAt}><Boundary where={url}>
                {data.view === 'page' ? <PageView page={data.page} unscoped={data.unscoped} />
                  : data.view === 'house-home' && desk && chrome?.shell ? (D ? <D.DeskHome home={data.home as never} shell={chrome.shell} /> : <Skeleton />)
                  : data.view === 'house-home' ? <HouseHomeView home={data.home as never} />
                  : data.view === 'dashboard' ? <DashboardView d={data.dashboard as never} now={data.now as number} />
                  : data.view === 'home' ? <><DashboardView d={{ label: 'Home', asks: data.asks as never, tiles: data.tiles as never, thread: [] }} now={Date.now()} /><div className="mt-4"><PageView page={data.page as Page} /></div></>
                  : data.view === 'comms' ? <Suspense fallback={<Spinner appearance="orbit" />}><CommsView data={data as never} /></Suspense>
                  : data.view === 'inbox' ? <Suspense fallback={<Spinner appearance="orbit" />}><InboxView key={String(data.open ?? '')} items={data.items as never} folder={data.folder as string} open={data.open as string | undefined} chrome={data.chrome} github={data.github as string | undefined} /></Suspense>
                  : data.view === 'passkeys' ? <Suspense fallback={<Spinner appearance="orbit" />}>
                    <AccountView me={(data.me as { name: string; role: string }) ?? { name: chrome?.shell?.owner ?? 'owner', role: 'Signed in' }} csrf={data.chrome.csrf}
                      add={data.add as never} reload={() => void load(url, false, true)}><PageView page={data.page as Page} /></AccountView></Suspense>
                  : data.view === 'sheet' && data.which === 'find' ? <Suspense fallback={<Spinner appearance="orbit" />}>
                    <div className="loom-find loom-find-page grid h-[min(70dvh,640px)] overflow-hidden"><FindPanel chrome={data.chrome} icon={icon} go={go} /></div></Suspense>
                  : data.view === 'sheet' ? <Suspense fallback={<Spinner appearance="orbit" />}><SheetView which={data.which as string} chrome={data.chrome} icon={icon} ground={ground} setGround={setGround} look={look} setLook={setLook} sound={sound} setSound={setSound} pixel={pixel} setPixel={setPixel} pixIcons={pixIcons} setPixIcons={setPixIcons} haptics={haptics} setHaptics={setHaptics} zoom={zoom} setZoom={setZoom} motion={motion} setMotion={setMotion} contrast={contrast} setContrast={setContrast} /></Suspense>
                  : <NotYet kind={data.view} url={url} />}
              </Boundary></SideAtContext.Provider></EnvContext.Provider></ArrivalContext.Provider>
            )}
            {!waiting && !error && data && !env && <NotYet kind={data.view} url={url} />}
          </main>
          </Wrap>

          {!wide && chrome && <div aria-hidden className="loom-fade pointer-events-none fixed inset-x-0 bottom-0 z-20 h-44" style={{ background: 'linear-gradient(to top, var(--v-canvas) 45%, transparent)' }} />}
          {pill && (
            // A phone's Find (as a phone's home screen has its Search over the dock): on the launch screens, Home and
            // Places, a pill just above the dock that opens Find over the page. Not a tile: it isn't a place you go.
            <button type="button" onClick={() => setFinding(true)} className="loom-find-pill fixed inset-x-0 z-40 mx-auto flex h-9 w-fit items-center gap-2 rounded-full px-4 text-sm font-medium [bottom:calc(var(--dock-h)_+_28px_+_env(safe-area-inset-bottom))]">
              <AnimatedIcon name={iconFor('search')} size="sm" />Find</button>
          )}
          {(!wide || desk) && chrome && (
            <nav className="loom-dock-bar fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 [padding-bottom:calc(env(safe-area-inset-bottom)_+_8px)]">
              <DockSwap id={agentDock ? `agent:${accent?.id}` : head ? `head:${head.label}` : 'household'}>
              <Dock variant="shelf" className={agentDock ? 'loom-agent-dock' : me ? 'loom-me-dock' : undefined}
                items={backTile ? [backTile, ...dockItems(phoneTabs)] : me ? [...dockItems(phoneTabs), me] : dockItems(phoneTabs)}
                value={lit} onValueChange={pick}
                aria-label={agentDock ? `${accent?.label}'s pages` : 'Pages'} />
              </DockSwap>
            </nav>
          )}
        </div>
      </div>

      {desk && D && <D.DeskKeys close={closeWindow} places={[...nav.tabs, ...nav.more]} />}
      {booting && D && chrome?.shell && <D.DeskBoot shell={chrome.shell} offline={!!savedAt} onDone={() => {
        setBooting(false);
        if (arriveOnce(document.querySelector<HTMLElement>('.loom-top h1')) && soundOn.current) void import('./sound').then((m) => m.chime('boot'));
      }} />}

      {moreAsked && <Suspense fallback={null}><MoreSheet open={more} onOpenChange={setMore} here={head?.label} pages={moreTabs} agents={chrome?.shell?.agents ?? []} icon={icon}
        go={(href) => { setMore(false); go(href); }} /></Suspense>}

      {chrome && finding && <Suspense fallback={null}><FindOverlay open={finding} onOpenChange={setFinding} chrome={chrome} icon={icon} go={go} /></Suspense>}

      {notes.length > 0 && <Suspense fallback={null}><Toasts notes={notes} wide={wide} dismiss={(id) => setNotes((x) => x.filter((y) => y.id !== id))}
        undo={ctx && chrome ? (n) => void act({ ...ctx, path: n.undo!.path, query: {} }, chrome.csrf, n.undo!.action, n.undo!.fields ?? {}, n.undo!.act).then((r) => { say(r); void load(url, false); }) : undefined} /></Suspense>}
    </TintContext.Provider></HapticsContext.Provider></PixelIconsContext.Provider></PixelContext.Provider>
  );
}

/** An agent's accent: the 000h family nearest its mark (loom's MARKS: Lilac, Plum, Pine, Mustard, Denim, Coral). */
const ACCENT: Record<string, string> = { '#b8a6ff': 'blue', '#7a2e4f': 'pink', '#2f6b5a': 'olive', '#e3b341': 'yellow', '#3d5a99': 'blue', '#f09a7a': 'pink' };
const accentOf = (bg: string) => ACCENT[bg.toLowerCase()] ?? 'pink';


const FoldCard = lazy(() => import('./fold'));

/** Where a page's side sections go (App's sideAt): folded at its top, a column beside it, or a desktop window's own
 * right-hand column (drawn into it). */
type SideAt = 'fold' | 'column' | { el: HTMLElement | null };
const SideAtContext = createContext<SideAt>('fold');
/** A section in the side column: `place: side`, or a kept copy from before it had a name (`side`). */
const isSide = (s: Page['sections'][number]) => s.place === 'side' || !!s.side;

/** The side sections folded together at the top of a page with no room for their column (a phone, a narrow window):
 * one block, closed, named for what's in it. */
function SideFold({ side, children }: { side: Page['sections']; children: React.ReactNode }) {
  const filters = side.some((s) => s.blocks.some((b) => b.type === 'filters'));
  const what = side.map((s) => s.title).filter(Boolean).join(' · ');
  return (
    <details className="loom-side-fold">
      <summary><span className="loom-side-fold__name">{filters ? 'Filters & more' : 'Details & more'}</span>
        {what && <span className="loom-side-fold__what">{what}</span>}</summary>
      <div className="loom-side-col grid content-start gap-4">{children}</div>
    </details>
  );
}

function PageView({ page, unscoped }: { page: Page; unscoped?: string }) {
  const at = useContext(SideAtContext);
  const main = page.sections.filter((s) => !isSide(s));
  const side = page.sections.filter(isSide);
  const card = (s: Page['sections'][number]) => (s.fold ? (
    // Its title while its chunk loads, so the page doesn't jump.
    <Suspense key={s.id} fallback={<Card className={sectionRing(s)}><CardHeader className="pb-6"><CardTitle>{s.title}</CardTitle></CardHeader></Card>}><FoldCard s={s} /></Suspense>
  ) : (
    <Card key={s.id} className={sectionRing(s)}>
      {s.title && <CardHeader><CardTitle>{s.title}</CardTitle></CardHeader>}
      <CardContent className="grid min-w-0 gap-4">{s.blocks.map((b, n) => <BlockView key={n} b={b} />)}</CardContent>
    </Card>
  ));
  const sideCards = <InSide.Provider value={true}>{side.map(card)}</InSide.Provider>;
  const column = at === 'column' && side.length > 0;
  return (
    // A side column only when the page has something for it: an empty one made every piece page a third thinner than the Inbox.
    <div className={`grid gap-4 ${column ? 'grid-cols-[minmax(0,1fr)_17.5rem]' : 'grid-cols-[minmax(0,1fr)]'}`}>
      <div className="grid min-w-0 content-start gap-4">
        {side.length > 0 && at === 'fold' && <SideFold side={side}>{sideCards}</SideFold>}
        {unscoped && <p className="text-sm opacity-70">This piece shows the whole household, not only {unscoped}.</p>}
        {page.sections.length === 0 && (page.title === 'Not found'
          ? <StateCard quiet icon="map-pin-off" tint="pink" title="There’s no page here" text="It may have moved, or it was never there." />
          : <StateCard quiet icon="sparkles" app={page.title} title={`Nothing in ${page.title} yet`} text="When there’s something to show, it’ll be here." />)}
        {main.map(card)}
      </div>
      {column && <aside className="loom-side-col grid content-start gap-4" aria-label="More on this page">{sideCards}</aside>}
      {side.length > 0 && typeof at === 'object' && at.el && createPortal(<div className="loom-side-col grid content-start gap-4">{sideCards}</div>, at.el)}
    </div>
  );
}

/** A kind of page this version of the app doesn't know (a newer loom): said, not blank. */
function NotYet({ kind, url }: { kind: string; url: string }) {
  void kind; void url;
  return <StateCard icon="refresh-cw" tint="olive" title="This page needs a newer app" text="loom has been updated. Reload to get the new version." action={{ label: 'Reload', onClick: () => location.reload() }} />;
}

/** Its children, or its children wrapped (a desktop's window around the page). */
function Wrap({ on, wrap, children }: { on: boolean; wrap: (c: React.ReactNode) => React.ReactNode; children: React.ReactNode }) {
  return <>{on ? wrap(children) : children}</>;
}
