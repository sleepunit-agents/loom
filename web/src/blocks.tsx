// loom's blocks (src/ui/vocab.ts) drawn with 000h's components, by the rules in docs/specs/ui-app.md:
// a details holding a form opens as an editor, one holding a list or a table as a drawer; danger asks
// first; a table is rows of label and value on a phone; a block this app doesn't know is shown, not dropped.
import { Arrive } from './arrive';
// Filters (000h's toggle group) load with a page that has them.
const Filters = lazy(() => import('./filters'));
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { Callout } from './safe';
import { tidy } from './tidy';
import { Item, ItemContent, ItemDescription, ItemTitle, ItemTrailing } from '@/components/ui/item';
// Rare blocks' components load when a page has one: a link block (living link), a meter (progress).
const LivingLink = lazy(() => import('@/components/ui/living-link').then((m) => ({ default: m.LivingLink })));
const Markdown = lazy(() => import('./markdown'));
const Profile = lazy(() => import('./profile'));
const ChartBlock = lazy(() => import('./chart'));
const Face = lazy(() => import('./face'));
// An agent's pixel face, where it has a sheet (pixel-face.tsx): its own chunk, its sheet loaded when drawn.
const PixelFace = lazy(() => import('./pixel-face'));
const PixelAvatar = lazy(() => import('./pixel-face').then((m) => ({ default: m.PixelAvatar })));
const Panel = lazy(() => import('./panel'));
const Health = lazy(() => import('./panel').then((m) => ({ default: m.Health })));
const Spark = lazy(() => import('./panel').then((m) => ({ default: m.Spark })));
const Progress = lazy(() => import('@/components/ui/progress').then((m) => ({ default: m.Progress })));
const CodeBlock = lazy(() => import('@/components/ui/code-block').then((m) => ({ default: m.CodeBlock })));
// What Home's first screen never draws loads when a page has it (the first page's weight, web-app.test.ts): forms and
// their editors (000h's fields, radio chips, switches, checkboxes, dialog), the confirm a danger button asks, a
// desktop's table and a long list's pages.
const Form = lazy(() => import('./form'));
const Confirm = lazy(() => import('./block-extras').then((m) => ({ default: m.Confirm })));
const Pager = lazy(() => import('./block-extras').then((m) => ({ default: m.Pager })));
const DetailsBlock = lazy(() => import('./details'));
const WideTable = lazy(() => import('./block-extras').then((m) => ({ default: m.WideTable })));
// What a list row opens to in place (its `more`): loads the first time one opens.
const RowMore = lazy(() => import('./row-more'));

import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { createContext, useContext, useState, type ReactNode, lazy, Suspense } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DOT } from './tones';
import { pageHref, type Block, type Button as Btn, type Ctx, type ListItem } from './loom';
import { markColor, markName, PixelContext } from './look';
import type { Sprite } from './pixel-face';

/** What a block needs from the page around it: where links go, how an action is sent, whether it's a phone. */
export interface Env {
  ctx: Ctx; send: (action: string, fields: Record<string, string>) => Promise<boolean>; go: (href: string) => void; wide: boolean;
  /** The same page, but links and actions belong to another source (an ask's or a tile's piece). */
  withSource: (source: Ctx['source']) => Env;
}
export const EnvContext = createContext<Env | null>(null);
export const useEnv = () => useContext(EnvContext)!;

const BADGE: Record<string, string> = { running: 'live', wanted: 'pending', starting: 'pending', failed: 'danger', lost: 'danger' };

export function Link({ page, href, children, className }: { page?: string; href?: string; children: ReactNode; className?: string }) {
  const { ctx, go } = useEnv();
  if (href) return <a className={className} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  if (page === undefined) return <span className={className}>{children}</span>;
  const to = pageHref(page, ctx.source);
  return <a className={className} href={to} onClick={(e) => { if (e.metaKey || e.ctrlKey || to === '#') return; e.preventDefault(); go(to); }}>{children}</a>;
}

// ---- actions ---------------------------------------------------------------------------------------

/** A button that sends its action; one that is danger (or says confirm) asks first. */
export function ActButton({ b, size = 'sm', full = false, onDone, disabled = false }: { b: Btn; size?: 'sm' | 'default'; full?: boolean; onDone?: () => void; disabled?: boolean }) {
  const { send } = useEnv();
  const [asking, setAsking] = useState(false);
  // The confirm dialog (000h's alert dialog) loads the first time it's asked for, and stays for its closing motion.
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const fire = async () => { setBusy(true); await send(b.action, b.fields ?? {}); setBusy(false); onDone?.(); };
  const variant = b.tone === 'danger' ? 'danger' : b.tone === 'primary' ? 'default' : 'outline';
  return (
    <>
      <Button size={size} variant={variant} disabled={busy || disabled} className={full ? 'w-full' : undefined}
        onClick={() => (b.confirm || b.tone === 'danger' ? (setAsked(true), setAsking(true)) : void fire())}>{b.label}</Button>
      {asked && <Suspense fallback={null}><Confirm b={b} open={asking} onOpenChange={setAsking} fire={() => void fire()} /></Suspense>}
    </>
  );
}

