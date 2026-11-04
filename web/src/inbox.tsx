// The Inbox: its own chunk, loaded when it opens (it and its folder switch aren't on the first page).
import { useContext, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Textarea } from '@/components/ui/textarea';
import { ActButton, EnvContext, Link, LoomMark, Nothing } from './blocks';
import type { Chrome, Source } from './loom';
import { ApprovalBox, As, InboxRow, KIND, Mark, useOpenItem, type InboxItem } from './views';
import { bits, githubUrl, plain, refsOf, type Bit } from './plain';
import { tidy } from './tidy';

const useEnv = () => useContext(EnvContext)!;

// The filters (Jonathan, 2026-10-30): "needs you, to do, fyi, everything is the order and we ditch answered". What
// was answered is history, in All; a permission, a decision, a reply or an alert needs you, and says which on
// its own row.
const KINDS: Array<[InboxItem['kind'], string]> = [['todo', 'To do'], ['fyi', 'FYI']];

export function InboxView({ items, folder, open: opened, chrome, github }: { items: InboxItem[]; folder: string; open?: string; chrome: Chrome; github?: string }) {
  const { ctx } = useEnv();
  // An item asked for by its address (/inbox?i=…: Home's banner, a push) opens at once.
  const [open, setOpen] = useState<InboxItem | null>(() => items.find((i) => i.key === opened) ?? null);
  // The switch is this page's own: every item came with it, so it filters here, at once.
  const [show, setShow] = useState(folder === 'needs' ? 'needs' : KINDS.some(([k]) => k === folder) ? folder : 'all');
  const agents = ctx.agents ?? {};
  const name = (a?: string) => (a && agents[a]?.label) || (a ? a[0].toUpperCase() + a.slice(1) : '');
  const tasks = items.find((i) => i.source.id === 'tasks')?.source ?? { id: 'tasks', base: '/p/tasks/' };
  const need = items.filter((i) => i.attention);
  const rest = items.filter((i) => !i.attention);
  // A row opens the item: its own page (a task's), else its sheet here.
  const openItem = useOpenItem(setOpen);
  const row = (i: InboxItem) => <InboxRow key={i.key} i={i} onOpen={openItem} />;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <ToggleGroup type="single" className="flex-wrap self-start justify-self-start" aria-label="Show" value={show} onValueChange={(f) => { if (f) setShow(f); }}>
        {[['needs', `Needs you${need.length ? ` · ${need.length}` : ''}`],
          ...KINDS.map(([k, l]) => { const c = items.filter((i) => i.kind === k).length; return [k, `${l}${c ? ` · ${c}` : ''}`]; }), ['all', 'All']]
          .map(([f, l]) => <ToggleGroupItem key={f} value={f}>{l}</ToggleGroupItem>)}</ToggleGroup>
      {(show === 'needs' || show === 'all') && need.length > 0 && <Card className="min-w-0"><CardHeader><CardTitle>Needs you · {need.length}</CardTitle></CardHeader><CardContent><ul className="min-w-0 divide-y">{need.map(row)}</ul></CardContent></Card>}
      {need.length === 0 && show === 'needs' && <Nothing title="Nothing needs you" text={rest.length ? `${rest.length} answered and FYI in All.` : 'Asks from your agents land here.'} />}
      {show === 'all' && rest.length > 0 && <Card className="min-w-0"><CardHeader><CardTitle>Lately</CardTitle></CardHeader><CardContent><ul className="min-w-0 divide-y">{rest.map(row)}</ul></CardContent></Card>}
      {KINDS.map(([k, l]) => {
        if (show !== k) return null;
        const these = items.filter((i) => i.kind === k);
        return these.length ? <Card key={k} className="min-w-0"><CardHeader><CardTitle>{l} · {these.length}</CardTitle></CardHeader><CardContent><ul className="min-w-0 divide-y">{these.map(row)}</ul></CardContent></Card>
          : <Nothing key={k} title={`No ${l.toLowerCase()}`} text="Nothing of this kind right now." />;
      })}
      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        {open && <ItemSheet i={open} who={name(open.agent)} mark={open.agent ? agents[open.agent] : undefined} tasks={tasks} github={github} onDone={() => setOpen(null)} />}
      </Drawer>
      {void chrome}
    </div>
  );
}

const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
function when(at?: string): string | undefined {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return undefined;
  const m = Math.round((Date.now() - t) / 60000);
  const ago = m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  return `${new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${ago}`;
}

