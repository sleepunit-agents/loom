/** Notifications on this device, as the boards page holds them: what is true now, and turning this device on and
 * off through the desktop Account's own helper and operations (pieces/account/notifications.ts). The control beside
 * the presence (./notify.tsx) and the `account` brick both use this one hook, each with its own read of the account.
 * The browser is asked for permission only inside `on`, which is called from the member's press and nowhere else.
 * `replies` is loom's record of whether this device is also told when the agent replies, and `reply` changes it. */
import { useEffect, useState } from 'react';
import {
  deviceRef, enableNotifications, notificationState, notificationsSupported, removeNotificationDevice, setReplyNotifications, thisDevice,
} from '../pieces/account/notifications';

/** The account's read: undefined while it loads, null when it has none. */
export type NotifyAccount = { publicKey: string | null; devices: readonly { ref: string; replies?: boolean | null }[] } | null | undefined;
const permissionNow = () => (notificationsSupported() ? Notification.permission : 'default');

export function useDeviceNotifications(account: NotifyAccount) {
  const [ref, setRef] = useState<string | null | undefined>(undefined);
  const [permission, setPermission] = useState(permissionNow);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    thisDevice().then((found) => live && setRef(found), () => live && setRef(null));
    return () => { live = false; };
  }, []);
  const state = notificationState({ account, supported: notificationsSupported(), permission, ref });
  /** One change at a time. True when it was made. */
  const run = async (work: () => Promise<void>, failed: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true); setError('');
    try { await work(); return true; }
    catch (e) { setError(e instanceof Error && e.message ? e.message : failed); return false; }
    finally { setPermission(permissionNow()); setBusy(false); }
  };
  const on = () => run(async () => { setRef(await deviceRef(await enableNotifications(account!.publicKey!))); }, 'Could not turn notifications on.');
  const off = () => run(async () => { try { await removeNotificationDevice(ref!); } catch { throw Error('Could not turn notifications off. Check the connection and try again.'); } }, '');
  const replies = !!account?.devices.find((device) => device.ref === ref)?.replies;
  const reply = (wanted: boolean) => run(async () => { try { await setReplyNotifications(wanted); } catch { throw Error('Could not change this. Check the connection and try again.'); } }, '');
  return { state, ref, busy, error, run, on, off, replies, reply };
}
