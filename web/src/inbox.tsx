// The Inbox (t-1925, Jonathan's approved mock 2026-11-06): a mail client for asks. Folders down the left (Needs you,
// Questions, Approvals, Alerts, Memory reviews, Done, and who it's from), the list, and the open item beside it whole:
// why, what happens either way, its buttons, a reply, where it lives and its trail. Answering it moves it to Done and
// opens the next. In a narrow tile or on a phone the folders are chips and the item slides over the list (split.tsx).
//
// An ask's buttons are live only once loom has said, just now, that it's still open (/inbox/open), and it's asked again
// right before one is sent: a copy kept on this device (page.ts, the service worker) may be of an ask answered since.
// Its own chunk, loaded when it opens.
import { buzz, HapticLabel, useHaptics } from './haptic';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Textarea } from '@/components/ui/textarea';
import { ActButton, EnvContext, Link, LoomMark, Nothing, type Env } from './blocks';
import { markRead, type Chrome, type Source } from './loom';
import { ApprovalBox, As, KIND, Mark, type InboxItem, Fine } from './views';
import { bits, githubUrl, plain, refsOf, type Bit } from './plain';
import { tidy } from './tidy';
import { draftOf, guardFooter, keepDraft } from './drafts';
import { Split, type SplitFolder } from './split';
import './inbox.css';

const useEnv = () => useContext(EnvContext)!;

type Box = NonNullable<InboxItem['box']>;
/** The folders, in the mock's order; each one's icon. */
const FOLDERS: Array<[string, string, string]> = [
  ['needs', 'Needs you', 'inbox'], ['question', 'Questions', 'message-circle-question'], ['approval', 'Approvals', 'lock'],
  ['alert', 'Alerts', 'triangle-alert'], ['memory', 'Memory reviews', 'brain'], ['done', 'Done', 'circle-check'],
];
const BOX_ICON: Record<Box, string> = { question: 'message-circle-question', approval: 'lock', alert: 'triangle-alert', memory: 'brain', done: 'circle-check' };
/** An item's folder: the server's, else worked out as it does (an older loom's answer, a test's fixture). */
const boxOf = (i: InboxItem): Box => i.box ?? (i.kind === 'answered' || i.kind === 'fyi' ? 'done' : i.kind === 'permission' || i.approval ? 'approval'
  : i.kind === 'decision' || i.kind === 'reply' || i.kind === 'todo' || i.reply || i.needs ? 'question' : 'alert');
const OLD: Record<string, string> = { permission: 'approval', decision: 'question', reply: 'question', todo: 'question', fyi: 'done', answered: 'done' };

