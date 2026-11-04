// The kinds of page that aren't a piece's Page (src/ui/handler.ts views): the household's home, an agent's
// Today, the Inbox, and the Places, Setup, Find and Scope sheets. Same data the classic page draws.
import { useContext, lazy, Suspense } from 'react';
import { Badge } from '@/components/ui/badge';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { iconFor } from './safe';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Arrive } from './arrive';
import { Spinner } from '@/components/ui/spinner';
// The activity feed loads on its own (it and its motion are heavy); the first page doesn't wait for it.
const Profile = lazy(() => import('./profile'));
const Ledger = lazy(() => import('./ledger'));
import { ActButton, AgentAvatar, BlockView, EnvContext, Link, LoomMark, Nothing, type Env } from './blocks';
import { DOT } from './tones';
import { markRead, pageHref, type Button as Btn, type Source, type Tone } from './loom';
import { openItem, plain } from './plain';
import { tidy } from './tidy';
import { hasDraft } from './drafts';
import { markColor } from './look';

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
    <Card className="loom-identity cursor-pointer gap-0 p-0" style={{ '--acc': markColor(c.bg) } as React.CSSProperties} onClick={() => go(`/a/${c.id}`)}>
      <div className="flex items-center gap-4 p-5">
        <span className="relative shrink-0">
          <AgentAvatar a={c} size={72} shape="circle" state={state === 'broken' || problems.length ? 'error' : state === 'working' || doing.length ? 'working' : 'idle'} style={{ boxShadow: `0 0 0 3px var(--v-paper), 0 0 0 5px color-mix(in oklab, ${markColor(c.bg)} 55%, transparent)` }} />
          <span role="img" aria-label={STATE[state].word} className={`loom-dot absolute bottom-0.5 right-0.5 size-4 rounded-full border-[3px] border-[var(--v-paper)] ${state === 'working' ? 'bg-[var(--loom-live)] loom-dot-live' : state === 'broken' ? 'bg-[var(--loom-bad)]' : state === 'unavailable' ? 'bg-[var(--loom-warn)]' : 'bg-[var(--loom-ok)]'}`} />
        </span>
        <div className="min-w-0 flex-1">
          <Arrive as="p" k={`eb:${c.id}\0${eyebrow}`} className={`text-[11px] font-semibold uppercase tracking-[.08em] ${problems.length ? 'text-[color:var(--v-danger-fill)]' : 'opacity-60'}`}>{eyebrow}</Arrive>
          <h3 className="truncate font-[family-name:var(--font-display)] text-2xl font-semibold leading-tight">{c.label}</h3>
          {c.reason && !doing.length && <Arrive as="p" k={`why:${c.id}\0${c.reason}`} className="line-clamp-2 break-words text-sm opacity-70">{c.reason}</Arrive>}
        </div>
      </div>
      {(doing.length > 0 || problems.length > 0) && (
        <ul className="grid gap-0.5 px-3 pb-3">
          {problems.map((p) => (
            <Arrive as="li" key={`p:${p.text}`} k={`pb:${c.id}\0${p.text}`} className={`flex min-w-0 items-center gap-3 rounded-xl px-2 py-2 text-sm ${p.tone === 'bad' ? 'bg-[color-mix(in_oklab,var(--loom-bad)_10%,transparent)]' : 'bg-[color-mix(in_oklab,var(--loom-warn)_10%,transparent)]'}`}>
              <AnimatedIcon name={iconFor('triangle-alert')} size="sm" /><span className="line-clamp-3 min-w-0 flex-1 break-words font-medium">{p.text}</span>
            </Arrive>))}
          {doing.map((d, n) => (
            <Arrive as="li" key={n} k={`do:${c.id}\0${d.text}\0${d.where ?? ''}`} className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-2 text-sm">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg" style={{ background: `color-mix(in oklab, ${c.bg} 22%, transparent)` }}>
                <AnimatedIcon name={iconFor(DOING_ICON[d.kind ?? 'other'])} size="sm" /></span>
              <span className="min-w-0 flex-1"><span className="line-clamp-3 break-words font-medium">{d.text}</span>
                {(d.where || d.since) && <span className="block truncate text-xs opacity-60">{d.where}{d.where && d.since ? ' · ' : ''}{d.since && <span className="loom-data">{ago(d.since)}</span>}</span>}</span>
            </Arrive>))}
        </ul>
      )}
      <div className="flex items-center gap-2 border-t px-5 py-3 text-sm">
        <span className="font-medium">Open {c.label}</span><AnimatedIcon name={iconFor('chevron-right')} size="sm" />
        {c.seen && <span className="ml-auto truncate text-xs opacity-60">seen <span className="loom-data">{ago(c.seen.at)}</span>{c.seen.where ? ` · ${c.seen.where}` : ''}</span>}
      </div>
    </Card>
  );
}
type Tile = { label: string; value: string; detail?: string; tone?: Tone; page?: string; source: Source };
type Ask = { text: string; meta?: string; page?: string; label?: string; tone?: Tone; at?: string; agent?: string; actions?: Btn[]; kind?: string; source: Source; sourceLabel?: string; approval?: Approval };
/** The approval a Needs you waits on, absorbed into it: that card's words and its Allow and Deny, posted to its piece. */
export type Approval = { text: string; meta?: string; actions: Btn[]; source: Source };
type ThreadRow = { agent?: string; text: string; meta?: string; where?: string; at?: string; page?: string };
export type Mode = 'auto' | 'light' | 'dark';
/** The page's ground (ground.tsx): the contour field, the depth background's contours, or the plain wash. */
export type Ground = 'contours' | 'depth' | 'wash';