/** An item, opened (Jonathan, 2026-10-29: "we should be presenting enough here that open it is unnecessary"): who
 * asked and where, what for (its tasks and pull requests a tap away), and how it was answered, laid out; a way to its
 * own page only when it has one (an item whose page is its piece's front page has nowhere more to go). */
export function ItemSheet({ i, who, mark, tasks, github, onDone }: { i: InboxItem; who: string; mark?: { label: string; bg: string; fg: string }; tasks: Source; github?: string; onDone: () => void }) {
  const p = plain(i, who);
  const from = cap(i.sourceLabel ?? i.source.id);
  const facts: [string, React.ReactNode][] = [];
  const asked = when(i.at);
  // Only an ask is asked: news is when it happened, an alert or a task since when it has stood.
  if (asked) facts.push([i.kind === 'fyi' ? 'When' : i.kind === 'alert' || i.kind === 'todo' ? 'Since' : 'Asked', asked]);
  if (p.answer) facts.push(['Answer', [p.answer.verdict, p.answer.by && `by ${p.answer.by}`, p.answer.for && `for ${p.answer.for}`].filter(Boolean).join(' ')]);
  else if (i.outcome) facts.push(['Answer', i.outcome]);
  const left = i.expires ? when(i.expires) : undefined;
  if (left && i.attention) facts.push(['Until', left.split(' · ')[0]]);
  // A Needs you laid out (its ask is the title): why, what happens either way, the approval it waits on, links, details.
  const n = i.needs;
  const why = n ? n.why : tidy(p.why ?? (i.kind !== 'answered' ? i.meta : undefined) ?? '') || undefined;
  const own = i.page !== undefined && i.page !== '';
  // What it names that opens (its pull requests, tasks, conversations), each a link of its own as well as in its words;
  // its own conversation last, when the words don't name it.
  const conv = /^loom:conversation\/(cv-[0-9a-f]{12})$/.exec(i.page ?? '')?.[1];
  const refs = refsOf(`${i.text} ${i.meta ?? ''} ${n?.refs.join(' ') ?? ''}`, github);
  if (conv && !refs.some((r) => r.t === 'conv' && r.id === conv)) refs.push({ t: 'conv', id: conv });
  const linked = !!i.href || (i.kind === 'alert' && refs.length > 0);
  const words = (s: string) => bits(s, github).map((b, n) => <Ref key={n} b={b} tasks={tasks} />);
  return (
    <DrawerContent className="lg:mx-auto lg:max-w-xl">
      <DrawerHeader className="flex-col items-stretch gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {mark ? <Mark a={mark} size={36} /> : <LoomMark size={36} />}
          <DrawerDescription className="min-w-0 truncate text-sm">{[who, from].filter(Boolean).join(' · ')}</DrawerDescription>
          <Badge variant={i.attention ? 'pending' : 'default'} className="ml-auto shrink-0">{p.ended ?? KIND[i.kind]}</Badge>
        </div>
        <DrawerTitle className="mb-0 break-words text-left leading-snug">{p.head === i.text ? words(p.head) : p.head}</DrawerTitle>
        {p.subject && <code className="self-start break-all rounded-lg bg-[color:var(--v-beige)] px-2 py-1 text-sm">{p.subject}</code>}
      </DrawerHeader>
      <div className="grid gap-5 py-2">
        {why && (
          <section className="grid gap-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide opacity-60">{!n && (i.kind === 'fyi' || i.kind === 'alert' || i.kind === 'todo') ? 'Details' : 'Why'}</h3>
            <p className="break-words leading-relaxed">{words(why)}</p>
          </section>
        )}
        {(n?.if_yes || n?.if_no) && (
          <dl className="grid gap-3 sm:grid-cols-2">
            {([['If yes', n.if_yes], ['If no', n.if_no]] as const).filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="grid gap-1"><dt className="text-xs font-semibold uppercase tracking-wide opacity-60">{k}</dt><dd className="break-words">{words(v!)}</dd></div>))}
          </dl>
        )}
        {i.approval && i.attention && <ApprovalBox a={i.approval} size="default" onDone={onDone} />}
        {linked && (
          <section className="grid gap-2" aria-label="Links">
            <h3 className="text-xs font-semibold uppercase tracking-wide opacity-60">Links</h3>
            <div className="flex flex-wrap gap-2">
              {i.href && <Button asChild size="sm"><Link href={i.href}>Open {shortHref(i.href)}</Link></Button>}
              {refs.filter((r) => !(r.t === 'pr' && i.href && shortHref(i.href) === `${r.repo.split('/')[1]}#${r.n}` && i.href.includes(`/${r.repo}/`))).map((r, n) => (
                <Button key={n} asChild size="sm" variant={r.t === 'conv' ? 'ghost' : 'outline'}>
                  {r.t === 'pr' ? <Link href={githubUrl(r.repo, r.n)}>{r.repo}#{r.n}</Link>
                    : r.t === 'task' ? <As source={tasks}><Link page={`task/${r.id}`}>Task {r.id}</Link></As>
                    : <As source={{ id: 'loom', base: '/' }}><Link page={`loom:conversation/${(r as { id: string }).id}`}>The conversation</Link></As>}
                </Button>))}
            </div>
          </section>
        )}
        {i.reply && i.attention && <As source={i.source}><ReplyBox r={i.reply} onDone={onDone} /></As>}
        {n && (
          <section className="grid gap-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide opacity-60">Details</h3>
            <p className="break-words text-sm leading-relaxed opacity-80">{words([n.details, ...n.refs].join(' · '))}</p>
          </section>
        )}
        {facts.length > 0 && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm">
            {facts.map(([k, v]) => [<dt key={`${k}k`} className="opacity-60">{k}</dt>, <dd key={`${k}v`} className="min-w-0">{v}</dd>])}
          </dl>
        )}
      </div>
      <As source={i.source}>
        <DrawerFooter className="flex-col-reverse items-stretch sm:flex-row sm:items-center">
          <DrawerClose asChild><Button variant="outline">Close</Button></DrawerClose>
          {own && !i.actions?.length && !conv && <Button asChild variant="outline"><Link page={i.page}>{i.label ?? `Open in ${from}`}</Link></Button>}
          {i.actions?.map((b) => <ActButton key={b.action + b.label} b={b} size="default" onDone={onDone} />)}
        </DrawerFooter>
      </As>
    </DrawerContent>
  );
}

