/** The boards page (docs/specs/boards.md): a conversation, and a second window the agent fills from bricks.
 * The page draws the thread's boards and nothing else there; what is on screen is a record, never page state. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpIcon } from 'lucide-react';
import { useDataQuery } from '../data/graphql';
import { memberOperation } from '../data/operation';
import { newId } from '../data/id';
import { useSession } from '../signin/use-session';
import { Portrait } from '../contexts/portrait';
import type { FaceState } from '../face';
import { Button } from '../pair/ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '../pair/ui/input-group';
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from '../pair/ui/message-scroller';
import { emptyTail, threadId, TranscriptPage, type ThreadTail } from '../pair/transcript';
import { brickView, type Params, type Place } from './bricks';
import { layout, type Slot } from './layout';
import { buildChanged } from './build';
import { wearMotion } from '../access';
import '../pair/screen.css';
import './board.css';

// This page has no boot script and no settings of its own, so it follows the device: access.ts answers what moves.
wearMotion('follow');

type Placement = { id: string; brick: string; params: string; rank: number; placedByKind: string; big: boolean; canBeBig: boolean; flagged: boolean };
type Board = { id: string; thread: string; title: string; revision: number; closed: boolean; trailAt: string; placements: Placement[] };
const boardFields = 'id thread title revision closed trailAt placements{id brick params rank placedByKind big canBeBig flagged}';

/** The one id the address holds: a board's, a thread's, or none. */
function address(): { board?: string; thread?: string } {
  const [, , kind, id] = location.pathname.split('/');
  return kind === 'b' && id ? { board: decodeURIComponent(id) } : kind === 't' && id ? { thread: decodeURIComponent(id) } : {};
}
const go = (path: string, replace = false) => { if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState'](null, '', path); };

function BoardView({ board, onRemove, onMaximize, onClose }: { board: Board; onRemove(id: string): void; onMaximize(id: string): void; onClose(): void }) {
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
    <section className="boards-board" aria-label={heading || 'Board'}>
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
            <article key={p.id} className="board-placement" data-form={slot.form} data-entering={!seen.current.has(p.id)}
              data-flagged={p.flagged || !!own[p.id]} onPointerEnter={() => looked(p)} onFocus={() => looked(p)}
              style={{ transform: `translate(${slot.x}px, ${slot.y}px)`, width: slot.w, height: slot.h }}>
              <header>
                <div className="board-names"><h2>{p.view.title(p.values)}</h2><small className="font-mono">{p.view.sub(p.values)}</small></div>
                {(p.flagged || own[p.id]) && <span className="board-flag" role="status">{own[p.id] || 'Look here'}</span>}
                {!board.closed && p.canBeBig && !p.big && <button type="button" className="board-maximize" aria-label={'Make ' + p.view.title(p.values) + ' the big one'} onClick={() => onMaximize(p.id)}>⤢</button>}
                {!board.closed && <button type="button" className="board-remove" aria-label={'Remove ' + p.view.title(p.values)} onClick={() => onRemove(p.id)}>✕</button>}
              </header>
              <div inert={board.closed}><Body params={p.values} form={slot.form} raise={(name) => raise(p.id, name)} act={(action, detail) => void memberOperation('boards.act', { board: board.id, placement: p.id, action, detail }).catch(() => {})} /></div>
            </article>
          );
        })}
      </div>
      <div className="boards-folded" data-flagged={folded.some((p) => p.flagged || own[p.id])}>
        {folded.length > 0 && 'Also here'}
        {folded.map((p) => p.canBeBig && !board.closed
          ? <button key={p.id} type="button" className="board-chip" data-flagged={p.flagged || !!own[p.id]} title="Make this the big one"
              onPointerEnter={() => looked(p)} onClick={() => onMaximize(p.id)}><i aria-hidden="true" />{p.view.title(p.values)} · {p.view.sub(p.values)}</button>
          : <span key={p.id} className="board-chip" data-flagged={p.flagged || !!own[p.id]} onPointerEnter={() => looked(p)}><i aria-hidden="true" />{p.view.title(p.values)} · {p.view.sub(p.values)}</span>)}
      </div>
    </section>
  );
}

