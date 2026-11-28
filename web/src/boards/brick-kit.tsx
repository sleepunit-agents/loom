/** What every brick's module shares (docs/specs/boards.md, "The first bricks"): the types of a brick's body, the two
 * one-line states, the chip that places another brick, and the watch a brick keeps on its own record. A brick's
 * module imports this file and never another brick's module, so each brick is loaded alone (./bricks.tsx). */
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { briefTime, fullTime } from '../kit/time';
import { knowledgePageRef } from '../../../src/core/boards/refs';
import { LIVE_RELAXED_MS } from '../../../src/core/data/live-pace';
import type { Form } from './layout';

export type Params = Record<string, string | number | undefined>;
export type Place = { brick: string; params: Params };
/** Report a brick's action after its own operation succeeded. */
export type Act = (action: string, detail: Record<string, string>) => void;
/** Mark this placement: its record changed in a way the brick flags itself for, and the member did not do it. */
export type Raise = (name: string) => void;
export type BodyProps = { params: Params; form: Form; act: Act; raise: Raise };

/** How long after the member's own action here a change to the same value is taken to be that action. The page asks
 * for a brick's data the moment its own write is answered, so the change is usually back in a tenth of a second;
 * if that asking is lost, it arrives with the next relaxed reading, which this still covers. */
export const OWN_ACTION_MS = LIVE_RELAXED_MS + 2000;
/** Watches one value of a brick's record. When it changes while the page is open, and the change was not the
 * member's own doing here a moment ago, the brick flags itself with the name the change is given. A brick's data is
 * read every few seconds, so several changes may arrive as one: the flag is for the difference between what was
 * shown and what is shown now, once. */
export function useOwnFlag<T>(value: T | undefined, raise: Raise, name: (before: T, now: T) => string | null) {
  const before = useRef<T | undefined>(undefined), mine = useRef(0);
  useEffect(() => {
    const was = before.current;
    before.current = value;
    if (was === undefined || value === undefined || was === value) return;
    if (Date.now() - mine.current < OWN_ACTION_MS) { mine.current = 0; return; }
    const called = name(was, value);
    if (called) raise(called);
  });
  return () => { mine.current = Date.now(); };
}

