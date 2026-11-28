/** The boards page (docs/specs/boards.md): a conversation, and a second window the agent fills from bricks.
 * The page draws the thread's boards and nothing else there; what is on screen is a record, never page state. */
import { afterOwnWrite } from './own-writes';
import { Component, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpIcon } from 'lucide-react';
import { useDataQuery } from '../data/graphql';
import { memberOperation } from '../data/operation';
import { useCommsDraft } from '../pieces/comms/drafts';
import { useSession } from '../signin/use-session';
import type { FaceState } from '../face';
import { Button } from '../pair/ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '../pair/ui/input-group';
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from '../pair/ui/message-scroller';
import { emptyTail, threadId, TranscriptPage, type ThreadTail } from '../pair/transcript';
import { brickView, type Params, type Place } from './bricks';
import { Fetching, Here, Loading, Lost } from './brick-kit';
import { layout, type Slot } from './layout';
import { PlacementFrame } from './placement';
import { buildChanged } from './build';
import { AgentFace, FACE } from './agent-face';
import { useAgentNames } from './agents-data';
import { BridgeReceipt, ThreadHead, ThreadStop, ThreadSwitch, threadHeadQuery } from './threads';
import { Notify, useNotifyWorker } from './notify';
import { usePageTitle } from './title';
import { reducedMotion, wearMotion } from '../access';
import { Remembered } from '../data/graphql/remembered';
import { refreshRelaxed } from '../data/graphql/pace';
import { forgetAnswers, rememberedFor } from './remember';
import { Wear } from './wear';
import '../pair/screen.css';
import './board.css';
import './board-kit.css';

// This page has no boot script, so it starts by following the device (access.ts answers what moves). Once the
// member is known it wears their own Reduce motion, and of their Appearance nothing else (./wear.ts).
wearMotion('follow');

// A brick's data is read again every few seconds (../data/graphql/pace.ts). What the member does here is not kept
// waiting for that: the moment loom answers a write of this page, the bricks on screen are asked for now. Two
// writes change no brick's data and ask nothing: looking at a flagged placement, and the report of a brick's
// action, which follows the action's own write.
const QUIET_WRITES = new Set(['/api/boards/seen', '/api/boards/act']);
afterOwnWrite((path) => { if (!QUIET_WRITES.has(path)) refreshRelaxed(); });

/** How long the trail takes to slide to another board (./board.css, `.boards-trail`). */
const SLIDE_MS = 600;
type Placement = { id: string; brick: string; params: string; rank: number; placedByKind: string; big: boolean; canBeBig: boolean; flagged: boolean };
type Board = { id: string; thread: string; title: string; revision: number; closed: boolean; trailAt: string; placements: Placement[] };
const boardFields = 'id thread title revision closed trailAt placements{id brick params rank placedByKind big canBeBig flagged}';

