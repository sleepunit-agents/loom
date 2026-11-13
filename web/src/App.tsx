import { apps, appAt } from './apps';
// loom's page as an app (docs/specs/ui-app.md): every page is the JSON loom answers for its path.
// A phone gets a top bar and 000h's dock at the bottom (four tabs and More); a desktop the dock as a rail.
import { phoneRowAbout } from './row-about';
import { useAttention, withAttention } from './attention';
import { useThreads, withThreads } from './threads-live';
import { deskHomeOf, useAgentCards, withAgentCards } from './agents-live';
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
// An agent's state beside its name (a desktop's alone): its own chunk.
import { AnimatedIcon } from '@/components/ui/animated-icon';
// The ground (contour field), on its own (ground.tsx).
const Contours = lazy(() => import('./ground').then((m) => ({ default: m.Contours })));
const Depth = lazy(() => import('./ground').then((m) => ({ default: m.Depth })));
// The More drawer's menu (000h's navigation menu) loads when it opens.
// The More drawer (its menu, 000h's drawer) loads the first time it opens; it stays mounted for its closing motion.
const MoreSheet = lazy(() => import('./more-sheet'));
// The launcher (launcher.tsx): a desktop's every app, from the dock's last key; loads the first time it opens.
const Launcher = lazy(() => import('./launcher'));
// The rail is a desktop's alone: a phone never draws it, so never loads it.
const LoomSidebar = lazy(() => import('./sidebar').then((m) => ({ default: m.LoomSidebar })));
// The account's page (passkeys' controls: WebAuthn, push) loads with that page only.
const AccountView = lazy(() => import('./account').then((m) => ({ default: m.AccountView })));
import type { Me } from './account';
const PushAsk = lazy(() => import('./passkeys').then((m) => ({ default: m.PushAsk })));
import { ArrivalContext, arriveOnce, type Arrivals } from './arrive';
import { Boundary, Callout, iconFor } from './safe';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dock, type DockItem } from '@/components/ui/dock';
import { Spinner } from '@/components/ui/spinner';
import { usePage, hasKept, screenNav, type PageNav, type PageState } from './page';
import { nameOf as tileName } from './tiling/name';
// The toasts load with the first one (toasts.tsx).
const Toasts = lazy(() => import('./toasts'));
// Chat about this (about.ts): its sheet's own chunk, the first time something asks.
const ChatAbout = lazy(() => import('./chat-about'));
import type { Note } from './toasts';
import { act, type ActResult, type AgentHead, type Chrome, type Ctx, type Page, type View } from './loom';
import { AgentAvatar, BlockView, EnvContext, type Env } from './blocks';
import { type Ground, DashboardView, HouseHomeView } from './views';
import { placesOf, settingsOf } from './nav';
import { AppHeader, AppTile, oneLine } from './app-header';
import { PhoneBar } from './phone-bar';
import { SysClock, SysIcons, SystemBar } from './system-bar';
import { Skeleton, StateCard } from './states';
import { MeAvatar, nameOf } from './account-button';
// Knowledge, a reader (knowledge.tsx): its own chunk.
const KnowledgeView = lazy(() => import('./knowledge').then((m) => ({ default: m.KnowledgeView })));
// Activity (activity.tsx, t-1972): its own chunk.
const ChangesView = lazy(() => import('./changes').then((m) => ({ default: m.ChangesView })));
const ActivityView = lazy(() => import('./activity').then((m) => ({ default: m.ActivityView })));
// An agent's window (agent-window.tsx): its header and its sections, around its pages. Its own chunk.
const AgentWindow = lazy(() => import('./agent-window'));
const InboxView = lazy(() => import('./inbox').then((m) => ({ default: m.InboxView })));
const PeopleView = lazy(() => import('./people').then((m) => ({ default: m.PeopleView })));
const ProjectsView = lazy(() => import('./projects').then((m) => ({ default: m.ProjectsView })));
// Comms (docs/specs/comms.md): its own chunk, loaded only when it opens.
const CommsView = lazy(() => import('./comms').then((m) => ({ default: m.CommsView })));
// A phone's Home (desk-agents.tsx PhoneHome): the agents' cards, their own chunk (a desktop's comes with the desk's).
const PhoneHome = lazy(() => import('./desk-agents').then((m) => ({ default: m.PhoneHome })));
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
import { aboutPage, chatAbout, CHAT_ABOUT, type About } from './about';
import { keptFollow, wearContrast, wearMotion, type Follow } from './access';
import { keep, LOOKS, lookOf, markColor, modeOf, oneWindowKept, PixelContext, savePrefs, shownLook, wearLook, type Look, type Prefs } from './look';

const ICON: Record<string, string> = {
  Today: 'house', Home: 'house', Inbox: 'inbox', Places: 'layout-grid', Find: 'search', Setup: 'settings', Mind: 'brain', People: 'users',
  Knowledge: 'book-open', Bridges: 'messages-square', Clock: 'alarm-clock', Fuel: 'fuel', Houses: 'container', Secrets: 'key-round',
  Boxes: 'server', Subscriptions: 'credit-card', Tasks: 'list-checks', More: 'ellipsis', Activity: 'activity', Machine: 'cpu', Approvals: 'shield-check',
  Permissions: 'lock', Appearance: 'palette', Accessibility: 'accessibility', Passkeys: 'fingerprint-pattern', Members: 'users-round', Pieces: 'puzzle', Account: 'circle-user-round', Profile: 'circle-user-round', Projects: 'folder-kanban', Comms: 'radio-tower',
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
/** Where a page's side sections stand (docs/extensions.md, "Pages"): 1280 px and wider, a column of their own beside the
 * page; narrower, folded together at the top of the page. (A desktop's tile has its own rule: tiles.tsx SIDE_WIDE.) */
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
  // A desktop in a household: Setup isn't a key (t-1925 G): its apps are in the launcher, the dock's last key (App).
  return matchMedia('(min-width: 1024px)').matches
    // (and no More key for the setting pieces: they're the launcher's too).
    ? s.household ? { tabs: [home, inbox, ...places], more: [] } : { tabs: [home, inbox, ...places, setup], more: settings }
    : { tabs: phone, more: [] };
}

