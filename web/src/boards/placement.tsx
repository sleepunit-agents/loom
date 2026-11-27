/** One placement's frame (docs/specs/boards.md, "The page"): the brick's name, its reference, its flag and the two
 * quiet controls, around the brick's own body. The page draws it where the layout says; the gallery draws it alone. */
import { useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { RememberedWatch } from '../data/graphql/remembered';
import { Frame } from './brick-kit';
import type { Form } from './layout';

export function PlacementFrame({ title, sub, form, flag, entering, closed, canMaximize, onMaximize, onRemove, onLook, style, children }: {
  title: string; sub: string; form: Form;
  /** The flag's words, when the placement is flagged. */
  flag?: string;
  entering?: boolean; closed?: boolean; canMaximize?: boolean;
  onMaximize?(): void; onRemove?(): void; onLook?(): void; style?: CSSProperties; children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null), can = !closed && !!canMaximize;
  const latest = useRef(onMaximize); latest.current = onMaximize;
  // The reads below that still show a remembered answer (../data/graphql/remembered.ts): while there is one, the
  // frame says so once, and a brick whose controls must not act on old data can ask (the kit's `Frame`).
  const stale = useRef(new Set<object>()), [settling, setSettling] = useState(false);
  const watch = useCallback((hook: object, on: boolean) => { if (on) stale.current.add(hook); else stale.current.delete(hook); setSettling(stale.current.size > 0); }, []);
  const frame = useMemo(() => ({ body, maximize: can ? () => latest.current?.() : undefined, settling }), [can, settling]);
  return (
    <article className="board-placement" data-form={form} data-entering={!!entering} data-flagged={!!flag} onPointerEnter={onLook} onFocus={onLook} style={style}>
      <header>
        <div className="board-names"><h2>{title}</h2><small className="font-mono">{sub}</small></div>
        {settling && <span className="board-settling" role="status" aria-label="Getting new data" title="Getting new data" />}
        {flag && <span className="board-flag" role="status">{flag}</span>}
        {/* The two controls lie over the header's end and take no room in it: the name is never pushed, and they are
            seen only while the placement is pointed at or holds the keyboard. */}
        {!closed && (
          <span className="board-tools">
            {canMaximize && <button type="button" className="board-maximize" aria-label={'Make ' + title + ' the big one'} title="Make this the big one" onClick={onMaximize}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" /></svg></button>}
            <button type="button" className="board-remove" aria-label={'Remove ' + title} title="Remove" onClick={onRemove}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 3.5 9 9M12.5 3.5l-9 9" /></svg></button>
          </span>
        )}
      </header>
      <div ref={body} inert={closed}><RememberedWatch.Provider value={watch}><Frame.Provider value={frame}>{children}</Frame.Provider></RememberedWatch.Provider></div>
    </article>
  );
}