// ---- blocks ----------------------------------------------------------------------------------------

function Row({ i, wrap, marked }: { i: ListItem; wrap?: boolean; marked?: boolean }) {
  // One row is 000h's item: its lead (a tone, an agent's avatar), title and description, and what's at the end.
  // Nothing is cut so it can't be read (Jonathan, 2026-11-03): a row's words run to two lines, and a row that goes
  // nowhere opens to its whole text on a tap; one that goes somewhere shows it all there.
  const [open, setOpen] = useState(false);
  const whole = wrap || open;
  // A row with `more` opens in place; its link is then inside what opened, not where the tap goes.
  const linked = !i.more && (i.page !== undefined || !!i.href);
  const body = (
    <ItemContent className="min-w-0 flex-1">
      <ItemTitle className={`flex min-w-0 gap-2 ${whole ? 'items-start' : 'items-center'}`}>
        {i.tone && <span className={`size-2 shrink-0 rounded-full ${DOT[i.tone]}`} />}
        {marked && <Who agent={i.agent} person={i.person} avatar={i.avatar} size={20} />}
        <span className={whole ? 'font-medium leading-relaxed whitespace-pre-line [overflow-wrap:anywhere]' : 'line-clamp-2 font-medium [overflow-wrap:anywhere]'}>{tidy(i.text)}</span>
        {i.badge && <Badge variant={(BADGE[i.badge] ?? 'default') as 'default'}>{i.badge}</Badge>}
      </ItemTitle>
      {i.meta && <ItemDescription className={whole ? '[overflow-wrap:anywhere]' : 'line-clamp-2 [overflow-wrap:anywhere]'}>{tidy(i.meta)}</ItemDescription>}
    </ItemContent>
  );
  return (
    <Arrive as="li" k={`li:${i.text}\0${i.badge ?? ''}\0${i.tone ?? ''}`} className="min-w-0" data-open={i.more && open ? '' : undefined}>
      <Item as="div" className="flex min-h-11 w-full min-w-0 items-center gap-3 py-2.5">
        {linked ? <Link page={i.page} href={i.href} className="flex min-w-0 flex-1 items-center gap-2 no-underline">{body}{i.act ? null : <AnimatedIcon name="chevron-right" size="sm" />}</Link>
          : wrap && !i.more ? body
            : <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {body}{i.more && !i.act && <AnimatedIcon name="chevron-down" size="sm" className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />}</button>}
        {i.act && <ItemTrailing><ActButton b={i.act} /></ItemTrailing>}
      </Item>
      {i.more && open && <Suspense fallback={<div className="min-h-16" />}><RowMore more={i.more} page={i.page} href={i.href} indent={marked || !!i.tone} /></Suspense>}
    </Arrive>
  );
}

/** Long tables, lists and panels a page at a time (000h's pagination): PAGE_ROWS rows, then numbered pages. */
const PAGE_ROWS = 15;
/** Where a list or table that pages itself is (the piece serves one page; loom asks for ?<param>=<n>). */
type Pages = { param: string; at: number; count: number; total?: number };
export function usePaged<T>(all: T[], served?: Pages): { rows: T[]; pager: ReactNode } {
  const { ctx, go } = useEnv();
  const [at, setAt] = useState(0);
  // The piece's own pages (0-based here), else ours over what it sent.
  const pages = served ? served.count : Math.ceil(all.length / PAGE_ROWS);
  const page = served ? served.at - 1 : Math.min(at, Math.max(0, pages - 1));
  const to = (p: number) => {
    if (!served) return setAt(p);
    const q = new URLSearchParams(Object.entries({ ...ctx.query, [served.param]: String(p + 1) }).filter(([, v]) => v !== ''));
    go(`${pageHref(ctx.path, ctx.source)}?${q}`);
  };
  if (pages <= 1) return { rows: all, pager: null };
  // The pages around this one, the first and the last; gaps as an ellipsis.
  const shown = [...new Set([0, page - 1, page, page + 1, pages - 1].filter((p) => p >= 0 && p < pages))].sort((x, y) => x - y);
  return {
    rows: served ? all : all.slice(page * PAGE_ROWS, (page + 1) * PAGE_ROWS),
    pager: <Suspense fallback={<div className="mt-2 h-9" />}><Pager page={page} pages={pages} shown={shown} to={to} total={served?.total} /></Suspense>,
  };
}