export default function App() {
  const wide = useWide();
  const aboutRows = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!wide && aboutRows.current) return phoneRowAbout(aboutRows.current); }, [wide]);
  const sideWide = useMedia(SIDE_COLUMN);
  const [vw, setVw] = useState(() => innerWidth);
  useEffect(() => { const f = () => setVw(innerWidth); addEventListener('resize', f); return () => removeEventListener('resize', f); }, []);
  const [notes, setNotes] = useState<Note[]>([]);
  const [more, setMore] = useState(false);
  const [moreAsked, setMoreAsked] = useState(false);
  const [finding, setFinding] = useState(false);
  // Chat about this (about.ts): undefined until something first asks (its chunk isn't loaded before), null when closed.
  const [about, setAbout] = useState<(About & { seen: string }) | null | undefined>(undefined);
  useEffect(() => {
    const f = (e: Event) => setAbout((e as CustomEvent<About & { seen: string }>).detail);
    addEventListener(CHAT_ABOUT, f);
    return () => removeEventListener(CHAT_ABOUT, f);
  }, []);
  // The launcher (launcher.tsx), a desktop's: open, and whether it has opened yet (its chunk stays for its next time).
  const [launching, setLaunchingState] = useState(false);
  const [launchAsked, setLaunchAsked] = useState(false);
  const setLaunching = useCallback((o: boolean | ((was: boolean) => boolean)) => { setLaunchAsked(true); setLaunchingState(o); }, []);
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
  // One window at a time (Accessibility; docs/specs/desk-tiling.md): the tiled desktop with one app tile at most. Off
  // unless the person turns it on; a device that kept the old Desktop choice as One window at a time starts with it on.
  const [oneWindow, setOneWindowState] = useState(oneWindowKept);
  const setOneWindow = (on: boolean) => { setOneWindowState(on); keep('loom-one-window', on ? 'on' : 'off'); save({ oneWindow: on }); };
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
  // Tiled (tiling/tiles.tsx), the screen's page is the desktop's (Home), and the address is the tiles': it stands aside.
  const tiledNow = useRef(false);
  // A desktop in a household (desk, below), for the launcher's shortcut: the same rule as its dock key.
  const deskNow = useRef(false);
  const appNav = useMemo<PageNav>(() => ({
    here: () => (tiledNow.current ? '/' : screenNav.here()), push: (to) => { if (!tiledNow.current) screenNav.push(to); },
    replace: (to) => { if (!tiledNow.current) screenNav.replace(to); }, top: () => { if (!tiledNow.current) screenNav.top(); },
  }), []);
  const mainPage = usePage(location.pathname + location.search, say, appNav);
  const { url, error, waiting, pending, savedAt, showing, load } = mainPage;
  // What needs you, live (attention.ts; t-2025): the badges, Home's Needs you and the Inbox read one set once it's in.
  const attention = useAttention(mainPage.data?.chrome?.csrf);
  // And the member's Comms threads, live (threads-live.ts, t-2027): the dock's count and the agent cards read them.
  const threads = useThreads(mainPage.data?.chrome?.csrf);
  // And each agent's card, live (agents-live.ts, t-2028): the desktop's cards and rail, and Home's, on every page.
  const cards = useAgentCards(mainPage.data?.chrome?.csrf);
  const data = useMemo(() => withAgentCards(withThreads(withAttention(mainPage.data, attention), threads), cards), [mainPage.data, attention, threads, cards]);
  const deskHome = useMemo(() => deskHomeOf(data?.view === 'house-home' ? data.home as never : null, cards, attention), [data, cards, attention]);
  const tilesApi = useRef<import('./tiling/tiles').TilesApi | null>(null);
  // The desktop's chunk (desk.tsx), once it's here; asked for when a screen becomes a desktop (a look changed).
  const [D, setD] = useState(desk$);
  // The tile that has focus (tiles.tsx tells): the dock lights its key and the bar says its page.
  const [tileOpen, setTileOpen] = useState<{ key: string; label: string }[]>([]);
  const [tileFocus, setTileFocus] = useState<import('./tiling/tiles').Focused>(null);

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
  useEffect(() => {
    void load(url, false);
    const f = () => {
      if (tiledNow.current) { tilesApi.current?.pop(); return; }
      // The browser's Back or Forward: the page it leaves is still the one shown. Its history and the app's agree when
      // it lands on the app's page before or after this one, and that page comes back where it was.
      const to = location.pathname + location.search;
      trail.keepTop(appKeyRef.current, showing.current, scrollY);
      intent.current = { how: 'pop', url: to };
      const near = [trail.step(appKeyRef.current, -1), trail.step(appKeyRef.current, 1)].find((p) => p?.url === to);
      if (near) restoreTo.current = near;
      void showWith(moveFor(location.pathname, true), to, false);
    };
    addEventListener('popstate', f); return () => removeEventListener('popstate', f);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // ⌘K / Ctrl-K: Find, from anywhere.
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setFinding((o) => !o); }
      // The launcher, a desktop's: Ctrl+Shift+Space (⌘⇧Space). Not ⌘Space (Spotlight's) or Ctrl+Space (the input
      // language's, on every desktop OS): the browser doesn't get those reliably (launcher.tsx).
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.code === 'Space' || e.key === ' ') && deskNow.current) { e.preventDefault(); setLaunching((o) => !o); }
    };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);
  const go = useCallback((href: string, o?: { how?: 'back' | 'forward' }) => {
    const u = new URL(href, location.href);
    // Find is an overlay over the page you're in, not a page of its own (find.tsx).
    if (u.origin === location.origin && u.pathname === '/find' && !u.search) { setFinding(true); return; }
    if (u.origin !== location.origin || u.pathname.startsWith('/app/') || /^\/(login|logout)/.test(u.pathname)) { location.href = href; return; }
    // Tiled, More (Places) and Setup are the launcher's now (t-1925 G): an old link to either opens it.
    if (tiledNow.current && u.origin === location.origin && (u.pathname === '/setup' || u.pathname === '/places')) { setLaunching(true); return; }
    // Tiled: a page opens in its app's tile; the desktop sends the apps to the dock.
    if (tiledNow.current && tilesApi.current) { if (href[0] === '#') tilesApi.current.open(href); else if (u.pathname === '/') tilesApi.current.desktop(); else tilesApi.current.open(u.pathname + u.search); return; }
    // Leaving a page: how far down it was, for Back to come back to; and how the next one is reached (trail.ts).
    trail.keepTop(appKeyRef.current, location.pathname + location.search, scrollY);
    intent.current = { how: o?.how ?? 'go', url: u.pathname + u.search };
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
    if (p.oneWindow !== undefined) { setOneWindowState(p.oneWindow); keep('loom-one-window', p.oneWindow ? 'on' : 'off'); }
    if (p.haptics !== undefined) { setHapticsState(p.haptics); keep('loom-haptics', p.haptics ? 'on' : 'off'); }
    if (p.zoom !== undefined) { setZoomState(p.zoom); keep('loom-zoom', p.zoom ? 'on' : 'off'); }
    if (p.motion) { setMotionState(p.motion); keep('loom-motion', p.motion); wearMotion(p.motion); }
    if (p.contrast) { setContrastState(p.contrast); keep('loom-contrast', p.contrast); wearContrast(p.contrast); }
  }, [chrome]);
  // Tiled (docs/specs/desk-tiling.md): a desktop (1024 px and wider, in a household), and the desk's chunk is here. The
  // only desktop there is (Jonathan, 2026-11-06: "it should be the default ... make this the only option").
  const tiled = wide && !!chrome?.shell?.household && !!D;
  useLayoutEffect(() => { tiledNow.current = tiled; });
  // Into tiles, the screen's page becomes the desktop (the page that was shown is a tile now); out of them, the
  // focused tile's page is the screen's again.
  const wasTiled = useRef(false);
  useEffect(() => {
    if (tiled === wasTiled.current) return;
    wasTiled.current = tiled;
    if (tiled) {
      // An old link to Setup or More (Places): the launcher, over the desktop.
      if (['/setup', '/places'].includes(url.split('?')[0])) setLaunching(true);
      if (url !== '/') void load('/', false);
      return;
    }
    const u = new URL(location.href);
    for (const k of ['t', 'm', 'w']) u.searchParams.delete(k);
    history.replaceState(null, '', u.pathname + u.search);
    void load(u.pathname + u.search, false);
  }, [tiled]);   // eslint-disable-line react-hooks/exhaustive-deps
  const ctx = (data && 'ctx' in data ? data.ctx : undefined) as Ctx | undefined;
  const head = data?.view === 'page' ? data.head : data?.view === 'dashboard' ? (data.dashboard as { agent?: AgentHead }).agent : undefined;
  const accent = useMemo(() => {
    const agentId = /^\/a\/([a-z][a-z0-9-]*)/.exec(url)?.[1];
    return agentId ? chrome?.shell?.agents.find((a) => a.id === agentId) : undefined;
  }, [url, chrome]);

  // Acting as another source (an ask's or a tile's piece, an Inbox item's), the page to come back to is still this one:
  // it goes as loom's own link (loom:inbox?i=…), or the piece reads it as one of its pages and lands on its Not found.
  // (An agent's page is loom's too, under /a/<agent>/: loom:a/art, loom:a/art/mind.)
  const backAs = (c: Ctx) => (c.source.id !== 'loom' || c.path.startsWith('loom:') ? c.path
    : `loom:${(c.source.base.slice(1) + c.path).replace(/\/$/, '')}`);
  /** A page's Env (blocks.tsx): its links go by `goTo`, and an action that lands refreshes that page. Pages without a ctx
   * of their own (the household's home, a sheet) act and link as loom itself. */
  const pageEnv = (pg: PageState, goTo: (href: string) => void): Env | null => {
    const ch = pg.data?.chrome;
    const own = (pg.data && 'ctx' in pg.data ? pg.data.ctx : undefined) as Ctx | undefined;
    const base: Ctx | null = own ?? (ch ? { source: { id: 'loom', base: '/' }, path: pg.url.replace(/^\//, '').split('?')[0], query: {}, csrf: ch.csrf,
      agents: Object.fromEntries((ch.shell?.agents ?? []).map((a) => [a.id, { label: a.label, bg: a.bg, fg: a.fg }])) } : null);
    if (!base) return null;
    const sendAs = async (action: string, fields: Record<string, string>, c: Ctx): Promise<boolean> => {
      if (!ch) return false;
      const r: ActResult = await act(c, ch.csrf, action, fields);
      say({ ok: r.ok, message: r.message, from: r.from, undo: r.undo });
      // Unsure whether it landed (an unreadable answer, t-1995): read the page again, so it shows what loom recorded.
      if (r.go) goTo(r.go); else if (r.ok || r.unsure) void pg.load(pg.url, false);
      return r.ok;
    };
    const envFor = (c: Ctx): Env => ({ ctx: c, send: (a, f) => sendAs(a, f, c), go: goTo, wide, stale: !pg.fresh, withSource: (source) => envFor({ ...c, source, path: backAs(c) }) });
    return envFor(base);
  };
  const env: Env | null = pageEnv(mainPage, go);
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
  // A desktop's account is the launcher's (its corner: the mockups), so its dock ends with the launcher's key instead.
  const meTile = !agentDock && chrome?.shell && !(wide && chrome.shell.household) ? chrome.shell.owner : null;
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
    value: t.href, label: t.label, open: tiled && tileOpen.some((a) => a.key === t.href), icon: <>{agentDock
      // An agent's own dock wears the agent's colour, not an app's tint (looks.css): the pixel ramps are the apps' tints,
      // so its keys keep their line icons.
      ? <AnimatedIcon name={iconFor(icon(t.label))} active={t.current} />
      // On the tiled desktop, the key of the app that has focus (or Home's, with none) is the one lit.
      : <AppIcon label={t.href === '/setup' ? 'Setup' : t.label} name={iconFor(icon(t.label))} active={tiled ? t.href === lit : t.current} lit={tiled ? t.href === lit : t.current} />}<HapticLabel on={haptics} /></>, ...(agentDock ? {} : { tint: tint(t.label) }),
    ...(t.count ? { badge: <span className="loom-data text-[10px] font-semibold">{t.count}</span> } : {}),
  }));
  const current = (list: Tab[]) => list.find((t) => t.current)?.href ?? '';
  const me: DockItem | null = meTile ? { value: '/account', label: nameOf(meTile), icon: <span className="loom-back-mark" aria-hidden>{nameOf(meTile)[0]}</span> } : null;
  const accountOpen = data?.view === 'passkeys';
  const lit = launching && wide && chrome?.shell?.household ? '#apps' : tiled && tileFocus ? tileFocus.key : accountOpen && me ? '/account' : current(phoneTabs);
  const temporary = tiled && !agentDock ? tileOpen.filter((a) => !phoneTabs.some((t) => t.href === a.key)) : [];
  const temporaryItems = dockItems(temporary.map((a) => ({ href: a.key, label: a.label, current: false })))
    .map((a, i) => ({ ...a, divider: i === 0 }));
  const pick = (href: string) => {
    buzz(haptics, true);
    if (href === '#more') { setMoreAsked(true); setMore(true); return; }
    if (href === '#apps') { setLaunching(true); return; }
    if (tiledNow.current && tilesApi.current) { tilesApi.current.pick(href); return; }
    if (href === '#back') { go('/'); return; }
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
    : data?.view === 'inbox' ? 'Inbox' : data?.view === 'activity' ? 'Activity' : data?.view === 'knowledge' ? String(data.title ?? 'Knowledge') : data?.view === 'comms' ? 'Comms' : data?.view === 'sheet' ? (data.which === 'setup' && !wide ? 'More' : String(data.which).replace(/^./, (c) => c.toUpperCase())) : 'Home');

  // The header (app-header.tsx): the app's icon tile (or the agent's mark, or its way back), the title, one line.
  // Chat about this page (about.ts): a phone's page-name sheet and More offer it; a desktop's window menu does.
  const pageAbout = aboutPage(url, title || head?.label || 'This page');
  const pageChat = pageAbout ? () => chatAbout(pageAbout) : undefined;
  const shellPlaces = chrome?.shell ? [...placesOf(chrome.shell), ...settingsOf(chrome.shell), ...chrome.shell.core] : [];
  const placeAt = (at: string) => shellPlaces.find((p) => at === p.href) ?? shellPlaces.find((p) => p.href !== '/' && at.startsWith(`${p.href}/`));
  // Which app a page is in, as a tile (tiling/tiles.tsx): keyed as the dock keys it (trail.ts keys the same), an agent's
  // pages that agent's; Home is no tile.
  const agentOf = (key: string) => chrome?.shell?.agents.find((a) => key === `/a/${a.id}`);
  const tileOf = (at: string): { key: string; label: string } | null => {
    const registered = appAt(new URL(at, 'http://loom').pathname);
    if (registered) return { key:registered.path,label:registered.title };
    if (at === '/' || !chrome?.shell) return null;
    const agent = /^\/a\/([a-z][a-z0-9-]*)/.exec(at)?.[1];
    if (agent) { const a = chrome.shell.agents.find((x) => x.id === agent); return a ? { key: `/a/${a.id}`, label: a.label } : null; }
    const tab = [...nav.tabs, ...nav.more].find((t) => !t.href.startsWith('#') && t.href !== '/' && (at === t.href || at.startsWith(`${t.href}/`)));
    if (tab) return { key: tab.href, label: tab.label };
    if (at === '/account' || at === '/passkeys') return { key: '/account', label: 'Profile' };
    // Setup and Places (More) are the launcher's on a desktop (t-1925 G), not tiles: each of their apps is its own.
    if (at === '/setup' || at === '/places') return null;
    const set = settingsOf(chrome.shell).find((p) => at === p.href || at.startsWith(`${p.href}/`));
    if (set) return { key: set.href, label: set.label };
    const p = placeAt(at);
    if (p) return { key: p.href, label: p.label };
    const seg = at.split('/')[1] ?? '';
    return seg ? { key: `/${seg}`, label: seg[0].toUpperCase() + seg.slice(1) } : null;
  };
  /** An app by its name in the tiles' address (the last part of its key): a household app's first, then an agent's. */
  const tileNamed = (name: string) => {
    const hrefs = [...apps.map(app => ({ href: app.path })), ...nav.tabs, ...nav.more].map((t) => t.href).filter((h) => !h.startsWith('#') && h !== '/')
      .concat('/account', ...shellPlaces.map((p) => p.href), ...(chrome?.shell?.agents ?? []).map((a) => `/a/${a.id}`));
    for (const h of hrefs) { const r = tileOf(h); if (r && tileName(r.key) === name) return { ...r, href: h }; }
    return null;
  };
  // On its way, or not opened: the header still says which app (a place's name), not the last page's title.
  const path = (waiting && pending ? pending : url).split('?')[0];
  const place = placeAt(path);
  const shownTitle = title || ((error || waiting) && place ? place.label : '');
  // A sheet (Accessibility) can carry an intro too, as a page does.
  const intro = error ? undefined : data?.view === 'page' ? (data.page as Page).intro : data?.view === 'sheet' || data?.view === 'knowledge' ? (data.intro as string | undefined) : undefined;
  const context = error || waiting ? undefined : head?.sub ?? (place && path === place.href ? (place as { stat?: string }).stat : undefined) ?? oneLine(intro)
    ?? (data?.view === 'inbox' && chrome?.shell?.asks ? `${chrome.shell.asks} need${chrome.shell.asks === 1 ? 's' : ''} you` : undefined);
  const tileLabel = data?.view === 'passkeys' ? 'Profile' : data?.view === 'sheet' && data.which === 'setup' ? 'Setup' : data?.view === 'inbox' ? 'Inbox'
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

  /** A page's body (its state, its error, its view), in the screen's page or a tile's. */
  const pageBody = (pg: PageState, env: Env | null, side: SideAt, arr: Arrivals, inTile = false) => {
    const registered = appAt(new URL(pg.url, 'http://loom').pathname);
    if (registered) return <Suspense fallback={<Skeleton />}><registered.Screen /></Suspense>;
    const data = withAgentCards(withThreads(withAttention(pg.data, attention), threads), cards);
    // An agent's page is its window (t-1925 D): its header, and in a tile its sections down the side.
    const agentHead = data?.view === 'page' ? data.head : data?.view === 'dashboard' ? (data.dashboard as { agent?: AgentHead }).agent : undefined;
    const inAgent = !!agentHead?.id && !!data?.chrome?.shell?.household;
    const own = (body: React.ReactNode) => (inAgent && agentHead ? <Suspense fallback={<Skeleton />}>
      <AgentWindow head={agentHead} chrome={data?.chrome} icon={icon} rail={inTile}>{body}</AgentWindow></Suspense> : body);
    return (<>
            {pg.waiting && <Skeleton />}
            {pg.savedAt && <Callout tone="warn" icon="cloud-off" role="status" className="mb-4" title="Can’t reach loom">
              This is how it looked at <span className="loom-data">{new Date(pg.savedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>. Actions wait for a connection.</Callout>}
            {!pg.waiting && pg.error && (pg.error === 'offline'
              ? <StateCard icon="cloud-off" tint="blue" title="Can’t reach loom" text="This page isn’t saved on this device yet. It opens as soon as there’s a connection."
                  action={{ label: 'Try again', onClick: () => void pg.load(pg.url, false) }} />
              : <StateCard icon="triangle-alert" tint="yellow" title={`${placeAt(pg.url.split('?')[0])?.label ?? 'This page'} didn’t load`} text="loom had trouble opening it. Try again, or come back in a minute."
                  action={{ label: 'Try again', onClick: () => void pg.load(pg.url, false) }} />)}
            {/* Home and the Inbox ask a device that could get Your call and doesn't (passkeys.tsx PushAsk). */}
            {!pg.waiting && !pg.error && data?.chrome && ['house-home', 'home', 'inbox'].includes(data.view) && (
              <Suspense fallback={null}><PushAsk csrf={data.chrome.csrf} /></Suspense>
            )}
            {!pg.waiting && !pg.error && data && env && (
              <ArrivalContext.Provider value={arr}><EnvContext.Provider value={env}><SideAtContext.Provider value={side}><Boundary where={pg.url}>
                {own(data.view === 'page' && data.people ? <Suspense fallback={<Spinner size="lg" />}><PeopleView data={data.people} /></Suspense>
                  : data.view === 'page' && data.projects ? <Suspense fallback={<Spinner size="lg" />}><ProjectsView cards={data.projects} /></Suspense>
                  : data.view === 'page' && data.page.changes ? <Suspense fallback={<Spinner size="lg" />}><ChangesView page={data.page} unscoped={data.unscoped} /></Suspense>
                  : data.view === 'page' ? <PageView page={data.page} unscoped={data.unscoped} />
                  // A desktop's Home is its widgets (tiles.tsx), drawn once the desk's chunk is here.
                  : data.view === 'house-home' && desk ? <Skeleton />
                  // A phone's Home is the agents too (docs/specs/agent-desk.md, "A phone"): Needs you, then a card each.
                  : data.view === 'house-home' && data.chrome?.shell ? <Suspense fallback={<Skeleton />}><PhoneHome home={data.home as never} shell={data.chrome.shell} /></Suspense>
                  : data.view === 'house-home' ? <HouseHomeView home={data.home as never} />
                  : data.view === 'dashboard' ? <DashboardView d={data.dashboard as never} now={data.now as number} bare={inAgent} />
                  : data.view === 'home' ? <><DashboardView d={{ label: 'Home', asks: data.asks as never, tiles: data.tiles as never, thread: [] }} now={Date.now()} /><div className="mt-4"><PageView page={data.page as Page} /></div></>
                  : data.view === 'comms' ? <Suspense fallback={<Spinner size="lg" />}><CommsView data={data as never} /></Suspense>
                  : data.view === 'knowledge' ? <Suspense fallback={<Spinner size="lg" />}><KnowledgeView data={data as never} /></Suspense>
                  : data.view === 'activity' ? <Suspense fallback={<Spinner size="lg" />}><ActivityView data={data as never} /></Suspense>
                  : data.view === 'inbox' ? <Suspense fallback={<Spinner size="lg" />}><InboxView key={String(data.open ?? '')} items={data.items as never} folder={data.folder as string} folders={data.folders as never} open={data.open as string | undefined} chrome={data.chrome} github={data.github as string | undefined} /></Suspense>
                  : data.view === 'passkeys' ? <Suspense fallback={<Spinner size="lg" />}>
                    <AccountView me={(data.me as Me | undefined) ?? { name: data.chrome?.shell?.owner ?? 'owner', role: 'Signed in' }} csrf={data.chrome.csrf}
                      add={data.add as never} reload={() => void pg.load(pg.url, false, true)} page={data.page as Page} /></Suspense>
                  : data.view === 'sheet' && data.which === 'find' ? <Suspense fallback={<Spinner size="lg" />}>
                    <div className="loom-find loom-find-page grid h-[min(70dvh,640px)] overflow-hidden"><FindPanel chrome={data.chrome} icon={icon} go={go} /></div></Suspense>
                  : data.view === 'sheet' ? <Suspense fallback={<Spinner size="lg" />}><SheetView which={data.which as string} chrome={data.chrome} icon={icon} ground={ground} setGround={setGround} look={look} setLook={setLook} sound={sound} setSound={setSound} pixel={pixel} setPixel={setPixel} pixIcons={pixIcons} setPixIcons={setPixIcons} oneWindow={oneWindow} setOneWindow={setOneWindow} haptics={haptics} setHaptics={setHaptics} zoom={zoom} setZoom={setZoom} motion={motion} setMotion={setMotion} contrast={contrast} setContrast={setContrast} /></Suspense>
                  : <NotYet kind={data.view} url={pg.url} />)}
              </Boundary></SideAtContext.Provider></EnvContext.Provider></ArrivalContext.Provider>
            )}
            {!pg.waiting && !pg.error && data && !env && <NotYet kind={data.view} url={pg.url} />}
    </>);
  };

  // The app's arrival, once a session: the first time a page with its header has landed (arrive.tsx arriveOnce).
  const arrived = useRef(false);
  // A desktop's boot (desk.tsx DeskBoot): with the arrival, once a session, never under reduced motion.
  const [booting, setBooting] = useState(false);
  useLayoutEffect(() => {
    if (arrived.current || !data || waiting) return;
    // A cold desktop chunk can land after the page data. Keep the session fresh until it can boot.
    if (desk && !D) return;
    arrived.current = true;
    // Its sound only when it runs (never under reduced motion), and only if the person turned Sound on.
    // loom's word on Sound first: on a device that has no copy yet, the page that just landed is the first to say it.
    const soundNow = data.chrome?.prefs?.sound ?? soundOn.current;
    // A desktop boots first, once a session and only with motion allowed; the arrival (its power-on) runs as it ends.
    if (desk && D?.bootsNow()) { setBooting(true); return; }
    if (arriveOnce(document.querySelector<HTMLElement>('.loom-top h1')) && soundNow) void import('./sound').then((m) => m.chime('boot'));
  }, [data, waiting, D, wide]);

  // A page come back to with Back or Forward: back where it was, once its page is drawn.
  useLayoutEffect(() => {
    const r = restoreTo.current;
    if (!r || waiting) return;
    restoreTo.current = null;
    if (url !== r.url) return;
    scrollTo({ top: r.top });
  }, [url, waiting, data]);
  // Where you've been, for Find's Recent: each page that opened, by its title.
  useEffect(() => { if (!error && data && title && url !== '/') noteRecent(title, url); }, [url, title, error, data]);
  // The phone's bar at every width (phone-bar.tsx). On a phone it merges with the phone's own status bar; wider,
  // there's none, so loom draws one over it (system-bar.tsx; Jonathan, 2026-11-05). A page with no shell keeps the big header.
  const phoneBar = !!chrome?.shell;
  // 1024 px and wider, in a household (desk.tsx): a desktop, tiled (tiles.tsx). The dock sits at the bottom centre (no
  // rail). 1024 is where the rail took over from the phone's dock before: below it the phone's layout (its dock, its
  // gestures) is unchanged.
  const desk = wide && !!chrome?.shell?.household;
  useLayoutEffect(() => { deskNow.current = desk; });

  // The app the page shown is in, for its own history (trail.ts): an agent's pages are that agent's; else the place it's
  // under. (A desktop's tiles keep their own: tiles.tsx.)
  const appKey = path === '/' ? undefined : accent ? `/a/${accent.id}` : place?.href ?? `/${path.split('/')[1]}`;
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
  // A phone's back chevron (phone-bar.tsx), on a page under another: the page before this one in the same app, as it
  // was left; opened from somewhere else (a link, Find, the Inbox), the page it's under, as before.
  const prevHere = back ? trail.step(appKey, -1) : undefined;
  const phoneCrumb = prevHere ? { label: prevHere.label ?? back!.label, href: prevHere.url } : back;
  // Where the page's side sections stand (SIDE_COLUMN): beside the page at 1280 and wider, else folded at its top.
  const sideAt: SideAt = sideWide ? 'column' : 'fold';
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
        ref={aboutRows}
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
            <header className={`loom-top loom-top--bar${desk ? ' loom-top--one' : deskBar ? ' loom-top--desk' : ''}`} data-accent={appAccent}>
              <div className="mx-auto max-w-5xl px-4">
                {/* Wider than a phone: loom's own status bar over it, across the page's column, so its clock sits over
                    the page's name and its glyphs over LOOM//OS and the count, as a phone's do (system-bar.tsx). */}
                {deskBar && !desk && <SystemBar shell={chrome.shell} clock={{ text: chrome.clock, tz: chrome.tz }} offline={!!savedAt} go={go} />}
                {/* A desktop's is one line, as a desktop's own is (Jonathan, 2026-11-06): the clock and the page's name on
                    the left, LOOM//OS and the glyphs on the right, the ticker between. */}
                <PhoneBar clock={desk ? <SysClock clock={{ text: chrome.clock, tz: chrome.tz }} /> : undefined}
                  status={desk ? <SysIcons shell={chrome.shell} offline={!!savedAt} go={go} /> : undefined} title={(tiled && tileFocus ? tileFocus.title : shownTitle) ?? ''} go={go} crumb={phoneCrumb} onBack={prevHere ? () => move(-1) : undefined} shell={chrome.shell} offline={!!savedAt} where={tiled && tileFocus ? `${tileFocus.key}\0${tileFocus.title}` : url}
                  info={tiled ? { more: tileFocus?.intro } : { line: profileLeads || data?.view === 'inbox' ? undefined : context, more: intro }}
                  color={accent ? markColor(accent.bg) : `var(--loom-tint-${tint(tileLabel || 'Home')})`} chat={desk ? undefined : pageChat} />
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

          {tiled && D && chrome?.shell ? (
            <main className="loom-desk-main loom-tiles-main">
              <D.TileDesk api={tilesApi} appOf={tileOf} byName={tileNamed} say={say} onFocus={setTileFocus} onOpen={setTileOpen} outerGo={go}
                shell={chrome.shell} homeData={deskHome} deskEnv={(g) => pageEnv(mainPage, g)}
                oneWindow={oneWindow} render={(pg, g, roomy) => pageBody(pg, pageEnv(pg, g), roomy ? 'column' : 'fold', { before: null, now: new Set() }, true)}
                home={pageBody(mainPage, env, sideAt, arrivals)}
                // An agent's window wears its letter in the corner (t-1925 D): a cropped pixel head there read wrong.
                lead={(o) => o.key.startsWith('/a/') && agentOf(o.key) ? <span className="loom-letter" aria-hidden style={{ '--c': markColor(agentOf(o.key)!.bg), '--ls': '22px' } as React.CSSProperties}>{agentOf(o.key)!.label[0]}</span> : <AppIcon label={o.label} name={iconFor(icon(o.label))} size="sm" lit />}
                tint={(o) => (agentOf(o.key) ? markColor(agentOf(o.key)!.bg) : `var(--loom-tint-${tint(o.label)})`)}
                // A tile's page wears its app's colour (tint.ts), or its agent's, as the page did before tiles: its
                // buttons, switches and selection (000h's --v-pink). Not the account's.
                accent={(o) => { const a = agentOf(o.key); return a ? { name: accentOf(a.bg), style: { '--loom-accent': a.bg, '--loom-on-accent': a.fg, '--loom-accent-lit': markColor(a.bg) } as React.CSSProperties }
                  : o.key === '/account' || tint(o.label) === 'pink' ? {} : { name: tint(o.label) }; }} />
            </main>
          ) : (
          // A phone's page, or a desktop's for the moment before the desk's chunk is here.
          <main aria-busy={waiting || !!pending || undefined} data-pending={pending && !waiting && !tiled ? '' : undefined} className={desk ? 'loom-desk-main' : 'mx-auto max-w-5xl px-4 pb-44 pt-5 lg:pb-10'} data-accent={appAccent}>
            {pageBody(mainPage, env, sideAt, arrivals)}
          </main>
          )}

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
                items={backTile ? [backTile, ...dockItems(phoneTabs)] : [...dockItems(phoneTabs), ...temporaryItems, ...(me ? [me] : []),
                  // A desktop's last key: every app (launcher.tsx).
                  ...(desk && !agentDock ? [{ value: '#apps', label: 'All apps', tint: 'olive', icon: <span className="loom-apps-dots" aria-hidden>{Array.from({ length: 9 }, (_, n) => <i key={n} />)}</span> }] : [])]}
                value={lit} onValueChange={pick}
                aria-label={agentDock ? `${accent?.label}'s pages` : 'Pages'} />
              </DockSwap>
            </nav>
          )}
        </div>
      </div>

      {booting && D && chrome?.shell && <D.DeskBoot shell={chrome.shell} offline={!!savedAt} onDone={() => {
        setBooting(false);
        if (arriveOnce(document.querySelector<HTMLElement>('.loom-top h1')) && soundOn.current) void import('./sound').then((m) => m.chime('boot'));
      }} />}

      {moreAsked && <Suspense fallback={null}><MoreSheet open={more} onOpenChange={setMore} here={head?.label} pages={moreTabs} agents={chrome?.shell?.agents ?? []} icon={icon}
        chat={pageChat ? () => { setMore(false); pageChat(); } : undefined}
        go={(href) => { setMore(false); go(href); }} /></Suspense>}

      {launchAsked && desk && chrome?.shell && <Suspense fallback={null}><Launcher open={launching} onOpenChange={setLaunching} shell={chrome.shell} icon={icon}
        look={LOOKS.find((l) => l.look === look)?.name} motion={motion === 'on' ? 'Less motion' : motion === 'off' ? 'Full motion' : 'As this device'}
        launch={(href) => { if (!(tiledNow.current && tilesApi.current?.open(href))) go(href); }} /></Suspense>}

      {chrome && finding && <Suspense fallback={null}><FindOverlay open={finding} onOpenChange={setFinding} chrome={chrome} icon={icon} go={go} /></Suspense>}

      {about !== undefined && chrome && <Suspense fallback={null}><ChatAbout about={about} csrf={chrome.csrf} agents={chrome.shell?.agents ?? []} onClose={() => setAbout(null)}
        go={(href) => { if (!(tiledNow.current && tilesApi.current?.open(href))) go(href); }} /></Suspense>}

      {notes.length > 0 && <Suspense fallback={null}><Toasts notes={notes} wide={wide} dismiss={(id) => setNotes((x) => x.filter((y) => y.id !== id))}
        undo={ctx && chrome ? (n) => void act({ ...ctx, path: n.undo!.path, query: {} }, chrome.csrf, n.undo!.action, n.undo!.fields ?? {}, n.undo!.act).then((r) => { say(r); void load(url, false); }) : undefined} /></Suspense>}
    </TintContext.Provider></HapticsContext.Provider></PixelIconsContext.Provider></PixelContext.Provider>
  );
}

