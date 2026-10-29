// The kinds of page that aren't a piece's Page (src/ui/handler.ts views): the household's home, an agent's
// Today, the Inbox, and the Places, Setup, Find and Scope sheets. Same data the classic page draws.
import { useContext, useState, lazy, Suspense } from 'react';
import { AgentState } from '@/components/ui/agent-state';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { iconFor } from './safe';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Arrive } from './arrive';
import { Spinner } from '@/components/ui/spinner';
// The activity feed loads on its own (it and its motion are heavy); the first page doesn't wait for it.
const ActivityFeed = lazy(() => import('@/components/ui/activity-feed').then((m) => ({ default: m.ActivityFeed })));
import { ActButton, BlockView, EnvContext, Link, Nothing, type Env } from './blocks';
import type { Button as Btn, Chrome, Source, Tone } from './loom';

type Reading = { label: string; value: string; detail?: string; tone?: Tone; page?: string; source?: Source };
type Doing = { text: string; kind?: 'talk' | 'lane' | 'task' | 'session' | 'other'; where?: string; since?: string; page?: string; source: Source };
type AgentCard = { id: string; label: string; bg: string; fg: string; state?: 'working' | 'available' | 'unavailable' | 'broken'; reason?: string; readings?: Reading[];
  doing?: Doing[]; problems?: { text: string; tone: 'bad' | 'warn'; source: Source; page?: string }[]; seen?: { at: string; where: string } };

const DOING_ICON: Record<string, string> = { talk: 'message-circle', lane: 'route', task: 'hammer', session: 'terminal', other: 'sparkles' };
const ago = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/**
 * An agent at a glance, as 000h's identity card (Jonathan, 2026-10-29: "are they up, are they working, what's
 * happening, but that's it"): its mark with its state on it, a line saying how it is, its name, what it's on, and
 * each thing it has going (a conversation, a lane, a task, a session), simply. Trouble shows only when there is some.
 * The details are a tap away.
 */
