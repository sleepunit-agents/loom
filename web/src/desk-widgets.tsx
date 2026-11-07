// Home's widgets (docs/specs/desk-tiling.md, "Widgets"): what needs you, answered where it stands; one card per agent with
// its face and what it's on; box vitals from the pieces' own tiles; the nightly backup. The tiled desktop
// (tiling/tiles.tsx) draws them as tiles: on the desktop, in the rail or the board beside the apps, or as the strip's
// keys. Never a number loom doesn't have.
//
// In the desk's own chunk (desk.tsx and the tiles import it): a phone never fetches it.
import { useState } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Button } from '@/components/ui/button';
import { ActButton, AgentAvatar, LoomMark, Nothing, useEnv, type Mark } from './blocks';
import { Arrive } from './arrive';
import { AnswersWithLines, ApprovalBox, As, Fine, useOpenItem, type InboxItem } from './views';
import { plain } from './plain';
import { tidy } from './tidy';
import { iconFor } from './safe';
import { markColor } from './look';
import { DOT } from './tones';
import type { Shell } from './loom';
import type { WidgetKind } from './tiling/fit';

type Doing = { text: string; kind?: string; where?: string; since?: string };
export type Card = Mark & { id: string; state?: 'working' | 'available' | 'unavailable' | 'broken'; reason?: string;
  doing?: Doing[]; problems?: { text: string; tone: 'bad' | 'warn' }[]; seen?: { at: string; where: string } };
export type DeskHomeData = { headline: string; needs: number; need?: InboxItem; stack?: InboxItem[]; cards: Card[] };

const ago = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/** A widget: a dark panel with a lit edge in its tint, its name in small caps with a dot, and a way to its app. */
export type Tint = 'pink' | 'blue' | 'yellow' | 'olive';
export function Widget({ tint, title, more, className, children }: { tint: Tint; title: string; more?: { label: string; href: string }; className?: string; children: React.ReactNode }) {
  const { go } = useEnv();
  return (
    <section className={`loom-w ${className ?? ''}`} data-tint={tint} aria-label={title}>
      <header className="loom-w__head">
        <span className="loom-w__dot" aria-hidden />
        <h2>{title}</h2>
        {more && <a href={more.href} className="loom-w__more" onClick={(e) => { e.preventDefault(); go(more.href); }}>{more.label}</a>}
      </header>
      {children}
    </section>
  );
}

// ---- what needs you, answered where it stands --------------------------------------------------

/** One thing that needs you: who, what, why, and its answers: Allow and Deny under the approval's own words (never the
 * ask's alone: inbox.tsx ApprovalBox), Yes and No for a yes/no ask, else its own buttons. Words, or anything more, open it. */
function Need({ i }: { i: InboxItem }) {
  const env = useEnv();
  const agents = env.ctx.agents ?? {};
  const who = (i.agent && agents[i.agent]?.label) || (i.agent ? i.agent[0].toUpperCase() + i.agent.slice(1) : '');
  const p = plain(i, who);
  const open = useOpenItem();
  const [busy, setBusy] = useState(false);
  const approval = i.approval && i.attention ? i.approval : undefined;
  const yesNo = !approval && i.needs?.answers === 'yes-no' && !!i.reply;
  // A yes or a no, posted as its own source's, as its sheet does (inbox.tsx useAnswer).
  const say = async (answer: 'yes' | 'no') => {
    if (busy || !i.reply) return;
    setBusy(true);
    await env.withSource(i.source).send('needs-answer', { ...i.reply.fields, answer });
    setBusy(false);
  };
  const acts = !approval && !yesNo ? (i.actions ?? []) : [];
  const lined = acts.length > 0 && !!(i.needs?.if_yes || i.needs?.if_no);
  // Answered in words: its sheet has the box for them.
  const words = !approval && !yesNo && !!i.reply;
  return (
    // Its own buttons (an approval's card that wasn't absorbed is its own Allow and Deny) stand under its words whole,
    // never cut: what a button grants is read in full beside it (views.tsx ApprovalBox's rule).
    <Arrive as="li" k={`need:${i.key}`} className="loom-need" {...(acts.length ? { 'data-whole': '' } : {})}>
      {i.agent && agents[i.agent] ? <AgentAvatar a={agents[i.agent]} size={28} /> : <LoomMark size={28} />}
      <div className="loom-need__body">
        <button type="button" className="loom-need__title" onClick={() => open(i)}>
          {i.unread && <span className="loom-need__unread" aria-label="Unread" />}{p.title}
        </button>
        {(p.why ?? i.outcome) && <p className="loom-need__why">{tidy(p.why ?? i.outcome ?? '')}</p>}
        {approval && <ApprovalBox a={approval} />}
        {(yesNo || words || (acts.length > 0 && !lined)) && (
          <div className="loom-need__acts" role="group" aria-label="Your answer">
            {yesNo && <><Button size="sm" disabled={busy} onClick={() => void say('yes')}>Yes</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void say('no')}>No</Button></>}
            {words && <Button size="sm" variant="outline" onClick={() => open(i)}>{i.reply!.label || 'Answer'}…</Button>}
            {acts.length > 0 && !lined && <As source={i.source}>{acts.map((b) => <ActButton key={b.action + b.label} b={b} />)}</As>}
          </div>
        )}
        {/* Allow beside "If you allow", Deny beside "If you deny", under the ask read whole. */}
        {lined && <As source={i.source}><AnswersWithLines actions={acts} lines={i.needs!} /></As>}
        {acts.length > 0 && <Fine text={i.fine} className="loom-need__fine" />}
      </div>
    </Arrive>
  );
}