/** One bit of an item's words: a task or a pull request linked, a conversation opened, a file as code. */
function Ref({ b, tasks }: { b: Bit; tasks: Source }) {
  const cls = 'font-medium underline underline-offset-4';
  if (b.t === 'text') return <span>{b.s}</span>;
  if (b.t === 'task') return <As source={tasks}><Link page={`task/${b.id}`} className={cls}>{b.id}</Link></As>;
  if (b.t === 'pr') return <Link href={githubUrl(b.repo, b.n)} className={cls}>{b.repo}#{b.n}</Link>;
  if (b.t === 'conv') return <As source={{ id: 'loom', base: '/' }}><Link page={`loom:conversation/${b.id}`} className={cls}>{b.id}</Link></As>;
  return <code className="break-all rounded bg-[color:var(--v-beige)] px-1 text-[0.9em]">{b.s}</code>;
}

/** "github.com/sleepunit-agents/art/pull/68" → "art#68"; any other link, its host and path, short. */
function shortHref(href: string): string {
  try {
    const u = new URL(href);
    const gh = u.hostname === 'github.com' && /^\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/.exec(u.pathname);
    if (gh) return `${gh[2]}#${gh[3]}`;
    const path = u.pathname.replace(/\/$/, '');
    return `${u.hostname}${path.length > 24 ? `${path.slice(0, 23)}…` : path}`;
  } catch { return href; }
}

/** Answer the agent in words (the Needs you sheet's Reply): posted as the owner's own message into its conversation. */
export function ReplyBox({ r, onDone }: { r: NonNullable<InboxItem['reply']>; onDone: () => void }) {
  const { send } = useEnv();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const fire = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const ok = await send(r.action, { ...r.fields, text });
    setBusy(false);
    if (ok) { setText(''); onDone(); }
  };
  return (
    <section className="grid gap-2">
      <label htmlFor="loom-reply" className="text-xs font-semibold uppercase tracking-wide opacity-60">{r.label}</label>
      <Textarea id="loom-reply" value={text} rows={3} placeholder="What should it know or do?" onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void fire(); }} />
      <Button className="justify-self-end" disabled={busy || !text.trim()} onClick={() => void fire()}>{busy ? 'Sending…' : 'Send'}</Button>
    </section>
  );
}