function AgentIdentity({ c }: { c: AgentCard }) {
  const { go } = useEnv();
  const doing = c.doing ?? [];
  const problems = c.problems ?? [];
  const state = c.state ?? 'available';
  const eyebrow = problems.length ? (state === 'broken' ? 'Something’s broken' : 'Needs a look')
    : state === 'working' || doing.length ? `Working${doing.length > 1 ? ` · ${doing.length} things` : ''}`
    : state === 'unavailable' ? 'Unavailable' : 'Up · quiet';
  return (
    <Card className="loom-identity cursor-pointer gap-0 p-0" onClick={() => go(`/a/${c.id}`)}>
      <div className="flex items-center gap-4 p-5">
        <span className="relative shrink-0">
          <span className="grid size-16 place-items-center rounded-full font-[family-name:var(--font-display)] text-2xl font-semibold"
            style={{ background: c.bg, color: c.fg, boxShadow: `0 0 0 3px var(--v-paper), 0 0 0 5px color-mix(in oklab, ${c.bg} 55%, transparent)` }}>{c.label[0]}</span>
          <span role="img" aria-label={STATE[state].word} className={`loom-dot absolute bottom-0.5 right-0.5 size-4 rounded-full border-[3px] border-[var(--v-paper)] ${state === 'working' ? 'bg-sky-500 loom-dot-live' : state === 'broken' ? 'bg-red-500' : state === 'unavailable' ? 'bg-amber-500' : 'bg-emerald-500'}`} />
        </span>
        <div className="min-w-0 flex-1">
          <Arrive as="p" k={`eb:${c.id}\0${eyebrow}`} className={`text-[11px] font-semibold uppercase tracking-[.08em] ${problems.length ? 'text-[color:var(--v-danger-fill,#b42c22)]' : 'opacity-60'}`}>{eyebrow}</Arrive>
          <h3 className="truncate font-[family-name:var(--font-display)] text-2xl font-semibold leading-tight">{c.label}</h3>
          {c.reason && !doing.length && <Arrive as="p" k={`why:${c.id}\0${c.reason}`} className="truncate text-sm opacity-70">{c.reason}</Arrive>}
        </div>
      </div>
      {(doing.length > 0 || problems.length > 0) && (
        <ul className="grid gap-0.5 px-3 pb-3">
          {problems.map((p) => (
            <Arrive as="li" key={`p:${p.text}`} k={`pb:${c.id}\0${p.text}`} className={`flex min-w-0 items-center gap-3 rounded-xl px-2 py-2 text-sm ${p.tone === 'bad' ? 'bg-red-500/10' : 'bg-amber-500/10'}`}>
              <AnimatedIcon name={iconFor('triangle-alert')} size="sm" /><span className="min-w-0 flex-1 truncate font-medium">{p.text}</span>
            </Arrive>))}
          {doing.map((d, n) => (
            <Arrive as="li" key={n} k={`do:${c.id}\0${d.text}\0${d.where ?? ''}`} className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-2 text-sm">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg" style={{ background: `color-mix(in oklab, ${c.bg} 22%, transparent)` }}>
                <AnimatedIcon name={iconFor(DOING_ICON[d.kind ?? 'other'])} size="sm" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{d.text}</span>
                {(d.where || d.since) && <span className="block truncate text-xs opacity-60">{[d.where, d.since ? ago(d.since) : ''].filter(Boolean).join(' · ')}</span>}</span>
            </Arrive>))}
        </ul>
      )}
      <div className="flex items-center gap-2 border-t px-5 py-3 text-sm">
        <span className="font-medium">Open {c.label}</span><AnimatedIcon name={iconFor('chevron-right')} size="sm" />
        {c.seen && <span className="ml-auto truncate text-xs opacity-60">seen {ago(c.seen.at)}{c.seen.where ? ` · ${c.seen.where}` : ''}</span>}
      </div>
    </Card>
  );
}
type Tile = { label: string; value: string; detail?: string; tone?: Tone; page?: string; source: Source };
type Ask = { text: string; meta?: string; page?: string; label?: string; tone?: Tone; at?: string; agent?: string; actions?: Btn[]; kind?: string; source: Source; sourceLabel?: string };
type ThreadRow = { agent?: string; text: string; meta?: string; at?: string; page?: string };
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
      {home.cards.length === 0 && <Nothing title="No agents yet" text="An agent is who does the work here. Make the first one.">
        <Button className="mt-2" onClick={() => go('/new-agent')}>New agent</Button></Nothing>}
      <div className="grid items-start gap-4 md:grid-cols-2">
        {home.cards.map((c) => <AgentIdentity key={c.id} c={c} />)}
      </div>
    </div>
  );
}

// ---- an agent's Today (and a lone agent's Home) ------------------------------------------------

function Asks({ asks }: { asks: Ask[] }) {
  if (!asks.length) return null;
  return (
    <div className="grid gap-3">{asks.map((a, n) => (
      <As key={n} source={a.source}><Arrive k={`ask:${a.source.id}\0${a.text}`} className="rounded-3xl">
        <Card className={a.tone === 'bad' ? 'ring-1 ring-red-400' : 'ring-1 ring-amber-300'}>
          <CardContent className="grid gap-2 py-4">
            <p className="text-xs opacity-60">{a.sourceLabel ?? a.source.id}</p>
            <Link page={a.page} className="font-medium no-underline hover:underline">{a.text}</Link>
            {a.meta && <p className="text-sm opacity-70">{a.meta}</p>}
            {a.actions && <div className="flex flex-wrap gap-2">{a.actions.map((b) => <ActButton key={b.action + b.label} b={b} />)}</div>}
          </CardContent>
        </Card>
      </Arrive></As>))}
    </div>
  );
}

function Tiles({ tiles }: { tiles: Tile[] }) {
  if (!tiles.length) return null;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{tiles.map((t) => (
      <As key={t.source.id + t.label} source={t.source}>
        <Arrive k={`tile:${t.source.id}\0${t.label}\0${t.value}`} className="rounded-3xl"><Link page={t.page} className="grid gap-0.5 rounded-3xl border p-4 no-underline hover:border-current">
          <span className="flex items-center gap-2 text-xs opacity-60">{t.tone && <span className={`size-2 rounded-full ${DOT[t.tone]}`} />}{t.label}</span>
          <span className="text-xl font-semibold">{t.value}</span>
          {t.detail && <span className="line-clamp-2 text-xs opacity-60">{t.detail}</span>}
        </Link></Arrive>
      </As>))}
    </div>
  );
}