function ListBlock({ items, pages, wrap, who }: { items: ListItem[]; pages?: Pages; wrap?: boolean; who?: boolean }) {
  const { rows, pager } = usePaged(items, pages);
  // Every row of a list that says who says it on each row: one without is nobody's yet, not a gap (Jonathan, 2026-10-31:
  // "everything should have one ... otherwise the ones without that are confusing as shit").
  const marked = who || items.some((i) => i.agent || i.person || i.avatar);
  if (!items.length) return <Nothing title="Nothing here yet" />;
  return <>{<ul className="min-w-0 divide-y">{rows.map((i, n) => <Row key={n} i={i} wrap={wrap} marked={marked} />)}</ul>}{pager}</>;
}

function TableBlock({ b }: { b: Extract<Block, { type: 'table' }> }) {
  const { wide } = useEnv();
  const { rows, pager } = usePaged(b.rows, (b as { pages?: Pages }).pages);
  const cell = (c: string | { text: string; page?: string }) => (typeof c === 'string' ? tidy(c) : <Link page={c.page}>{tidy(c.text)}</Link>);
  if (!b.rows.length) return <Nothing title="Nothing here yet" />;
  if (!wide) {
    return (
      <><ul className="divide-y">{rows.map((r, n) => (
        <Arrive as="li" key={n} k={`tr:${JSON.stringify(r)}`} className="grid gap-0.5 py-2.5">
          <span className="font-medium">{cell(r[0])}</span>
          <span className="text-sm opacity-70">{r.slice(1).map((c, m) => <span key={m}>{m ? ' · ' : ''}{cell(c)}</span>)}</span>
        </Arrive>))}
      </ul>{pager}</>
    );
  }
  // A desktop: 000h's table (its ledger look), rows as they come.
  return <><Suspense fallback={<div className="min-h-24" />}><WideTable columns={b.columns} rows={rows} cell={cell} /></Suspense>{pager}</>;
}


/** Pills that set one query value on this page, and an optional search over them (?q=), the other choices kept. */

/** A link block (000h's living link): one of the page's own, or another site's. */
function PageLink({ l }: { l: Extract<Block, { type: 'link' }> }) {
  const { ctx, go } = useEnv();
  const plain = <Link page={l.page} href={l.href} className="underline underline-offset-4">{l.text}</Link>;
  if (l.href) return <Suspense fallback={plain}><LivingLink href={l.href} target="_blank" rel="noopener noreferrer">{l.text}</LivingLink></Suspense>;
  const to = pageHref(l.page ?? '', ctx.source);
  return <Suspense fallback={plain}><LivingLink href={to} direction="forward" onClick={(e: React.MouseEvent) => { if (e.metaKey || e.ctrlKey || to === '#') return; e.preventDefault(); go(to); }}>{l.text}</LivingLink></Suspense>;
}

/** An agent's mark: its face (face.tsx), its shape and eyes its own, its expression its state; its initial on its
 * colour while the face loads. */
export type Mark = { label: string; bg: string; fg: string; face?: { shape?: string; eyes?: string; sprite?: Sprite } };
export type MarkState = 'idle' | 'thinking' | 'working' | 'needs-input' | 'complete' | 'error';
const isDark = () => typeof document !== 'undefined' && document.querySelector('[data-mode]')?.getAttribute('data-mode') === 'dark';
export function AgentAvatar({ a, size = 40, shape = 'rounded', className, style, state }: { a: Mark; size?: number; shape?: 'circle' | 'rounded' | 'pebble'; className?: string; style?: React.CSSProperties; state?: MarkState }) {
  // An agent with a pixel sheet wears it (unless the person turned Pixel faces off): its whole face, alive, from 36 px
  // (1x, 2x from 64); smaller, a still crop of its head (pixel-face.tsx PixelAvatar). Without one, the drawn face.
  const sprite = useContext(PixelContext) ? a.face?.sprite : undefined;
  const initial = (
    <Avatar shape={shape} className={className} aria-label={a.label}
      style={{ '--c': markColor(a.bg), color: markName(a.bg) ? 'var(--v-on-accent)' : a.fg, width: size, height: size, fontSize: Math.round(size * 0.42), boxShadow: 'none', ...style } as React.CSSProperties}>
      <AvatarFallback>{a.label[0]}</AvatarFallback>
    </Avatar>
  );
  return (
    <Suspense fallback={initial}>
      <span className={`inline-grid shrink-0 place-items-center ${className ?? ''}`} style={{ width: size, height: size }}>
        {(() => {
          const drawn = <Face bg={a.bg} fg={a.fg} shape={a.face?.shape as never} eyes={a.face?.eyes as never} state={state} size={size} label={a.label} dark={isDark()} />;
          return !sprite ? drawn : size >= 36 ? <PixelFace sprite={sprite} state={state} size={size} label={a.label} fallback={drawn} /> : <PixelAvatar sprite={sprite} size={size} label={a.label} fallback={drawn} />;
        })()}
      </span>
    </Suspense>
  );
}

