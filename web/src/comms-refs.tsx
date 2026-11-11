// The loom things a thread names, as chips (docs/specs/comms.md, "Chips"): a task (t-12), a pull request
// (acme/app#3), an approval (a-0123abcd), a conversation (cv-…), a note (note:<path>), a knowledge page ([[slug]]),
// a project (project:slug), a person (person:slug) and an agent or person by @name. Each is its words until loom says
// what it is for this viewer (GET /comms/<thread>/refs, asked in batches as they're drawn); then it's a chip that opens
// a small card (its title, its state, Open), or, when this viewer couldn't open it, it stays its words. Part of the
// Comms chunk.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { List, LinkRow } from './kit';
import { useEnv } from './blocks';
import { watchTasks } from './tasks-live';
import { taskCardsOf } from './task-ref-cards';
import type { Rec } from './collections/runtime';

export type RefKind = 'task' | 'pr' | 'approval' | 'conv' | 'note' | 'knowledge' | 'project' | 'person' | 'agent';
export interface RefCard { kind: RefKind; title: string; status?: string; tone?: 'bad' | 'warn' | 'ok'; page?: string; href?: string }

/** Where a card's Open may go inside loom, by exact shape: anything else isn't offered (the server's CARD_PAGE, the same:
 * src/ui/pixel-talk.test.ts checks they agree). */
