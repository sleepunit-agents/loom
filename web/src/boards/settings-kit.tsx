/** What the household's settings bricks share beyond the kit (./brick-kit.tsx): a row that opens in place, and the
 * part it opens. Styles in ./kit-settings.css. */
import { useState, type ReactNode } from 'react';
import { Action, Row } from './brick-kit';

/** A record's name as the control that opens the rest of it under its row. */
export const Opens = ({ open, onToggle, children, label }: { open: boolean; onToggle(): void; children: ReactNode; label?: string }) => (
  <button type="button" className="board-opens" aria-expanded={open} aria-label={label} onClick={onToggle}>{children}</button>
);
/** What a row opened: set in from the row, beside a hairline. */
export const Opened = ({ children }: { children: ReactNode }) => <div className="board-opened">{children}</div>;

type AsksProps = { /** The opening control's full name: "Remove passkey Laptop key". */ label?: string; ask: string; yes: string; no?: string;
  act(): Promise<boolean | void> | boolean | void; busy?: boolean; /** What will happen, said before it does. */ children?: ReactNode };
/** Asking before acting (./brick-kit.tsx, Confirm), in two parts so a row can hold them apart: the quiet control that
 * opens the question, named for its row so a screen reader can tell one row's from the next, and the question
 * with the act and the way back. `act` answers false when it did not happen, and the question stays open. */
function useAsks({ label, ask, yes, no = 'Cancel', act, busy, children }: AsksProps) {
  const [open, setOpen] = useState(false), [acting, setActing] = useState(false);
  const go = async () => { setActing(true); try { if ((await act()) !== false) setOpen(false); } finally { setActing(false); } };
  return {
    control: open ? null : <Action kind="quiet" label={label} disabled={busy} onClick={() => setOpen(true)}>{ask}</Action>,
    question: !open ? null : (
      <div className="board-confirm" role="group" aria-label={label}>
        {children && <p>{children}</p>}
        <Action kind="danger" disabled={busy || acting} onClick={() => void go()}>{yes}</Action>
        <Action kind="quiet" disabled={busy || acting} onClick={() => setOpen(false)}>{no}</Action>
      </div>
    ),
  };
}
/** The question alone, where it is not in a row. */
export function Asks(props: AsksProps) {
  const { control, question } = useAsks(props);
  return question ?? <div className="board-actions">{control}</div>;
}
/** A row whose record can be taken away: the control sits at the row's end, and the question opens under the row. */
export function AskRow({ title, meta, end, asks, children }: { title: ReactNode; meta?: ReactNode; end?: ReactNode; asks: AsksProps; children?: ReactNode }) {
  const { control, question } = useAsks(asks);
  return <Row title={title} meta={meta} end={<>{end}{control}</>}>{question || children ? <>{children}{question}</> : undefined}</Row>;
}
