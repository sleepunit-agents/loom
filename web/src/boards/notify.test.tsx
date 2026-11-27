/** Notifications from the boards page: the control beside the presence says what is true of this device, turns it
 * on and off by Account's own operations, asks the browser for permission only on the member's press, and keeps
 * the device's choice of where a notification opens. No browser and no push service: the test renderer, with the
 * data hook, the operations and the browser's objects faked, as in page.test.tsx. */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';

type Answer = { status: string; data?: unknown };
const f = vi.hoisted(() => {
  const f = { listeners: new Set<() => void>(), version: 0, answers: {} as Record<string, Answer>, asked: [] as string[], op: vi.fn(), tail: null as object | null };
  const g = globalThis as Record<string, any>;
  const store = () => ({ length: 0, getItem: () => null, key: () => null, setItem() {}, removeItem() {}, clear() {} });
  g.document = { getElementById: () => null, visibilityState: 'visible', title: 'Loom' };
  g.location = { pathname: '/app/boards', search: '', hash: '', reload() {} };
  g.history = { pushState() {}, replaceState() {} };
  g.localStorage = store(); g.sessionStorage = store();
  g.Element = class {};
  g.ResizeObserver = class { observe() {} disconnect() {} };
  g.requestAnimationFrame = (frame: () => void) => { queueMicrotask(frame); return 1; };
  g.cancelAnimationFrame = () => {};
  g.addEventListener = () => {}; g.removeEventListener = () => {};
  return f;
});
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render() {} }) }));
vi.mock('../access', () => ({ wearMotion() {}, motionQuery: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }), reducedMotion: () => true }));
vi.mock('../signin/use-session', () => ({ useSession: () => ({ session: null, login() {}, message: '' }) }));
vi.mock('../contexts/portrait', async () => { const { createElement } = await import('react'); return { Portrait: () => createElement('art-sprite') }; });
vi.mock('../pair/ui/button', async () => { const { createElement } = await import('react'); return { Button: (p: object) => createElement('button', p) }; });
vi.mock('../pair/ui/input-group', async () => {
  const { createElement } = await import('react');
  const box = ({ children }: { children?: unknown }) => createElement('div', null, children as never);
  return { InputGroup: box, InputGroupAddon: box, InputGroupTextarea: (p: object) => createElement('textarea', p), InputGroupButton: ({ variant: _v, size: _s, ...p }: Record<string, unknown>) => createElement('button', p) };
});
vi.mock('../pair/ui/message-scroller', async () => {
  const { createElement } = await import('react');
  const box = ({ children }: { children?: unknown }) => createElement('div', null, children as never);
  return { MessageScroller: box, MessageScrollerContent: box, MessageScrollerProvider: box, MessageScrollerViewport: box, MessageScrollerButton: () => null };
});
vi.mock('../pair/transcript', async () => {
  const { createElement, useEffect } = await import('react');
  return { emptyTail: { last: 0, read: 0, working: false, conversation: '', tool: null, update: false, status: 'connecting' }, threadId: (prefix: string, parts: string[]) => prefix + parts.join('-'),
    TranscriptPage: ({ id, onTail }: { id: string; onTail(tail: object): void }) => { useEffect(() => { if (f.tail) onTail(f.tail); }); return createElement('transcript-of', { id }); } };
});
vi.mock('./build', () => ({ buildChanged: async () => false }));
vi.mock('../data/operation', () => ({ memberOperation: f.op }));
vi.mock('../data/graphql', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useDataQuery(query: string, _variables: unknown, options?: { pause?: boolean }) {
      useSyncExternalStore((fn) => { f.listeners.add(fn); return () => { f.listeners.delete(fn); }; }, () => f.version);
      if (options?.pause) return { status: 'loading' };
      const name = /query (\w+)/.exec(query)?.[1] ?? (/account/.test(query) ? 'Account' : 'Other');
      if (!f.asked.includes(name)) f.asked.push(name);
      return f.answers[name] ?? { status: 'live', data: null };
    },
  };
});
import { Page } from './main';
import { Notify, notifyQuery } from './notify';
import { NOTIFICATION_WORDS } from '../pieces/account/notifications';
import { NOTIFICATION_DEVICE_REF, DEVICE_CACHE, OPEN_IN_BOARDS } from '../../../src/ui/notification-target';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(test: (n: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
const text = (n: Node | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let tree: { root: Node; unmount(): void } | undefined;
const settle = () => act(async () => { for (let n = 0; n < 5; n++) await new Promise((done) => setTimeout(done, 0)); });
const mount = async (element: unknown) => { await act(async () => { tree = create(element, { createNodeMock: () => ({ clientWidth: 1200, clientHeight: 800, focus() {} }) }); }); await settle(); };
const feed = async (answers: typeof f.answers) => { await act(async () => { Object.assign(f.answers, answers); f.version++; for (const fn of [...f.listeners]) fn(); }); await settle(); };
const buttons = () => tree!.root.findAllByType('button');
const button = (label: string) => buttons().find((b) => text(b) === label || b.props['aria-label'] === label);
const press = async (label: string) => { await act(async () => { await button(label)!.props.onClick(); }); await settle(); };
const dialog = () => tree!.root.findAll((n) => n.props.role === 'dialog' && n.props['aria-label'] === 'Notifications')[0];
const status = () => text(dialog().findAll((n) => n.props.role === 'status')[0]);
const alert = () => dialog().findAll((n) => n.props.role === 'alert').map(text).join('');
const box = () => dialog().findAllByType('input')[0];

const endpoint = 'https://fcm.googleapis.com/fictional', mine = createHash('sha256').update(NOTIFICATION_DEVICE_REF + endpoint).digest('hex');
const sub = { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }) };
const account = (devices: string[] = [], publicKey: string | null = 'a2V5') => ({ Account: { status: 'live', data: { account: { notifications: { publicKey, devices: devices.map((ref) => ({ ref })) } } } } });
/** The browser as the page meets it. `permission` is what it says now; `answer` what the person answers when asked. */
function browser(now: { permission?: string; answer?: string; subscribed?: boolean; push?: boolean } = {}) {
  const state = { permission: now.permission ?? 'default', held: now.subscribed ? sub : null as typeof sub | null };
  const subscribe = vi.fn(async () => (state.held = sub)), registration = { pushManager: { subscribe, getSubscription: async () => state.held } };
  const requestPermission = vi.fn(async () => (state.permission = now.answer ?? 'granted')), register = vi.fn(async () => registration);
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/130.0 Safari/537.36', serviceWorker: { ready: Promise.resolve(registration), register, getRegistration: async () => registration } });
  vi.stubGlobal('window', now.push === false ? { Notification: class {} } : { PushManager: class {}, Notification: class {} });
  vi.stubGlobal('Notification', { get permission() { return state.permission; }, requestPermission });
  const kept = new Map<string, unknown>(), opened: string[] = [];
  vi.stubGlobal('caches', { open: async (name: string) => { opened.push(name); return { match: async (key: string) => kept.get(key), put: async (key: string, value: unknown) => { kept.set(key, value); }, delete: async (key: string) => kept.delete(key) }; } });
  vi.stubGlobal('Response', class { constructor(readonly body: string) {} });
  return { subscribe, requestPermission, register, kept, opened };
}
const called = (name: string) => f.op.mock.calls.filter(([op]) => op === name).map(([, input]) => input);
const open = async (answers: typeof f.answers) => { f.answers = answers; await mount(h(Notify)); await press('Notifications'); };

beforeEach(() => { f.answers = {}; f.asked = []; f.tail = null; f.op.mockReset().mockResolvedValue(undefined); location.pathname = '/app/boards'; });
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

describe('the control on the page', () => {
  it('is drawn beside the presence, registers the worker, and asks the browser nothing when the page opens', async () => {
    const b = browser();
    f.answers = { ...account() };
    await mount(h(Page, { member: 'sam', thread: 'th:pond', agent: 'art', exists: true }));
    const top = tree!.root.findAll((n) => n.props.className === 'boards-top')[0];
    expect(top.findAllByType('button').map((n) => n.props['aria-label'] ?? n.props.className)).toEqual(['boards-presence', 'Notifications', 'Conversations']);
    expect(button('Notifications')!.props['aria-expanded']).toBe(false);
    expect(dialog()).toBeUndefined();
    expect(b.register).toHaveBeenCalledExactlyOnceWith('/sw.js');
    expect(b.requestPermission).not.toHaveBeenCalled(); expect(b.subscribe).not.toHaveBeenCalled(); expect(f.op.mock.calls.filter(([op]) => /^notifications\./.test(op))).toEqual([]);
    // Opening the panel still asks nothing: it only says what is true.
    await press('Notifications');
    expect(status()).toBe(NOTIFICATION_WORDS.off);
    expect(b.requestPermission).not.toHaveBeenCalled();
  });
  it('reads Account\'s own notifications selection and nothing else', async () => {
    browser(); await open(account());
    expect(notifyQuery).toBe('{ account { notifications { publicKey devices { ref replies } } } }');
    expect(f.asked).toEqual(['Account']);
  });
  it('closes on Escape and on a second press', async () => {
    browser(); await open(account());
    await act(async () => dialog().props.onKeyDown({ key: 'Escape' }));
    expect(dialog()).toBeUndefined();
    await press('Notifications'); expect(dialog()).toBeDefined();
    await press('Notifications'); expect(dialog()).toBeUndefined();
  });
});

describe('what the panel says is true', () => {
  const actions = () => dialog().findAllByType('button').map(text);
  it('while the account is being read', async () => {
    browser(); await open({ Account: { status: 'loading' } });
    expect(status()).toBe(NOTIFICATION_WORDS.loading); expect(actions()).toEqual([]);
  });
  it('unavailable: this loom has no push key, or the account cannot be read', async () => {
    browser(); await open(account([], null));
    expect(status()).toBe('Notifications are unavailable.'); expect(actions()).toEqual([]);
    await feed({ Account: { status: 'live', data: { account: null } } });
    expect(status()).toBe('Notifications are unavailable.');
  });
  it('unsupported: the browser has no push', async () => {
    const b = browser({ push: false }); await open(account());
    expect(status()).toBe('This browser does not support notifications.'); expect(actions()).toEqual([]);
    expect(b.requestPermission).not.toHaveBeenCalled();
  });
  it('blocked by the browser: says so and offers nothing that cannot work', async () => {
    const b = browser({ permission: 'denied', subscribed: true }); await open(account([mine]));
    expect(status()).toBe(NOTIFICATION_WORDS.blocked); expect(actions()).toEqual([]);
    expect(b.requestPermission).not.toHaveBeenCalled();
  });
  it('off: never enrolled, or only the member\'s other devices are', async () => {
    browser(); await open(account());
    expect(status()).toBe('Notifications are off on this device.'); expect(actions()).toEqual(['Turn on notifications on this device']);
    expect(box()).toBeUndefined();
    await feed(account(['f'.repeat(64)]));
    expect(status()).toBe('Notifications are off on this device.');
  });
  it('off: the browser still holds a subscription but loom no longer lists it', async () => {
    browser({ permission: 'granted', subscribed: true }); await open(account([]));
    expect(status()).toBe('Notifications are off on this device.');
  });
  it('on for this device: loom lists this browser\'s own subscription and the browser allows it', async () => {
    browser({ permission: 'granted', subscribed: true }); await open(account([mine, 'f'.repeat(64)]));
    expect(status()).toBe('Notifications are on for this device.'); expect(actions()).toEqual(['Turn off notifications on this device']);
    expect(box().props.checked).toBe(false);
  });
});

describe('turning this device on and off', () => {
  it('asks the browser on the member\'s press, enrols by notifications.subscribe, and then says on', async () => {
    const b = browser(); await open(account());
    await press('Turn on notifications on this device');
    expect(b.requestPermission).toHaveBeenCalledOnce(); expect(b.subscribe).toHaveBeenCalledOnce();
    expect(called('notifications.subscribe')).toEqual([{ sub: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, device: 'Chrome on Mac' }]);
    expect(alert()).toBe('');
    // What is true is the record: on only once loom lists this device.
    expect(status()).toBe('Notifications are off on this device.');
    await feed(account([mine]));
    expect(status()).toBe('Notifications are on for this device.');
  });
  it('a refusal enrols nothing and the panel then says blocked', async () => {
    const b = browser({ answer: 'denied' }); await open(account());
    await press('Turn on notifications on this device');
    expect(b.subscribe).not.toHaveBeenCalled(); expect(called('notifications.subscribe')).toEqual([]);
    expect(alert()).toBe('Notifications were not allowed.');
    expect(status()).toBe(NOTIFICATION_WORDS.blocked);
  });
  it('a dismissed question leaves it off and can be asked again', async () => {
    const b = browser({ answer: 'default' }); await open(account());
    await press('Turn on notifications on this device');
    expect(alert()).toBe('Notifications were not allowed.'); expect(status()).toBe('Notifications are off on this device.');
    expect(button('Turn on notifications on this device')!.props.disabled).toBe(false);
    expect(b.requestPermission).toHaveBeenCalledOnce();
  });
  it('says when loom refused the enrolment', async () => {
    browser(); await open(account());
    f.op.mockRejectedValueOnce(new Error('Operation refused'));
    await press('Turn on notifications on this device');
    expect(alert()).toBe('Operation refused'); expect(status()).toBe('Notifications are off on this device.');
  });
  it('turns off by notifications.removeDevice with this device\'s own reference, never another device\'s', async () => {
    const b = browser({ permission: 'granted', subscribed: true }); await open(account(['f'.repeat(64), mine]));
    await press('Turn off notifications on this device');
    expect(called('notifications.removeDevice')).toEqual([{ ref: mine }]);
    expect(b.requestPermission).not.toHaveBeenCalled();
    await feed(account(['f'.repeat(64)]));
    expect(status()).toBe('Notifications are off on this device.');
  });
  it('says when turning off failed and stays on', async () => {
    browser({ permission: 'granted', subscribed: true }); await open(account([mine]));
    f.op.mockRejectedValueOnce(new Error('offline'));
    await press('Turn off notifications on this device');
    expect(alert()).toBe('Could not turn notifications off. Check the connection and try again.');
    expect(status()).toBe('Notifications are on for this device.');
  });
});

describe('where this device opens a notification', () => {
  const choose = async (checked: boolean) => { await act(async () => { await box().props.onChange({ target: { checked } }); }); await settle(); };
  it('is the desktop until chosen, and the choice is kept where the worker reads it, calling no operation', async () => {
    const b = browser({ permission: 'granted', subscribed: true }); await open(account([mine]));
    expect(box().props.checked).toBe(false);
    await choose(true);
    expect(box().props.checked).toBe(true); expect([...b.kept.keys()]).toEqual([OPEN_IN_BOARDS]); expect(new Set(b.opened)).toEqual(new Set([DEVICE_CACHE]));
    await choose(false);
    expect(box().props.checked).toBe(false); expect(b.kept.size).toBe(0);
    expect(f.op).not.toHaveBeenCalled();
  });
  it('shows a choice made earlier', async () => {
    const b = browser({ permission: 'granted', subscribed: true }); b.kept.set(OPEN_IN_BOARDS, {});
    await open(account([mine]));
    expect(box().props.checked).toBe(true);
  });
  it('says when the browser did not keep the choice', async () => {
    browser({ permission: 'granted', subscribed: true }); await open(account([mine]));
    vi.stubGlobal('caches', { open: async () => { throw new Error('denied'); } });
    await choose(true);
    expect(alert()).toBe('This browser did not keep the choice.'); expect(box().props.checked).toBe(false);
  });
});