const useEnv = () => useContext(EnvContext)!;
const STATE: Record<string, { status: 'working' | 'idle' | 'needs-input' | 'error'; word: string }> = {
  working: { status: 'working', word: 'Working' }, available: { status: 'idle', word: 'Available' },
  unavailable: { status: 'needs-input', word: 'Unavailable' }, broken: { status: 'error', word: 'Broken' },
};

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

export function HouseHomeView({ home }: { home: { headline: string; needs: number; need?: InboxItem; cards: AgentCard[]; moving: { agent?: string; text: string; meta?: string }[] } }) {
  const { go } = useEnv();
  const open = useOpenItem();
  return (
    <div className="grid gap-4">
      <h2 className="text-2xl font-semibold">{home.headline}</h2>
      {/* What needs you is its Inbox row (Jonathan, 2026-11-02: "effectively the same thing as that item's row"), under
          a small Needs you, and it opens as it does there: to the item, not to the Inbox. The rest are a tap away. */}
      {home.need && (
        <Card className="gap-0 px-4 py-3">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.08em]">
            <span className="size-2 rounded-full bg-[var(--loom-warn)]" />
            <span className="opacity-70">Needs you{home.needs > 1 ? ` · ${home.needs}` : ''}</span>
            {home.needs > 1 && <button type="button" className="ml-auto normal-case tracking-normal opacity-70 hover:opacity-100" onClick={() => go('/inbox')}>All in the Inbox</button>}
          </div>
          <ul className="min-w-0"><InboxRow i={home.need} onOpen={open} /></ul>
        </Card>
      )}
      {home.cards.length === 0 && <Nothing title="No agents yet" text="An agent is who does the work here. Make the first one.">
        <Button className="mt-2" onClick={() => go('/new-agent')}>New agent</Button></Nothing>}
      <div className="grid items-start gap-4 md:grid-cols-2">
        {home.cards.map((c) => <AgentIdentity key={c.id} c={c} />)}
      </div>
    </div>
  );
}

// ---- an Inbox item's row (the Inbox's, and Home's banner) ---------------------------------------

export type InboxItem = { key: string; kind: 'permission' | 'decision' | 'reply' | 'alert' | 'todo' | 'fyi' | 'answered'; attention: boolean; unread: boolean; text: string; meta?: string; at?: string; expires?: string; agent?: string; source: Source; sourceLabel?: string; page?: string; label?: string; actions?: Btn[]; outcome?: string;
  /** The exact thing it's about, outside loom (a pull request's URL); and a box to answer its agent in words (core's Needs you). */
  href?: string; reply?: { action: string; label: string; fields: Record<string, string> };
  /** A Needs you laid out (its text is the ask), and the approval it waits on. */
  needs?: { why?: string; if_yes?: string; if_no?: string; answers?: 'yes-no' | 'words'; refs: string[]; details: string }; approval?: Approval };
