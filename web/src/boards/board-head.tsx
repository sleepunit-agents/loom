/** The board's header row (docs/specs/boards.md, "The header row"): one slim line over the field. The board's
 * heading, then what needs the member, then one quiet mark while anything on the board is getting new data, then
 * Close as an icon at the far end. What needs the member is of two kinds:
 *
 * - Attention chips, one for each flagged placement on this board, in the board's order: the brick's name, its
 *   reference and its flag word. Built only from what the placements carry (the agent's stored flag, which takes no
 *   words, or the brick's own flag), never from words an agent wrote. Pressing one brings that placement into view
 *   and gives it the keyboard, and does nothing else: it clears no flag, sends no action, tells loom nothing.
 *   More than the row has room for become `+N`, which opens a small list of the rest, made of the same chips. Where
 *   not even one chip fits beside it (a phone), the chips fold to one count, "N flagged", which opens all of them.
 * - Page-level notices, said here once instead of inside whichever brick drew them: a token whose fate is unknown or
 *   whose value was lost (./token-notices.ts), that loom was updated while the page was open, and how many bricks
 *   did not load. One is said in the row, in a few words with its one action. Two or more fold to one "N notices",
 *   which opens them in full, each with its action; on a phone even one is folded so (the CSS chooses).
 *
 * The row's height never changes as these come and go: it is one line of a fixed block size, nothing in it wraps,
 * and the lists open over the board beneath it, never inside the row. */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { dismissTokenNotice, noticeBrief, noticeWords, useTokenNotices, type TokenNotice } from './token-notices';

/** A flagged placement, as its chip says it. */
export type Attention = { id: string; title: string; sub: string; flag: string };

/** The room one chip takes in the row, its gap included (`.boards-attention` is at most 12.5rem wide), and the room
 * the `+N` takes. How many chips are shown is the row's width over these: chosen, not measured chip by chip, so a
 * chip that comes or goes never moves the others. */
export const CHIP_ROOM = 208;
export const MORE_ROOM = 48;

/** How many of `count` chips the row shows in `width`: all, some and a `+N`, or none and a count. */
export function chipsShown(width: number, count: number): { shown: number; counted: boolean } {
  if (count * CHIP_ROOM <= width) return { shown: count, counted: false };
  const shown = Math.floor((width - MORE_ROOM) / CHIP_ROOM);
  return shown < 1 ? { shown: 0, counted: true } : { shown, counted: false };
}

/** A chip's words: the brick's name, its reference, and its flag word. */
export const attentionWords = (a: Attention) => `${a.title}${a.sub ? ' ' + a.sub : ''} · ${a.flag.charAt(0).toLowerCase()}${a.flag.slice(1)}`;

function Chip({ a, onJump }: { a: Attention; onJump(id: string): void }) {
  const words = attentionWords(a);
  return <button type="button" className="board-chip boards-attention" data-flagged="true" title={words} onClick={() => onJump(a.id)}><i aria-hidden="true" /><span>{words}</span></button>;
}

/** Every token notice in full, each with its Dismiss: part of what the header's notices open. */
export function TokenNoticeList({ notices }: { notices: readonly TokenNotice[] }) {
  return <>{notices.map((notice) => (
    <li key={notice.id} data-token-notice={notice.fate}>
      <p>{noticeWords(notice)}</p>
      <button type="button" className="boards-head-act" aria-label={`Dismiss the notice for ${notice.label}`} onClick={() => dismissTokenNotice(notice.id)}>Dismiss</button>
    </li>
  ))}</>;
}

const UPDATED = 'loom was updated: the page reloads when your message is sent or cleared';
const didNotLoad = (lost: number) => (lost === 1 ? '1 brick didn’t load' : `${lost} bricks didn’t load`);

type Open = 'more' | 'notices' | null;

