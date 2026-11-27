/** "Also notify this device when the agent replies", on the boards page's notifications panel: loom's own record of
 * this device (`notification_devices.replies`), off until ticked, changed by `notifications.subscribe` with the
 * subscription this browser already holds. The harness is notify.test.tsx's: the test renderer with the data hook,
 * the operations and the browser's objects faked. Nothing here receives a real push. */
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
import { Notify, notifyQuery } from './notify';
import { NOTIFICATION_DEVICE_REF } from '../../../src/ui/notification-target';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(test: (n: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
const text = (n: Node | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
let tree: { root: Node; unmount(): void } | undefined;
const settle = () => act(async () => { for (let n = 0; n < 25; n++) await new Promise((done) => setTimeout(done, 0)); });
const mount = async (element: unknown) => { await act(async () => { tree = create(element, { createNodeMock: () => ({ clientWidth: 1200, clientHeight: 800, focus() {} }) }); }); await settle(); };
const feed = async (answers: typeof f.answers) => { await act(async () => { Object.assign(f.answers, answers); f.version++; for (const fn of [...f.listeners]) fn(); }); await settle(); };
const buttons = () => tree!.root.findAllByType('button');
const button = (label: string) => buttons().find((b) => text(b) === label || b.props['aria-label'] === label);
const press = async (label: string) => { await act(async () => { await button(label)!.props.onClick(); }); await settle(); };
const dialog = () => tree!.root.findAll((n) => n.props.role === 'group' && n.props['aria-label'] === 'Notifications')[0];
const status = () => text(dialog().findAll((n) => n.props.role === 'status')[0]);
const alert = () => dialog().findAll((n) => n.props.role === 'alert').map(text).join('');
const box = () => dialog().findAllByType('input')[0];

const endpoint = 'https://fcm.googleapis.com/fictional', mine = createHash('sha256').update(NOTIFICATION_DEVICE_REF + endpoint).digest('hex');
const sub = { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }) };
const account = (devices: { ref: string; replies?: boolean }[] = []) => ({ Account: { status: 'live', data: { account: { notifications: { publicKey: 'a2V5', devices } } } } });
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

const boxes = () => dialog().findAllByType('input');
const replyBox = () => dialog().findAll((n) => n.type === 'label' && text(n) === 'Also notify this device when the agent replies')[0]?.findAllByType('input')[0];
const choose = async (checked: boolean) => { await act(async () => { await replyBox().props.onChange({ target: { checked } }); }); await settle(); };
const other = 'f'.repeat(64);

describe('also notify this device when the agent replies', () => {
  it('is offered only while notifications are on for this device', async () => {
    browser(); await open(account());
    expect(replyBox()).toBeUndefined();
    await act(async () => tree?.unmount()); tree = undefined;
    browser({ permission: 'denied', subscribed: true }); await open(account([{ ref: mine, replies: true }]));
    expect(replyBox()).toBeUndefined();
  });
  it('is off until chosen, and another device\'s choice is not this one\'s', async () => {
    browser({ permission: 'granted', subscribed: true }); await open(account([{ ref: mine }, { ref: other, replies: true }]));
    expect(boxes()).toHaveLength(2);
    expect(replyBox().props.checked).toBe(false);
  });
  it('shows what loom records for this device', async () => {
    browser({ permission: 'granted', subscribed: true }); await open(account([{ ref: mine, replies: true }, { ref: other, replies: false }]));
    expect(replyBox().props.checked).toBe(true);
    await feed(account([{ ref: mine, replies: false }]));
    expect(replyBox().props.checked).toBe(false);
  });
  it('is changed by notifications.subscribe with this browser\'s own subscription, asking the browser nothing', async () => {
    const b = browser({ permission: 'granted', subscribed: true }); await open(account([{ ref: mine, replies: false }]));
    await choose(true);
    expect(called('notifications.subscribe')).toEqual([{ sub: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, device: 'Chrome on Mac', replies: true }]);
    expect(b.requestPermission).not.toHaveBeenCalled(); expect(b.subscribe).not.toHaveBeenCalled(); expect(alert()).toBe('');
    // What is ticked is the record: only once loom says so.
    expect(replyBox().props.checked).toBe(false);
    await feed(account([{ ref: mine, replies: true }]));
    expect(replyBox().props.checked).toBe(true);
    await choose(false);
    expect(called('notifications.subscribe').at(-1)).toEqual({ sub: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, device: 'Chrome on Mac', replies: false });
    expect(called('notifications.removeDevice')).toEqual([]);
  });
  it('says when loom did not take the change, and stays as recorded', async () => {
    browser({ permission: 'granted', subscribed: true }); await open(account([{ ref: mine, replies: false }]));
    f.op.mockRejectedValueOnce(new Error('offline'));
    await choose(true);
    expect(alert()).toBe('Could not change this. Check the connection and try again.');
    expect(replyBox().props.checked).toBe(false); expect(replyBox().props.disabled).toBe(false);
  });
  it('leaves the choice of where a notification opens alone', async () => {
    const b = browser({ permission: 'granted', subscribed: true }); await open(account([{ ref: mine, replies: false }]));
    await choose(true);
    expect(b.kept.size).toBe(0); expect(boxes()[0].props.checked).toBe(false);
  });
});