export const KIND: Record<InboxItem['kind'], string> = { permission: 'Permission', decision: 'Decision', reply: 'Reply', alert: 'Alert', todo: 'To do', fyi: 'FYI', answered: 'Answered' };

/** Opening an item (plain.ts opensTo): its own page when it has one; else its sheet, here (`sheet`, in the Inbox) or
 * in the Inbox (from anywhere else). */
export function useOpenItem(sheet?: (i: InboxItem) => void) {
  const { go, ctx } = useEnv();
  return (i: InboxItem) => void openItem(i, {
    read: (key) => markRead(key, ctx.csrf), page: (page) => go(pageHref(page, i.source)), go,
    ...(sheet ? { sheet: () => sheet({ ...i, unread: false }) } : {}),
  });
}

/** An item in a line: who (their mark, or loom's), what, why, and its kind. */
export function InboxRow({ i, onOpen }: { i: InboxItem; onOpen: (i: InboxItem) => void }) {
  const { ctx } = useEnv();
  const agents = ctx.agents ?? {};
  const name = (a?: string) => (a && agents[a]?.label) || (a ? a[0].toUpperCase() + a.slice(1) : '');
  const p = plain(i, name(i.agent));
  return (
    <Arrive as="li" k={`in:${i.key}\0${i.kind}`} className="min-w-0">
      <button className="flex w-full min-w-0 items-start gap-3 py-3 text-left" onClick={() => onOpen(i)}>
        {/* No agent behind it (an alert, a piece's own): loom's, said with its mark, never a gap. */}
        {i.agent && agents[i.agent] ? <Mark a={agents[i.agent]} size={28} /> : <LoomMark size={28} />}
        <span className="min-w-0 flex-1">
          {/* The whole title, mostly (Jonathan liked reading it): three lines before it's cut. */}
          <span className="flex min-w-0 items-start gap-2">{i.unread && <span className="mt-[0.45em] size-2 shrink-0 rounded-full bg-[var(--loom-accent,var(--loom-unread))]" />}
            <span className={`line-clamp-3 break-words ${i.unread ? 'font-semibold' : 'font-medium'}`}>{p.title}</span></span>
          {/* A quote (a memory's words, a reason) reads to three lines; the row opens it whole. */}
          {(p.why ?? i.outcome) && <span className="line-clamp-3 break-words text-sm opacity-70">{tidy(p.why ?? i.outcome ?? '')}</span>}
        </span>
        <span className="grid shrink-0 justify-items-end gap-1">
          <Badge variant={i.attention ? 'pending' : 'default'}>{p.ended ?? KIND[i.kind]}</Badge>
          {/* A reply typed in its sheet and not sent (drafts.ts): said here, so it isn't forgotten. */}
          {i.reply && i.attention && hasDraft(i.key) && <span className="text-xs font-medium text-[color:var(--v-pink-deep)]">Draft not sent</span>}
        </span>
      </button>
    </Arrive>
  );
}

// ---- an agent's Today (and a lone agent's Home) ------------------------------------------------

function Asks({ asks }: { asks: Ask[] }) {
  if (!asks.length) return null;
  return (
    <div className="grid gap-3">{asks.map((a, n) => (
      <As key={n} source={a.source}><Arrive k={`ask:${a.source.id}\0${a.text}`} className="rounded-3xl">
        <Card className={a.tone === 'bad' ? 'ring-1 ring-[var(--loom-ring-bad)]' : 'ring-1 ring-[var(--loom-ring-warn-soft)]'}>
          <CardContent className="grid gap-2 py-4">
            <p className="text-xs opacity-60">{a.sourceLabel ?? a.source.id}</p>
            <Link page={a.page} className="font-medium no-underline hover:underline">{a.text}</Link>
            {a.meta && <p className="text-sm opacity-70">{a.meta}</p>}
            {a.approval && <ApprovalBox a={a.approval} />}
            {a.actions && <div className="flex flex-wrap gap-2">{a.actions.map((b) => <ActButton key={b.action + b.label} b={b} />)}</div>}
          </CardContent>
        </Card>
      </Arrive></As>))}
    </div>
  );
}

/**
 * What Allow allows, beside Allow (security review, t-1778): an ask that absorbed an approval is the agent's words,
 * and an agent could word it innocently while the approval grants something else. So its Allow and Deny never stand
 * under the ask alone: always the approval's own words, whole (never cut), labelled as what you're allowing. With no
 * words to show, no buttons; the sheet's link is the way in.
 */
