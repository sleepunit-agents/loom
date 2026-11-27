/** Notifications on this device, from the boards page: the control beside the presence and the panel it opens.
 * It says what is true (unavailable, unsupported, blocked by the browser, off, on for this device) and turns this
 * device on and off through the desktop Account's own helper and operations (pieces/account/notifications.ts).
 * The browser is asked for permission only when the member presses "Turn on"; opening the page asks nothing.
 * It also holds this device's choice of where a notification opens (notify-target.ts). */
import { useEffect, useState } from 'react';
import { BellIcon } from 'lucide-react';
import { useDataQuery } from '../data/graphql';
import {
  NOTIFICATION_WORDS, deviceRef, enableNotifications, notificationState, notificationsSupported, registerWorker, removeNotificationDevice, thisDevice,
} from '../pieces/account/notifications';
import { opensInBoards, setOpensInBoards } from './notify-target';

/** Account's own selection, less what this control does not draw. */
export const notifyQuery = '{ account { notifications { publicKey devices { ref } } } }';
type Read = { account: { notifications?: { publicKey: string | null; devices: { ref: string }[] } | null } | null };
const permissionNow = () => (notificationsSupported() ? Notification.permission : 'default');

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
  const [ref, setRef] = useState<string | null | undefined>(undefined);
  const [permission, setPermission] = useState(permissionNow);
  const [boards, setBoards] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    thisDevice().then((found) => live && setRef(found), () => live && setRef(null));
    void opensInBoards().then((on) => live && setBoards(on));
    return () => { live = false; };
  }, []);
  const state = notificationState({ account, supported: notificationsSupported(), permission, ref });
  const run = async (work: () => Promise<void>, failed: string) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); }
    catch (e) { setError(e instanceof Error && e.message ? e.message : failed); }
    finally { setPermission(permissionNow()); setBusy(false); }
  };
  const on = () => run(async () => { setRef(await deviceRef(await enableNotifications(account!.publicKey!))); }, 'Could not turn notifications on.');
  const off = () => run(async () => { try { await removeNotificationDevice(ref!); } catch { throw Error('Could not turn notifications off. Check the connection and try again.'); } }, '');
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
        </>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}
