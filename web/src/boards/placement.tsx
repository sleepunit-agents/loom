/** One placement's frame (docs/specs/boards.md, "The page"): the brick's name, its reference, its flag and the two
 * quiet controls (refresh, make it the big one, remove), around the brick's own body. The page draws it where the layout says; the gallery draws it alone. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FocusEvent, type ReactNode } from 'react';
import { RememberedWatch } from '../data/graphql/remembered';
import { Pace, paceScope } from '../data/graphql/pace';
import { asOf, Frame } from './brick-kit';
import type { Form } from './layout';

export function PlacementFrame({ title, sub, form, flag, entering, closed, canMaximize, onMaximize, onRemove, onLook, onGetting, anchor, style, children }: {
  title: string; sub: string; form: Form;
  /** The flag's words, when the placement is flagged. */
  flag?: string;
  entering?: boolean; closed?: boolean; canMaximize?: boolean;
  onMaximize?(): void; onRemove?(): void; onLook?(): void;
  /** Told whether the placement is getting new data, so the board's header row can say it once for all of them. */
  onGetting?(getting: boolean): void;
  /** The placement's element, for the header row's attention chips to bring into view and focus. */
  anchor?(element: HTMLElement | null): void;
  style?: CSSProperties; children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null), can = !closed && !!canMaximize;
  const latest = useRef(onMaximize); latest.current = onMaximize;
  // The reads below that still show a remembered answer (../data/graphql/remembered.ts): while there is one, the
  // frame says so once, and a brick whose controls must not act on old data can ask (the kit's `Frame`).
  const stale = useRef(new Set<object>()), [settling, setSettling] = useState(false);
  const watch = useCallback((hook: object, on: boolean) => { if (on) stale.current.add(hook); else stale.current.delete(hook); setSettling(stale.current.size > 0); }, []);
  const frame = useMemo(() => ({ body, maximize: can ? () => latest.current?.() : undefined, settling }), [can, settling]);
  // The reads below are relaxed: loom reads them again every few seconds, not for every write (../data/graphql/pace.ts).
  // This placement can ask for its own now (the refresh control), and the page asks for every placement's after the
  // member's own write. While an asking is unanswered the same mark shows; a brick that is only waiting out its
  // few seconds shows nothing. The mark's words say when what is drawn was last confirmed.
  const scope = useMemo(paceScope, []), reads = useSyncExternalStore(scope.subscribe, scope.snapshot, scope.snapshot);
  const getting = settling || reads.refreshing, since = reads.confirmedAt === undefined ? undefined : asOf(reads.confirmedAt);
  const tell = useRef(onGetting); tell.current = onGetting;
  useEffect(() => { if (!getting) return; tell.current?.(true); return () => tell.current?.(false); }, [getting]);
  // Focus inside the placement is looking at it. The placement itself is focused only by an attention chip of the
  // header row, which brings it into view and must change nothing: that focus is not looking.
  const focused = (e: FocusEvent) => { if (e.target !== e.currentTarget) onLook?.(); };
  return (
    <article ref={anchor} tabIndex={anchor ? -1 : undefined} className="board-placement" data-form={form} data-entering={!!entering} data-flagged={!!flag} onPointerEnter={onLook} onFocus={focused} style={style}>
      <header>
        <div className="board-names"><h2>{title}</h2><small className="font-mono">{sub}</small></div>
        {getting && <span className="board-settling" role="status" aria-label="Getting new data" aria-description={since} title={since ? 'Getting new data, ' + since : 'Getting new data'} />}
        {flag && <span className="board-flag" role="status">{flag}</span>}
        {/* The controls lie over the header's end and take no room in it: the name is never pushed, and they are
            seen only while the placement is pointed at or holds the keyboard. */}
        {!closed && (
          <span className="board-tools">
            <button type="button" className="board-refresh" aria-label={'Refresh ' + title} title="Refresh" onClick={scope.refresh}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v2.4h-2.4" /></svg></button>
            {canMaximize && <button type="button" className="board-maximize" aria-label={'Make ' + title + ' the big one'} title="Make this the big one" onClick={onMaximize}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" /></svg></button>}
            <button type="button" className="board-remove" aria-label={'Remove ' + title} title="Remove" onClick={onRemove}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 3.5 9 9M12.5 3.5l-9 9" /></svg></button>
          </span>
        )}
      </header>
      <div ref={body} inert={closed}><Pace.Provider value={scope}><RememberedWatch.Provider value={watch}><Frame.Provider value={frame}>{children}</Frame.Provider></RememberedWatch.Provider></Pace.Provider></div>
    </article>
  );
}
