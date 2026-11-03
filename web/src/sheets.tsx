// The shell's sheets as pages (Scope, Places, Setup, Appearance; Find is find.tsx's overlay): their own chunk, loaded when
// one opens (the first page doesn't carry them).
import { useContext } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { iconFor } from './safe';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { EnvContext, Nothing } from './blocks';
import type { Chrome, Tone } from './loom';
import { DOT, Mark, PressCard, type Ground, type Mode } from './views';
import { placesOf, settingsOf } from './nav';

const useEnv = () => useContext(EnvContext)!;

export function SheetView({ which, chrome, mode, setMode, ground, setGround }: { which: string; chrome: Chrome; mode: Mode; setMode: (m: Mode) => void; ground: Ground; setGround: (g: Ground) => void }) {
  const { go } = useEnv();
  const s = chrome.shell;
  // A launcher, as a phone's home screen (Jonathan, 2026-10-31: "we look like a phone os screen ... let's make both
  // screens a kind of click here to go to the place you want to go thing"): a tile in the dock's colours, its name
  // under it, a badge for what's waiting, and the piece's own word (22 in progress) small beneath.
  const launch = (p: { label: string; href: string; stat?: string; tone?: Tone; count?: number }, i: number) => (
    <button key={p.href} type="button" onClick={() => go(p.href)} className="loom-launch group grid min-w-0 content-start justify-items-center gap-1.5 text-center">
      <span className="loom-launch-tile relative grid size-16 place-items-center rounded-[22%] shadow-sm transition-transform group-active:scale-95" data-tint={i % 4}>
        <AnimatedIcon name={iconFor(ICONS[p.label] ?? 'circle')} />
        {p.count ? <span className="absolute -right-1.5 -top-1.5 grid min-w-5 place-items-center rounded-full bg-[var(--v-red,#e5484d)] px-1.5 text-[11px] font-semibold text-white">{p.count}</span> : null}
        {p.tone && p.tone !== 'ok' && <span className={`absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-[var(--v-paper)] ${DOT[p.tone]}`} />}
      </span>
      <span className="w-full truncate text-sm font-medium">{p.label}</span>
      {p.stat && <span className="-mt-1 w-full truncate text-[11px] opacity-60">{p.stat}</span>}
    </button>
  );
  const grid = (items: Array<{ label: string; href: string; stat?: string; tone?: Tone; count?: number }>) => (
    <div className="grid grid-cols-4 gap-x-3 gap-y-6 sm:grid-cols-6">{items.map(launch)}</div>
  );
  // Places: the apps, where you go regularly (Activity, Knowledge, People, Tasks, Appearance). The Inbox has its own tab.
  if (which === 'places' && s) return grid(placesOf(s));
  // Appearance: an app of its own (it was a card on Setup), this device's look.
  if (which === 'appearance') return <AppearanceApp mode={mode} setMode={setMode} ground={ground} setGround={setGround} />;
  // Setup: the household's configuration only (the pieces that are settings, its members, its pieces). What's the
  // member's own (passkeys, signing out) is the account's: the avatar on a phone's dock, the side's account menu.
  if (which === 'setup' && s) {
    const settings = settingsOf(s);
    return settings.length ? grid(settings) : <Nothing title="Nothing to set up" text="The household's settings are its owner's." />;
  }
  if (which === 'scope' && s) {
    return (
      <div className="grid gap-3">
        <PressCard className="flex items-center gap-3" onPress={() => go('/')}><AnimatedIcon name={iconFor("house")} /><span className="font-medium">The household</span></PressCard>
        {s.agents.map((a) => (
          <PressCard key={a.id} className="flex items-center gap-3" onPress={() => go(a.href)}>
            <Mark a={a} /><span className="min-w-0 flex-1"><span className="block font-medium">{a.label}</span>{a.sub && <span className="block text-sm opacity-70">{a.sub}</span>}</span>
            {a.asks ? <Badge variant="pending">{a.asks}</Badge> : null}
          </PressCard>))}
      </div>
    );
  }
  return <p className="opacity-70">Nothing here.</p>;
}

export function Appearance({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <ToggleGroup type="single" className="v-seg" aria-label="Appearance" value={mode} onValueChange={(m) => { if (m) setMode(m as Mode); }}>
      {(['auto', 'light', 'dark'] as Mode[]).map((m) => <ToggleGroupItem key={m} value={m}>{m === 'auto' ? 'Auto' : m === 'light' ? 'Light' : 'Dark'}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}

/** The Appearance app: light or dark, and the ground behind everything. Kept in this browser. */
function AppearanceApp({ mode, setMode, ground, setGround }: { mode: Mode; setMode: (m: Mode) => void; ground: Ground; setGround: (g: Ground) => void }) {
  return (
    <div className="grid gap-4">
      <Card><CardHeader><CardTitle>Light or dark</CardTitle></CardHeader>
        <CardContent className="grid gap-2"><Appearance mode={mode} setMode={setMode} />
          <p className="text-sm opacity-70">Auto follows this device.</p></CardContent></Card>
      <Card><CardHeader><CardTitle>Background</CardTitle></CardHeader>
        <CardContent className="grid gap-2">
          <ToggleGroup type="single" className="v-seg" aria-label="Background" value={ground} onValueChange={(g) => { if (g) setGround(g as Ground); }}>
            {([['depth', 'Depth'], ['contours', 'Contours'], ['wash', 'Wash']] as const).map(([g, l]) => <ToggleGroupItem key={g} value={g}>{l}</ToggleGroupItem>)}</ToggleGroup>
          <p className="text-sm opacity-70">What’s behind every page.</p></CardContent></Card>
      <p className="text-sm opacity-60">Kept on this device: another phone or browser keeps its own.</p>
    </div>
  );
}

const ICONS: Record<string, string> = {
  Knowledge: 'book-open', People: 'users', Mind: 'brain', Activity: 'activity', Bridges: 'messages-square', Clock: 'alarm-clock', Boxes: 'server',
  Subscriptions: 'credit-card', Secrets: 'key-round', Tasks: 'list-checks', Members: 'users-round', Pieces: 'puzzle', Passkeys: 'fingerprint-pattern', Machine: 'cpu',
  Appearance: 'palette', Account: 'circle-user-round',
};
