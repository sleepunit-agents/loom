// Neon Noir on a big screen (Jonathan, 2026-11-05, the desktop OS prototype's "Level 1: Shell": "if 1 is done well,
// there's no need to do [the others]"). Home is a desktop: widgets on the ground, each drawn from what Home already
// has (src/ui/handler.ts house-home): what needs you, answered where it stands; one card per agent with its face and
// what it's on; the pieces' own tiles; the nightly backup. Never a number loom doesn't have.
//
// Its own chunk, loaded only on a screen this wide under Neon (App.tsx): a phone never fetches it.
import { useState } from 'react';
import './desk.css';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Button } from '@/components/ui/button';
import { ActButton, AgentAvatar, LoomMark, Nothing, useEnv, type Mark } from './blocks';
import { Arrive } from './arrive';
import { ApprovalBox, As, useOpenItem, type InboxItem } from './views';
import { plain } from './plain';
import { tidy } from './tidy';
import { iconFor } from './safe';
import { markColor } from './look';
import { DOT } from './tones';
import type { Shell } from './loom';

type Doing = { text: string; kind?: string; where?: string; since?: string };
type Card = Mark & { id: string; state?: 'working' | 'available' | 'unavailable' | 'broken'; reason?: string;
  doing?: Doing[]; problems?: { text: string; tone: 'bad' | 'warn' }[]; seen?: { at: string; where: string } };
export type DeskHomeData = { headline: string; needs: number; need?: InboxItem; stack?: InboxItem[]; cards: Card[]; moving: { agent?: string; text: string; meta?: string }[] };

const ago = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/** A widget: a dark panel with a lit edge in its tint, its name in small caps with a dot, and a way to its app. */
type Tint = 'pink' | 'blue' | 'yellow' | 'olive';
function Widget({ tint, title, more, className, children }: { tint: Tint; title: string; more?: { label: string; href: string }; className?: string; children: React.ReactNode }) {
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
        {(yesNo || words || acts.length > 0) && (
          <div className="loom-need__acts" role="group" aria-label="Your answer">
            {yesNo && <><Button size="sm" disabled={busy} onClick={() => void say('yes')}>Yes</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void say('no')}>No</Button></>}
            {words && <Button size="sm" variant="outline" onClick={() => open(i)}>{i.reply!.label || 'Answer'}…</Button>}
            {acts.length > 0 && <As source={i.source}>{acts.map((b) => <ActButton key={b.action + b.label} b={b} />)}</As>}
          </div>
        )}
      </div>
    </Arrive>
  );
}

function Needs({ d }: { d: DeskHomeData }) {
  const { go } = useEnv();
  const stack = d.stack ?? (d.need ? [d.need] : []);
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

/** An agent: its face, big and alive (the pixel face where it has one), how it is, and the one thing it's on. */
function Agent({ c }: { c: Card }) {
  const { go } = useEnv();
  const problems = c.problems ?? [];
  const doing = c.doing ?? [];
  const lit = markColor(c.bg);
  const state = c.state === 'broken' || problems.length ? 'error' : c.state === 'working' || doing.length ? 'working' : 'idle';
  // Its status line: trouble first, then what it's on, else why it's quiet.
  const line = problems[0]?.text ?? doing[0]?.text ?? c.reason;
  const where = problems.length ? undefined : doing[0] ? [doing[0].where, doing[0].since && ago(doing[0].since)].filter(Boolean).join(' · ') : undefined;
  return (
    <a href={`/a/${c.id}`} className="loom-w loom-w--agent" style={{ '--acc': lit } as React.CSSProperties} data-state={state}
      onClick={(e) => { e.preventDefault(); go(`/a/${c.id}`); }} aria-label={`${c.label}: ${EYEBROW(c)}${line ? `. ${line}` : ''}`}>
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
    </a>
  );
}

// ---- vitals: the pieces' own tiles, and the nightly backup -------------------------------------

/** Box vitals, from what every page's shell already carries (never a number of its own): the Boxes place's count, its
 * tone and its open alerts, then any other place that's in trouble. Each a link to its page. */
function Vitals({ shell }: { shell: Shell }) {
  const { go } = useEnv();
  const places = shell.pieces as (Shell['pieces'][number] & { alerts?: number })[];
  const trouble = (p: (typeof places)[number]) => (p.alerts ?? 0) > 0 || p.tone === 'bad' || p.tone === 'warn';
  // One row per place: two pieces can carry the same one for a while (a piece and its successor side by side).
  const rows = [...places.filter((p) => p.label === 'Boxes'), ...places.filter((p) => p.label !== 'Boxes' && trouble(p))]
    .filter((p, n, all) => all.findIndex((x) => x.href === p.href) === n);
  if (!rows.length) return null;
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

function BackupW({ b }: { b: NonNullable<Shell['backup']> }) {
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

/** What's moving: the agents' work as the pieces report it, a line each. */
function Tape({ rows }: { rows: DeskHomeData['moving'] }) {
  const { ctx } = useEnv();
  const agents = ctx.agents ?? {};
  return (
    <section className="loom-w loom-w--tape" data-tint="olive" aria-label="What's moving">
      <span className="loom-tape__label" aria-hidden>Moving</span>
      <ul className="loom-tape">{rows.filter((r, n) => rows.findIndex((x) => x.agent === r.agent && x.text === r.text) === n).slice(0, 6).map((r, n) => (
        <li key={n}><b>{(r.agent && agents[r.agent]?.label) || r.agent}</b> {r.text}{r.meta && <span className="loom-tape__meta"> · {r.meta}</span>}</li>))}
      </ul>
    </section>
  );
}

function NoAgents() {
  const { go } = useEnv();
  return <Nothing title="No agents yet" text="An agent is who does the work here. Make the first one."><Button className="mt-2" onClick={() => go('/new-agent')}>New agent</Button></Nothing>;
}

// ---- the desktop --------------------------------------------------------------------------------

export function DeskHome({ home, shell }: { home: DeskHomeData; shell: Shell }) {
  const backup = shell.backup;
  return (
    <div className="loom-desk-home">
      <div className="loom-desk-col loom-desk-col--left">
        <Needs d={home} />
      </div>
      <div className="loom-desk-col loom-desk-col--mid">
        <p className="loom-desk-headline">{home.headline}</p>
        {home.cards.length === 0 ? <NoAgents />
          : <div className="loom-desk-agents">{home.cards.map((c) => <Agent key={c.id} c={c} />)}</div>}
        {home.moving.length > 0 && <Tape rows={home.moving} />}
      </div>
      <div className="loom-desk-col loom-desk-col--right">
        <Vitals shell={shell} />
        {backup && <BackupW b={backup} />}
      </div>
    </div>
  );
}