export function Page({ member, thread, agent }: { member: string; thread: string; agent: string }) {
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
  useEffect(() => {
    const back = () => want(address().board);
    addEventListener('popstate', back);
    return () => removeEventListener('popstate', back);
  }, []);
  const column = shown && !shown.closed ? trail.findIndex((b) => b.id === shown.id) : 0;
  const drawn = shown?.closed ? [shown] : trail;

  const change = useCallback((board: string, changes: object[]) => memberOperation('boards.change', { board, changes }).catch(() => {}), []);
  const place = useCallback((p: Place) => {
    if (shown && !shown.closed) void change(shown.id, [{ change: 'place', ...p }]);
    else void memberOperation('boards.open', { thread, place: p }).catch(() => {});
  }, [shown, thread, change]);

  const [ready, setReady] = useState(false), [tail, setTail] = useState<ThreadTail>(emptyTail);
  const [words, setWords] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    let live = true;
    memberOperation('comms.open', { thread, agent, title: 'Boards' }, thread.slice(3))
      .then(() => live && setReady(true)).catch(() => live && setError('Could not open the conversation.'));
    return () => { live = false; };
  }, [thread, agent]);
  const sending = useRef(false);
  async function send(e: FormEvent) {
    e.preventDefault();
    const text = words.trim();
    if (!text || !ready || sending.current) return;
    sending.current = true; setBusy(true); setError('');
    try {
      const clientId = newId();
      await memberOperation('comms.send', { thread, clientId, words: text, shows: { board: shown?.id ?? null } }, clientId);
      setWords((now) => (now.trim() === text ? '' : now)); setSheet(true);
    } catch { setError('Delivery unconfirmed. Send the same message to retry.'); }
    finally { sending.current = false; setBusy(false); }
  }
  // A deploy while the page is open: when the live read comes back, see whether loom serves a newer page, and
  // take it once nothing typed would be lost. The board is a record and the address holds its id, so the new
  // page opens on the same board. This is how a brick that did not exist a minute ago gets drawn.
  const [stale, setStale] = useState(false);
  useEffect(() => { if (read.status === 'live') void buildChanged().then((changed) => changed && setStale(true)); }, [read.status]);
  useEffect(() => { if (stale && !words.trim() && !busy) location.reload(); }, [stale, words, busy]);
  const mood: FaceState = error ? 'error' : !ready || tail.status === 'connecting' ? 'thinking' : tail.working ? 'working' : tail.update ? 'talking' : 'idle';
  const status = error || (!ready ? 'Connecting…' : tail.working ? (tail.tool ? 'Working · ' + tail.tool.split(' → ').at(-1) : 'Working') : tail.update ? 'Has a reply for you' : 'Here when you need me.');
  const name = agent === 'art' ? 'Art' : agent;

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
          <div className="boards-trail" style={{ transform: `translateX(${-100 * Math.max(0, column)}%)` }}>
            {drawn.map((b) => (
              <BoardView key={b.id} board={b} onRemove={(id) => void change(b.id, [{ change: 'remove', placement: id }])}
                onMaximize={(id) => void change(b.id, [{ change: 'maximize', placement: id }])}
                onClose={() => void memberOperation('boards.close', { board: b.id }).catch(() => {})} />
            ))}
          </div>
          {drawn.length > 1 && <div className="boards-dots" aria-hidden="true">{drawn.map((b) => <i key={b.id} data-on={b.id === shown?.id} />)}</div>}
        </section>
      )}
      <section className="boards-talk" aria-label="Conversation" data-sheet={sheet} data-empty={!tail.last}>
        <button type="button" className="boards-presence" aria-expanded={sheet} onClick={() => setSheet((open) => !open)}>
          {agent === 'art' && <span className="boards-face" aria-hidden="true"><Portrait className="art-portrait shrink-0" state={mood} /></span>}
          <span className="min-w-0"><span className="block font-semibold">{name}</span><span role="status" className="block text-sm text-muted-foreground">{status}</span></span>
        </button>
        <div className="boards-log">
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
              onChange={(e) => setWords(e.target.value)}
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

/** Finds the thread the address names, or the member's own boards thread with the household's first agent. */
function Resolve({ member }: { member: string }) {
  const at = address();
  const home = useDataQuery<{ homeComms: { agents: string[] } | null }>('query BoardsHome{homeComms{agents}}');
  const board = useDataQuery<{ board: { thread: string } | null }>('query BoardThread($id:String!){board(id:$id){thread}}', { id: at.board ?? '' }, { pause: !at.board });
  const named = useDataQuery<{ thread: { id: string; agent: string } | null }>('query BoardsThread($id:String!){thread:commsThread(id:$id){id agent}}',
    { id: at.thread ?? board.data?.board?.thread ?? '' }, { pause: !(at.thread ?? board.data?.board?.thread) });
  if (home.status === 'loading' || (at.board && board.status === 'loading')) return <p role="status" className="p-6">Opening…</p>;
  if (at.board && !board.data?.board) return <p role="status" className="p-6">There is nothing here.</p>;
  const wanted = at.thread ?? board.data?.board?.thread;
  if (wanted) {
    if (named.status === 'loading') return <p role="status" className="p-6">Opening…</p>;
    if (!named.data?.thread) return <p role="status" className="p-6">There is nothing here.</p>;
    return <Page key={wanted} member={member} thread={wanted} agent={named.data.thread.agent} />;
  }
  const agent = home.data?.homeComms?.agents[0];
  if (!agent) return <p role="status" className="p-6">No agent is available.</p>;
  return <Page member={member} thread={threadId('th:board-', [member, agent])} agent={agent} />;
}

function App() {
  const { session, login, message } = useSession();
  return session?.viewer ? <Resolve member={session.viewer.id} /> : (
    <main className="p-6">
      {session ? <Button onClick={() => void login()}>Sign in with a passkey</Button> : <p>Connecting to Loom…</p>}
      {message && <p role="status">{message}</p>}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