/** Needs you. Compact (a rail taller than the screen, docs/specs/desk-tiling.md rule 1): its first ask and "N more". */
export function Needs({ d, compact }: { d: DeskHomeData; compact?: boolean }) {
  const { go } = useEnv();
  const all = d.stack ?? (d.need ? [d.need] : []);
  const stack = compact ? all.slice(0, 1) : all;
  const rest = d.needs - stack.length;
  return (
    <Widget tint="pink" title={d.needs ? `Needs you · ${d.needs}` : 'Needs you'} className="loom-w--needs" more={{ label: 'Inbox', href: '/inbox' }}>
      {stack.length ? <ul className="loom-needs">{stack.map((i) => <Need key={i.key} i={i} />)}</ul>
        : <p className="loom-w__quiet">Nothing needs you.</p>}
      {rest > 0 && <a href="/inbox" className="loom-w__foot" onClick={(e) => { e.preventDefault(); go('/inbox'); }}>{rest} more in the Inbox</a>}
    </Widget>
  );
}

// ---- the agents ---------------------------------------------------------------------------------

const EYEBROW = (c: Card) => {
  const doing = c.doing ?? [], problems = c.problems ?? [];
  return problems.length ? (c.state === 'broken' ? 'Something’s broken' : 'Needs a look')
    : c.state === 'working' || doing.length ? `Working${doing.length > 1 ? ` · ${doing.length} things` : ''}`
    : c.state === 'unavailable' ? 'Unavailable' : 'Up · quiet';
};

/** An agent: its face, big and alive (the pixel face where it has one), how it is, and the one thing it's on. As a tile
 * (tiling/tiles.tsx) it has Chat too, which opens the agent's latest Comms thread beside it: then the card is a panel with
 * the whole of it a link to the agent's pages under Chat (a button can't sit inside a link). Compact: its face, name
 * and status line. */
export function Agent({ c, chat, compact }: { c: Card; chat?: () => void; compact?: boolean }) {
  const { go } = useEnv();
  const problems = c.problems ?? [];
  const doing = c.doing ?? [];
  const lit = markColor(c.bg);
  const state = c.state === 'broken' || problems.length ? 'error' : c.state === 'working' || doing.length ? 'working' : 'idle';
  // Its status line: trouble first, then what it's on, else why it's quiet.
  const line = problems[0]?.text ?? doing[0]?.text ?? c.reason;
  const where = problems.length ? undefined : doing[0] ? [doing[0].where, doing[0].since && ago(doing[0].since)].filter(Boolean).join(' · ') : undefined;
  const label = `${c.label}: ${EYEBROW(c)}${line ? `. ${line}` : ''}`;
  const open = (e: React.MouseEvent) => { e.preventDefault(); go(`/a/${c.id}`); };
  const inner = (<>
      <span className="loom-agent__face"><AgentAvatar a={c} size={96} state={state} /></span>
      <span className="loom-agent__who">
        <span className="loom-agent__eyebrow" data-trouble={problems.length ? '' : undefined}>{EYEBROW(c)}</span>
        <span className="loom-agent__name">{c.label}</span>
      </span>
      {line && <Arrive as="span" k={`line:${c.id}\0${line}`} className="loom-agent__line" {...(problems[0] ? { 'data-tone': problems[0].tone } : {})}>
        <AnimatedIcon name={iconFor(problems.length ? 'triangle-alert' : doing.length ? 'activity' : 'moon')} size="sm" />
        <span><span className="loom-agent__text">{line}</span>{where && <span className="loom-agent__where">{where}</span>}</span></Arrive>}
      <span className="loom-agent__foot">
        <span>Open {c.label}</span>
        {c.seen && <span className="loom-data">seen {ago(c.seen.at)}{c.seen.where ? ` · ${c.seen.where}` : ''}</span>}
      </span>
  </>);
  const style = { '--acc': lit } as React.CSSProperties;
  if (!chat && !compact) return <a href={`/a/${c.id}`} className="loom-w loom-w--agent" style={style} data-state={state} onClick={open} aria-label={label}>{inner}</a>;
  return (
    <div className="loom-w loom-w--agent" style={style} data-state={state} data-compact={compact || undefined}>
      <a href={`/a/${c.id}`} className="loom-agent__open" onClick={open} aria-label={label} />
      {inner}
      {chat && <button type="button" className="loom-agent__chat" onClick={chat} aria-label={`Chat with ${c.label}`}>
        <AnimatedIcon name={iconFor('message-circle')} size="sm" /><span>Chat</span></button>}
    </div>
  );
}

