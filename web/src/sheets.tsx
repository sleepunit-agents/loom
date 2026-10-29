// The shell's sheets as pages (Scope, Places, Find, Setup), and the appearance choices: their own chunk, loaded when
// one opens (the first page doesn't carry them).
import { useContext, useState } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { iconFor } from './safe';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EnvContext, Nothing } from './blocks';
import type { Chrome, Tone } from './loom';
import { DOT, Mark, PressCard, type Ground, type Mode } from './views';

const useEnv = () => useContext(EnvContext)!;

export function SheetView({ which, chrome, q, found, mode, setMode, ground, setGround }: { which: string; chrome: Chrome; q: string; found?: Record<string, { label: string; href: string; agent?: string }[]>; mode: Mode; setMode: (m: Mode) => void; ground: Ground; setGround: (g: Ground) => void }) {
  const { go } = useEnv();
  const s = chrome.shell;
  const [query, setQuery] = useState(q);
  const tile = (p: { label: string; href: string; stat?: string; tone?: Tone; count?: number }) => (
    <PressCard key={p.href} className="grid gap-1" onPress={() => go(p.href)}>
      <span className="flex items-center gap-2"><AnimatedIcon name={iconFor(ICONS[p.label] ?? 'circle')} />{p.tone && <span className={`size-2 rounded-full ${DOT[p.tone]}`} />}</span>
      <span className="font-medium">{p.label}</span>
      {(p.stat ?? p.count) !== undefined && <span className="text-sm opacity-70">{p.stat ?? p.count}</span>}
    </PressCard>
  );
  if (which === 'places' && s) {
    return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{[...s.core, ...s.pieces.filter((p) => p.kind !== 'setting')].map(tile)}</div>;
  }
  if (which === 'setup' && s) {
    const admin = s.admin !== false;
    const own = [
      ...(admin ? [{ label: 'Members', href: '/members' }, { label: 'Pieces', href: '/pieces' }] : []),
      { label: 'Passkeys', href: '/passkeys' },
    ];
    return (
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{[...s.pieces.filter((p) => p.kind === 'setting'), ...own].map(tile)}</div>
        <Card><CardHeader><CardTitle>Appearance</CardTitle></CardHeader>
          <CardContent className="grid gap-4"><Appearance mode={mode} setMode={setMode} />
            <div className="grid gap-2"><p className="text-sm opacity-70">Background</p>
              <div className="flex gap-2" role="radiogroup" aria-label="Background">{([['contours', 'Contours'], ['depth', 'Depth'], ['wash', 'Wash']] as const).map(([g, l]) => (
                <Button key={g} role="radio" aria-checked={ground === g} size="sm" variant={ground === g ? 'default' : 'outline'} onClick={() => setGround(g)}>{l}</Button>))}</div></div>
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
    <div className="flex gap-2" role="radiogroup" aria-label="Appearance">{(['auto', 'light', 'dark'] as Mode[]).map((m) => (
      <Button key={m} role="radio" aria-checked={mode === m} size="sm" variant={mode === m ? 'default' : 'outline'} onClick={() => setMode(m)}>
        {m === 'auto' ? 'Auto' : m === 'light' ? 'Light' : 'Dark'}</Button>))}
    </div>
  );
}

const ICONS: Record<string, string> = {
  Knowledge: 'book-open', People: 'users', Mind: 'brain', Activity: 'activity', Bridges: 'messages-square', Clock: 'alarm-clock', Boxes: 'server',
  Subscriptions: 'credit-card', Secrets: 'key-round', Tasks: 'list-checks', Members: 'users-round', Pieces: 'puzzle', Passkeys: 'key-round', Machine: 'cpu',
};