export function DashboardView({ d, now }: { d: { label: string; title?: string; asks: Ask[]; tiles: Tile[]; thread: ThreadRow[]; inbox?: { count: number; first?: string }; sinceMs?: number; sinceLabel?: string; filters?: { param: string; options: { value: string; label: string }[] } }; now: number }) {
  const { go, ctx } = useEnv();
  return (
    <div className="grid gap-4">
      {d.inbox && d.inbox.count > 0 && (
        <Button variant="secondary" className="justify-start" onClick={() => go('/inbox')}>{d.inbox.first ?? `${d.inbox.count} in the Inbox`}</Button>
      )}
      {d.filters && <BlockView b={{ type: 'filters', ...d.filters }} />}
      <Asks asks={d.asks} />
      <Tiles tiles={d.tiles} />
      {/* The thread as 000h's activity feed (its living-thread look): newest first, a page at a time. */}
      <div className="min-w-0">
        <Suspense fallback={<div className="grid place-items-center py-8"><Spinner appearance="orbit" /></div>}>
        <ActivityFeed variant="thread" title={d.title ?? 'Thread'} initialVisible={12} pageSize={12} showMoreLabel="Earlier"
          empty={<Nothing title="Quiet" text="Nothing on the thread yet today." />}
          entries={d.thread.map((r) => ({
            id: `${r.at}\0${r.text}`,
            title: <Arrive as="span" k={`th:${r.at}\0${r.text}`}><Link page={r.page} className="no-underline hover:underline">{r.text}</Link></Arrive>,
            description: r.meta,
            ...(r.agent && ctx.agents?.[r.agent] ? { actor: { name: ctx.agents[r.agent].label, initials: ctx.agents[r.agent].label[0] } } : {}),
            ...(r.at ? { dateTime: r.at } : {}),   // its age is already in the meta line
          }))} />
        </Suspense>
        {void now}
      </div>
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
    <Arrive as="li" key={i.key} k={`in:${i.key}\0${i.kind}`}>
      <button className="flex w-full min-w-0 items-start gap-3 py-3 text-left" onClick={() => setOpen(i)}>
        {i.agent && agents[i.agent] ? <Mark a={agents[i.agent]} size={28} /> : <span className="size-7" />}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">{i.unread && <span className="size-2 shrink-0 rounded-full bg-[var(--loom-accent,#2563eb)]" />}
            <span className={`truncate ${i.unread ? 'font-semibold' : 'font-medium'}`}>{i.text}</span></span>
          <span className="block truncate text-sm opacity-70">{i.outcome ?? i.meta ?? ''}</span>
        </span>
        <Badge variant={i.attention ? 'pending' : 'default'}>{KIND[i.kind]}</Badge>
      </button>
    </Arrive>
  );
  return (
    <div className="grid gap-4">
      <div className="flex gap-2">{[['needs', 'Needs you'], ['all', 'Everything']].map(([f, l]) => (
        <Button key={f} size="sm" variant={folder === f ? 'default' : 'outline'} onClick={() => go(`/inbox${f === 'needs' ? '' : `?folder=${f}`}`)}>{l}</Button>))}</div>
      {need.length > 0 && <Card><CardHeader><CardTitle>Needs you · {need.length}</CardTitle></CardHeader><CardContent><ul className="divide-y">{need.map(row)}</ul></CardContent></Card>}
      {need.length === 0 && <Nothing title="Nothing needs you" text="Asks from your agents land here." />}
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

export function SheetView({ which, chrome, q, found, mode, setMode, ground, setGround }: { which: string; chrome: Chrome; q: string; found?: Record<string, { label: string; href: string; agent?: string }[]>; mode: Mode; setMode: (m: Mode) => void; ground: 'contours' | 'wash'; setGround: (g: 'contours' | 'wash') => void }) {
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
          <CardContent className="grid gap-4"><Appearance mode={mode} setMode={setMode} />
            <div className="grid gap-2"><p className="text-sm opacity-70">Background</p>
              <div className="flex gap-2" role="radiogroup" aria-label="Background">{([['contours', 'Contours'], ['wash', 'Wash']] as const).map(([g, l]) => (
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
