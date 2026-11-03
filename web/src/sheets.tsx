// The shell's sheets as pages (Scope, Places, Find, Setup), and the appearance choices: their own chunk, loaded when
// one opens (the first page doesn't carry them).
import { useContext, useState } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { iconFor } from './safe';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { EnvContext, Nothing } from './blocks';
import type { Chrome, Tone } from './loom';
import { DOT, Mark, PressCard, type Ground, type Mode } from './views';

const useEnv = () => useContext(EnvContext)!;

export function SheetView({ which, chrome, q, found, mode, setMode, ground, setGround }: { which: string; chrome: Chrome; q: string; found?: Record<string, { label: string; href: string; agent?: string }[]>; mode: Mode; setMode: (m: Mode) => void; ground: Ground; setGround: (g: Ground) => void }) {
  const { go } = useEnv();
  const s = chrome.shell;
  const [query, setQuery] = useState(q);
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
  // Places: where you go regularly (Activity, Knowledge, People, Tasks). The Inbox has its own tab.
  if (which === 'places' && s) {
    return grid([...s.core, ...s.pieces.filter((p) => p.kind !== 'setting')].filter((p) => p.href !== '/inbox'));
  }
  if (which === 'setup' && s) {
    const admin = s.admin !== false;
    const own = [
      ...(admin ? [{ label: 'Members', href: '/members' }, { label: 'Pieces', href: '/pieces' }] : []),
      { label: 'Passkeys', href: '/passkeys' },
    ];
    return (
      <div className="grid gap-4">
        {grid([...s.pieces.filter((p) => p.kind === 'setting'), ...own])}
        <Card><CardHeader><CardTitle>Appearance</CardTitle></CardHeader>
          <CardContent className="grid gap-4"><Appearance mode={mode} setMode={setMode} />
            <div className="grid gap-2"><p className="text-sm opacity-70">Background</p>
              <ToggleGroup type="single" className="v-seg" aria-label="Background" value={ground} onValueChange={(g) => { if (g) setGround(g as Ground); }}>
                {([['depth', 'Depth'], ['contours', 'Contours'], ['wash', 'Wash']] as const).map(([g, l]) => <ToggleGroupItem key={g} value={g}>{l}</ToggleGroupItem>)}</ToggleGroup></div>
          </CardContent></Card>
        <Card><CardContent className="grid gap-2 py-4">
          <form method="post" action="/logout"><input type="hidden" name="_csrf" value={chrome.csrf} /><Button type="submit" variant="ghost" className="w-full">Sign out</Button></form>
        </CardContent></Card>
      </div>
    );
  }
  if (which === 'find') {
    const groups: [string, string][] = [['do', 'Do'], ['knowledge', 'Knowledge'], ['people', 'People'], ['memories', 'Memories']];
    // Places whose name matches, as the classic Find sheet had them: loom's own, the pieces', the agents', and Setup's.
    const needle = q.trim().toLowerCase();
    const places = s ? [...s.core, ...s.pieces, ...s.agents.map((x) => ({ label: x.label, href: x.href })), { label: 'Setup', href: '/setup' }, { label: 'Passkeys', href: '/passkeys' },
      ...(s.admin ? [{ label: 'Members', href: '/members' }, { label: 'Manage pieces', href: '/pieces' }] : [])] : [];
    const goTo = needle ? places.filter((p, n) => p.label.toLowerCase().includes(needle) && places.findIndex((x) => x.href === p.href) === n) : [];
    return (
      <div className="grid gap-4">
        <form onSubmit={(e) => { e.preventDefault(); go(`/find?q=${encodeURIComponent(query)}`); }}>
          <Input autoFocus placeholder="Find anything" value={query} onChange={(e) => setQuery(e.target.value)} />
        </form>
        {goTo.length > 0 && (
          <Card><CardHeader><CardTitle>Go to</CardTitle></CardHeader>
            <CardContent><ul className="divide-y">{goTo.map((p) => (
              <li key={p.href}><button className="w-full py-2.5 text-left" onClick={() => go(p.href)}>{p.label}</button></li>))}</ul></CardContent></Card>
        )}
        {found && groups.map(([k, l]) => (found[k]?.length ? (
          <Card key={k}><CardHeader><CardTitle>{l}</CardTitle></CardHeader>
            <CardContent><ul className="divide-y">{found[k].map((f) => (
              <li key={f.href}><button className="w-full py-2.5 text-left" onClick={() => go(f.href)}>{f.label}{f.agent ? <span className="opacity-60"> · {f.agent}</span> : null}</button></li>))}</ul></CardContent></Card>
        ) : null))}
        {found && !goTo.length && groups.every(([k]) => !found[k]?.length) && <Nothing title={`Nothing found for “${q}”`} text="Try fewer words, or another name." />}
      </div>
    );
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

const ICONS: Record<string, string> = {
  Knowledge: 'book-open', People: 'users', Mind: 'brain', Activity: 'activity', Bridges: 'messages-square', Clock: 'alarm-clock', Boxes: 'server',
  Subscriptions: 'credit-card', Secrets: 'key-round', Tasks: 'list-checks', Members: 'users-round', Pieces: 'puzzle', Passkeys: 'fingerprint-pattern', Machine: 'cpu',
};
