/** Notifications on this browser, the part Account and the boards page share: what is true, this browser's device
 * reference, and turning it on. The browser's objects are faked; nothing here asks a real browser or push service. */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ op: vi.fn() }));
vi.mock('../../data/operation', () => ({ memberOperation: f.op }));
import { NOTIFICATION_WORDS, deviceRef, enableNotifications, notificationState, notificationsSupported, registerWorker, removeNotificationDevice, thisDevice } from './notifications';
import { NOTIFICATION_DEVICE_REF } from '../../../../src/ui/notification-target';

const g = globalThis as Record<string, any>;
const endpoint = 'https://fcm.googleapis.com/fictional';
const sub = { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }) };
function browser(now: { permission?: string; answer?: string; existing?: object | null; registered?: boolean } = {}) {
  const subscribe = vi.fn(async (_options: object) => sub), getSubscription = vi.fn(async () => now.existing ?? null);
  const registration = { pushManager: { subscribe, getSubscription } };
  const requestPermission = vi.fn(async () => now.answer ?? 'granted'), register = vi.fn(async () => registration);
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36',
    serviceWorker: { ready: Promise.resolve(registration), register, getRegistration: vi.fn(async () => (now.registered === false ? undefined : registration)) } });
  vi.stubGlobal('window', { PushManager: class {}, Notification: class {} });
  vi.stubGlobal('Notification', { permission: now.permission ?? 'default', requestPermission });
  return { subscribe, getSubscription, requestPermission, register };
}
beforeEach(() => { f.op.mockReset().mockResolvedValue({ saved: true }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('what is true of notifications on this browser', () => {
  const account = { publicKey: 'key', devices: [{ ref: 'mine' }, { ref: 'phone' }] };
  const of = (over: object) => notificationState({ account, supported: true, permission: 'granted', ref: 'mine', ...over });
  it('says each state, the one a person can act on first', () => {
    expect(of({})).toBe('on');
    expect(of({ account: undefined })).toBe('loading');
    expect(of({ account: null })).toBe('unavailable');
    expect(of({ account: { publicKey: null, devices: [] } })).toBe('unavailable');
    expect(of({ supported: false })).toBe('unsupported');
    expect(of({ permission: 'denied' })).toBe('blocked');
    expect(of({ ref: undefined })).toBe('loading');
    expect(of({ ref: null })).toBe('off');
    // Another of the member's devices is enrolled; this one is not.
    expect(of({ ref: 'other' })).toBe('off');
    // The server lists this browser but the browser no longer allows it: nothing would be shown.
    expect(of({ permission: 'default' })).toBe('off');
    // Unavailable and unsupported come before blocked: there is nothing to unblock.
    expect(of({ account: null, supported: false, permission: 'denied' })).toBe('unavailable');
    expect(of({ supported: false, permission: 'denied' })).toBe('unsupported');
  });
  it('has words for every state', () => {
    for (const state of ['loading', 'unavailable', 'unsupported', 'blocked', 'off', 'on'] as const) expect(NOTIFICATION_WORDS[state]).toBeTruthy();
  });
});

describe('this browser as a notification device', () => {
  it('works out the reference the server gives the same endpoint', async () => {
    expect(await deviceRef(endpoint)).toBe(createHash('sha256').update(NOTIFICATION_DEVICE_REF + endpoint).digest('hex'));
  });
  it('is unsupported without a worker, a push manager or notifications, and then asks nothing', async () => {
    vi.stubGlobal('navigator', { userAgent: 'x' }); vi.stubGlobal('window', {});
    expect(notificationsSupported()).toBe(false);
    expect(await thisDevice()).toBeNull();
    await expect(enableNotifications('a2V5')).rejects.toThrow('This browser does not support notifications.');
    expect(f.op).not.toHaveBeenCalled();
    registerWorker();
  });
  it('finds its own reference without asking for permission', async () => {
    const b = browser({ existing: sub });
    expect(await thisDevice()).toBe(await deviceRef(endpoint));
    expect(b.requestPermission).not.toHaveBeenCalled(); expect(b.subscribe).not.toHaveBeenCalled();
    browser({ existing: null }); expect(await thisDevice()).toBeNull();
    browser({ registered: false }); expect(await thisDevice()).toBeNull();
  });
  it('registers the worker without asking for permission', () => {
    const b = browser(); registerWorker();
    expect(b.register).toHaveBeenCalledExactlyOnceWith('/sw.js'); expect(b.requestPermission).not.toHaveBeenCalled();
  });
  it('turning on asks, subscribes with the household\'s key and enrols by Account\'s operation', async () => {
    const b = browser();
    expect(await enableNotifications('a2V5')).toBe(endpoint);
    expect(b.requestPermission).toHaveBeenCalledOnce();
    expect(b.subscribe).toHaveBeenCalledExactlyOnceWith({ userVisibleOnly: true, applicationServerKey: Uint8Array.from([107, 101, 121]) });
    expect(f.op.mock.calls).toEqual([['notifications.subscribe', { sub: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, device: 'Chrome on Linux' }]]);
  });
  it('enrols the subscription the browser already holds rather than making another', async () => {
    const b = browser({ existing: sub });
    await enableNotifications('a2V5');
    expect(b.subscribe).not.toHaveBeenCalled(); expect(f.op).toHaveBeenCalledOnce();
  });
  it('a refusal enrols nothing', async () => {
    const b = browser({ answer: 'denied' });
    await expect(enableNotifications('a2V5')).rejects.toThrow('Notifications were not allowed.');
    expect(b.subscribe).not.toHaveBeenCalled(); expect(f.op).not.toHaveBeenCalled();
  });
  it('turning off is Account\'s removal of that device', async () => {
    await removeNotificationDevice('r'.repeat(64));
    expect(f.op.mock.calls).toEqual([['notifications.removeDevice', { ref: 'r'.repeat(64) }]]);
  });
});
