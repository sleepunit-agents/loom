/** Notifications on this browser: the part of Account that is not drawn. The desktop's Account piece and the boards
 * page's control both turn a device on and off through these functions and the same two operations
 * (`notifications.subscribe`, `notifications.removeDevice`). No component and no stylesheet.
 *
 * `enableNotifications` asks the browser for permission, so it is called from a person's click and nowhere else. */
import { browserDevice } from '../../../../src/core/signin/browser-device';
import { NOTIFICATION_DEVICE_REF } from '../../../../src/ui/notification-target';
import { memberOperation } from '../../data/operation';
import { decode } from './encoding';

export const notificationsSupported = () =>
  typeof navigator !== 'undefined' && typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** The worker that shows a push (src/next-pwa.ts). Registering it asks the person nothing. */
export const registerWorker = () => {
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});
};

/** A device's reference as the server says it (core/signin/shared-notifications.ts), from its push endpoint. */
export async function deviceRef(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(NOTIFICATION_DEVICE_REF + endpoint));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** This browser's own device reference, when it holds a push subscription. Asks the person nothing. */
export async function thisDevice(): Promise<string | null> {
  if (!notificationsSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const sub = await registration?.pushManager.getSubscription();
  return sub ? deviceRef(sub.endpoint) : null;
}

/** Asks for permission, subscribes this browser and enrols it. Its push endpoint; throws with words a person can read. */
export async function enableNotifications(publicKey: string): Promise<string> {
  if (!notificationsSupported()) throw Error('This browser does not support notifications.');
  if ((await Notification.requestPermission()) !== 'granted') throw Error('Notifications were not allowed.');
  const registration = await navigator.serviceWorker.ready, existing = await registration.pushManager.getSubscription();
  const sub = existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decode(publicKey) })), value = sub.toJSON();
  await memberOperation('notifications.subscribe', { sub: { endpoint: sub.endpoint, keys: value.keys }, device: browserDevice(navigator.userAgent) });
  return sub.endpoint;
}

export const removeNotificationDevice = (ref: string) => memberOperation('notifications.removeDevice', { ref });

/** What is true of notifications on this browser, in the order a person can do something about it. */
export type NotificationState = 'loading' | 'unavailable' | 'unsupported' | 'blocked' | 'off' | 'on';
export function notificationState(now: {
  /** The account's read: undefined while it loads, null when it has none. */
  account: { publicKey: string | null; devices: readonly { ref: string }[] } | null | undefined;
  supported: boolean; permission: string;
  /** This browser's device reference: undefined while it is being found, null when it has no subscription. */
  ref: string | null | undefined;
}): NotificationState {
  if (now.account === undefined) return 'loading';
  if (!now.account?.publicKey) return 'unavailable';
  if (!now.supported) return 'unsupported';
  if (now.permission === 'denied') return 'blocked';
  if (now.ref === undefined) return 'loading';
  return now.permission === 'granted' && now.ref !== null && now.account.devices.some((device) => device.ref === now.ref) ? 'on' : 'off';
}
export const NOTIFICATION_WORDS: Record<NotificationState, string> = {
  loading: 'Checking notifications…',
  unavailable: 'Notifications are unavailable.',
  unsupported: 'This browser does not support notifications.',
  blocked: 'Notifications are blocked for loom in this browser. Allow them in the browser\'s site settings.',
  off: 'Notifications are off on this device.',
  on: 'Notifications are on for this device.',
};
