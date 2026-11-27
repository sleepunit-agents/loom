/** The `account` brick (docs/specs/boards.md, "The first bricks"): the member's own passkeys, signed-in browsers and
 * notification devices from the desktop Account's selection, and its changes by the desktop's own operations and
 * sign-in door. No browser, push service or authenticator: the data hook, fetch and the browser's objects are faked. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { accountQuery } from '../pieces/account/query';
import { deviceRef } from '../pieces/account/notifications';
import { bricks, loadBricks } from './bricks';
import { bench } from './bricks-work.test.helper';

await loadBricks();

const b = bench(feed);
const key = 'a'.repeat(64), spare = 'c'.repeat(64), browser = 'b'.repeat(64), phone = 'd'.repeat(64);
const endpoint = 'https://push.example/fictional', linkPath = '/login/' + 'e'.repeat(64);
const account = (over: object = {}) => ({
  member: 'sam',
  passkeys: [{ ref: key, label: 'Laptop key', createdAt: '2026-11-15T00:00:00Z', lastUsedAt: '2026-11-20T00:00:00Z', ended: false }, { ref: spare, label: 'Old key', createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null, ended: true }],
  sessions: [{ ref: browser, device: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/145.0 Safari/537.36', issuedAt: '2026-11-15T00:00:00Z', seenAt: '2026-11-15T01:00:00Z', ended: false }],
  notifications: { publicKey: 'a2V5', devices: [{ ref: phone, device: 'Kitchen tablet', createdAt: '2026-11-15T00:00:00Z', seenAt: '2026-11-16T00:00:00Z' }] },
  ...over,
});
/** Every request the brick made, and what each door answers. */
const calls: [string, unknown][] = [];
const world = { viewer: { id: 'sam' } as object | null, refuse: new Set<string>(), link: { status: 200, body: { ok: true, value: { path: linkPath } } as unknown }, reload: vi.fn() };
function answer(data: unknown, status = 'live') {
  feed.mockImplementation((query: string) => (query === accountQuery ? (data === undefined ? { status: 'loading' } : { status, data: { account: data } }) : { status: 'live', data: { deskTime: { timezone: 'UTC' } } }));
}
function device(now: { subscribed?: boolean; permission?: string } = {}) {
  const sub = { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }) };
  const registration = { pushManager: { subscribe: vi.fn(async () => sub), getSubscription: vi.fn(async () => (now.subscribed ? sub : null)) } };
  const requestPermission = vi.fn(async () => 'granted');
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36', serviceWorker: { ready: Promise.resolve(registration), getRegistration: async () => registration },
    credentials: { create: vi.fn(async () => ({ rawId: new Uint8Array([1]).buffer, response: { clientDataJSON: new Uint8Array([2]).buffer, getAuthenticatorData: () => new Uint8Array([3]).buffer, getPublicKey: () => new Uint8Array([4]).buffer, getPublicKeyAlgorithm: () => -7 } })) } });
  vi.stubGlobal('window', { PushManager: class {}, Notification: class {} });
  vi.stubGlobal('Notification', { permission: now.permission ?? 'default', requestPermission });
  return { requestPermission };
}
beforeEach(() => {
  b.before();
  calls.length = 0; world.viewer = { id: 'sam' }; world.refuse.clear(); world.reload.mockReset();
  world.link = { status: 200, body: { ok: true, value: { path: linkPath } } };
  vi.stubGlobal('location', { origin: 'https://loom.example', reload: world.reload });
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push([url, url.startsWith('/api/') && url !== '/api/signin/link' ? body.input : body]);
    const reply = (status: number, value: unknown) => ({ ok: status < 400, status, json: async () => value });
    if (world.refuse.has(url)) return reply(409, { ok: false, error: 'Add a passkey within ten minutes of signing in' });
    if (url === '/auth/session') return reply(200, { viewer: world.viewer });
    if (url === '/api/signin/link') return reply(world.link.status, world.link.body);
    if (url === '/passkeys/options') return reply(200, { challenge: 'AQ', user: { id: 'AQ', name: 'sam' }, excludeCredentials: [{ id: 'AQ' }] });
    return reply(200, { ok: true, value: {} });
  });
  device();
});
afterEach(b.after);
const flush = () => b.redraw('account', {}, 'primary');

