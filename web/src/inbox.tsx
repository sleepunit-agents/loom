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
import { Arrive } from './arrive';
import { bits, githubUrl, plain, refsOf, type Bit } from './plain';
import { tidy } from './tidy';
import { draftOf, guardFooter, hasDraft, keepDraft } from './drafts';
import { Split, type SplitFolder } from './split';
import './inbox.css';

const useEnv = () => useContext(EnvContext)!;

type Box = NonNullable<InboxItem['box']>;
/** Each folder's icon (its name and order are loom's: the view's `folders`, src/ui/render.ts INBOX_FOLDERS). Every
 * one is in the authored icon set, so the Inbox never pulls in the whole Lucide pack (icon.tsx). */
const FOLDER_ICON: Record<string, string> = { needs: 'inbox', question: 'message-circle', approval: 'lock', alert: 'triangle-alert', memory: 'brain', done: 'circle-check' };
/** What an open item is, as its reader's first line says it. */
const BOX_WORD: Record<Box, string> = { question: 'Question', approval: 'Approval', alert: 'Alert', memory: 'Memory review', done: 'Done' };
const BOX_ICON: Record<Box, string> = { question: 'message-circle', approval: 'lock', alert: 'triangle-alert', memory: 'brain', done: 'circle-check' };
/** An item's folder is loom's (render.ts inboxBox: one rule, on the server); an answer from before it said one is Done. */
const boxOf = (i: InboxItem): Box => i.box ?? 'done';

