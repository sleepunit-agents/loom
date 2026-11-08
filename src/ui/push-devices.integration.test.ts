/**
 * Profile's devices that get notifications (t-1978), through the page: a device stays on through agent sign-ins and
 * signing in again, each person sees and tests only their own, and Remove sticks until it's turned on there again.
 * No push leaves the test: web-push's send is a stand-in that records.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sent = vi.hoisted(() => [] as Array<{ endpoint: string; payload: string }>);
vi.mock('web-push', async (orig) => {
  const real = (await orig()) as { default: Record<string, unknown> };
  return { default: { ...real.default, sendNotification: async (sub: { endpoint: string }, payload: string) => { sent.push({ endpoint: sub.endpoint, payload }); return {}; } } };
});

const { startHttpServer } = await import('../transport/http-server.js');
const { createToken, loadHousehold } = await import('../household.js');
const { MAX_SESSIONS, signinLink } = await import('./sessions.js');
const { closeAllBackends } = await import('../backends/index.js');

const HEADLESS = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const phoneSub = { endpoint: 'https://web.push.apple.com/QJ-phone-test', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };
const lorenSub = { endpoint: 'https://fcm.googleapis.com/fcm/send/loren-test', keys: { p256dh: 'C'.repeat(87), auth: 'b'.repeat(22) } };

describe('devices that get notifications, on Profile (t-1978, t-1936)', () => {
  let home: string;
  let handle: Awaited<ReturnType<typeof startHttpServer>>;
  let base: string;
  let h: NonNullable<ReturnType<typeof loadHousehold>>;
  let jonathan: string;
  let loren: string;
  beforeEach(async () => {
    sent.length = 0;
    home = mkdtempSync(join(tmpdir(), 'loom-push-devices-'));
    for (const a of ['art', 'mark']) { mkdirSync(join(home, 'agents', a), { recursive: true }); writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n\nI am ${a}.\n`); }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'loren', role: 'owner', agents: ['mark'] }] }));
    h = loadHousehold(home)!;
    jonathan = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    loren = createToken(h, { role: { kind: 'owner', member: 'loren' }, label: 'loren · page' }).token;
    handle = await startHttpServer({ contextDir: join(home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    await handle.close();
    await closeAllBackends();
    rmSync(home, { recursive: true, force: true });
  });

  const login = async (token: string, ua = IPHONE) => {
    const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': ua }, body: `token=${encodeURIComponent(token)}`, redirect: 'manual' });
    return (r.headers.get('set-cookie') ?? '').split(';')[0];
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const account = async (cookie: string): Promise<any> => (await fetch(`${base}/account`, { headers: { cookie, accept: 'application/json' }, redirect: 'manual' })).json();
  const devices = async (cookie: string) => {
    const sec = (await account(cookie)).page.sections.find((s: { id: string }) => s.id === 'notifications');
    return (sec.blocks.find((b: { type: string }) => b.type === 'list')?.items ?? []) as Array<{ text: string; act: { action: string; fields: { ref: string } } }>;
  };
  const subscribe = async (cookie: string, sub: unknown, again = false) => {
    const csrf = (await account(cookie)).ctx.csrf as string;
    return fetch(`${base}/push/subscribe`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'user-agent': IPHONE }, body: JSON.stringify({ _csrf: csrf, sub, ...(again ? { again: true } : {}) }) });
  };
  const act = async (cookie: string, action: string, ref: string) => {
    const csrf = (await account(cookie)).ctx.csrf as string;
    const r = await fetch(`${base}/act/loom`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1', 'sec-fetch-site': 'same-origin' },
      body: new URLSearchParams({ _csrf: csrf, _action: action, _path: 'passkeys', ref }).toString() });
    return r.json() as Promise<{ ok: boolean; message: string }>;
  };

  it('his phone stays on through a cap\'s worth of agent sign-ins, he can send it a test, and only his own', async () => {
    const phone = await login(jonathan);
    expect((await subscribe(phone, phoneSub)).status).toBe(200);
    const lorenC = await login(loren);
    // An agent owner turns them on too (they were refused /push/* before t-1978).
    expect((await subscribe(lorenC, lorenSub)).status).toBe(200);
    // Agents' screenshot sign-ins, more than the cap (t-1936): his session and his device stay.
    for (let i = 0; i < MAX_SESSIONS + 5; i++) {
      const code = signinLink(h, 600, 'jonathan', `screenshots t-${i}`, undefined, true);
      const r = await fetch(`${base}/login/${code}`, { method: 'POST', redirect: 'manual', headers: { 'user-agent': HEADLESS, 'sec-fetch-site': 'same-origin' } });
      expect(r.status).toBe(303);
    }
    expect((await fetch(`${base}/account`, { headers: { cookie: phone, accept: 'application/json' }, redirect: 'manual' })).status).toBe(200);
    const mine = await devices(phone);
    expect(mine.map((d) => d.text)).toEqual(['Safari on iPhone (this device)']);
    expect((await devices(lorenC)).map((d) => d.text)).toEqual(['Safari on iPhone (this device)']);
    // The test goes to his phone alone.
    expect(await act(phone, 'push-test', mine[0].act.fields.ref)).toMatchObject({ ok: true });
    expect(sent.map((x) => x.endpoint)).toEqual([phoneSub.endpoint]);
    expect(JSON.parse(sent[0].payload)).toMatchObject({ title: 'loom · test' });
    // Loren's device isn't his to test or remove.
    const hers = (await devices(lorenC))[0].act.fields.ref;
    expect(await act(phone, 'push-test', hers)).toMatchObject({ ok: false });
    expect(await act(phone, 'push-remove', hers)).toMatchObject({ ok: false });
    expect(sent).toHaveLength(1);
    // An agent's screenshot session can't turn notifications on.
    const code = signinLink(h, 600, 'jonathan', 'screenshots push', undefined, true);
    const shot = (await fetch(`${base}/login/${code}`, { method: 'POST', redirect: 'manual', headers: { 'user-agent': HEADLESS, 'sec-fetch-site': 'same-origin' } })).headers.get('set-cookie')!.split(';')[0];
    expect((await subscribe(shot, { ...phoneSub, endpoint: 'https://web.push.apple.com/agent' })).status).toBe(403);
    expect((await devices(phone)).map((d) => d.text)).toEqual(['Safari on iPhone (this device)']);
  });

  it('signing a lost phone out on Profile stops its notifications; his other devices keep theirs', async () => {
    const lost = await login(jonathan);
    await subscribe(lost, phoneSub);
    const desk = await login(jonathan, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await subscribe(desk, { ...lorenSub, endpoint: 'https://fcm.googleapis.com/fcm/send/desk-test' });
    expect(await devices(desk)).toHaveLength(2);
    const sessions = (await account(desk)).page.sections.find((x: { id: string }) => x.id === 'sessions').blocks[0].items as Array<{ text: string; act?: { fields: { ref: string } } }>;
    const row = sessions.find((r) => r.text.startsWith('Safari on iPhone'))!;
    const csrf = (await account(desk)).ctx.csrf as string;
    const r = await fetch(`${base}/act/loom`, { method: 'POST', redirect: 'manual', headers: { cookie: desk, 'content-type': 'application/x-www-form-urlencoded', 'x-loom-fetch': '1', 'sec-fetch-site': 'same-origin' },
      body: new URLSearchParams({ _csrf: csrf, _action: 'session-revoke', _path: 'passkeys', ref: row.act!.fields.ref }).toString() });
    expect(await r.json()).toMatchObject({ ok: true });
    // Only the desk's own is left (the helper names every device from its iPhone User-Agent; "this device" is the desk).
    expect((await devices(desk)).map((d) => d.text)).toEqual(['Safari on iPhone (this device)']);
  });

  it('signing out and in again on the device keeps it; Remove on Profile stops it, the device can\'t quietly undo that, turning it on can', async () => {
    const first = await login(jonathan);
    await subscribe(first, phoneSub);
    const csrf = (await account(first)).ctx.csrf as string;
    await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: first, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, body: `_csrf=${csrf}` });
    const again = await login(jonathan);
    expect((await devices(again)).map((d) => d.text)).toEqual(['Safari on iPhone']);
    // The app, loaded on the phone, sends what it holds again: it's this device once more.
    expect((await subscribe(again, phoneSub, true)).status).toBe(200);
    const [d] = await devices(again);
    expect(d.text).toBe('Safari on iPhone (this device)');
    expect(await act(again, 'push-remove', d.act.fields.ref)).toMatchObject({ ok: true });
    expect(await devices(again)).toEqual([]);
    const quiet = await subscribe(again, phoneSub, true);
    expect(quiet.status).toBe(409);
    expect(await quiet.json()).toMatchObject({ removed: true });
    expect(await devices(again)).toEqual([]);
    expect((await subscribe(again, phoneSub)).status).toBe(200);
    expect(await devices(again)).toHaveLength(1);
  });
});