it('shows the member\'s own passkeys, browsers and notification devices from Account\'s selection, and the small forms only count them', async () => {
  answer(account());
  await b.draw('account', {}, 'primary');
  expect(feed.mock.calls.some(([query, , options]) => query === accountQuery && options?.keep === true)).toBe(true);
  for (const shown of ['sam', 'Laptop key', 'Active', 'Old key', 'Stopped', 'Chrome on Linux', 'Signed in', 'Kitchen tablet', 'Last confirmed', 'Last used', 'Add a passkey within ten minutes of signing in.', 'One sign-in within five minutes as sam.']) expect(b.all(), shown).toContain(shown);
  expect(b.all()).not.toContain('Mozilla/');
  expect(b.placed()).toEqual([]);
  await b.draw('account', {}, 'side');
  for (const shown of ['sam', '1 passkey', '1 signed-in browser', '1 notification device']) expect(b.all(), shown).toContain(shown);
  expect(b.all()).not.toContain('Laptop key');
  expect(b.controls()).toEqual([]);
  await b.draw('account', {}, 'compact');
  b.oneLine();
  expect(b.all()).toBe('1 passkey · 1 signed-in browser · 1 notification device');
  expect(b.controls()).toEqual([]);
  answer(account({ passkeys: [], sessions: [], notifications: undefined }));
  await b.draw('account', {}, 'compact');
  expect(b.all()).toBe('No passkeys · No signed-in browsers · No notification devices');
  expect(bricks.account.title({})).toBe('Your account');
  expect(bricks.account.sub({})).toBe('');
  expect(calls).toEqual([]);
});

it('says so while it loads and when there is no account to read, and then draws no control', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    answer(undefined);
    await b.draw('account', {}, form);
    expect(b.all(), form).toBe('Loading…');
    answer(null);
    await b.draw('account', {}, form);
    expect(b.all(), form).toBe('This account is unavailable.');
    expect(b.controls()).toEqual([]);
    answer(account(), 'offline');
    await b.draw('account', {}, form);
    expect(b.all(), form).toBe('This account is unavailable.');
    expect(b.controls()).toEqual([]);
  }
  expect(calls).toEqual([]);
});

it('removes a passkey only after asking, by Account\'s operation, and tells the board nothing but that it happened', async () => {
  answer(account());
  await b.draw('account', {}, 'primary');
  await b.press('Remove passkey Laptop key');
  expect(b.all()).toContain('Remove this passkey? The browsers it signed in are signed out. It is your only active passkey.');
  expect(calls).toEqual([]);
  await b.press('Keep');
  expect(b.all()).not.toContain('Remove this passkey?');
  expect(calls).toEqual([]);
  await b.press('Remove passkey Old key');
  expect(b.all()).not.toContain('only active passkey');
  await b.press('Remove passkey');
  expect(calls).toEqual([['/api/account/removePasskey', { ref: spare }]]);
  expect(b.reported.mock.calls).toEqual([['removePasskey', {}]]);
  expect(b.all()).toContain('Saved.');
});

it('a refused removal says so and reports nothing', async () => {
  answer(account());
  await b.draw('account', {}, 'primary');
  world.refuse.add('/api/account/removePasskey');
  await b.press('Remove passkey Laptop key');
  await b.press('Remove passkey');
  expect(b.all()).toContain('Could not save. Check the connection and try again.');
  expect(b.reported).not.toHaveBeenCalled();
});

it('signs a browser out after asking, through the desktop\'s check of this browser\'s own sign-in', async () => {
  answer(account());
  await b.draw('account', {}, 'primary');
  await b.press('Sign out Chrome on Linux');
  expect(b.all()).toContain('Sign this browser out?');
  expect(calls).toEqual([]);
  await b.press('Sign out browser');
  expect(calls).toEqual([['/api/account/revokeSession', { ref: browser }], ['/auth/session', undefined]]);
  expect(b.reported.mock.calls).toEqual([['revokeSession', {}]]);
  expect(world.reload).not.toHaveBeenCalled();
});

it('reloads and reports nothing when the browser signed out was this one; a refusal is not hidden', async () => {
  answer(account());
  await b.draw('account', {}, 'primary');
  world.viewer = null;
  await b.press('Sign out Chrome on Linux');
  await b.press('Sign out browser');
  expect(world.reload).toHaveBeenCalledOnce();
  expect(b.reported).not.toHaveBeenCalled();
  expect(b.all()).not.toContain('Saved.');
  world.viewer = { id: 'sam' }; world.refuse.add('/api/account/revokeSession'); world.reload.mockReset();
  await b.draw('account', {}, 'primary');
  await b.press('Sign out Chrome on Linux');
  await b.press('Sign out browser');
  expect(b.all()).toContain('Could not confirm sign-out. Check your sign-in and connection.');
  expect(b.reported).not.toHaveBeenCalled();
  expect(world.reload).not.toHaveBeenCalled();
});

/** This device's state arrives after a digest of its endpoint, which takes more than one turn of the loop on a
 * busy machine: wait for the words, for a bounded number of turns, and let the assertion that follows speak. */