/** An agent's accent: the 000h family nearest its mark (loom's MARKS: Lilac, Plum, Pine, Mustard, Denim, Coral). */
const ACCENT: Record<string, string> = { '#b8a6ff': 'blue', '#7a2e4f': 'pink', '#2f6b5a': 'olive', '#e3b341': 'yellow', '#3d5a99': 'blue', '#f09a7a': 'pink' };
const accentOf = (bg: string) => ACCENT[bg.toLowerCase()] ?? 'pink';


const FoldCard = lazy(() => import('./fold'));
const ChartLine = lazy(() => import('./chart-line'));

/** Where a page's side sections go (App's sideAt): folded at its top, or a column beside it. */
type SideAt = 'fold' | 'column';
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
    <Suspense key={s.id} fallback={<Card data-band className={sectionRing(s)}><CardHeader className="pb-6"><CardTitle>{s.title}</CardTitle></CardHeader></Card>}><FoldCard s={s} /></Suspense>
  ) : (
    <Card key={s.id} data-band className={sectionRing(s)}>
      {s.title && <CardHeader><CardTitle>{s.title}</CardTitle></CardHeader>}
      <CardContent className="grid min-w-0 gap-4">{s.blocks.map((b, n) => <BlockView key={n} b={b} />)}</CardContent>
    </Card>
  ));
  const sideCards = <InSide.Provider value={true}>{side.map(card)}</InSide.Provider>;
  const column = at === 'column' && side.length > 0;
  return (
    // A side column only when the page has something for it: an empty one made every piece page a third thinner than the Inbox.
    <div className={`loom-pv grid gap-4 ${column ? 'grid-cols-[minmax(0,1fr)_17.5rem]' : 'grid-cols-[minmax(0,1fr)]'}`}>
      <div className="loom-pv__main grid min-w-0 content-start gap-4">
        {/* Folded, a side chart is a line over the fold (t-1925: Tasks in a narrow window), the whole chart in it. */}
        {at === 'fold' && side.flatMap((s) => s.blocks.filter((b) => b.type === 'chart').map((b, n) => (
          <Suspense key={`${s.id}:${n}`} fallback={<div className="min-h-10" />}><ChartLine b={b as never} title={s.title} /></Suspense>)))}
        {side.length > 0 && at === 'fold' && <SideFold side={side}>{sideCards}</SideFold>}
        {unscoped && <p className="text-sm opacity-70">This piece shows the whole household, not only {unscoped}.</p>}
        {page.sections.length === 0 && (page.title === 'Not found'
          ? <StateCard quiet icon="map-pin-off" tint="pink" title="There’s no page here" text="It may have moved, or it was never there." />
          : <StateCard quiet icon="sparkles" app={page.title} title={`Nothing in ${page.title} yet`} text="When there’s something to show, it’ll be here." />)}
        {main.map(card)}
      </div>
      {column && <aside className="loom-side-col grid content-start gap-4" aria-label="More on this page">{sideCards}</aside>}
    </div>
  );
}

/** A kind of page this version of the app doesn't know (a newer loom): said, not blank. */
function NotYet({ kind, url }: { kind: string; url: string }) {
  void kind; void url;
  return <StateCard icon="refresh-cw" tint="olive" title="This page needs a newer app" text="loom has been updated. Reload to get the new version." action={{ label: 'Reload', onClick: () => location.reload() }} />;
}
