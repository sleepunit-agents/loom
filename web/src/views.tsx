// The kinds of page that aren't a piece's Page (src/ui/handler.ts views): the household's home, an agent's
// Today, the Inbox, and the Places, Setup, Find and Scope sheets. Same data the classic page draws.
import { useContext, useState } from 'react';
import { AgentState } from '@/components/ui/agent-state';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { iconFor } from './safe';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { ActButton, BlockView, EnvContext, Link, type Env } from './blocks';
import type { Button as Btn, Chrome, Source, Tone } from './loom';

type Reading = { label: string; value: string; detail?: string; tone?: Tone; page?: string; source?: Source };
type AgentCard = { id: string; label: string; bg: string; fg: string; state?: 'working' | 'available' | 'unavailable' | 'broken'; reason?: string; readings?: Reading[] };
type Tile = { label: string; value: string; detail?: string; tone?: Tone; page?: string; source: Source };
type Ask = { text: string; meta?: string; page?: string; label?: string; tone?: Tone; at?: string; agent?: string; actions?: Btn[]; kind?: string; source: Source; sourceLabel?: string };
type ThreadRow = { text: string; meta?: string; at?: string; page?: string };
export type Mode = 'auto' | 'light' | 'dark';

const useEnv = () => useContext(EnvContext)!;
const STATE: Record<string, { status: 'working' | 'idle' | 'needs-input' | 'error'; word: string }> = {
  working: { status: 'working', word: 'Working' }, available: { status: 'idle', word: 'Available' },
  unavailable: { status: 'needs-input', word: 'Unavailable' }, broken: { status: 'error', word: 'Broken' },
};
const DOT: Record<Tone, string> = { ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', muted: 'bg-neutral-400' };

/** The same blocks, but links and actions go to another source (a tile's piece, an ask's piece). */
function As({ source, children }: { source: Source; children: React.ReactNode }) {
  const env = useEnv();
  return <EnvContext.Provider value={env.withSource(source)}>{children}</EnvContext.Provider>;
}

const Mark = ({ a, size = 40 }: { a: { label: string; bg: string; fg: string }; size?: number }) => (
  <span className="grid shrink-0 place-items-center rounded-2xl font-semibold" style={{ background: a.bg, color: a.fg, width: size, height: size, fontSize: size * 0.42 }}>{a.label[0]}</span>
);

// ---- the household's home ----------------------------------------------------------------------

export function HouseHomeView({ home }: { home: { headline: string; needs: number; firstNeed?: string; cards: AgentCard[]; moving: { agent?: string; text: string; meta?: string }[] } }) {
  const { go } = useEnv();
  return (
    <div className="grid gap-4">
      <h2 className="text-2xl font-semibold">{home.headline}</h2>
      {home.needs > 0 && (
        <button className="flex items-center gap-3 rounded-3xl border p-4 text-left" onClick={() => go('/inbox')}>
          <AgentState status="needs-input" size="sm" />
          <span className="min-w-0 flex-1"><span className="block font-medium">{home.firstNeed ?? `${home.needs} need${home.needs === 1 ? 's' : ''} you`}</span>
            <span className="block text-sm opacity-70">In the Inbox</span></span>
          <AnimatedIcon name={iconFor("chevron-right")} size="sm" />
        </button>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {home.cards.map((c) => (
          <Card key={c.id} className="cursor-pointer" onClick={() => go(`/a/${c.id}`)}>
            <CardHeader className="flex flex-row items-center gap-3">
              <Mark a={c} />
              <div className="min-w-0 flex-1"><CardTitle>{c.label}</CardTitle>{c.reason && <p className="truncate text-sm opacity-70">{c.reason}</p>}</div>
              {c.state && <AgentState status={STATE[c.state].status} size="sm" label={STATE[c.state].word} />}
            </CardHeader>
            {c.readings && c.readings.length > 0 && (
              <CardContent>
                <dl className="grid min-w-0 gap-1.5 text-sm">{c.readings.map((r) => (
                  <div key={r.label} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-3">
                    <dt className="flex items-center gap-2 opacity-70">{r.tone && <span className={`size-2 shrink-0 rounded-full ${DOT[r.tone]}`} />}{r.label}</dt>
                    <dd className="min-w-0 truncate text-right">{r.value}</dd>
                  </div>))}</dl>
              </CardContent>
            )}
          </Card>
        ))}
      </div>
      {home.moving.length > 0 && (
        <Card><CardHeader><CardTitle>What's moving</CardTitle></CardHeader>
          <CardContent><ul className="divide-y">{home.moving.map((m, n) => (
            <li key={n} className="py-2.5"><span className="block">{m.text}</span><span className="block text-sm opacity-70">{[m.agent, m.meta].filter(Boolean).join(' · ')}</span></li>))}</ul></CardContent>
        </Card>
      )}
    </div>
  );
}

// ---- an agent's Today (and a lone agent's Home) ------------------------------------------------

function Asks({ asks }: { asks: Ask[] }) {
  if (!asks.length) return null;
  return (
    <div className="grid gap-3">{asks.map((a, n) => (
      <As key={n} source={a.source}>
        <Card className={a.tone === 'bad' ? 'ring-1 ring-red-400' : 'ring-1 ring-amber-300'}>
          <CardContent className="grid gap-2 py-4">
            <p className="text-xs opacity-60">{a.sourceLabel ?? a.source.id}</p>
            <Link page={a.page} className="font-medium no-underline hover:underline">{a.text}</Link>
            {a.meta && <p className="text-sm opacity-70">{a.meta}</p>}
            {a.actions && <div className="flex flex-wrap gap-2">{a.actions.map((b) => <ActButton key={b.action + b.label} b={b} />)}</div>}
          </CardContent>
        </Card>
      </As>))}
    </div>
  );
}

function Tiles({ tiles }: { tiles: Tile[] }) {
  if (!tiles.length) return null;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{tiles.map((t) => (
      <As key={t.source.id + t.label} source={t.source}>
        <Link page={t.page} className="grid gap-0.5 rounded-3xl border p-4 no-underline hover:border-current">
          <span className="flex items-center gap-2 text-xs opacity-60">{t.tone && <span className={`size-2 rounded-full ${DOT[t.tone]}`} />}{t.label}</span>
          <span className="text-xl font-semibold">{t.value}</span>
          {t.detail && <span className="line-clamp-2 text-xs opacity-60">{t.detail}</span>}
        </Link>
      </As>))}
    </div>
  );
}

export function DashboardView({ d, now }: { d: { label: string; title?: string; asks: Ask[]; tiles: Tile[]; thread: ThreadRow[]; inbox?: { count: number; first?: string }; sinceMs?: number; sinceLabel?: string; filters?: { param: string; options: { value: string; label: string }[] } }; now: number }) {
  const { go } = useEnv();
  return (
    <div className="grid gap-4">
      {d.inbox && d.inbox.count > 0 && (
        <Button variant="secondary" className="justify-start" onClick={() => go('/inbox')}>{d.inbox.first ?? `${d.inbox.count} in the Inbox`}</Button>
      )}
      {d.filters && <BlockView b={{ type: 'filters', ...d.filters }} />}
      <Asks asks={d.asks} />
      <Tiles tiles={d.tiles} />
      {d.thread.length > 0 && (
        <Card><CardHeader><CardTitle>{d.title ?? 'Thread'}</CardTitle></CardHeader>
          <CardContent><ol className="relative grid gap-0 border-l pl-4">{d.thread.map((r, n) => {
            const fresh = d.sinceMs && r.at && Date.parse(r.at) > d.sinceMs;
            return (
              <li key={n} className="relative py-2.5">
                <span className={`absolute -left-[21px] top-4 size-2.5 rounded-full ${fresh ? 'bg-[var(--loom-accent,#16a34a)]' : 'bg-neutral-300 dark:bg-neutral-600'}`} />
                <Link page={r.page} className="block no-underline hover:underline">{r.text}</Link>
                {r.meta && <span className="block text-xs opacity-60">{r.meta}</span>}
              </li>);
          })}</ol>{void now}</CardContent>
        </Card>
      )}
    </div>
  );
}

// ---- the Inbox ---------------------------------------------------------------------------------

type InboxItem = { key: string; kind: 'permission' | 'decision' | 'reply' | 'fyi' | 'answered'; attention: boolean; unread: boolean; text: string; meta?: string; at?: string; agent?: string; source: Source; sourceLabel?: string; page?: string; label?: string; actions?: Btn[]; outcome?: string };
const KIND: Record<InboxItem['kind'], string> = { permission: 'Permission', decision: 'Decision', reply: 'Reply', fyi: 'FYI', answered: 'Answered' };

export function InboxView({ items, folder, chrome }: { items: InboxItem[]; folder: string; chrome: Chrome }) {
  const { go, ctx } = useEnv();
  const [open, setOpen] = useState<InboxItem | null>(null);
  const agents = ctx.agents ?? {};
  const need = items.filter((i) => i.attention);
  const rest = items.filter((i) => !i.attention);
  const row = (i: InboxItem) => (
    <li key={i.key}>
      <button className="flex w-full min-w-0 items-start gap-3 py-3 text-left" onClick={() => setOpen(i)}>
        {i.agent && agents[i.agent] ? <Mark a={agents[i.agent]} size={28} /> : <span className="size-7" />}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">{i.unread && <span className="size-2 shrink-0 rounded-full bg-[var(--loom-accent,#2563eb)]" />}
            <span className={`truncate ${i.unread ? 'font-semibold' : 'font-medium'}`}>{i.text}</span></span>
          <span className="block truncate text-sm opacity-70">{i.outcome ?? i.meta ?? ''}</span>
        </span>
        <Badge variant={i.attention ? 'pending' : 'default'}>{KIND[i.kind]}</Badge>
      </button>
    </li>
  );
  return (
    <div className="grid gap-4">
      <div className="flex gap-2">{[['needs', 'Needs you'], ['all', 'Everything']].map(([f, l]) => (
        <Button key={f} size="sm" variant={folder === f ? 'default' : 'outline'} onClick={() => go(`/inbox${f === 'needs' ? '' : `?folder=${f}`}`)}>{l}</Button>))}</div>
      {need.length > 0 && <Card><CardHeader><CardTitle>Needs you · {need.length}</CardTitle></CardHeader><CardContent><ul className="divide-y">{need.map(row)}</ul></CardContent></Card>}
      {need.length === 0 && <p className="opacity-70">Nothing needs you.</p>}
      {rest.length > 0 && <Card><CardHeader><CardTitle>Lately</CardTitle></CardHeader><CardContent><ul className="divide-y">{rest.map(row)}</ul></CardContent></Card>}
      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        {open && (
          <DrawerContent className="lg:mx-auto lg:max-w-xl">
            <DrawerHeader><DrawerTitle>{open.text}</DrawerTitle><DrawerDescription>{[open.sourceLabel ?? open.source.id, open.agent].filter(Boolean).join(' · ')}</DrawerDescription></DrawerHeader>
            {open.meta && <p className="text-sm">{open.meta}</p>}
            {open.outcome && <p className="text-sm opacity-80">{open.outcome}</p>}
            <As source={open.source}>
              <div className="grid gap-2">
                {open.actions?.map((b) => <ActButton key={b.action + b.label} b={b} size="default" full onDone={() => setOpen(null)} />)}
                {open.page !== undefined && <Link page={open.page} className="text-center underline underline-offset-4">{open.label ?? 'Open it'}</Link>}
              </div>
            </As>
          </DrawerContent>
        )}
      </Drawer>
      {void chrome}
    </div>
  );
}

// ---- sheets: Places, Setup, Find, Scope --------------------------------------------------------

export function SheetView({ which, chrome, q, found, mode, setMode }: { which: string; chrome: Chrome; q: string; found?: Record<string, { label: string; href: string; agent?: string }[]>; mode: Mode; setMode: (m: Mode) => void }) {
  const { go } = useEnv();
  const s = chrome.shell;
  const [query, setQuery] = useState(q);
  const tile = (p: { label: string; href: string; stat?: string; tone?: Tone; count?: number }) => (
    <button key={p.href} className="grid gap-1 rounded-3xl border p-4 text-left" onClick={() => go(p.href)}>
      <span className="flex items-center gap-2"><AnimatedIcon name={iconFor(ICONS[p.label] ?? 'circle')} />{p.tone && <span className={`size-2 rounded-full ${DOT[p.tone]}`} />}</span>
      <span className="font-medium">{p.label}</span>
      {(p.stat ?? p.count) !== undefined && <span className="text-sm opacity-70">{p.stat ?? p.count}</span>}
    </button>
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
          <CardContent><Appearance mode={mode} setMode={setMode} /></CardContent></Card>
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
        {found && !goTo.length && groups.every(([k]) => !found[k]?.length) && <p className="opacity-70">Nothing found for “{q}”.</p>}
      </div>
    );
  }
  if (which === 'scope' && s) {
    return (
      <div className="grid gap-3">
        <button className="flex items-center gap-3 rounded-3xl border p-4 text-left" onClick={() => go('/')}><AnimatedIcon name={iconFor("house")} /><span className="font-medium">The household</span></button>
        {s.agents.map((a) => (
          <button key={a.id} className="flex items-center gap-3 rounded-3xl border p-4 text-left" onClick={() => go(a.href)}>
            <Mark a={a} /><span className="min-w-0 flex-1"><span className="block font-medium">{a.label}</span>{a.sub && <span className="block text-sm opacity-70">{a.sub}</span>}</span>
            {a.asks ? <Badge variant="pending">{a.asks}</Badge> : null}
          </button>))}
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
export type { Env };