/** When, as a list's right edge says it: today's time, this week's day, else the date. */
function short(at?: string): string {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return '';
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (Math.abs(now.getTime() - t) < 6 * 86_400_000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function InboxView({ items, folder, open: opened, chrome, github }: { items: InboxItem[]; folder: string; open?: string; chrome: Chrome; github?: string }) {
  const env = useEnv();
  const { ctx } = env;
  const agents = ctx.agents ?? {};
  const name = (a?: string) => (a && agents[a]?.label) || (a ? a[0].toUpperCase() + a.slice(1) : '');
  const [f, setF] = useState(() => (FOLDERS.some(([k]) => k === folder) ? folder : OLD[folder] ?? 'needs'));
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(() => (opened && items.some((i) => i.key === opened) ? opened : null));
  // Answered here, before loom's new answer lands: Done at once, with what was said.
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [read, setRead] = useState<Set<string>>(() => new Set());
  const all = useMemo(() => items.map((i): InboxItem => (answered[i.key] ? { ...i, attention: false, unread: false, box: 'done', outcome: answered[i.key] }
    : read.has(i.key) ? { ...i, unread: false } : { ...i, box: boxOf(i) })), [items, answered, read]);
  const tasks = items.find((i) => i.source.id === 'tasks')?.source ?? { id: 'tasks', base: '/p/tasks/' };
  const inF = (id: string, i: InboxItem) => (id === 'needs' ? i.attention : id.startsWith('from:') ? i.agent === id.slice(5) : i.box === id);
  const needle = q.trim().toLowerCase();
  const shown = all.filter((i) => inF(f, i) && (!needle || `${i.text} ${i.meta ?? ''} ${i.needs?.why ?? ''} ${i.sourceLabel ?? ''} ${name(i.agent)}`.toLowerCase().includes(needle)));
  // Who it's from: the agents with anything here, each with what of theirs is open.
  const from = [...new Set(all.map((i) => i.agent).filter((a): a is string => !!a))];
  const folders: SplitFolder[] = [
    ...FOLDERS.map(([id, label, icon]) => ({ id, label, icon, count: id === 'done' ? undefined : all.filter((i) => inF(id, i)).length, loud: id === 'needs' })),
    ...(from.length ? [{ heading: 'From' }, ...from.map((a) => ({ id: `from:${a}`, label: name(a), count: all.filter((i) => i.agent === a && i.attention).length }))] : []),
  ];
  const current = shown.find((i) => i.key === sel) ?? all.find((i) => i.key === sel) ?? null;
  // The one picked went (answered elsewhere, or changed: loom's newer answer has it no more): said, not swapped for another.
  const went = sel !== null && !current;
  // Beside the list, the folder's first is shown until one is picked (only picking one reads it).
  const reading = went ? null : current ?? shown[0] ?? null;
  // Each pick asks loom again whether it's open, even of the item already shown (it may have been answered since).
  const [picks, setPicks] = useState(0);
  const pick = (i: InboxItem) => {
    setSel(i.key); setPicks((x) => x + 1);
    if (i.unread) { setRead((r) => new Set(r).add(i.key)); void markRead(i.key, ctx.csrf); }
  };
  const next = (key: string) => { const n = shown.findIndex((i) => i.key === key); return shown.filter((i) => i.key !== key && i.attention)[Math.max(0, n)] ?? null; };
  const onAnswered = (i: InboxItem, said: string) => {
    const nx = next(i.key);
    setAnswered((a) => ({ ...a, [i.key]: said }));
    setSel(nx?.key ?? null);
  };
  void chrome;
  const label = FOLDERS.find(([k]) => k === f)?.[1] ?? (f.startsWith('from:') ? `From ${name(f.slice(5))}` : 'Inbox');
  const search = (
    <label className="loom-inbox__search"><Icon name="search" size="sm" />
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the Inbox" aria-label="Search the Inbox" /></label>
  );
  return (
    <Split className="loom-inbox" label="Inbox" folders={folders} folder={f} onFolder={(id) => { setF(id); setSel(null); }} search={search}
      listTitle={label} listMeta={shown.length || undefined}
      list={shown.length ? shown.map((i) => <Row key={i.key} i={i} who={name(i.agent)} current={reading?.key === i.key} onPick={pick} />)
        : <div className="loom-inbox__empty"><Nothing title={needle ? `Nothing matches “${q.trim()}”` : f === 'needs' ? 'Nothing needs you' : `Nothing in ${label}`}
          text={needle ? undefined : f === 'needs' ? 'Asks from your agents land here.' : 'Nothing of this kind right now.'} /></div>}
      reader={went ? <p className="loom-inbox__live" role="status" data-live="gone">That item isn’t here any more: it was answered or changed elsewhere.</p>
        : reading ? <Reader key={reading.key} i={reading} who={name(reading.agent)} mark={reading.agent ? agents[reading.agent] : undefined}
        tasks={tasks} github={github} env={env} onAnswered={onAnswered} picks={picks} /> : null}
      open={!!current || went} onBack={() => setSel(null)} backLabel={label} blank={f === 'needs' ? 'All caught up' : 'Nothing open'} />
  );
}

/** A row: what it is (its folder's mark), its words, when; unread is bold with a dot. */
function Row({ i, who, current, onPick }: { i: InboxItem; who: string; current: boolean; onPick: (i: InboxItem) => void }) {
  const p = plain(i, who);
  const box = boxOf(i);
  const sub = tidy(p.why ?? i.outcome ?? i.meta ?? '') || [who, i.sourceLabel].filter(Boolean).join(' · ');
  return (
    <button type="button" data-split-row="" className="loom-inbox__row" data-box={box} data-unread={i.unread || undefined} aria-current={current ? 'true' : undefined} onClick={() => onPick(i)}>
      {i.unread && <span className="loom-inbox__dot" aria-label="Unread" />}
      <span className="loom-inbox__kind" aria-hidden><Icon name={(i.kind === 'fyi' ? 'info' : BOX_ICON[box]) as never} size="sm" /></span>
      <span className="loom-inbox__words"><span className="loom-inbox__title">{p.title}</span>{sub && <span className="loom-inbox__sub">{sub}</span>}</span>
      <span className="loom-inbox__when loom-data">{short(i.at)}</span>
    </button>
  );
}

type Live = 'checking' | 'live' | 'gone' | 'unknown';

/** Whether loom says, now, that this ask is still open. Never from a copy: a stamped one (x-loom-saved-at) can't tell. */
async function stillOpen(key: string): Promise<Live> {
  try {
    const r = await fetch(`/inbox/open?k=${key}`, { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok || r.headers.has('x-loom-saved-at') || !(r.headers.get('content-type') ?? '').startsWith('application/json')) return 'unknown';
    return ((await r.json()) as { open?: boolean }).open ? 'live' : 'gone';
  } catch { return 'unknown'; }
}

const LIVE_SAYS: Record<Exclude<Live, 'live'>, string> = {
  checking: 'Checking it’s still open…',
  gone: 'This isn’t open any more: it was answered or changed since. Nothing was sent.',
  unknown: 'Can’t check with loom right now, so its buttons wait. Try again in a moment.',
};

/** The open item, whole: who and what, why, what happens either way, the answer, where it lives and its trail. */
function Reader({ i, who, mark, tasks, github, env, onAnswered, picks }: { i: InboxItem; who: string; mark?: { label: string; bg: string; fg: string }; tasks: Source; github?: string; env: Env;
  onAnswered: (i: InboxItem, said: string) => void; picks: number }) {
  const p = plain(i, who);
  const from = cap(i.sourceLabel ?? i.source.id);
  const acts = i.attention && (!!i.actions?.length || !!i.reply || !!i.approval);
  const [live, setLive] = useState<Live>(acts ? 'checking' : 'live');
  const check = async () => { const l = await stillOpen(i.key); setLive(l); return l === 'live'; };
  useEffect(() => { if (!acts) return; setLive('checking'); void check(); }, [i.key, picks]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Every button here goes through this: asked again right before it's sent; answered, it's Done here at once.
  const lastSaid = useRef('Answered');
  const guard = (e: Env): Env => ({ ...e,
    send: async (a, fields) => {
      if (!(await check())) return false;
      const ok = await e.send(a, fields);
      if (ok) onAnswered(i, lastSaid.current);
      return ok;
    },
    withSource: (s) => guard(e.withSource(s)) });
  const guarded = useMemo(() => guard(env), [env, i.key]);   // eslint-disable-line react-hooks/exhaustive-deps
  const n = i.needs;
  const why = n ? n.why : tidy(p.why ?? (i.kind !== 'answered' ? i.meta : undefined) ?? '') || undefined;
  const conv = /^loom:conversation\/(cv-[0-9a-f]{12})$/.exec(i.page ?? '')?.[1];
  const refs = refsOf(`${i.text} ${i.meta ?? ''} ${n?.refs.join(' ') ?? ''}`, github);
  if (conv && !refs.some((r) => r.t === 'conv' && r.id === conv)) refs.push({ t: 'conv', id: conv });
  const own = i.page !== undefined && i.page !== '' && !conv;
  const words = (s: string) => bits(s, github).map((b, k) => <Ref key={k} b={b} tasks={tasks} />);
  const ans = useAnswer(i.reply && i.attention ? i : undefined, () => undefined, guarded);
  const yesNo = n?.answers === 'yes-no' && !(i.approval && i.attention);
  const ok = live === 'live';
  const trail = trailOf(i, who, p.answer ? [p.answer.verdict, p.answer.by && `by ${p.answer.by}`].filter(Boolean).join(' ') : i.outcome);
  return (
    <article className="loom-inbox__read" data-box={boxOf(i)} aria-labelledby={`ib-${i.key}`}>
      <header className="loom-inbox__from">
        {mark ? <Mark a={mark} size={28} /> : <LoomMark size={28} />}
        <span><b>{who || from}</b> · {p.ended ?? KIND[i.kind]}</span>
        <span className="loom-data loom-inbox__at">{short(i.at)}</span>
      </header>
      <h2 id={`ib-${i.key}`} className="loom-inbox__head">{p.head === i.text ? words(p.head) : p.head}</h2>
      {p.subject && <code className="loom-inbox__subject">{p.subject}</code>}
      {why && <p className="loom-inbox__why">{words(why)}</p>}
      {(n?.if_yes || n?.if_no) && (
        <dl className="loom-inbox__ifs">
          {([[i.kind === 'permission' ? 'If you allow' : 'If yes', n.if_yes], [i.kind === 'permission' ? 'If you deny' : 'If no', n.if_no]] as const).filter(([, v]) => v).map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{words(v!)}</dd></div>))}
        </dl>
      )}
      {acts && !ok && <p className="loom-inbox__live" role="status" data-live={live}>{LIVE_SAYS[live as Exclude<Live, 'live'>]}
        {live === 'unknown' && <Button size="sm" variant="outline" onClick={() => { setLive('checking'); void check(); }}>Check again</Button>}</p>}
      {/* The buttons only once loom says it's open: a stale ask never shows live ones (t-1925). */}
      {acts && ok && (
        <EnvContext.Provider value={guarded}>
          <div className="loom-inbox__answer">
            {i.approval && <ApprovalBox a={i.approval} size="default" />}
            {ans && <AnswerBox a={{ ...ans, say: async (v) => { lastSaid.current = v === 'yes' ? 'You said yes' : 'You said no'; await ans.say(v); },
              reply: async () => { lastSaid.current = 'You replied'; await ans.reply(); } }} yesNo={yesNo} />}
            {!!i.actions?.length && (
              <As source={i.source}>
                <div className="loom-inbox__buttons">
                  {guardFooter(i.actions, !!ans?.drafted, !!ans?.busy).map((fb) => fb.send
                    ? <Button key={fb.b.action} disabled={fb.disabled} onClick={() => { lastSaid.current = 'You replied'; void ans?.reply(); }}>{fb.label}</Button>
                    : <span key={fb.b.action + fb.b.label} onClickCapture={() => { lastSaid.current = fb.b.label === 'Done' ? 'Done' : fb.b.label; }}>
                      <ActButton b={fb.b} size="default" disabled={fb.disabled} /></span>)}
                </div>
              </As>
            )}
          </div>
        </EnvContext.Provider>
      )}
      <Fine text={i.fine} className="loom-inbox__fine" />
      <div className="loom-inbox__meta">
        {(own || i.href || refs.length > 0) && (
          <section aria-label="Where it lives">
            <h3>Where it lives</h3>
            <div className="loom-inbox__links">
              {own && <As source={i.source}><Link page={i.page} className="loom-inbox__chip">{i.label ?? `Open in ${from}`}</Link></As>}
              {i.href && <Link href={i.href} className="loom-inbox__chip">{shortHref(i.href)} <Icon name="external-link" size="sm" /></Link>}
              {refs.filter((r) => !(r.t === 'pr' && i.href && i.href.includes(`/${r.repo}/`) && i.href.endsWith(`/${r.n}`))).map((r, k) => (
                r.t === 'pr' ? <Link key={k} href={githubUrl(r.repo, r.n)} className="loom-inbox__chip">{r.repo}#{r.n}</Link>
                  : r.t === 'task' ? <As key={k} source={tasks}><Link page={`task/${r.id}`} className="loom-inbox__chip">Task {r.id}</Link></As>
                  : r.t === 'conv' ? <As key={k} source={{ id: 'loom', base: '/' }}><Link page={`loom:conversation/${r.id}`} className="loom-inbox__chip">The conversation</Link></As> : null))}
            </div>
          </section>
        )}
        {trail.length > 0 && (
          <section aria-label="Trail">
            <h3>Trail</h3>
            <ol className="loom-inbox__trail">{trail.map((t, k) => <li key={k} data-tone={t.tone}><span className="loom-data">{t.when}</span> {t.text}</li>)}</ol>
          </section>
        )}
      </div>
      {n && (n.details || n.refs.length > 0) && <p className="loom-inbox__details">{words([n.details, ...n.refs].join(' · '))}</p>}
    </article>
  );
}

/** What happened to an item, oldest first: asked, seen, answered, and until when it waits. */
function trailOf(i: InboxItem, who: string, answer?: string): Array<{ when: string; text: string; tone?: string; t: number }> {
  const out: Array<{ when: string; text: string; tone?: string; t: number }> = [];
  const at = (s?: string) => (s ? Date.parse(s) : NaN);
  const stamp = (t: number) => `${short(new Date(t).toISOString())}${new Date(t).toDateString() === new Date().toDateString() ? '' : ` ${new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`}`;
  const add = (t: number, text: string, tone?: string) => { if (Number.isFinite(t)) out.push({ when: stamp(t), text, tone, t }); };
  const by = who || i.sourceLabel || 'loom';
  add(at(i.at), i.kind === 'fyi' ? `${by}: news` : boxOf(i) === 'alert' ? `${by} raised this` : i.kind === 'answered' ? `${by} asked` : `${by} asked`, 'ask');
  add(at(i.seen), 'You opened it', 'seen');
  if (!i.attention && answer) add(i.kind === 'answered' ? at(i.at) : Date.now(), answer, 'done');
  if (i.attention && i.expires) add(at(i.expires), 'It expires', 'until');
  return out.sort((x, y) => x.t - y.t);
}

const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

/** One bit of an item's words: a task or a pull request linked, a conversation opened, a file as code. */
function Ref({ b, tasks }: { b: Bit; tasks: Source }) {
  const cls = 'font-medium underline underline-offset-4';
  if (b.t === 'text') return <span>{b.s}</span>;
  if (b.t === 'task') return <As source={tasks}><Link page={`task/${b.id}`} className={`${cls} loom-data`}>{b.id}</Link></As>;
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

type Answer = { draft: string; setDraft: (s: string) => void; drafted: boolean; busy: boolean; reply: () => Promise<void>; say: (a: 'yes' | 'no') => Promise<void>; label: string };

/** A Needs you's answer, as its sheet holds it: the words in its box (kept on this device until they're sent, so
 * closing the sheet loses nothing), and sending them, or a Yes or a No. One at a time: while one is on its way, the
 * sheet's other answers wait (on 2026-11-04 a Done pressed while a reply was sending answered the ask first). */
function useAnswer(i: InboxItem | undefined, onDone: () => void, env: Env): Answer | undefined {
  const key = i?.key ?? '';
  const [draft, setDraft] = useState(() => (key ? draftOf(key) : ''));
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (key) keepDraft(key, draft); }, [key, draft]);
  if (!i?.reply) return undefined;
  const r = i.reply;
  const post = async (fields: Record<string, string>, action = r.action) => {
    setBusy(true);
    // Posted as the item's own source's (the agent's actions), as its sheet's other buttons are.
    const ok = await env.withSource(i.source).send(action, { ...r.fields, ...fields });
    setBusy(false);
    return ok;
  };
  return {
    draft, setDraft, busy, drafted: !!draft.trim(), label: r.label,
    reply: async () => {
      if (!draft.trim() || busy) return;
      if (await post({ text: draft })) { keepDraft(key, ''); setDraft(''); onDone(); }
    },
    say: async (a) => {
      if (busy) return;
      if (await post({ answer: a }, 'needs-answer')) { keepDraft(key, ''); setDraft(''); onDone(); }
    },
  };
}

/** Answer the agent: Yes or No (a yes/no question), or in words, posted as the owner's own message into its
 * conversation. */
export function AnswerBox({ a, yesNo }: { a: Answer; yesNo: boolean }) {
  const haptics = useHaptics();
  const answer = (v: 'yes' | 'no') => { buzz(haptics, true); void a.say(v); };
  return (
    <section className="grid gap-3">
      {yesNo && (
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Your answer">
          <Button className="relative" disabled={a.busy} onClick={() => answer('yes')}>Yes<HapticLabel on={haptics && !a.busy} /></Button>
          <Button className="relative" disabled={a.busy} onClick={() => answer('no')}>No<HapticLabel on={haptics && !a.busy} /></Button>
        </div>
      )}
      <label htmlFor="loom-reply" className="text-xs font-semibold uppercase tracking-wide opacity-60">{yesNo ? 'Or answer in your own words' : a.label}</label>
      <Textarea id="loom-reply" value={a.draft} rows={3} placeholder="What should it know or do?" onChange={(e) => a.setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void a.reply(); }} />
      <div className="flex items-center justify-end gap-3">
        {a.drafted && !a.busy && <span className="text-sm opacity-70">Not sent yet</span>}
        {/* A press on Send leaves the reply box focused, as Comms' composer does: a phone's keyboard doesn't start
            closing (and the sheet move under the finger) before the click lands. */}
        <Button variant={yesNo ? 'outline' : 'default'} disabled={a.busy || !a.drafted} onClick={() => void a.reply()}
          onMouseDown={(e) => e.preventDefault()}>{a.busy ? 'Sending…' : 'Send'}</Button>
      </div>
    </section>
  );
}