/** A person (a People slug) in 000h's colours: the same person, the same colour, everywhere. */
const PERSON_TINTS = ['pink', 'blue', 'olive', 'yellow'];
const tintOf = (slug: string) => PERSON_TINTS[[...slug].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PERSON_TINTS.length];
// One letter, as the account button draws its owner.
const initialsOf = (slug: string) => slug.slice(0, 1).toUpperCase();

/** loom itself (a system row, an alert): its app icon, so it reads as loom and not as an agent. */
export function LoomMark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <Avatar shape="rounded" className={`shrink-0 ${className ?? ''}`} aria-label="loom" style={{ width: size, height: size, boxShadow: 'none' } as React.CSSProperties}>
      <AvatarImage src="/icons/loom-180.png" alt="" /><AvatarFallback>l</AvatarFallback>
    </Avatar>
  );
}

/**
 * Who a row is: an agent's mark (rounded), loom's own, a person's avatar (round, their initials), initials the piece
 * gave, or nobody's yet (a dashed circle).
 */
export function Who({ agent, person, avatar, size = 20 }: { agent?: string; person?: string; avatar?: string; size?: number }) {
  const { ctx } = useEnv();
  const a = agent ? ctx.agents?.[agent] : undefined;
  if (a) return <AgentAvatar a={a} size={size} className="shrink-0" />;
  if (agent === 'loom') return <LoomMark size={size} />;
  const letters = avatar ?? (person ? initialsOf(person) : undefined);
  if (letters) {
    return (
      <Avatar shape="circle" className="shrink-0" aria-label={person ?? letters}
        style={{ '--c': `var(--v-${tintOf(person ?? letters)})`, color: 'var(--v-text)', width: size, height: size, fontSize: Math.round(size * (letters.length > 1 ? 0.36 : 0.42)), boxShadow: 'none' } as React.CSSProperties}>
        <AvatarFallback>{letters}</AvatarFallback>
      </Avatar>
    );
  }
  return <span role="img" aria-label="Nobody yet" className="shrink-0 rounded-full border-[1.5px] border-dashed border-current opacity-35" style={{ width: size, height: size }} />;
}

/** An empty collection says so (000h's empty), never a blank. */
export function Nothing({ title, text, children }: { title: string; text?: string; children?: ReactNode }) {
  return (
    <Empty className="loom-empty grid justify-items-center gap-2 rounded-2xl border border-dashed px-4 py-8 text-center">
      <EmptyTitle className="text-base">{title}</EmptyTitle>{text && <EmptyDescription className="text-sm">{text}</EmptyDescription>}{children}
    </Empty>
  );
}

