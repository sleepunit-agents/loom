// The kinds of page that aren't a piece's Page (src/ui/handler.ts views): the household's home, an agent's
// Today, the Inbox, and the Places, Setup, Find and Scope sheets. Same data the classic page draws.
import { useContext, lazy, Suspense } from 'react';
import { AgentState } from '@/components/ui/agent-state';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { iconFor } from './safe';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Arrive } from './arrive';
import { Spinner } from '@/components/ui/spinner';
// The activity feed loads on its own (it and its motion are heavy); the first page doesn't wait for it.
const ActivityFeed = lazy(() => import('@/components/ui/activity-feed').then((m) => ({ default: m.ActivityFeed })));
import { ActButton, AgentAvatar, BlockView, EnvContext, Link, Nothing, type Env } from './blocks';
import type { Button as Btn, Source, Tone } from './loom';

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
          <AgentAvatar a={c} size={64} shape="circle" style={{ boxShadow: `0 0 0 3px var(--v-paper), 0 0 0 5px color-mix(in oklab, ${c.bg} 55%, transparent)` }} />
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
/** The page's ground (ground.tsx): the contour field, the depth background's contours, or the plain wash. */
export type Ground = 'contours' | 'depth' | 'wash';

const useEnv = () => useContext(EnvContext)!;
const STATE: Record<string, { status: 'working' | 'idle' | 'needs-input' | 'error'; word: string }> = {
  working: { status: 'working', word: 'Working' }, available: { status: 'idle', word: 'Available' },
  unavailable: { status: 'needs-input', word: 'Unavailable' }, broken: { status: 'error', word: 'Broken' },
};
export const DOT: Record<Tone, string> = { ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', muted: 'bg-neutral-400' };

/** The same blocks, but links and actions go to another source (a tile's piece, an ask's piece). */
export function As({ source, children }: { source: Source; children: React.ReactNode }) {
  const env = useEnv();
  return <EnvContext.Provider value={env.withSource(source)}>{children}</EnvContext.Provider>;
}

/** An agent's mark: 000h's avatar (blocks.tsx AgentAvatar). */
export const Mark = ({ a, size = 40 }: { a: { label: string; bg: string; fg: string }; size?: number }) => <AgentAvatar a={a} size={size} className="shrink-0" />;

/** A box you can press (a place, a tile, a choice): 000h's card, lifting, the whole of it the button. */
export function PressCard({ onPress, className, children }: { onPress: () => void; className?: string; children: React.ReactNode }) {
  return <Card lift className="gap-0 p-0"><button type="button" className={`w-full rounded-[inherit] p-4 text-left ${className ?? ''}`} onClick={onPress}>{children}</button></Card>;
}

// ---- the household's home ----------------------------------------------------------------------

export function HouseHomeView({ home }: { home: { headline: string; needs: number; firstNeed?: string; cards: AgentCard[]; moving: { agent?: string; text: string; meta?: string }[] } }) {
  const { go } = useEnv();
  return (
    <div className="grid gap-4">
      <h2 className="text-2xl font-semibold">{home.headline}</h2>
      {home.needs > 0 && (
        <PressCard className="flex items-center gap-3" onPress={() => go('/inbox')}>
          <AgentState status="needs-input" size="sm" />
          <span className="min-w-0 flex-1"><span className="block font-medium">{home.firstNeed ?? `${home.needs} need${home.needs === 1 ? 's' : ''} you`}</span>
            <span className="block text-sm opacity-70">In the Inbox</span></span>
          <AnimatedIcon name={iconFor("chevron-right")} size="sm" />
        </PressCard>
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
        <Arrive k={`tile:${t.source.id}\0${t.label}\0${t.value}`} className="rounded-[var(--r-card)]"><Card lift className="gap-0 p-0"><Link page={t.page} className="grid gap-0.5 p-4 no-underline">
          <span className="flex items-center gap-2 text-xs opacity-60">{t.tone && <span className={`size-2 rounded-full ${DOT[t.tone]}`} />}{t.label}</span>
          <span className="text-xl font-semibold">{t.value}</span>
          {t.detail && <span className="line-clamp-2 text-xs opacity-60">{t.detail}</span>}
        </Link></Card></Arrive>
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


// ---- sheets: Places, Setup, Find, Scope --------------------------------------------------------

export type { Env };
