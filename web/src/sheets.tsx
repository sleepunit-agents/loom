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
import { Mark, PressCard, type Ground, type Mode } from './views';
import { DOT } from './tones';
import { placesOf, settingsOf } from './nav';
import { useTint } from './tint';
import type { Look } from './look';

const useEnv = () => useContext(EnvContext)!;

export function SheetView({ which, chrome, icon, mode, setMode, ground, setGround, look, setLook, sound, setSound, pixel, setPixel, haptics, setHaptics, zoom, setZoom }: { which: string; chrome: Chrome; icon: (label: string) => string; mode: Mode; setMode: (m: Mode) => void; ground: Ground; setGround: (g: Ground) => void; look: Look; setLook: (l: Look) => void; sound: boolean; setSound: (on: boolean) => void; pixel: boolean; setPixel: (on: boolean) => void; haptics: boolean; setHaptics: (on: boolean) => void; zoom: boolean; setZoom: (on: boolean) => void }) {
  const { go } = useEnv();
  const tint = useTint();
  const s = chrome.shell;
  // A launcher, as a phone's home screen (Jonathan, 2026-10-31: "we look like a phone os screen ... let's make both
  // screens a kind of click here to go to the place you want to go thing"): a tile in the dock's colours, its name
  // under it, a badge for what's waiting, and the piece's own word (22 in progress) small beneath. Its colour is the
  // app's own (tint.ts), not its place in the grid, so installing a piece moves no other tile's colour.
  const launch = (p: { label: string; href: string; stat?: string; tone?: Tone; count?: number }) => (
    <button key={p.href} type="button" onClick={() => go(p.href)} className="loom-launch group grid min-w-0 content-start justify-items-center gap-1.5 text-center">
      <span className="loom-launch-tile relative grid size-16 place-items-center rounded-[var(--loom-r-launch)] shadow-sm transition-transform group-active:scale-95" data-tint={tint(p.label)}>
        <AnimatedIcon name={iconFor(icon(p.label))} />
        {p.count ? <span className="absolute -right-1.5 -top-1.5 grid min-w-5 place-items-center rounded-full loom-data bg-[var(--loom-count)] px-1.5 text-[11px] font-semibold text-[color:var(--loom-count-ink)]">{p.count}</span> : null}
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
  // Appearance: an app of Setup's, the person's look (look.ts).
  if (which === 'appearance') return <AppearanceApp mode={mode} setMode={setMode} ground={ground} setGround={setGround} look={look} setLook={setLook} sound={sound} setSound={setSound} pixel={pixel} setPixel={setPixel} haptics={haptics} setHaptics={setHaptics} zoom={zoom} setZoom={setZoom} sprites={!!s?.agents.some((a) => a.face?.sprite)} />;
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

/** The Appearance app: the look, light or dark (000h's), and the ground behind every page. The person's, on every device. */
function AppearanceApp({ mode, setMode, ground, setGround, look, setLook, sound, setSound, pixel, setPixel, haptics, setHaptics, zoom, setZoom, sprites }: { mode: Mode; setMode: (m: Mode) => void; ground: Ground; setGround: (g: Ground) => void; look: Look; setLook: (l: Look) => void; sound: boolean; setSound: (on: boolean) => void; pixel: boolean; setPixel: (on: boolean) => void; haptics: boolean; setHaptics: (on: boolean) => void; zoom: boolean; setZoom: (on: boolean) => void; sprites: boolean }) {
  const row = (label: string, hint: string, control: React.ReactNode) => (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0">
      <span className="grid min-w-0 leading-tight"><span className="font-medium">{label}</span><span className="text-sm opacity-70">{hint}</span></span>
      {control}
    </div>
  );
  return (
    <Card id="appearance">
      <CardContent className="grid divide-y">
        {row('Look', look === 'neon' ? 'Neon Noir is dark only. For a light page, choose 000h.' : '000h, light or dark.', (
          <ToggleGroup type="single" className="v-seg" aria-label="Look" value={look} onValueChange={(l) => { if (l) setLook(l as Look); }}>
            <ToggleGroupItem value="neon">Neon Noir</ToggleGroupItem><ToggleGroupItem value="000h">000h</ToggleGroupItem></ToggleGroup>
        ))}
        {look === '000h' && row('Light or dark', 'Auto follows this device.', <Appearance mode={mode} setMode={setMode} />)}
        {row('Background', 'What’s behind every page.', (
          <ToggleGroup type="single" className="v-seg" aria-label="Background" value={ground} onValueChange={(g) => { if (g) setGround(g as Ground); }}>
            {([['depth', 'Depth'], ['contours', 'Contours'], ['wash', 'Wash']] as const).map(([g, l]) => <ToggleGroupItem key={g} value={g}>{l}</ToggleGroupItem>)}</ToggleGroup>
        ))}
        {sprites && row('Pixel faces', 'An agent with a pixel portrait wears it; off, every agent has its drawn face.', (
          <ToggleGroup type="single" className="v-seg" aria-label="Pixel faces" value={pixel ? 'on' : 'off'} onValueChange={(v) => { if (v) setPixel(v === 'on'); }}>
            <ToggleGroupItem value="on">On</ToggleGroupItem><ToggleGroupItem value="off">Off</ToggleGroupItem></ToggleGroup>
        ))}
        {row('Sound', 'A chime when loom opens and when something you did lands. Off unless you turn it on.', (
          <ToggleGroup type="single" className="v-seg" aria-label="Sound" value={sound ? 'on' : 'off'} onValueChange={(v) => { if (v) setSound(v === 'on'); }}>
            <ToggleGroupItem value="off">Off</ToggleGroupItem><ToggleGroupItem value="on">On</ToggleGroupItem></ToggleGroup>
        ))}
        {row('Haptics', 'A light tick on a phone when you press a dock key, answer Yes or No, or swipe.', (
          <ToggleGroup type="single" className="v-seg" aria-label="Haptics" value={haptics ? 'on' : 'off'} onValueChange={(v) => { if (v) setHaptics(v === 'on'); }}>
            <ToggleGroupItem value="on">On</ToggleGroupItem><ToggleGroupItem value="off">Off</ToggleGroupItem></ToggleGroup>
        ))}
        {row('Allow zoom', 'Pinch or double-tap to zoom in on a phone. Off, loom holds still like an app.', (
          <ToggleGroup type="single" className="v-seg" aria-label="Allow zoom" value={zoom ? 'on' : 'off'} onValueChange={(v) => { if (v) setZoom(v === 'on'); }}>
            <ToggleGroupItem value="off">Off</ToggleGroupItem><ToggleGroupItem value="on">On</ToggleGroupItem></ToggleGroup>
        ))}
        <p className="loom-gestures-hint pb-3 text-sm opacity-70 lg:hidden">On a phone, swipe sideways to move between Home, Inbox, Places and More, and swipe up from the dock to Find.</p>
        <p className="pt-3 text-sm opacity-60">Yours on every device you sign in on.</p>
      </CardContent>
    </Card>
  );
}