/** The one id the address holds: a board's, a thread's, or none. */
function address(): { board?: string; thread?: string } {
  const [, , kind, id] = location.pathname.split('/');
  return kind === 'b' && id ? { board: decodeURIComponent(id) } : kind === 't' && id ? { thread: decodeURIComponent(id) } : {};
}
const go = (path: string, replace = false) => { if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState'](null, '', path); };
/** Going to another thread or board from inside the page: the address changes, and whoever resolves it is told. */
const moved = new Set<() => void>();
const visit = (path: string) => { go(path); for (const tell of [...moved]) tell(); };
/** Where the member went, once it is known to be in this page's thread. A new one each time they go. */
type At = { board?: string };

/** How long a placement waits before it draws a failed body again by itself, each time in turn. After the last it
 * stops and offers the member the same. An array so a suite can shorten or empty it. */
export const brickRetryMs = [700, 2500];

/** A brick's body is fetched when a board first shows it (./bricks.tsx). One that fails, as when loom was deployed
 * while the page stayed open and the old file is gone, or a body that threw, is drawn again by its own placement
 * after a moment, twice, saying only that it is being fetched again. The rest of the board stays drawn. If it still
 * fails the placement says sorry and offers to try again; where loom now serves a newer page it offers that page,
 * which the page takes by itself once nothing typed would be lost (see `stale` below). */
class BodyBoundary extends Component<{ children: ReactNode; stale: boolean; onLost(): void; /** Makes the body fetchable again (bricks.tsx `again`). */ again?(): void }, { failed: boolean; tries: number; why: string }> {
  state = { failed: false, tries: 0, why: '' };
  private timer: ReturnType<typeof setTimeout> | undefined;
  // What was caught is kept, cut short, and shown under the sorry line: a brick that fails on one person's screen and
  // not another's can only be mended from what it said.
  static getDerivedStateFromError(error: unknown) { return { failed: true, why: (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/\s+/g, ' ').slice(0, 200) }; }
  componentDidCatch() {
    this.props.onLost();
    const wait = brickRetryMs[this.state.tries];
    if (wait !== undefined) this.timer = setTimeout(() => { this.props.again?.(); this.setState(({ tries }) => ({ failed: false, tries: tries + 1 })); }, wait);
  }
  componentWillUnmount() { clearTimeout(this.timer); }
  render() {
    if (!this.state.failed) return this.props.children;
    if (this.state.tries < brickRetryMs.length) return <Fetching />;
    return <Lost again={() => { this.props.again?.(); this.setState({ failed: false, tries: brickRetryMs.length }); }} reload={this.props.stale ? () => location.reload() : undefined} why={this.state.why} />;
  }
}

function BoardView({ board, live, stale, onRemove, onMaximize, onClose, onLost }: { board: Board; /** loom now serves a newer page than this one. */ stale: boolean; /** It is the board on screen (or sliding off it): its bricks are drawn. Any other board on the trail is its frames alone: no body, no read, no brick fetched. */ live: boolean; onRemove(id: string): void; onMaximize(id: string): void; onClose(): void; /** A brick's body could not be fetched. */ onLost(): void }) {
  const field = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = field.current!;
    const measure = () => setArea({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const placements = board.placements.map((p) => ({ ...p, view: brickView(p.brick), values: JSON.parse(p.params) as Params }));
  const slots = area.w ? layout(placements.map((p) => ({ id: p.id, fits: p.view.fits, big: p.big })), area) : new Map<string, Slot>();
  // A placement is drawn where it will rest and faded in; one already there moves by its transform.
  const seen = useRef(new Set<string>());
  const [, settle] = useState(0);
  useEffect(() => {
    const fresh = placements.filter((p) => slots.get(p.id) && !seen.current.has(p.id));
    if (!fresh.length) return;
    const frame = requestAnimationFrame(() => { for (const p of fresh) seen.current.add(p.id); settle((n) => n + 1); });
    return () => cancelAnimationFrame(frame);
  });
  const folded = placements.filter((p) => slots.get(p.id)?.form === 'folded');
  const lead = placements.find((p) => p.big) ?? placements[0];
  // An untitled board is headed by its leading brick's name alone: a reference is never a heading.
  const heading = board.title || (lead ? lead.view.title(lead.values) : '');
  // A brick's own flag: raised by the page when it sees the change happen, kept only while the page is open.
  const [own, setOwn] = useState<Record<string, string>>({});
  const raise = useCallback((id: string, name: string) => setOwn((now) => (now[id] === name ? now : { ...now, [id]: name })), []);
  const looked = (p: Placement) => {
    if (own[p.id]) setOwn(({ [p.id]: _gone, ...rest }) => rest);
    if (p.flagged) void memberOperation('boards.seen', { board: board.id, placement: p.id }).catch(() => {});
  };
  return (
    <section className="boards-board" aria-label={heading || 'Board'} data-live={live} inert={!live}>
      <header>
        <h1>{heading}</h1>
        {board.closed
          ? <button type="button" onClick={() => void memberOperation('boards.reopen', { board: board.id }).catch(() => {})}>Reopen</button>
          : <button type="button" onClick={onClose}>Close</button>}
      </header>
      <div ref={field} className="boards-field">
        {placements.map((p) => {
          const slot = slots.get(p.id);
          if (!slot || slot.form === 'folded') return null;
          const { Body } = p.view;
          return (
            <PlacementFrame key={p.id} title={p.view.title(p.values)} sub={p.view.sub(p.values)} form={slot.form} entering={!seen.current.has(p.id)}
              flag={p.flagged || own[p.id] ? own[p.id] || 'Look here' : undefined} closed={board.closed} canMaximize={p.canBeBig && !p.big}
              onMaximize={() => onMaximize(p.id)} onRemove={() => onRemove(p.id)} onLook={() => looked(p)}
              style={{ transform: `translate(${slot.x}px, ${slot.y}px)`, width: slot.w, height: slot.h }}>
              {live && <BodyBoundary stale={stale} onLost={onLost} again={p.view.again}><Suspense fallback={<Loading />}><Body params={p.values} form={slot.form} raise={(name) => raise(p.id, name)} act={(action, detail) => void memberOperation('boards.act', { board: board.id, placement: p.id, action, detail }).catch(() => {})} /></Suspense></BodyBoundary>}
            </PlacementFrame>
          );
        })}
      </div>
      <div className="boards-folded" data-flagged={folded.some((p) => p.flagged || own[p.id])}>
        {/* How many did not fit, said once, then each by its name and reference. */}
        {folded.length > 0 && <span className="boards-folded-count">{folded.length} more</span>}
        {folded.map((p) => { const sub = p.view.sub(p.values), words = <><i aria-hidden="true" />{p.view.title(p.values)}{sub && <> <small>{sub}</small></>}</>; return p.canBeBig && !board.closed
          ? <button key={p.id} type="button" className="board-chip" data-flagged={p.flagged || !!own[p.id]} title="Make this the big one"
              onPointerEnter={() => looked(p)} onClick={() => onMaximize(p.id)}>{words}</button>
          : <span key={p.id} className="board-chip" data-flagged={p.flagged || !!own[p.id]} onPointerEnter={() => looked(p)}>{words}</span>; })}
      </div>
    </section>
  );
}

export function Page({ member, thread, agent, at, exists = false }: { member: string; thread: string; agent: string; at?: At; /** The thread is already there: it was read. */ exists?: boolean }) {
  const read = useDataQuery<{ threadBoards: Board[] }>(`query ThreadBoards($thread:String!){threadBoards(thread:$thread){${boardFields}}}`, { thread }, { keep: true });
  const all = read.data?.threadBoards ?? [];
  const trail = all.filter((b) => !b.closed);
  const [wanted, want] = useState(() => address().board);
  // The page follows the thread: a board that joins the trail is the one shown; a closed one gives way.
  const newest = trail.at(-1);
  const lastTrail = useRef('');
  useEffect(() => {
    if (read.status !== 'live') return;
    if (newest && newest.trailAt > lastTrail.current) { if (lastTrail.current) want(newest.id); lastTrail.current = newest.trailAt; }
  }, [read.status, newest]);
  const shown = all.find((b) => b.id === wanted && (!b.closed || address().board === b.id)) ?? newest;
  useEffect(() => {
    if (read.status !== 'live') return;
    go(shown ? '/app/b/' + encodeURIComponent(shown.id) : '/app/t/' + encodeURIComponent(thread), !wanted);
  }, [read.status, shown?.id, thread, wanted]);
  // Back, forward and the list of conversations: the address is resolved above (Resolve), which hands down a new
  // `at` when it names this thread or one of its boards. Drawn alone, the page reads the address itself.
  useEffect(() => {
    if (at) return want(at.board);
    const back = () => want(address().board);
    addEventListener('popstate', back);
    return () => removeEventListener('popstate', back);
  }, [at]);
  const column = shown && !shown.closed ? trail.findIndex((b) => b.id === shown.id) : 0;
  const drawn = shown?.closed ? [shown] : trail;
  // Everything not on screen is paused (the owner, 2026-11-27): only the board shown draws its bricks, so only it
  // holds live reads. The board the page is sliding away from keeps its bricks until the slide ends, so it does not
  // empty while it is still in view; where nothing moves it lets go at once.
  const [onScreen, setOnScreen] = useState<{ shown?: string; leaving?: string }>({ shown: shown?.id });
  if (onScreen.shown !== shown?.id) setOnScreen({ shown: shown?.id, leaving: reducedMotion() ? undefined : onScreen.shown });
  const arrived = useCallback(() => setOnScreen((now) => (now.leaving ? { shown: now.shown } : now)), []);
  useEffect(() => {
    if (!onScreen.leaving) return;
    const late = setTimeout(arrived, SLIDE_MS + 100);
    return () => clearTimeout(late);
  }, [onScreen.leaving, onScreen.shown, arrived]);
  const answers = useMemo(() => rememberedFor(member), [member]);
  // The conversation this page is open on, for the bricks that must not treat it as any other (./brick-kit.tsx, Here).
  const here = useMemo(() => ({ thread }), [thread]);
  // A tab that was hidden and is seen again asks for its bricks' data now. A board that comes back on screen needs
  // no asking: its bricks open their reads anew, and a selection's first answer never waits.
  useEffect(() => {
    const seen = () => { if (document.visibilityState === 'visible') refreshRelaxed(); };
    document.addEventListener?.('visibilitychange', seen);
    return () => document.removeEventListener?.('visibilitychange', seen);
  }, []);

  const change = useCallback((board: string, changes: object[]) => memberOperation('boards.change', { board, changes }).catch(() => {}), []);
  const place = useCallback((p: Place) => {
    if (shown && !shown.closed) void change(shown.id, [{ change: 'place', ...p }]);
    else void memberOperation('boards.open', { thread, place: p }).catch(() => {});
  }, [shown, thread, change]);

  const [ready, setReady] = useState(exists), [tail, setTail] = useState<ThreadTail>(emptyTail);
  // What is typed is the desktop's Comms draft for this member and conversation (../pieces/comms/drafts.ts): kept in
  // this browser's own storage only, so it comes back after a reload or another conversation, and the same words are
  // in the desktop's composer for this thread. It leaves the browser only as the message, on Send, and goes when loom
  // acknowledges that send; a send that fails keeps it, with the same id, so sending again cannot post it twice.
  const composer = useCommsDraft(member, thread), words = composer.value.text;
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    if (exists) return;
    let live = true;
    memberOperation('comms.open', { thread, agent, title: 'Boards' }, thread.slice(3))
      .then(() => live && setReady(true)).catch(() => live && setError('Could not open the conversation.'));
    return () => { live = false; };
  }, [thread, agent, exists]);
  // Read, as Comms marks it: the conversation is on screen (not a closed sheet, not a hidden tab) and holds
  // something after the member's read mark. This is what makes "unread" in the list of conversations mean something.
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mark = () => {
      if (ready && tail.status === 'live' && tail.last > tail.read && document.visibilityState !== 'hidden' && (log.current?.clientHeight ?? 0) > 0)
        void memberOperation('comms.change', { thread, change: 'read', seq: tail.last }).catch(() => {});
    };
    mark();
    document.addEventListener?.('visibilitychange', mark);
    return () => document.removeEventListener?.('visibilitychange', mark);
  }, [ready, thread, tail.status, tail.last, tail.read, sheet]);
  const sending = useRef(false);
  async function send(e: FormEvent) {
    e.preventDefault();
    const sent = composer.value, text = sent.text.trim();
    if (!text || !ready || sending.current) return;
    sending.current = true; setBusy(true); setError('');
    try {
      await memberOperation('comms.send', { thread, clientId: sent.id, words: text, shows: { board: shown?.id ?? null } });
      composer.acknowledged(sent); setSheet(true);
    } catch { setError('Delivery unconfirmed. Send the same message to retry.'); }
    finally { sending.current = false; setBusy(false); }
  }
  // A deploy while the page is open: when the live read comes back, see whether loom serves a newer page, and
  // take it once nothing typed would be lost. The board is a record and the address holds its id, so the new
  // page opens on the same board. This is how a brick that did not exist a minute ago gets drawn.
  const [stale, setStale] = useState(false);
  const newer = useCallback(() => void buildChanged().then((changed) => changed && setStale(true)), []);
  useEffect(() => { if (read.status === 'live') newer(); }, [read.status, newer]);
  useEffect(() => { if (stale && !words.trim() && !busy) location.reload(); }, [stale, words, busy]);
  const mood: FaceState = error ? 'error' : !ready || tail.status === 'connecting' ? 'thinking' : tail.working ? 'working' : tail.update ? 'talking' : 'idle';
  const status = error || (!ready ? 'Connecting…' : tail.working ? (tail.tool ? 'Working · ' + tail.tool.split(' → ').at(-1) : 'Working') : tail.update ? 'Has a reply for you' : 'Here when you need me.');
  const names = useAgentNames(), name = names(agent);
  usePageTitle(thread, tail.update);
  useNotifyWorker();
  // The open thread's title, said beside the presence: the same selection the panel's rename and archive read.
  const head = useDataQuery<{ thread: { id: string; title: string } | null }>(threadHeadQuery, { id: thread }, { keep: true });
  const title = head.status === 'live' && head.data?.thread?.id === thread ? head.data.thread.title : '';

  return (
    <main className="boards-page pair-workspace" data-board={drawn.length > 0}
      onClick={(e) => {
        const target = e.target instanceof Element ? e.target : null;
        const chip = target?.closest<HTMLElement>('[data-place]');
        if (chip) return place(JSON.parse(chip.dataset.place!) as Place);
        const link = target?.closest('a');
        const ticket = link && /^\?ticket=(t-\d+)$/i.exec(link.getAttribute('href') || '');
        if (ticket && !e.metaKey && !e.ctrlKey) { e.preventDefault(); place({ brick: 'ticket', params: { ticket: ticket[1].toLowerCase() } }); }
      }}>
      {drawn.length > 0 && (
        <section className="boards-stage" aria-label="Board">
          <div className="boards-trail" style={{ transform: `translateX(${-100 * Math.max(0, column)}%)` }} onTransitionEnd={(e) => { if (e.target === e.currentTarget) arrived(); }}>
            <Remembered.Provider value={answers}><Here.Provider value={here}>
            {drawn.map((b) => (
              <BoardView key={b.id} board={b} live={b.id === shown?.id || b.id === onScreen.leaving} onRemove={(id) => void change(b.id, [{ change: 'remove', placement: id }])}
                onMaximize={(id) => void change(b.id, [{ change: 'maximize', placement: id }])}
                onClose={() => void memberOperation('boards.close', { board: b.id }).catch(() => {})} onLost={newer} stale={stale} />
            ))}
            </Here.Provider></Remembered.Provider>
          </div>
          {drawn.length > 1 && <div className="boards-dots" aria-hidden="true">{drawn.map((b) => <i key={b.id} data-on={b.id === shown?.id} />)}</div>}
        </section>
      )}
      <section className="boards-talk" aria-label="Conversation" data-sheet={sheet} data-empty={!tail.last}>
        <div className="boards-top">
          <button type="button" className="boards-presence" aria-expanded={sheet} onClick={() => setSheet((open) => !open)}>
            <AgentFace agent={agent} state={mood} size={FACE.presence} />
            <span className="boards-who">
              <span className="boards-name">{name}</span>
              {/* One quiet line: which conversation this is, as plain words, then how the agent stands. */}
              <span className="boards-where">{title && <span className="boards-thread-title">{title}</span>}<span role="status">{status}</span></span>
            </span>
          </button>
          {/* Stop for the whole conversation, only while the agent is working in it (./threads.tsx, ThreadStop). */}
          <ThreadStop thread={thread} member={member} name={name} />
          {/* The one control: the panel it opens holds the conversations, this one's rename and archive, and notifications. */}
          <ThreadSwitch thread={thread} visit={visit}>
            <ThreadHead thread={thread} member={member} visit={visit} />
            <Notify />
          </ThreadSwitch>
        </div>
        <BridgeReceipt thread={thread} agentName={names} />
        <div className="boards-log" ref={log}>
          <MessageScrollerProvider defaultScrollPosition="end" autoScroll>
            <MessageScroller>
              <MessageScrollerViewport preserveScrollOnPrepend aria-label="Conversation history">
                <MessageScrollerContent className="p-4">{ready && <TranscriptPage id={thread} visible onTail={setTail} />}</MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          </MessageScrollerProvider>
        </div>
        <form className="boards-ask" onSubmit={(e) => void send(e)}>
          <InputGroup>
            <InputGroupTextarea aria-label={'Message ' + name} placeholder="What are we doing now?" value={words} autoFocus
              onChange={(e) => composer.edit(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
            <InputGroupAddon align="block-end">
              <InputGroupButton className="ms-auto" type="submit" variant="default" size="icon-sm" aria-label="Send" disabled={busy || !ready || !words.trim()}><ArrowUpIcon /></InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </section>
      <span hidden>{member}</span>
    </main>
  );
}

/** Finds the thread the address names, or the member's own boards thread with the household's first agent. The
 * address is read again when the member goes back or forward or chooses another conversation. While the new address
 * is being resolved the page on screen stays as it is, untold: it is replaced only by another thread's page, and a
 * board of its own thread is handed to it. */
export function Resolve({ member }: { member: string }) {
  const [at, setAt] = useState(address);
  useEffect(() => {
    const read = () => setAt(address());
    moved.add(read); addEventListener('popstate', read);
    return () => { moved.delete(read); removeEventListener('popstate', read); };
  }, []);
  const home = useDataQuery<{ homeComms: { agents: string[] } | null }>('query BoardsHome{homeComms{agents}}');
  const board = useDataQuery<{ board: { thread: string } | null }>('query BoardThread($id:String!){board(id:$id){thread}}', { id: at.board ?? '' }, { pause: !at.board });
  const boardThread = at.board ? board.data?.board?.thread : undefined;
  const wanted = at.thread ?? boardThread;
  const named = useDataQuery<{ thread: { id: string; agent: string } | null }>('query BoardsThread($id:String!){thread:commsThread(id:$id){id agent}}',
    { id: wanted ?? '' }, { pause: !wanted });
  const shown = useRef<{ thread: string; agent: string; exists: boolean; at: At } | null>(null);
  const none = (words: string) => { shown.current = null; return <p role="status" className="p-6">{words}</p>; };
  const waiting = () => (shown.current ? <Page key={shown.current.thread} member={member} {...shown.current} /> : <p role="status" className="p-6">Opening…</p>);
  if (home.status === 'loading' || (at.board && board.status === 'loading')) return waiting();
  if (at.board && !boardThread) return none('There is nothing here.');
  if (wanted) {
    if (named.status === 'loading') return waiting();
    if (named.data?.thread?.id !== wanted) return none('There is nothing here.');
    if (shown.current?.at !== at) shown.current = { thread: wanted, agent: named.data.thread.agent, exists: true, at };
  } else {
    const agent = home.data?.homeComms?.agents[0];
    if (!agent) return none('No agent is available.');
    if (shown.current?.at !== at) shown.current = { thread: threadId('th:board-', [member, agent]), agent, exists: false, at };
  }
  return <Page key={shown.current!.thread} member={member} {...shown.current!} />;
}

function App() {
  const { session, login, message } = useSession();
  // What the page remembered of a member's bricks ends with their session.
  const viewer = session?.viewer?.id;
  useEffect(() => { if (!viewer) forgetAnswers(); }, [viewer]);
  return session?.viewer ? <><Wear /><Resolve member={session.viewer.id} /></> : (
    <main className="p-6">
      {session ? <Button onClick={() => void login()}>Sign in with a passkey</Button> : <p>Connecting to Loom…</p>}
      {message && <p role="status">{message}</p>}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