// ---- vitals: the pieces' own tiles, and the nightly backup -------------------------------------

/** Box vitals, from what every page's shell already carries (never a number of its own): the Boxes place's count, its
 * tone and its open alerts, then any other place that's in trouble. Each a link to its page. */
export function Vitals({ shell }: { shell: Shell }) {
  const { go } = useEnv();
  const places = shell.pieces as (Shell['pieces'][number] & { alerts?: number })[];
  const trouble = (p: (typeof places)[number]) => (p.alerts ?? 0) > 0 || p.tone === 'bad' || p.tone === 'warn';
  // One row per place: two pieces can carry the same one for a while (a piece and its successor side by side).
  const rows = [...places.filter((p) => p.label === 'Boxes'), ...places.filter((p) => p.label !== 'Boxes' && trouble(p))]
    .filter((p, n, all) => all.findIndex((x) => x.href === p.href) === n);
  if (!rows.length) return <Widget tint="blue" title="Vitals" className="loom-w--vitals"><p className="loom-w__quiet">All quiet.</p></Widget>;
  return (
    <Widget tint="blue" title="Vitals" className="loom-w--vitals">
      <ul className="loom-vitals">{rows.map((p) => {
        const alerts = p.alerts ?? 0;
        const tone = alerts || p.tone === 'bad' ? 'bad' : p.tone === 'warn' ? 'warn' : p.tone === 'ok' || !trouble(p) ? 'ok' : undefined;
        return (
          <Arrive as="li" key={p.href} k={`vital:${p.href}\0${p.stat ?? ''}\0${alerts}`}><a href={p.href} className="loom-vital" onClick={(e) => { e.preventDefault(); go(p.href); }}>
            <span className="loom-vital__label">{tone && <span className={`size-2 rounded-full ${DOT[tone]}`} />}{p.label}</span>
            {p.stat && <span className="loom-vital__value loom-data">{p.stat}</span>}
            <span className="loom-vital__detail">{alerts ? `${alerts} open alert${alerts === 1 ? '' : 's'}` : trouble(p) ? 'needs a look' : 'all quiet'}</span>
          </a></Arrive>
        );
      })}
      </ul>
    </Widget>
  );
}

export function BackupW({ b }: { b: NonNullable<Shell['backup']> }) {
  const tint: Tint = b.tone === 'ok' ? 'olive' : b.tone === 'bad' ? 'pink' : 'yellow';
  return (
    <Widget tint={tint} title="Backup" className="loom-w--backup" more={{ label: 'Details', href: b.href }}>
      <p className="loom-backup" data-tone={b.tone}>
        <span className={`size-2 shrink-0 rounded-full ${b.tone === 'ok' ? 'bg-[var(--loom-ok)]' : b.tone === 'bad' ? 'bg-[var(--loom-bad)]' : 'bg-[var(--loom-warn)]'}`} />
        <span>{b.tone === 'ok' ? <>Last good copy <span className="loom-data">{b.text}</span></> : b.text}</span>
      </p>
    </Widget>
  );
}

export function NoAgents() {
  const { go } = useEnv();
  return <Nothing title="No agents yet" text="An agent is who does the work here. Make the first one."><Button className="mt-2" onClick={() => go('/new-agent')}>New agent</Button></Nothing>;
}


// ---- as tiles (tiling/tiles.tsx) ---------------------------------------------------------------

export type WidgetData = { home: DeskHomeData; shell: Shell; live: boolean };
type Kind = WidgetKind;