export function ApprovalBox({ a, size = 'sm', onDone }: { a: Approval; size?: 'sm' | 'default'; onDone?: () => void }) {
  const text = a.text?.trim();
  if (!text) return null;
  return (
    <section className="grid gap-1.5 rounded-2xl bg-[color:var(--v-beige)] p-3" aria-label="You're allowing">
      <h3 className="text-xs font-semibold uppercase tracking-wide opacity-60">You're allowing</h3>
      <p className="whitespace-pre-wrap break-words font-medium">{text}</p>
      {a.meta && <p className="whitespace-pre-wrap break-words text-sm opacity-70">{a.meta}</p>}
      <As source={a.source}><div className="flex flex-wrap gap-2 pt-1">{a.actions.map((b) => <ActButton key={b.action + b.label} b={b} size={size} onDone={onDone} />)}</div></As>
    </section>
  );
}

function Tiles({ tiles }: { tiles: Tile[] }) {
  if (!tiles.length) return null;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{tiles.map((t) => (
      <As key={t.source.id + t.label} source={t.source}>
        <Arrive k={`tile:${t.source.id}\0${t.label}\0${t.value}`} className="rounded-[var(--r-card)]"><Card lift className="gap-0 p-0"><Link page={t.page} className="grid gap-0.5 p-4 no-underline">
          <span className="flex items-center gap-2 text-xs opacity-60">{t.tone && <span className={`size-2 rounded-full ${DOT[t.tone]}`} />}{t.label}</span>
          <span className="loom-data text-xl font-semibold">{t.value}</span>
          {t.detail && <span className="line-clamp-3 break-words text-xs opacity-60">{t.detail}</span>}
        </Link></Card></Arrive>
      </As>))}
    </div>
  );
}

export function DashboardView({ d, now }: { d: { label: string; title?: string; agent?: import('./loom').AgentHead; asks: Ask[]; tiles: Tile[]; thread: ThreadRow[]; inbox?: { count: number; first?: string }; sinceMs?: number; sinceLabel?: string; filters?: { param: string; options: { value: string; label: string }[] } }; now: number }) {
  const { go } = useEnv();
  return (
    <div className="grid gap-4">
      {d.inbox && d.inbox.count > 0 && (
        <Button variant="secondary" className="justify-start" onClick={() => go('/inbox')}>{d.inbox.first ?? `${d.inbox.count} in the Inbox`}</Button>
      )}
      {d.filters && <BlockView b={{ type: 'filters', ...d.filters }} />}
      {/* An agent's Today opens on its profile (Jonathan, 2026-10-29: "lets do this to the agent pages too. we can merge
          the memory and clock and shit into it"): its colour, its identity's opening, how it is, and its tiles as stats. */}
      {d.agent?.id ? (
        <Suspense fallback={<div className="min-h-64" />}><Profile p={{
          type: 'profile', name: d.agent.label, agent: d.agent.id, ...(d.agent.bio ? { summary: d.agent.bio } : {}),
          badges: [d.agent.waiting ? `${d.agent.waiting} waiting on you` : 'Ready', ...(d.agent.active ? [d.agent.active] : [])],
          stats: [...(d.agent.today !== undefined ? [{ label: 'today', value: d.agent.today.toLocaleString() }] : []),
            ...d.tiles.slice(0, 3).map((t) => ({ label: t.label.toLowerCase(), value: t.value, detail: t.detail, page: t.page, source: t.source, tone: t.tone }))],
        }} /></Suspense>
      ) : null}
      <Asks asks={d.asks} />
      {!d.agent?.id && <Tiles tiles={d.tiles} />}
      {/* The thread as 000h's activity feed (its living-thread look): newest first, a page at a time. */}
      <div className="min-w-0">
        <Suspense fallback={<div className="grid place-items-center py-8"><Spinner appearance="orbit" /></div>}>
        <Ledger rows={d.thread} title={d.title ?? 'Thread'} now={now} />
        </Suspense>
      </div>
    </div>
  );
}

// ---- the Inbox ---------------------------------------------------------------------------------


// ---- sheets: Places, Setup, Find, Scope --------------------------------------------------------

export type { Env };