const PAGE = /^(?:p\/[a-z0-9-]{1,40}\/task\/t-\d{1,9}|conversation\/cv-[0-9a-f]{12}|knowledge\/[a-z0-9][a-z0-9-]{0,79}|projects\/[a-z0-9][a-z0-9-]{0,79}|people\/[a-z0-9][a-z0-9-]{0,79}|a\/[a-z][a-z0-9-]{0,39}|inbox)$/;
export const cardPage = (c: RefCard): string | undefined => (c.page && PAGE.test(c.page) ? `/${c.page}` : undefined);
export const cardHref = (c: RefCard): string | undefined => (c.href && /^https:\/\/[^\s<>"'\\]{1,500}$/.test(c.href) ? c.href : undefined);

const KIND_WORD: Record<RefKind, string> = { task: 'Task', pr: 'Pull request', approval: 'Approval', conv: 'Conversation', note: 'Note', knowledge: 'Knowledge', project: 'Project', person: 'Person', agent: 'Agent' };

/** A piece of text cut where it names something (the server's own shapes, comms-refs.ts refShape). */
export type RefBit = { t: 'text'; s: string } | { t: 'ref'; ref: string; s: string };
const RE = /\b(t-\d{1,9})\b|(?<![\w./-])([\w.-]+\/)?([\w.-]+)#(\d{1,10})\b|\b(a-[0-9a-f]{8})\b|\b(cv-[0-9a-f]{12})\b|(?<![\w])note:([A-Za-z0-9][\w./-]{0,199})|\[\[([a-z0-9][a-z0-9-]{0,79})\]\]|\b(project|person|agent):([a-z0-9][a-z0-9-]{0,79})\b|(?<![\w@./-])@([a-z][a-z0-9-]{0,39})\b/g;

/** Text cut into words and refs. A bare repo#N is a ref only under the household's GitHub owner. */
export function refBits(s: string, owner?: string): RefBit[] {
  const out: RefBit[] = [];
  let at = 0;
  RE.lastIndex = 0;
  for (let m; (m = RE.exec(s));) {
    let ref: string | undefined, words = m[0], len = m[0].length;
    if (m[1]) ref = m[1];
    else if (m[4]) { const o = m[2] ? m[2].slice(0, -1) : owner; if (o) ref = `github:${o}/${m[3]}#${m[4]}`; }
    else if (m[5]) ref = m[5];
    else if (m[6]) ref = m[6];
    else if (m[7]) { const p = m[7].replace(/[./]+$/, ''); if (p && !p.split('/').includes('..')) { ref = `note:${p}`; words = `note:${p}`; len = words.length; } }
    else if (m[8]) { ref = `knowledge:${m[8]}`; words = m[8]; }
    else if (m[9]) ref = `${m[9]}:${m[10]}`;
    else if (m[11]) ref = `at:${m[11]}`;
    if (!ref) continue;
    if (m.index > at) out.push({ t: 'text', s: s.slice(at, m.index) });
    out.push({ t: 'ref', ref, s: words });
    at = m.index + len;
    RE.lastIndex = at;
  }
  if (at < s.length) out.push({ t: 'text', s: s.slice(at) });
  return out;
}

// ---- what a thread knows of its refs ---------------------------------------------------------------

/** The most refs one read asks (the server answers at most this many: src/comms-refs.ts REFS_MAX). */
export const BATCH = 60;
/** Refs in reads of at most BATCH, each once. */
export function batches(refs: string[]): string[][] {
  const once = [...new Set(refs)];
  const out: string[][] = [];
  for (let i = 0; i < once.length; i += BATCH) out.push(once.slice(i, i + BATCH));
  return out;
}

type Cards = ReadonlyMap<string, RefCard | null>;
interface RefsApi { cards: Cards; want: (refs: string[]) => void; open: (ref: string, at: HTMLElement) => void }
const RefsContext = createContext<RefsApi | null>(null);
export const useRefs = () => useContext(RefsContext);

/** A thread's refs: asked for as they're drawn (a batch at a time), asked again `refresh` after it changes (a new reply
 * may have moved a task), and the one card open. */
export function ThreadRefs({ thread, refresh, csrf, member, children }: { thread: string; refresh: number; csrf: string; member: string; children: ReactNode }) {
  const [cards, setCards] = useState<Cards>(() => new Map());
  const asked = useRef(new Set<string>());
  const queue = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (again.current) clearTimeout(again.current); }; }, []);
  // A read that failed: what isn't known yet is asked again in 15 s (until then it reads as its words).
  const again = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retry = () => {
    if (again.current || !alive.current) return;
    again.current = setTimeout(() => { again.current = null; const left = [...asked.current].filter((x) => !cardsNow.current.has(x)); if (left.length) void fetchSome(left); }, 15_000);
  };
  const cardsNow = useRef<Cards>(new Map());
  const fetchSome = useCallback(async (refs: string[]) => {
    for (const part of batches(refs)) {
      try {
        const r = await fetch(`/comms/${thread}/refs?${part.map((x) => `r=${encodeURIComponent(x)}`).join('&')}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
        if (!r.ok) { retry(); continue; }
        const got = ((await r.json()) as { refs?: Record<string, RefCard | null> }).refs ?? {};
        if (!alive.current) return;
        setCards((m) => { const n = new Map(m); for (const x of part) n.set(x, got[x] ?? null); return n; });
      } catch { retry(); }
    }
  }, [thread]);   // eslint-disable-line react-hooks/exhaustive-deps
  const want = useCallback((refs: string[]) => {
    for (const r of refs) if (!asked.current.has(r)) { asked.current.add(r); queue.current.add(r); }
    if (!queue.current.size || timer.current) return;
    timer.current = setTimeout(() => { timer.current = null; const q = [...queue.current]; queue.current.clear(); void fetchSome(q); }, 40);
  }, [fetchSome]);
  // A new reply: what's known is asked again, a moment later (once the pieces have seen what it did).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => { if (asked.current.size) void fetchSome([...asked.current]); }, 5_000);
    return () => clearTimeout(t);
  }, [refresh, fetchSome]);
  cardsNow.current = cards;
  // Only already-admitted chips read these records; absent rows can be outside the recent window.
  const [tasks, setTasks] = useState<ReadonlyMap<string, Rec>>(() => new Map());
  const needsTasks = [...cards].some(([ref, card]) => card?.kind === 'task' && card.page === `p/tasks/task/${ref}`);
  useEffect(() => {
    setTasks(new Map());
    if (!csrf || !needsTasks) return;
    return watchTasks(csrf, (_keys, records) => setTasks(records), true);
  }, [csrf, needsTasks]);
  const liveCards = useMemo(() => taskCardsOf(cards, tasks, member), [cards, tasks, member]);
  const [shown, setShown] = useState<{ ref: string; at: HTMLElement } | null>(null);
  const open = useCallback((ref: string, at: HTMLElement) => setShown((s) => (s?.ref === ref && s.at === at ? null : { ref, at })), []);
  const api = useMemo(() => ({ cards: liveCards, want, open }), [liveCards, want, open]);
  return (
    <RefsContext.Provider value={api}>
      {children}
      {shown && liveCards.get(shown.ref) && <RefPopover card={liveCards.get(shown.ref)!} at={shown.at} onClose={() => setShown(null)} />}
    </RefsContext.Provider>
  );
}

/** The card a chip opens: what it is, its title, its state, and Open (in its app's tile, or GitHub in a new tab). */
function RefPopover({ card, at, onClose }: { card: RefCard; at: HTMLElement; onClose: () => void }) {
  const { go } = useEnv();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = at.getBoundingClientRect();
      const w = Math.min(300, window.innerWidth - 32);
      const h = box.current?.offsetHeight ?? 120;
      const left = Math.max(16, Math.min(r.left, window.innerWidth - w - 16));
      const below = r.bottom + 6 + h <= window.innerHeight - 8;
      setPos({ left, top: below ? r.bottom + 6 : Math.max(8, r.top - 6 - h) });
    };
    place();
    const close = (e: Event) => { if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return; if (e.type === 'pointerdown' && (box.current?.contains(e.target as Node) || at.contains(e.target as Node))) return; onClose(); };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close);
    window.addEventListener('resize', place);
    const scroller = at.closest('.comms-msgs');
    scroller?.addEventListener('scroll', onClose, { passive: true });
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', close); window.removeEventListener('resize', place); scroller?.removeEventListener('scroll', onClose); };
  }, [at, onClose]);
  useEffect(() => { box.current?.querySelector<HTMLElement>('a,button')?.focus({ preventScroll: true }); }, []);
  const page = cardPage(card), href = cardHref(card);
  return createPortal(
    <div ref={box} className="comms-refcard" role="dialog" aria-label={`${KIND_WORD[card.kind]}: ${card.title}`} data-kind={card.kind}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}>
      <List label="Reference preview"><LinkRow title={card.title} meta={KIND_WORD[card.kind]} status={card.status} tone={card.tone} /></List>
      {page ? <a className="comms-refcard__open" href={page} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); onClose(); go(page); }}>Open</a>
        : href ? <a className="comms-refcard__open" href={href} target="_blank" rel="noopener noreferrer" onClick={onClose}>Open on GitHub ↗</a>
          : <span className="loom-data text-xs opacity-70">{card.kind === 'note' ? 'Notes have no page yet' : ''}</span>}
    </div>, document.body);
}

/** One ref in React-drawn text (a step, an ask's refs): its words until it's known; a chip when this viewer may open it. */
export function RefChip({ r, words }: { r: string; words: string }) {
  const refs = useRefs();
  const card = refs?.cards.get(r);
  useEffect(() => { refs?.want([r]); }, [r]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!card) return <>{words}</>;
  return (
    <button type="button" className="comms-chip" data-kind={card.kind} data-tone={card.tone} aria-haspopup="dialog"
      aria-label={`${KIND_WORD[card.kind]} ${words}: ${card.title}${card.status ? `, ${card.status}` : ''}`}
      onClick={(e) => { e.stopPropagation(); refs!.open(r, e.currentTarget); }}>{words}</button>
  );
}

/** Text with its refs as chips. */
export function RefText({ text, owner }: { text: string; owner?: string }) {
  const parts = useMemo(() => refBits(text, owner), [text, owner]);
  return <>{parts.map((p, k) => (p.t === 'text' ? <span key={k}>{p.s}</span> : <RefChip key={k} r={p.ref} words={p.s} />))}</>;
}

/**
 * The refs inside markdown loom drew as HTML (a reply): each element marked `data-ref` asked for, then made a chip
 * (`data-chip`, a button's role and focus) once it's known, or its words once it's known that this viewer can't open
 * it. Until then it reads as words (comms.css: a ref not yet a chip has no link look and takes no click).
 */
export function useHtmlRefs(box: React.RefObject<HTMLElement | null>, html: string): (e: React.MouseEvent | React.KeyboardEvent) => boolean {
  const refs = useRefs();
  useEffect(() => {
    const el = box.current;
    if (!el || !refs) return;
    const marked = [...el.querySelectorAll<HTMLElement>('[data-ref]')];
    refs.want(marked.map((m) => m.dataset.ref!));
    for (const m of marked) {
      const ref = m.dataset.ref!;
      const card = refs.cards.get(ref);
      // Unknown yet, or not this reader's to open: its words (it stays marked, so a later answer can still make it a chip).
      if (!card) {
        if (m.dataset.chip === undefined) continue;
        for (const k of ['chip', 'kind', 'tone']) delete m.dataset[k];
        for (const a of ['aria-haspopup', 'aria-label', 'role', 'tabindex']) m.removeAttribute(a);
        continue;
      }
      m.dataset.chip = '';
      m.dataset.kind = card.kind;
      if (card.tone) m.dataset.tone = card.tone; else delete m.dataset.tone;
      m.setAttribute('aria-haspopup', 'dialog');
      m.setAttribute('aria-label', `${KIND_WORD[card.kind]} ${m.textContent ?? ''}: ${card.title}${card.status ? `, ${card.status}` : ''}`);
      m.setAttribute('role', 'button');
      m.tabIndex = 0;
    }
  }, [box, html, refs?.cards]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-chip][data-ref]');
    if (!chip || !refs) return false;
    if ('key' in e && e.key !== 'Enter' && e.key !== ' ') return false;
    e.preventDefault();
    refs.open(chip.dataset.ref!, chip);
    return true;
  };
}