/** One widget, by its id and kind, drawn from Home's data: null when it has nothing to draw from (an agent gone). */
export function WidgetBody({ id, kind, d, compact, chat }: { id: string; kind: Kind; d: WidgetData; compact?: boolean; chat?: (agent: string) => void }) {
  if (kind === 'needs') return <Needs d={d.home} compact={compact} />;
  if (kind === 'vitals') return <Vitals shell={d.shell} />;
  if (kind === 'backup') return d.shell.backup ? <BackupW b={d.shell.backup} /> : null;
  const c = d.home.cards.find((x) => x.id === id);
  return c ? <Agent c={c} compact={compact} chat={chat ? () => chat(id) : undefined} /> : null;
}

/** Where a widget's own app is: its key in the strip opens it. */
export function widgetHref(id: string, kind: Kind, d: WidgetData): string {
  if (kind === 'agent') return `/a/${id}`;
  if (kind === 'needs') return '/inbox';
  if (kind === 'backup') return d.shell.backup?.href ?? '/setup';
  if (kind === 'vitals') return d.shell.pieces.find((p) => p.label === 'Boxes')?.href ?? '/places';
  return '/places';
}

/** A widget folded to the strip (docs/specs/desk-tiling.md rule 1): one 64 px key with a face or an icon and a count,
 * that opens the widget's app. */
export function StripKey({ id, kind, name, d, open }: { id: string; kind: Kind; name: string; d: WidgetData; open: (href: string) => void }) {
  const c = kind === 'agent' ? d.home.cards.find((x) => x.id === id) : undefined;
  const count = kind === 'needs' ? d.home.needs : kind === 'vitals' ? d.shell.pieces.reduce((n, p) => n + ((p as { alerts?: number }).alerts ?? 0), 0) : 0;
  const icon = kind === 'needs' ? 'inbox' : kind === 'vitals' ? 'activity' : kind === 'backup' ? 'hard-drive' : 'radio';
  const href = widgetHref(id, kind, d);
  const what = kind === 'needs' ? (count ? `${count} need${count === 1 ? 's' : ''} you` : 'nothing needs you') : kind === 'vitals' && count ? `${count} open alert${count === 1 ? '' : 's'}` : '';
  return (
    <a href={href} className="loom-strip-key" data-kind={kind} style={c ? ({ '--t': markColor(c.bg) } as React.CSSProperties) : undefined}
      onClick={(e) => { e.preventDefault(); open(href); }} title={name} aria-label={`${name}${what ? `: ${what}` : ''}. Open`}>
      {c ? <AgentAvatar a={c} size={40} state={(c.problems ?? []).length ? 'error' : c.state === 'working' || (c.doing ?? []).length ? 'working' : 'idle'} />
        : <AnimatedIcon name={iconFor(icon)} />}
      {count > 0 && <span className="loom-strip-key__n loom-data">{count}</span>}
    </a>
  );
}

/** The desktop with no app open (docs/specs/desk-tiling.md rule 1): the widgets laid out as Home is, and nothing else
 * (no status line: Jonathan, 2026-11-06, "just cards, widgets and windows"): Needs you on the left, the agents in the middle, the rest on the right; each in the order added, each with its
 * ×. With none, it says how to get some. */
export function WidgetDesk({ ws, d, chat, frame }: {
  ws: { id: string; kind: Kind; name: string }[]; d: WidgetData; chat?: (agent: string) => void;
  /** a widget in its tile's frame (its ×, and the box its height is measured from) */
  frame: (w: { id: string; name: string }, body: React.ReactNode) => React.ReactNode;
}) {
  if (!ws.length) return (
    <div className="loom-desk-home loom-desk-home--empty">
      <Nothing title="No tiles" text="Open an app from the dock, or right-click the desktop (or press Shift+F10) to add a widget." />
    </div>
  );
  const draw = (k: (w: (typeof ws)[number]) => boolean) => ws.filter(k).map((w) => frame(w, <WidgetBody id={w.id} kind={w.kind} d={d} chat={chat} />));
  const agents = draw((w) => w.kind === 'agent');
  return (
    <div className="loom-desk-home">
      <div className="loom-desk-col loom-desk-col--left">{draw((w) => w.kind === 'needs')}</div>
      {/* A household with no agent yet: how to make the first, where their cards would be. */}
      <div className="loom-desk-col loom-desk-col--mid">{agents.length > 0 ? <div className="loom-desk-agents">{agents}</div> : !d.shell.agents.length && <NoAgents />}</div>
      <div className="loom-desk-col loom-desk-col--right">{draw((w) => w.kind !== 'needs' && w.kind !== 'agent')}</div>
    </div>
  );
}
