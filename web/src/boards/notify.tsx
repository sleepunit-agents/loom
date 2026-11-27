/** Notifications on this device, from the boards page: the control beside the presence and the panel it opens.
 * It says what is true (unavailable, unsupported, blocked by the browser, off, on for this device) and turns this
 * device on and off through the desktop Account's own helper and operations (pieces/account/notifications.ts).
 * The browser is asked for permission only when the member presses "Turn on"; opening the page asks nothing.
 * It also holds this device's choice of where a notification opens (notify-target.ts), and whether this device is
 * also told when the agent replies: loom's record of the device, off until the member ticks it. */
import { useEffect, useState } from 'react';
import { BellIcon } from 'lucide-react';
import { useDataQuery } from '../data/graphql';
import { NOTIFICATION_WORDS, registerWorker } from '../pieces/account/notifications';
import { useDeviceNotifications } from './notify-device';
import { opensInBoards, setOpensInBoards } from './notify-target';

/** Account's own selection, less what this control does not draw. */
export const notifyQuery = '{ account { notifications { publicKey devices { ref replies } } } }';
type Read = { account: { notifications?: { publicKey: string | null; devices: { ref: string; replies?: boolean | null }[] } | null } | null };

export function Notify() {
  const [open, setOpen] = useState(false);
  // The worker shows a push and answers its click. Registering it asks the member nothing.
  useEffect(() => { registerWorker(); }, []);
  return (
    <>
      <button type="button" className="boards-notify-open board-action" aria-haspopup="dialog" aria-expanded={open} aria-label="Notifications"
        title="Notifications" onClick={() => setOpen((now) => !now)}><BellIcon aria-hidden="true" size={16} /></button>
      {open && <NotifyPanel close={() => setOpen(false)} />}
    </>
  );
}

function NotifyPanel({ close }: { close(): void }) {
  const read = useDataQuery<Read>(notifyQuery, undefined, { keep: true });
  const account = read.status === 'loading' ? undefined : read.data?.account?.notifications ?? null;
  const [boards, setBoards] = useState(false);
  const { state, busy, error, run, on, off, replies, reply } = useDeviceNotifications(account);
  useEffect(() => {
    let live = true;
    void opensInBoards().then((on) => live && setBoards(on));
    return () => { live = false; };
  }, []);
  const target = (wanted: boolean) => run(async () => { try { await setOpensInBoards(wanted); } catch { throw Error('This browser did not keep the choice.'); } setBoards(wanted); }, '');
  return (
    <div className="boards-threads boards-notify" role="dialog" aria-label="Notifications" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
      <p role="status">{NOTIFICATION_WORDS[state]}</p>
      {state === 'off' && <button type="button" className="board-action" disabled={busy} onClick={() => void on()}>Turn on notifications on this device</button>}
      {state === 'on' && (
        <>
          <button type="button" className="board-action" disabled={busy} onClick={() => void off()}>Turn off notifications on this device</button>
          <label className="board-line">
            <input type="checkbox" checked={boards} disabled={busy} onChange={(e) => void target(e.target.checked)} />
            <span>Open notifications from this device in the boards page</span>
          </label>
          <label className="board-line">
            <input type="checkbox" checked={replies} disabled={busy} onChange={(e) => void reply(e.target.checked)} />
            <span>Also notify this device when the agent replies</span>
          </label>
        </>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}