export const words = (v: unknown) => (v === undefined || v === null ? '' : String(v));
/** Written words as one plain line for a compact form: markdown's marks are left out, its words kept. */
export const plain = (text: string) => text.replace(/[*_`#>]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
export const Unavailable = ({ what }: { what: string }) => <p className="board-note">This {what} is unavailable.</p>;
export const Loading = () => <p role="status" className="board-note">Loading…</p>;

/* ── The bricks' vocabulary (docs/specs/boards.md, "The design kit"; styles in ./board-kit.css) ────────────────────
 * Every brick is made of these and of nothing else of its own: one lead, facts, rows, a state, sections, actions.
 * They hold no data and call nothing. Labels wrap; nothing here cuts a word short. */

/** What a brick's body may know of the placement around it (./placement.tsx): the element its body is drawn in, and
 * the way to make the placement the big one, where it can be, and whether its data is still a remembered answer. Drawn alone, as the suites draw a body, it has neither. */
export const Frame = createContext<{ body?: RefObject<HTMLElement | null>; maximize?(): void; /** One of its reads still shows a remembered answer: the fresh one has not arrived. */ settling?: boolean }>({});
/** Whether the brick is drawn from an answer the page remembered and the fresh one has not arrived yet. A brick whose
 * controls must never act on old data (an approval's answer, a secret's) waits for this to be false. */
export const useSettling = () => !!useContext(Frame).settling;
/** The page a brick is drawn on: the conversation open on it right now (./main.tsx). A brick never acts on that
 * conversation as if it were any other (the `threads` brick offers no Delete for it). Drawn alone, it is no thread. */
export const Here = createContext<{ thread?: string }>({});
export const useHereThread = () => useContext(Here).thread;

/** "and N more": what a list left out, said quietly. Where the placement can be the big one, the words are the
 * control that makes it so (the frame's own maximize); anywhere else they are a line. */
export function More({ n, words = 'more' }: { n: number; words?: string }) {
  const { maximize } = useContext(Frame);
  if (n <= 0) return null;
  return maximize ? <button type="button" className="board-more" onClick={maximize}>and {n}{' ' + words}</button> : <p className="board-note">and {n}{' ' + words}</p>;
}
/** A list in a small form: as many of its things as the placement has room for, never fewer than one, so a side form
 * is a glance that does not scroll (`least` says how few it may come down to: one, unless the brick says none). `first` is how many are drawn where nothing can be measured. The children draw
 * the ones shown and are told how many were left out. */
export function Few<T>({ of, first, fit = true, most = 12, least = 1, children }: { of: readonly T[]; first: number; least?: number; /** False where the form may scroll (the primary): `first` are drawn and nothing is measured. */ fit?: boolean; most?: number; children(shown: readonly T[], hidden: number): ReactNode }) {
  const frame = useContext(Frame), body = fit ? frame.body : undefined;
  const top = Math.min(of.length, most);
  const [shown, setShown] = useState(Math.min(of.length, first)), measured = useRef(''), [, again] = useState(0);
  useLayoutEffect(() => {
    const el = body?.current;
    if (!el || !el.clientHeight) return;
    const room = `${of.length}:${el.clientWidth}:${el.clientHeight}`;
    if (measured.current !== room) { measured.current = room; if (shown !== top) return setShown(top); }
    if (shown > least && el.scrollHeight > el.clientHeight + 1) setShown(shown - 1);
  });
  useEffect(() => {
    const el = body?.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => again((n) => n + 1));
    watch.observe(el);
    // Words measured before the page's own type arrived are measured again in it.
    let live = true;
    void document.fonts?.ready.then(() => { if (live) { measured.current = ''; again((n) => n + 1); } });
    return () => { live = false; watch.disconnect(); };
  }, [body]);
  // Where nothing is measured the count is worked out afresh each time: a list that grows while the page is
  // open shows its new row, and is not held to the number it started with.
  const n = body ? Math.min(shown, of.length) : Math.min(of.length, first);
  return <>{children(of.slice(0, n), of.length - n)}</>;
}

/** Prose in a small form: its first few lines, fading where it goes on. The whole of it is in the primary form. */
export const Excerpt = ({ lines = 3, children }: { lines?: number; children: ReactNode }) => <div className="board-excerpt" style={{ '--lines': lines } as React.CSSProperties}>{children}</div>;

/** n things, in words: `count(1, 'ticket')` is "1 ticket", `count(3, 'ticket')` is "3 tickets". */
export const count = (n: number, one: string, many: string = one + 's') => `${n} ${n === 1 ? one : many}`;

/** What a brick is about: the one line its primary form leads with. */
export const Lead = ({ children }: { children: ReactNode }) => <p className="board-lead">{children}</p>;
/** A quiet line: a summary, a count, an empty list, a reason. */
export const Note = ({ children, ...rest }: { children: ReactNode } & Record<`data-${string}`, string>) => <p className="board-note" {...rest}>{children}</p>;
/** Something that did not work, said where it happened. */
export const Problem = ({ children }: { children: ReactNode }) => (children ? <p role="alert" className="board-problem">{children}</p> : null);

/** The fixed tones of a state. A record's own states are mapped onto these and onto nothing else. */
export type Tone = 'neutral' | 'working' | 'waiting' | 'good' | 'bad' | 'muted';
/** Where a record stands: a mark and its word, in the state's own words (underscores read as spaces). */
export const State = ({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) => (
  <span className="board-state" data-tone={tone}>{typeof children === 'string' ? children.replaceAll('_', ' ') : children}</span>
);

/** How fresh a knowledge page is, as a tone: the page and the list of pages say it the same way. */
export const freshTone: Record<'fresh' | 'aging' | 'due', Tone> = { fresh: 'good', aging: 'neutral', due: 'waiting' };

/** A part of a brick under its own small heading, with a count where it lists things. */
export function Section({ title, count: n, children }: { title: string; count?: number | string; children: ReactNode }) {
  return <section className="board-section"><h3><span>{title}</span>{n !== undefined && <small>{n}</small>}</h3>{children}</section>;
}

/** A part of a brick that is read only once it is opened: its heading is the control, and says whether it is open.
 * One name for the part, whichever way it stands; what it holds is drawn under it like any section's. */
export function Fold({ title, open, onToggle, children }: { title: string; open: boolean; onToggle(): void; children?: ReactNode }) {
  return <section className="board-section"><h3><button type="button" className="board-fold" aria-expanded={open} onClick={onToggle}>{title}</button></h3>{open && children}</section>;
}

/** Label and value pairs. A short value sits beside its label; a `wide` one (prose) sits under it. */
export const Facts = ({ children }: { children: ReactNode }) => <dl className="board-facts">{children}</dl>;
export const Fact = ({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) => (
  <div data-wide={wide || undefined}><dt>{label}</dt><dd>{children}</dd></div>
);

/** A list of records, one to a row, parted by a hairline. Where a placement is narrow a row's end goes under its
 * words; `beside` keeps it at the row's right at any width, for an end that is one short thing (a state, a time). */
export const Rows = ({ children, label, beside }: { children: ReactNode; label?: string; beside?: boolean }) => <ul className="board-rows" aria-label={label} data-ends={beside ? 'beside' : undefined}>{children}</ul>;
/** One record in a list: its title, a quiet line under it, what stands at its end (a state, a time), and any
 * controls below. With `place` the title is the control that places that record's brick. */
export function Row({ title, meta, end, place, children, flagged }: { title: ReactNode; meta?: ReactNode; end?: ReactNode; place?: Place; children?: ReactNode; flagged?: boolean }) {
  const words = <><span className="board-row-title">{title}</span>{meta && <span className="board-row-meta">{meta}</span>}</>;
  return (
    <li className="board-row" data-flagged={flagged || undefined}>
      {place ? <button type="button" className="board-row-main" data-place={JSON.stringify(place)}>{words}</button> : <div className="board-row-main">{words}</div>}
      {end && <div className="board-row-end">{end}</div>}
      {children && <div className="board-row-more">{children}</div>}
    </li>
  );
}

/** A row's own controls, at its end: unseen until the row is pointed at or holds the keyboard, and always there
 * where nothing can point (a phone). They keep their place in the tab order and their room in the row, so nothing
 * moves when they appear. */
export const RowTools = ({ children, label }: { children: ReactNode; label: string }) => <span className="board-row-tools" role="group" aria-label={label}>{children}</span>;

/** The controls of a brick, in one row that wraps. */
export const Actions = ({ children, label }: { children: ReactNode; label?: string }) => <div className="board-actions" role={label ? 'group' : undefined} aria-label={label}>{children}</div>;
type ActionProps = { kind?: 'primary' | 'plain' | 'quiet' | 'danger'; children: ReactNode; disabled?: boolean; onClick?(): void; submit?: boolean; pressed?: boolean; label?: string };
/** One control. `primary` is the one thing the brick is for; `quiet` steps back; `danger` cannot be undone. */
export const Action = ({ kind = 'plain', children, disabled, onClick, submit, pressed, label }: ActionProps) => (
  <button type={submit ? 'submit' : 'button'} className="board-action" data-kind={kind} disabled={disabled} aria-pressed={pressed} aria-label={label} onClick={onClick}>{children}</button>
);
/** The question a brick asks before it acts: what will happen, the act in full, and the way back. `Confirm` opens
 * one; a brick that keeps its own asking (one question standing in place of several controls, or steps that are not
 * its to decide) draws this and nothing of its own. */
export function Asking({ yes, no = 'Cancel', kind = 'danger', onYes, onNo, disabled, busy, label, children }: {
  yes: string; no?: string; kind?: 'danger' | 'primary' | 'plain'; onYes(): void; onNo(): void; /** Neither answer can be given. */ disabled?: boolean; /** The act is under way: only the way back is open. */ busy?: boolean; label?: string; children?: ReactNode;
}) {
  return (
    <div className="board-confirm" role="group" aria-label={label}>
      {children && <p>{children}</p>}
      <Action kind={kind} disabled={disabled || busy} onClick={onYes}>{yes}</Action>
      <Action kind="quiet" disabled={disabled} onClick={onNo}>{no}</Action>
    </div>
  );
}
/** Asking before acting, the same everywhere: one control that opens the question, then the act and the way back.
 * `act` answers false when it did not happen, and the question stays open. */
export function Confirm({ ask, yes, no = 'Cancel', act, kind = 'danger', disabled, busy, label, children }: {
  /** The control's words, ending in an ellipsis: "Stop…". */ ask: string; /** The act, in full: "Stop this session". */ yes: string; no?: string;
  act(): Promise<boolean | void> | boolean | void; kind?: 'danger' | 'primary' | 'plain'; disabled?: boolean; busy?: boolean; /** The opening control's name, where its words alone do not say which record it is for. */ label?: string; /** What will happen, said before it does. */ children?: ReactNode;
}) {
  const [open, setOpen] = useState(false), [acting, setActing] = useState(false);
  if (!open) return <Action kind={kind === 'danger' ? 'plain' : kind} disabled={disabled || busy} label={label} onClick={() => setOpen(true)}>{ask}</Action>;
  const go = async () => { setActing(true); try { if ((await act()) !== false) setOpen(false); } finally { setActing(false); } };
  return <Asking yes={yes} no={no} kind={kind} busy={disabled || busy || acting} onYes={() => void go()} onNo={() => setOpen(false)}>{children}</Asking>;
}

/** A record's name as the control that opens the rest of it under its row. */
export const Opens = ({ open, onToggle, children, label }: { open: boolean; onToggle(): void; children: ReactNode; label?: string }) => (
  <button type="button" className="board-opens" aria-expanded={open} aria-label={label} onClick={onToggle}>{children}</button>
);
/** What a row opened: set in from the row, beside a hairline. */
export const Opened = ({ children }: { children: ReactNode }) => <div className="board-opened">{children}</div>;

type AsksProps = { /** The opening control's full name: "Remove passkey Laptop key". */ label?: string; ask: string; yes: string; no?: string;
  act(): Promise<boolean | void> | boolean | void; busy?: boolean; /** What will happen, said before it does. */ children?: ReactNode };
/** `Confirm` in two parts, so a row can hold them apart: the quiet control that opens the question, named for its row
 * so a screen reader can tell one row's from the next, and the question (`Asking`). `act` answers false when it did
 * not happen, and the question stays open. */
function useAsks({ label, ask, yes, no = 'Cancel', act, busy, children }: AsksProps) {
  const [open, setOpen] = useState(false), [acting, setActing] = useState(false);
  const go = async () => { setActing(true); try { if ((await act()) !== false) setOpen(false); } finally { setActing(false); } };
  return {
    control: open ? null : <Action kind="quiet" label={label} disabled={busy} onClick={() => setOpen(true)}>{ask}</Action>,
    question: !open ? null : <Asking label={label} yes={yes} no={no} disabled={busy || acting} onYes={() => void go()} onNo={() => setOpen(false)}>{children}</Asking>,
  };
}
/** The question alone, behind a quiet control, where it is not in a row. */
export function Asks(props: AsksProps) {
  const { control, question } = useAsks(props);
  return question ?? <div className="board-actions">{control}</div>;
}
/** A row whose record can be taken away: the control sits at the row's end, and the question opens under the row. */
export function AskRow({ title, meta, end, asks, children }: { title: ReactNode; meta?: ReactNode; end?: ReactNode; asks: AsksProps; children?: ReactNode }) {
  const { control, question } = useAsks(asks);
  return <Row title={title} meta={meta} end={<>{end}{control}</>}>{question || children ? <>{children}{question}</> : undefined}</Row>;
}

/** A brick's body that could not be drawn, after the placement's own tries (./main.tsx): sorry, said quietly, and
 * the ways on. `reload` is offered where loom now serves a newer page than this one. */
export function Lost({ again, reload }: { again(): void; reload?(): void }) {
  return (
    <div role="alert" className="board-lost">
      <p className="board-note">{reload ? 'Sorry, this brick didn’t load: loom was updated while this page was open. The page reloads by itself once your message is sent or cleared.' : 'Sorry, this brick didn’t load.'}</p>
      <Actions>
        <Action onClick={again}>Try again</Action>
        {reload && <Action kind="quiet" onClick={reload}>Reload now</Action>}
      </Actions>
    </div>
  );
}
/** A brick's body being fetched again by its placement. */
export const Fetching = () => <p role="status" className="board-note">Getting this brick again…</p>;

/** A few fields of a long form that belong together, under one small heading. */
export const Group = ({ title, children }: { title: string; children: ReactNode }) => <fieldset className="board-group"><legend>{title}</legend>{children}</fieldset>;

/** A field of words under its label. */
export function Field({ label, value, onChange, long, disabled, placeholder, type, autoFocus }: { label: string; value: string; onChange(value: string): void; long?: boolean; disabled?: boolean; placeholder?: string; type?: string; autoFocus?: boolean }) {
  const Control = long ? 'textarea' : 'input';
  return (
    <label className="board-field">
      <span>{label}</span>
      <Control className="board-input" aria-label={label} value={value} disabled={disabled} placeholder={placeholder} autoFocus={autoFocus} {...(long ? { rows: 2 } : { type })} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

type Option<T> = { value: T; label: string };
/** One of a few fixed choices, all in view: a segmented row. For more than a handful, `Menu`. */
export function Segmented<T extends string | number>({ label, value, options, onChange, disabled, bare }: { label: string; value: T; options: readonly Option<T>[]; onChange(value: T): void; disabled?: boolean; /** Draw no label: the group is still named. */ bare?: boolean }) {
  return (
    <div className="board-choice" role="group" aria-label={label}>
      {!bare && <span className="board-choice-label">{label}</span>}
      <span className="board-seg">
        {options.map((option) => (
          <button type="button" key={String(option.value)} aria-pressed={option.value === value} disabled={disabled} onClick={() => onChange(option.value)}>{option.label}</button>
        ))}
      </span>
    </div>
  );
}
/** One of many choices: the chosen one in view, the rest in a list that opens in place under it. The page has no
 * native picker (src/ui/label-wrap.test.ts): every choice here is a button whose words wrap. */
export function Menu<T extends string | number>({ label, value, options, onChange, disabled }: { label: string; value: T; options: readonly Option<T>[]; onChange(value: T): void; disabled?: boolean }) {
  const [open, setOpen] = useState(false), list = useId();
  const chosen = options.find((option) => option.value === value);
  return (
    <div className="board-choice" data-open={open}>
      <span className="board-choice-label">{label}</span>
      <button type="button" className="board-menu" aria-haspopup="listbox" aria-expanded={open} aria-controls={list} aria-label={`${label}: ${chosen?.label ?? 'none'}`} disabled={disabled} onClick={() => setOpen(!open)}>
        <span>{chosen?.label ?? 'Choose'}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && (
        <div className="board-menu-list" id={list} role="listbox" aria-label={label}>
          {options.map((option) => (
            <button type="button" role="option" key={String(option.value)} aria-selected={option.value === value} onClick={() => { setOpen(false); onChange(option.value); }}>{option.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** How full something is: a thin bar. Its tone turns as it fills. */
export function Meter({ label, value, max = 100, tone }: { label: string; value: number; max?: number; tone?: Tone }) {
  const part = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return <span className="board-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} data-tone={tone ?? (part >= 0.9 ? 'bad' : part >= 0.7 ? 'waiting' : 'working')}><i style={{ width: `${part * 100}%` }} /></span>;
}

/** A time, written one way on every brick: how long ago while it is recent (or how soon), the date after that,
 * in the member's own device zone. The whole date and time is its title. */
export function when(at: string | number, now: number = Date.now()): string {
  const then = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.round((now - then) / 60000), far = Math.abs(minutes);
  if (far < 1) return 'now';
  const span = far < 60 ? `${far} min` : far < 1440 ? `${Math.round(far / 60)} h` : '';
  if (span) return minutes > 0 ? span + ' ago' : 'in ' + span;
  return briefTime(new Date(then).toISOString(), undefined, now).replace(/, \d+:\d+.*$/, '');
}
/** When a brick's data was last confirmed, for the mark on its placement: to the second while that is under a minute. */
export function asOf(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return 'as of ' + (seconds < 60 ? seconds + ' s ago' : when(at, now));
}
/** `clock` writes the time of day alone, for a row under its day's heading; with `zone` it is that zone's clock (the
 * household's, where a brick's days are the household's days: the brick says the zone once, quietly). */
export const Time = ({ at, clock, zone }: { at: string | number | null | undefined; clock?: boolean; zone?: string }) => (at === null || at === undefined || !when(at) ? null
  : <time className="board-time" dateTime={new Date(at).toISOString()} title={fullTime(at)}>{clock ? new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: '2-digit', minute: '2-digit' }).format(new Date(at)) : when(at)}</time>);

/** A reference to another brick's record. Clicking it places that brick, at once, with no job. */
export function Chip({ place, children }: { place: Place; children: ReactNode }) {
  return (
    <button type="button" className="board-chip" data-place={JSON.stringify(place)}>
      <i aria-hidden="true" />
      {children}
    </button>
  );
}
export const ticketChip = (id: string) => <Chip place={{ brick: 'ticket', params: { ticket: id } }}><span className="font-mono">{id}</span></Chip>;
export function actorChip(kind: string | null | undefined, id: string) {
  return kind === 'agent'
    ? <Chip place={{ brick: 'agent', params: { agent: id } }}>{id}</Chip>
    : <Chip place={{ brick: 'person', params: { person: 'member:' + id } }}>{id}</Chip>;
}
/** A chip for a knowledge page, or its words alone when its slug is not one a board can hold. */
export const pageChip = (slug: string, label: string) => knowledgePageRef.test(slug)
  ? <Chip key={slug} place={{ brick: 'knowledge-page', params: { page: slug } }}>{label}</Chip> : <span key={slug}>{label}</span>;
/** How `changes.repository` is written (src/pieces/changes/model.ts, repositoryKey): owner/repo in lower case,
 * with no leading `github:` and no trailing `.git`. */
export const repositoryKey = (raw: string) => (raw.startsWith('github:') ? raw.slice(7) : raw).toLowerCase().replace(/\.git$/, '');
