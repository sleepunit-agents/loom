/** What every brick's module shares (docs/specs/boards.md, "The first bricks"): the types of a brick's body, the two
 * one-line states, the chip that places another brick, and the watch a brick keeps on its own record. A brick's
 * module imports this file and never another brick's module, so each brick is loaded alone (./bricks.tsx). */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { briefTime, fullTime } from '../kit/time';
import { knowledgePageRef } from '../../../src/core/boards/refs';
import type { Form } from './layout';

export type Params = Record<string, string | number | undefined>;
export type Place = { brick: string; params: Params };
/** Report a brick's action after its own operation succeeded. */
export type Act = (action: string, detail: Record<string, string>) => void;
/** Mark this placement: its record changed in a way the brick flags itself for, and the member did not do it. */
export type Raise = (name: string) => void;
export type BodyProps = { params: Params; form: Form; act: Act; raise: Raise };

/** Watches one value of a brick's record. When it changes while the page is open, and the change was not the
 * member's own doing here a moment ago, the brick flags itself with the name the change is given. */
export function useOwnFlag<T>(value: T | undefined, raise: Raise, name: (before: T, now: T) => string | null) {
  const before = useRef<T | undefined>(undefined), mine = useRef(0);
  useEffect(() => {
    const was = before.current;
    before.current = value;
    if (was === undefined || value === undefined || was === value) return;
    if (Date.now() - mine.current < 5000) { mine.current = 0; return; }
    const called = name(was, value);
    if (called) raise(called);
  });
  return () => { mine.current = Date.now(); };
}

export const words = (v: unknown) => (v === undefined || v === null ? '' : String(v));
export const Unavailable = ({ what }: { what: string }) => <p className="board-note">This {what} is unavailable.</p>;
export const Loading = () => <p role="status" className="board-note">Loading…</p>;

/* ── The bricks' vocabulary (docs/specs/boards.md, "The design kit"; styles in ./board-kit.css) ────────────────────
 * Every brick is made of these and of nothing else of its own: one lead, facts, rows, a state, sections, actions.
 * They hold no data and call nothing. Labels wrap; nothing here cuts a word short. */

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

/** Label and value pairs. A short value sits beside its label; a `wide` one (prose) sits under it. */
export const Facts = ({ children }: { children: ReactNode }) => <dl className="board-facts">{children}</dl>;
export const Fact = ({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) => (
  <div data-wide={wide || undefined}><dt>{label}</dt><dd>{children}</dd></div>
);

/** A list of records, one to a row, parted by a hairline. */
export const Rows = ({ children, label }: { children: ReactNode; label?: string }) => <ul className="board-rows" aria-label={label}>{children}</ul>;
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

/** The controls of a brick, in one row that wraps. */
export const Actions = ({ children, label }: { children: ReactNode; label?: string }) => <div className="board-actions" role={label ? 'group' : undefined} aria-label={label}>{children}</div>;
type ActionProps = { kind?: 'primary' | 'plain' | 'quiet' | 'danger'; children: ReactNode; disabled?: boolean; onClick?(): void; submit?: boolean; pressed?: boolean; label?: string };
/** One control. `primary` is the one thing the brick is for; `quiet` steps back; `danger` cannot be undone. */
export const Action = ({ kind = 'plain', children, disabled, onClick, submit, pressed, label }: ActionProps) => (
  <button type={submit ? 'submit' : 'button'} className="board-action" data-kind={kind} disabled={disabled} aria-pressed={pressed} aria-label={label} onClick={onClick}>{children}</button>
);
/** Asking before acting, the same everywhere: one control that opens the question, then the act and the way back.
 * `act` answers false when it did not happen, and the question stays open. */
export function Confirm({ ask, yes, no = 'Cancel', act, kind = 'danger', disabled, busy, label, children }: {
  /** The control's words, ending in an ellipsis: "Stop…". */ ask: string; /** The act, in full: "Stop this session". */ yes: string; no?: string;
  act(): Promise<boolean | void> | boolean | void; kind?: 'danger' | 'primary' | 'plain'; disabled?: boolean; busy?: boolean; /** The opening control's name, where its words alone do not say which record it is for. */ label?: string; /** What will happen, said before it does. */ children?: ReactNode;
}) {
  const [open, setOpen] = useState(false), [acting, setActing] = useState(false);
  if (!open) return <Action kind={kind === 'danger' ? 'plain' : kind} disabled={disabled || busy} label={label} onClick={() => setOpen(true)}>{ask}</Action>;
  const go = async () => { setActing(true); try { if ((await act()) !== false) setOpen(false); } finally { setActing(false); } };
  return (
    <div className="board-confirm" role="group">
      {children && <p>{children}</p>}
      <Action kind={kind} disabled={disabled || busy || acting} onClick={() => void go()}>{yes}</Action>
      <Action kind="quiet" onClick={() => setOpen(false)}>{no}</Action>
    </div>
  );
}

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
export const Time = ({ at }: { at: string | number | null | undefined }) => (at === null || at === undefined || !when(at) ? null
  : <time className="board-time" dateTime={new Date(at).toISOString()} title={fullTime(at)}>{when(at)}</time>);

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