async function settled(words: string) {
  for (let turn = 0; turn < 50 && !b.all().includes(words); turn++) await flush();
}

it('marks the notification device that is this one, removes a device after asking, and turns this device on by the bell\'s own helper', async () => {
  const mine = await deviceRef(endpoint);
  device({ subscribed: true, permission: 'granted' });
  answer(account({ notifications: { publicKey: 'a2V5', devices: [{ ref: mine, device: 'Chrome on Linux', createdAt: '2026-11-15T00:00:00Z', seenAt: '2026-11-16T00:00:00Z' }, { ref: phone, device: 'Kitchen tablet', createdAt: '2026-11-15T00:00:00Z', seenAt: '2026-11-16T00:00:00Z' }] } }));
  await b.draw('account', {}, 'primary');
  await settled('Notifications are on for this device.');
  expect(b.all()).toContain('Notifications are on for this device.');
  expect(b.all().split('This device')).toHaveLength(3); // the mark on one row, and the heading of the sign-out section
  expect(b.button('Turn on notifications on this device')).toBeUndefined();
  await b.press('Remove notification device Kitchen tablet');
  expect(calls).toEqual([]);
  await b.press('Remove notification device');
  expect(calls).toEqual([['/api/notifications/removeDevice', { ref: phone }]]);
  expect(b.reported.mock.calls).toEqual([['removeDevice', {}]]);

  calls.length = 0; b.reported.mockReset();
  const asked = device();
  answer(account());
  await b.draw('account', {}, 'primary');
  await settled('Notifications are off on this device.');
  expect(b.all()).toContain('Notifications are off on this device.');
  expect(asked.requestPermission).not.toHaveBeenCalled();
  await b.press('Turn on notifications on this device');
  expect(asked.requestPermission).toHaveBeenCalledOnce();
  expect(calls).toEqual([['/api/notifications/subscribe', { sub: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, device: 'Chrome on Linux' }]]);
  expect(b.reported.mock.calls).toEqual([['enableNotifications', {}]]);
});

it('adds a passkey through the sign-in door with the name typed, and the name never reaches the board', async () => {
  answer(account());
  await b.draw('account', {}, 'primary');
  await b.type('Passkey name', '  Garden phone ');
  await b.submit('Add a passkey');
  expect(calls.map(([url]) => url)).toEqual(['/passkeys/options', '/passkeys']);
  expect(calls[1][1]).toMatchObject({ label: 'Garden phone', publicKeyAlgorithm: -7 });
  expect(b.all()).toContain('Passkey added.');
  expect(b.field('Passkey name')!.props.value).toBe('');
  expect(b.reported).not.toHaveBeenCalled();
  calls.length = 0; world.refuse.add('/passkeys/options');
  await b.type('Passkey name', 'Another');
  await b.submit('Add a passkey');
  expect(b.all()).toContain('Add a passkey within ten minutes of signing in');
  expect(calls.map(([url]) => url)).toEqual(['/passkeys/options']);
  expect(b.reported).not.toHaveBeenCalled();
});

it('makes a one-time sign-in link once, shows it until hidden, and sends it nowhere', async () => {
  answer(account());
  await b.draw('account', {}, 'primary');
  await b.press('Make sign-in link');
  expect(calls).toEqual([['/api/signin/link', {}]]);
  expect(b.all()).toContain('https://loom.example' + linkPath);
  expect(b.reported).not.toHaveBeenCalled();
  await b.press('Hide sign-in link');
  expect(b.all()).not.toContain(linkPath);
  world.link = { status: 403, body: { error: 'PRIVATE DETAILS' } };
  await b.press('Make sign-in link');
  expect(b.all()).toContain('Sign in again before making a sign-in link.');
  expect(b.all()).not.toContain('PRIVATE');
  world.link = { status: 200, body: { ok: true, value: { path: '/elsewhere' } } };
  await b.press('Make sign-in link');
  expect(b.all()).toContain('The link could not be shown. It was not retried');
  expect(b.all()).not.toContain('/elsewhere');
  expect(calls).toHaveLength(3);
  expect(b.reported).not.toHaveBeenCalled();
});

it('signs this device out only after asking', async () => {
  answer(account());
  await b.draw('account', {}, 'primary');
  await b.press('Sign out this device…');
  expect(b.all()).toContain('Sign out of loom on this device?');
  expect(calls).toEqual([]);
  await b.press('Sign out this device');
  expect(calls).toEqual([['/logout', {}]]);
  expect(world.reload).toHaveBeenCalledOnce();
  expect(b.reported).not.toHaveBeenCalled();
});
