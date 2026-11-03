// The shell's sheets as pages (Scope, Places, Setup, and Appearance, an app in Setup's grid; Find is find.tsx's overlay): their own
// chunk, loaded when one opens (the first page doesn't carry them).
import { useContext } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { iconFor } from './safe';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { EnvContext } from './blocks';
import type { Chrome, Tone } from './loom';
import { DOT, Mark, PressCard, type Ground, type Mode } from './views';
import { placesOf, settingsOf } from './nav';
import { useTint } from './tint';

const useEnv = () => useContext(EnvContext)!;

export function SheetView({ which, chrome, icon, mode, setMode, ground, setGround }: { which: string; chrome: Chrome; icon: (label: string) => string; mode: Mode; setMode: (m: Mode) => void; ground: Ground; setGround: (g: Ground) => void }) {
  const { go } = useEnv();
  const tint = useTint();
  const s = chrome.shell;
  // A launcher, as a phone's home screen (Jonathan, 2026-10-31: "we look like a phone os screen ... let's make both
  // screens a kind of click here to go to the place you want to go thing"): a tile in the dock's colours, its name
  // under it, a badge for what's waiting, and the piece's own word (22 in progress) small beneath. Its colour is the
  // app's own (tint.ts), not its place in the grid, so installing a piece moves no other tile's colour.
  const launch = (p: { label: string; href: string; stat?: string; tone?: Tone; count?: number }) => (
    <button key={p.href} type="button" onClick={() => go(p.href)} className="loom-launch group grid min-w-0 content-start justify-items-center gap-1.5 text-center">
      <span className="loom-launch-tile relative grid size-16 place-items-center rounded-[22%] shadow-sm transition-transform group-active:scale-95" data-tint={tint(p.label)}>
        <AnimatedIcon name={iconFor(icon(p.label))} />
        {p.count ? <span className="absolute -right-1.5 -top-1.5 grid min-w-5 place-items-center rounded-full bg-[var(--v-red,#e5484d)] px-1.5 text-[11px] font-semibold text-white">{p.count}</span> : null}
        {p.tone && p.tone !== 'ok' && <span className={`absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-[var(--v-paper)] ${DOT[p.tone]}`} />}
      </span>
      <span className="w-full truncate text-sm font-medium">{p.label}</span>
      {p.stat && <span className="-mt-1 w-full truncate text-[11px] opacity-60">{p.stat}</span>}
    </button>
  );
  const grid = (items: Array<{ label: string; href: string; stat?: string; tone?: Tone; count?: number }>) => (
    <div className="grid grid-cols-4 gap-x-3 gap-y-6 sm:grid-cols-6">{items.map((p) => launch(p))}</div>
  );
  // Places: the apps, where you go regularly (Activity, Knowledge, People, Tasks, …). The Inbox has its own tab.
  if (which === 'places' && s) return grid(placesOf(s));
  // Setup: the household's configuration (the pieces that are settings, its members, its pieces), then Appearance, this
  // device's look: all tiles, nothing loose under them (Jonathan, 2026-11-03: a page that mixes icons with loose controls
  // is wrong). What's the member's own (passkeys, signing out) is the account's: the avatar on a phone's dock.
  if (which === 'setup' && s) return grid(settingsOf(s));
  // Appearance: an app of Setup's, this device's look.
  if (which === 'appearance') return <AppearanceApp mode={mode} setMode={setMode} ground={ground} setGround={setGround} />;
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

/** The Appearance app: light or dark, and the ground behind every page. Kept in this browser. */
function AppearanceApp({ mode, setMode, ground, setGround }: { mode: Mode; setMode: (m: Mode) => void; ground: Ground; setGround: (g: Ground) => void }) {
  const row = (label: string, hint: string, control: React.ReactNode) => (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0">
      <span className="grid min-w-0 leading-tight"><span className="font-medium">{label}</span><span className="text-sm opacity-70">{hint}</span></span>
      {control}
    </div>
  );
  return (
    <Card id="appearance">
      <CardContent className="grid divide-y">
        {row('Light or dark', 'Auto follows this device.', <Appearance mode={mode} setMode={setMode} />)}
        {row('Background', 'What’s behind every page.', (
          <ToggleGroup type="single" className="v-seg" aria-label="Background" value={ground} onValueChange={(g) => { if (g) setGround(g as Ground); }}>
            {([['depth', 'Depth'], ['contours', 'Contours'], ['wash', 'Wash']] as const).map(([g, l]) => <ToggleGroupItem key={g} value={g}>{l}</ToggleGroupItem>)}</ToggleGroup>
        ))}
        <p className="pt-3 text-sm opacity-60">Kept on this device: another phone or browser keeps its own.</p>
      </CardContent>
    </Card>
  );
}