export function BlockView({ b }: { b: Block }) {
  switch (b.type) {
    case 'text': { const t = b as Extract<Block, { type: 'text' }>; return <p className={t.tone === 'muted' ? 'text-sm opacity-70' : ''}>{tidy(t.text)}</p>; }
    case 'prose': { const text = (b as { text: string }).text;
      return <Suspense fallback={<div className="whitespace-pre-wrap">{text}</div>}><Markdown text={text} /></Suspense>; }
    case 'profile': return <Suspense fallback={<div className="min-h-64" />}><Profile p={b as Extract<Block, { type: 'profile' }>} /></Suspense>;
    case 'callout': { const c = b as Extract<Block, { type: 'callout' }>;
      return <Callout tone={c.tone === 'bad' ? 'danger' : c.tone === 'warn' ? 'warn' : c.tone === 'ok' ? 'ok' : 'info'} title={c.title} busy={c.busy}>{c.text}</Callout>; }
    case 'list': return <ListBlock items={(b as Extract<Block, { type: 'list' }>).items} pages={(b as { pages?: Pages }).pages} wrap={(b as { wrap?: boolean }).wrap} who={(b as { who?: boolean }).who} />;
    case 'table': return <TableBlock b={b as Extract<Block, { type: 'table' }>} />;
    case 'kv': return (
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {(b as Extract<Block, { type: 'kv' }>).items.map((i) => [<dt key={`${i.label}k`} className="opacity-70">{i.label}</dt>,
          <Arrive as="dd" key={`${i.label}v`} k={`kv:${i.label}\0${i.value}`} className="min-w-0 [overflow-wrap:anywhere]">{i.page !== undefined ? <Link page={i.page}>{tidy(i.value)}</Link> : tidy(i.value)}</Arrive>])}
      </dl>);
    case 'stats': return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{(b as Extract<Block, { type: 'stats' }>).items.map((s) => (
        <Arrive key={s.label} k={`st:${s.label}\0${s.value}`} className="rounded-[var(--r-card)]"><Card lift={s.page !== undefined} className="gap-0 p-0">
          <Link page={s.page} className="block p-4 no-underline"><span className="block text-xs opacity-60">{s.label}</span>
          <span className="loom-data flex items-center gap-1.5 text-xl font-semibold">{s.tone && s.tone !== 'muted' && <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[s.tone]}`} />}{s.value}</span>{s.detail && <span className="block text-xs opacity-60 [overflow-wrap:anywhere]">{s.detail}</span>}
          {s.meter !== undefined && <Suspense fallback={<div className="mt-2 h-2 rounded-full bg-[var(--loom-track)]" />}><Progress className="mt-2" value={Math.round(s.meter * 100)} aria-label={s.label} /></Suspense>}
          {s.spark && <Suspense fallback={<div className="mt-2 h-7" />}><Spark values={s.spark} tone={s.tone} /></Suspense>}</Link></Card></Arrive>))}</div>);
    case 'meter': return (
      <div className="grid gap-3">{(b as Extract<Block, { type: 'meter' }>).items.map((m) => (
        <div key={m.label} className="grid gap-1"><div className="flex justify-between text-sm"><span>{m.label}</span><span className="opacity-70">{Math.round(m.value * 100)}%</span></div>
          <Suspense fallback={<div className="h-2 rounded-full bg-[var(--loom-track)]" />}><Progress value={Math.round(Math.min(1, m.value) * 100)} aria-label={m.label} /></Suspense>
          {m.detail && <p className="text-xs opacity-60">{m.detail}</p>}</div>))}</div>);
    case 'status': return (
      <ul className="grid gap-2">{(b as Extract<Block, { type: 'status' }>).items.map((s) => (
        <Arrive as="li" key={s.label} k={`ss:${s.label}\0${s.text ?? ''}\0${s.tone ?? ''}`} className="flex items-center gap-2 text-sm"><span className={`size-2 rounded-full ${DOT[s.tone ?? 'muted']}`} /><span className="font-medium">{s.label}</span>
          <span className="opacity-70">{s.text}</span>{s.meta && <span className="ml-auto text-xs opacity-60">{s.meta}</span>}</Arrive>))}</ul>);
    case 'link': return <PageLink l={b as Extract<Block, { type: 'link' }>} />;
    // loom draws a from block for the viewer before the page leaves it; one that didn't says nothing of the thread.
    case 'from': return <p className="text-sm opacity-70">From a conversation</p>;
    case 'code': { const text = (b as { text: string }).text;
      return <Suspense fallback={<pre className="overflow-x-auto rounded-xl p-3 text-xs">{text}</pre>}><CodeBlock code={text} /></Suspense>; }
    case 'buttons': return <div className="flex flex-wrap gap-2">{(b as Extract<Block, { type: 'buttons' }>).items.map((x) => <ActButton key={x.action + x.label} b={x} />)}</div>;
    case 'form': return <Suspense fallback={<div className="min-h-24" />}><Form form={b as Extract<Block, { type: 'form' }>} /></Suspense>;
    case 'details': return <Suspense fallback={<Button size="sm" variant="ghost" disabled>{(b as { summary: string }).summary}</Button>}><DetailsBlock b={b as Extract<Block, { type: 'details' }>} /></Suspense>;
    case 'chart': return <Suspense fallback={<div className="h-64" />}><ChartBlock b={b as Extract<Block, { type: 'chart' }>} /></Suspense>;
    case 'panel': return <Suspense fallback={<div className="min-h-24" />}><Panel b={b as Extract<Block, { type: 'panel' }>} /></Suspense>;
    case 'health': return <Suspense fallback={<div className="min-h-14" />}><Health b={b as Extract<Block, { type: 'health' }>} /></Suspense>;
    case 'filters': return <Suspense fallback={null}><Filters b={b as Extract<Block, { type: 'filters' }>} /></Suspense>;
    default: return <p className="text-sm opacity-60">(a {b.type} block this app can't draw yet)</p>;
  }
}