export function BoardHead({ heading, attention, onJump, notices, stale, reload, lost, onTryAll, getting, closed, onClose, onReopen, tokenNotices: given }: {
  heading: string;
  /** The flagged placements, in the board's order. */
  attention: readonly Attention[];
  /** Bring a placement into view and give it the keyboard. */
  onJump(id: string): void;
  /** This is the board on screen: the page's own notices are said in its row and no other. */
  notices: boolean;
  /** loom now serves a newer page than this one. */
  stale: boolean;
  reload(): void;
  /** How many of this board's bricks did not load, their own tries spent. */
  lost: number;
  onTryAll(): void;
  /** Some placement on the board is getting new data. */
  getting: boolean;
  closed: boolean;
  onClose(): void;
  onReopen(): void;
  /** The token notices to say, for the gallery; the page's own (./token-notices.ts) otherwise. */
  tokenNotices?: readonly TokenNotice[];
}) {
  const kept = useTokenNotices(), tokens = given ?? kept;
  const strip = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const [open, setOpen] = useState<Open>(null);
  const toggle = (which: Exclude<Open, null>) => setOpen((now) => (now === which ? null : which));
  const fit = chipsShown(width, attention.length);
  const shown = attention.slice(0, fit.shown), rest = attention.slice(fit.shown);
  const tokenNotices = notices ? tokens : [], updated = notices && stale, failed = notices ? lost : 0;
  const count = tokenNotices.length + (updated ? 1 : 0) + (failed > 0 ? 1 : 0), folded = count > 1;
  // A list whose things have all gone closes.
  const opened: Open = open === 'more' && rest.length ? 'more' : open === 'notices' && count ? 'notices' : null;
  const jump = (id: string) => { setOpen(null); onJump(id); };
  const escape = (e: KeyboardEvent) => { if (e.key === 'Escape' && opened) { e.stopPropagation(); setOpen(null); } };
  return (
    <header className="boards-head" onKeyDown={escape}>
      <h1>{heading}</h1>
      <div ref={strip} className="boards-head-chips" data-some={attention.length > 0} role="group" aria-label="Flagged on this board">
        {shown.map((a) => <Chip key={a.id} a={a} onJump={jump} />)}
        {rest.length > 0 && (
          <button type="button" className="board-chip boards-head-more" data-flagged="true" aria-expanded={opened === 'more'}
            aria-label={fit.counted ? `${rest.length} flagged: show them` : `${rest.length} more flagged: show them`} onClick={() => toggle('more')}>
            {fit.counted ? <><i aria-hidden="true" />{rest.length} flagged</> : `+${rest.length}`}
          </button>
        )}
      </div>
      {count > 0 && (
        <span className="boards-notices" data-folded={folded}>
          {!folded && tokenNotices.length > 0 && (
            <span className="boards-notice" data-notice="token" role="alert">
              <button type="button" className="boards-notice-words" aria-expanded={opened === 'notices'} title={noticeWords(tokenNotices[0])} onClick={() => toggle('notices')}>{noticeBrief(tokenNotices[0])}</button>
            </span>
          )}
          {!folded && updated && (
            <span className="boards-notice" data-notice="update" role="status">
              <span className="boards-notice-words" title={UPDATED}>loom was updated<span className="boards-notice-more">{UPDATED.slice('loom was updated'.length)}</span></span>
              <button type="button" className="boards-head-act" onClick={reload}>Reload now</button>
            </span>
          )}
          {!folded && failed > 0 && (
            <span className="boards-notice" data-notice="lost" role="alert">
              <span className="boards-notice-words">{didNotLoad(failed)}</span>
              <button type="button" className="boards-head-act" onClick={onTryAll}>Try all again</button>
            </span>
          )}
          {/* Folded: two or more, or any on a phone. */}
          <button type="button" className="boards-notice-fold" role={folded ? 'alert' : undefined} aria-expanded={opened === 'notices'} onClick={() => toggle('notices')}>
            {count > 1 ? `${count} notices` : tokenNotices.length ? 'Token notice' : updated ? 'loom was updated' : didNotLoad(failed)}
          </button>
        </span>
      )}
      {getting && <span className="boards-getting" role="status" aria-label="Getting new data" title="Getting new data" />}
      {closed
        ? <button type="button" className="boards-head-act boards-reopen" onClick={onReopen}>Reopen</button>
        : <button type="button" className="boards-close" aria-label="Close board" title="Close board" onClick={onClose}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>}
      {opened === 'more' && (
        <div className="boards-head-panel" role="group" aria-label={fit.counted ? 'Flagged on this board' : 'More flagged on this board'}>
          {rest.map((a) => <Chip key={a.id} a={a} onJump={jump} />)}
        </div>
      )}
      {opened === 'notices' && (
        <div className="boards-head-panel" role="group" aria-label="Notices">
          <ul className="boards-notice-list">
            <TokenNoticeList notices={tokenNotices} />
            {updated && <li data-notice="update"><p>{UPDATED}.</p><button type="button" className="boards-head-act" onClick={reload}>Reload now</button></li>}
            {failed > 0 && <li data-notice="lost"><p>{didNotLoad(failed)}.</p><button type="button" className="boards-head-act" onClick={() => { setOpen(null); onTryAll(); }}>Try all again</button></li>}
          </ul>
        </div>
      )}
    </header>
  );
}