/** When, as a list's right edge says it: today's time, this week's day, else the date. */
function short(at?: string): string {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return '';
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (Math.abs(now.getTime() - t) < 6 * 86_400_000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function InboxView({ items, folder, folders: named, open: opened, chrome, github }: { items: InboxItem[]; folder: string; folders?: Array<{ id: string; label: string }>; open?: string; chrome: Chrome; github?: string }) {
  const FOLDERS = (named ?? [{ id: 'needs', label: 'Needs you' }]).map((x) => [x.id, x.label, FOLDER_ICON[x.id] ?? 'inbox'] as const);
  const env = useEnv();
  const { ctx } = env;
  const agents = ctx.agents ?? {};
  const name = (a?: string) => (a && agents[a]?.label) || (a ? a[0].toUpperCase() + a.slice(1) : '');
  const [f, setF] = useState(() => (FOLDERS.some(([k]) => k === folder) ? folder : 'needs'));
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(() => (opened && items.some((i) => i.key === opened) ? opened : null));
  // Answered here, before loom's new answer lands: Done at once, with what was said.
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [read, setRead] = useState<Set<string>>(() => new Set());
  const all = useMemo(() => items.map((i): InboxItem => (answered[i.key] ? { ...i, attention: false, unread: false, box: 'done', outcome: answered[i.key] }
    : read.has(i.key) ? { ...i, unread: false, box: boxOf(i) } : { ...i, box: boxOf(i) })), [items, answered, read]);
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
  // The next open one after it in the list, else the one before: a mail client's.
  const next = (key: string) => { const n = shown.findIndex((i) => i.key === key); const open = (i: InboxItem) => i.key !== key && boxOf(i) !== 'done';
    return shown.slice(n + 1).find(open) ?? shown.slice(0, Math.max(0, n)).reverse().find(open) ?? null; };
  const onAnswered = (i: InboxItem, said: string) => {
    const nx = next(i.key);
    setAnswered((a) => ({ ...a, [i.key]: said }));
    setSel(nx?.key ?? null);
  };
  // Mark done from a row's right-click (the desktop's; t-1925 E): only an item with a plain Done, nothing typed and not
  // sent (drafts.ts: Done must never drop his words: the reader sends them first), and only once loom says, now, that
  // it's still open, as the reader's own buttons are. Otherwise the item opens in the reader, which says why.
  const doneOf = (i: InboxItem) => (boxOf(i) === 'done' || i.approval || (i.reply && hasDraft(i.key)) ? undefined
    : (i.actions ?? []).find((b) => /^(mark )?done$/i.test(b.label.trim()) && b.tone !== 'danger' && !b.confirm));
  const markDone = async (i: InboxItem) => {
    const b = doneOf(i);
    if (!b || (i.reply && hasDraft(i.key)) || (await stillOpen(i.key)) !== 'live') { pick(i); return; }
    if (await env.withSource(i.source).send(b.action, b.fields ?? {})) onAnswered(i, 'Done');
  };
  void chrome;
  const label = FOLDERS.find(([k]) => k === f)?.[1] ?? (f.startsWith('from:') ? `From ${name(f.slice(5))}` : 'Inbox');
  const search = (
    <label className="loom-split__search"><Icon name="search" size="sm" />
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the Inbox" aria-label="Search the Inbox" /></label>
  );
  return (
    <Split className="loom-inbox" label="Inbox" folders={folders} folder={f} onFolder={(id) => { setF(id); setSel(null); }} search={search}
      listTitle={label} listMeta={shown.length || undefined}
      list={shown.length ? shown.map((i) => <Row key={i.key} i={i} who={name(i.agent)} mark={i.agent ? agents[i.agent] : undefined} current={reading?.key === i.key} onPick={pick}
        done={doneOf(i) ? () => void markDone(i) : undefined} />)
        : <div className="loom-split__empty"><Nothing title={needle ? `Nothing matches “${q.trim()}”` : f === 'needs' ? 'Nothing needs you' : `Nothing in ${label}`}
          text={needle ? undefined : f === 'needs' ? 'Asks from your agents land here.' : 'Nothing of this kind right now.'} /></div>}
      reader={went ? <p className="loom-split__note" role="status" data-live="gone">That item isn’t here any more: it was answered or changed elsewhere.</p>
        : reading ? <Reader key={reading.key} i={reading} who={name(reading.agent)} mark={reading.agent ? agents[reading.agent] : undefined}
        tasks={tasks} github={github} env={env} onAnswered={onAnswered} picks={picks} /> : null}
      open={!!current || went} onBack={() => setSel(null)} backLabel={label} blank={f === 'needs' ? 'All caught up' : 'Nothing open'} />
  );
}

/** A row: what it is (its folder's mark), its words, when; unread is bold with a dot. */
function Row({ i, who, mark, current, onPick, done }: { i: InboxItem; who: string; mark?: { label: string; bg: string; fg: string }; current: boolean; onPick: (i: InboxItem) => void;
  /** Mark done, from the desktop's right-click (tiling/tiles.tsx data-row-menu): there when the item has a plain Done. */
  done?: () => void }) {
  const p = plain(i, who);
  const el = useRef<HTMLButtonElement>(null);
  const act = useRef<(id: string) => void>(() => {});
  act.current = (id) => { if (id === 'open') onPick(i); else if (id === 'done') done?.(); };
  useEffect(() => {
    const b = el.current;
    const f = (e: Event) => act.current((e as CustomEvent<string>).detail);
    b?.addEventListener('loom-menu', f);
    return () => b?.removeEventListener('loom-menu', f);
  }, []);
  const box = boxOf(i);
  const sub = tidy(p.why ?? i.outcome ?? i.meta ?? '') || [who, i.sourceLabel].filter(Boolean).join(' · ');
  return (
    // What's new arrives (arrive.tsx; docs/specs/ui-app.md): a row that wasn't there at the last answer glows once.
    <Arrive k={`in:${i.key}\0${i.kind}`}>
      <button ref={el} type="button" data-split-row="" className="loom-inbox__row" data-box={box} data-unread={i.unread || undefined} aria-current={current ? 'true' : undefined} onClick={() => onPick(i)}
        data-row-menu={done ? 'open:Open|done:Mark done' : 'open:Open'} data-row-menu-title={p.title.slice(0, 60)}>
        {i.unread && <span className="loom-inbox__dot" aria-label="Unread" />}
        {/* Who asks, by their face (pixel or drawn), with what it is as a badge on it; nobody's is its kind alone. */}
        {mark ? <span className="loom-inbox__face"><Mark a={mark} size={28} /><span className="loom-inbox__badge" aria-hidden><Icon name={i.kind === 'fyi' ? 'info' : BOX_ICON[box]} size="sm" /></span></span>
          : <span className="loom-inbox__kind" aria-hidden><Icon name={i.kind === 'fyi' ? 'info' : BOX_ICON[box]} size="sm" /></span>}
        <span className="loom-split__words"><span className="loom-split__title">{p.title}</span>{sub && <span className="loom-inbox__sub">{sub}</span>}</span>
        <span className="loom-inbox__when loom-data">{short(i.at)}</span>
      </button>
    </Arrive>
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
  // Anything still open with a way to answer it: counted in Needs you or only filed (attention: false), the same.
  const acts = boxOf(i) !== 'done' && (!!i.actions?.length || !!i.reply || !!i.approval);
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
  const ans = useAnswer(i.reply && acts ? i : undefined, () => undefined, guarded);
  const yesNo = n?.answers === 'yes-no' && !(i.approval && acts);
  const ok = live === 'live';
  const trail = trailOf(i, who, p.answer ? [p.answer.verdict, p.answer.by && `by ${p.answer.by}`].filter(Boolean).join(' ') : i.outcome);
  return (
    <article className="loom-inbox__read" data-box={boxOf(i)} aria-labelledby={`ib-${i.key}`}>
      <header className="loom-inbox__from">
        {mark ? <Mark a={mark} size={28} /> : <LoomMark size={28} />}
        <span><b>{who || from}</b> · {p.ended ?? (boxOf(i) === 'done' ? KIND[i.kind] : BOX_WORD[boxOf(i)])}</span>
        <span className="loom-data loom-inbox__at">{short(i.at)}</span>
      </header>
      <h2 id={`ib-${i.key}`} className="loom-split__head">{p.head === i.text ? words(p.head) : p.head}</h2>
      {p.subject && <code className="loom-inbox__subject">{p.subject}</code>}
      {why && <p className="loom-inbox__why">{words(why)}</p>}
      {(n?.if_yes || n?.if_no) && (
        <dl className="loom-inbox__ifs">
          {([[i.kind === 'permission' ? 'If you allow' : 'If yes', n.if_yes], [i.kind === 'permission' ? 'If you deny' : 'If no', n.if_no]] as const).filter(([, v]) => v).map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{words(v!)}</dd></div>))}
        </dl>
      )}
      {acts && !ok && <p className="loom-split__note" role="status" data-live={live}>{LIVE_SAYS[live as Exclude<Live, 'live'>]}
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
                <div className="loom-split__buttons">
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
            <div className="loom-split__links">
              {own && <As source={i.source}><Link page={i.page} className="loom-split__chip">{i.label ?? `Open in ${from}`}</Link></As>}
              {i.href && <Link href={i.href} className="loom-split__chip">{shortHref(i.href)} <Icon name="external-link" size="sm" /></Link>}
              {refs.filter((r) => !(r.t === 'pr' && i.href && i.href.includes(`/${r.repo}/`) && i.href.endsWith(`/${r.n}`))).map((r, k) => (
                r.t === 'pr' ? <Link key={k} href={githubUrl(r.repo, r.n)} className="loom-split__chip">{r.repo}#{r.n}</Link>
                  : r.t === 'task' ? <As key={k} source={tasks}><Link page={`task/${r.id}`} className="loom-split__chip">Task {r.id}</Link></As>
                  : r.t === 'conv' ? <As key={k} source={{ id: 'loom', base: '/' }}><Link page={`loom:conversation/${r.id}`} className="loom-split__chip">The conversation</Link></As> : null))}
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
  add(at(i.at), i.kind === 'fyi' ? `${by}: news` : boxOf(i) === 'alert' ? `${by} raised this` : `${by} asked`, 'ask');
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
