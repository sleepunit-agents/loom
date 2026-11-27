/** One placement's frame (docs/specs/boards.md, "The page"): the brick's name, its reference, its flag and the two
 * quiet controls, around the brick's own body. The page draws it where the layout says; the gallery draws it alone. */
import type { CSSProperties, ReactNode } from 'react';
import type { Form } from './layout';

export function PlacementFrame({ title, sub, form, flag, entering, closed, canMaximize, onMaximize, onRemove, onLook, style, children }: {
  title: string; sub: string; form: Form;
  /** The flag's words, when the placement is flagged. */
  flag?: string;
  entering?: boolean; closed?: boolean; canMaximize?: boolean;
  onMaximize?(): void; onRemove?(): void; onLook?(): void; style?: CSSProperties; children: ReactNode;
}) {
  return (
    <article className="board-placement" data-form={form} data-entering={!!entering} data-flagged={!!flag} onPointerEnter={onLook} onFocus={onLook} style={style}>
      <header>
        <div className="board-names"><h2>{title}</h2><small className="font-mono">{sub}</small></div>
        {flag && <span className="board-flag" role="status">{flag}</span>}
        {!closed && canMaximize && <button type="button" className="board-maximize" aria-label={'Make ' + title + ' the big one'} onClick={onMaximize}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" /></svg></button>}
        {!closed && <button type="button" className="board-remove" aria-label={'Remove ' + title} onClick={onRemove}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 3.5 9 9M12.5 3.5l-9 9" /></svg></button>}
      </header>
      <div inert={closed}>{children}</div>
    </article>
  );
}
