import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startLoom } from '../../foundation.js';
import { FakeClock } from '../clock.js';
import { fixture } from '../../fixture.js';
import { SharingDatabase } from '../household/sharing.js';
import { signin, hash } from './index.js';
import { installComms } from '../../pieces/comms/index.js';
import { loadKey } from '../../pieces/comms/crypto.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup(beforeOpen?: () => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'signin-window-'));
  cleanups.push(() => rmSync(home, {recursive: true, force: true}));
  fixture(home);
  const clock = new FakeClock(), key = await loadKey(home);
  let comms!: ReturnType<typeof installComms>;
  const app = await startLoom({home, clock, next: true, stdout: () => {}, install: app => {
    comms = installComms({db: app.db, operations: app.operations, live: app.live, clock,
      sharing: () => new SharingDatabase(app.db, home).sharing(), key: {...key, async open(blob) { await beforeOpen?.(); return key.open(blob); }},
      runtime: {async deliver() {}, async end() {}}, hold: effect => effect(),
      attention: {answer: () => ({ok: false, code: 'unavailable', message: 'Not installed'})},
      recipients: () => ({agents: ['art'], default: 'art'}),
    });
  }});
  cleanups.push(app.close);
  cleanups.push(comms.close);
  const auth = signin(app), bearer = randomBytes(32).toString('hex');
  auth.tokens.change(tokens => tokens.push({role: 'owner', member: 'jonathan', label: 'window-test', sha256: hash(bearer), created: new Date(clock.now()).toISOString()}));
  const cookie = auth.createSession(hash(bearer));
  const headers = {cookie: `loom_ui=${cookie}`, origin: app.url};
  const resolve = (extra: Record<string, string> = {}, method = 'GET') => auth.resolve({headers: {...headers, ...extra}, method} as IncomingMessage);
  async function socket(extra: Record<string, string> = {}) {
    const ws = new WebSocket(app.url.replace('http:', 'ws:') + '/live', {headers: {...headers, ...extra}});
    cleanups.push(() => { ws.terminate(); });
    await once(ws, 'open'); return ws;
  }
  const call = async (ws: WebSocket, name: string, input: unknown, id = 'test') => {
    const answer = new Promise<{ok: boolean; value?: unknown}>(resolve => {
      const receive = (raw: unknown) => {
        const message = JSON.parse(String(raw));
        if (message.kind === 'result' && message.request === id) { ws.off('message', receive); resolve(message.result); }
      };
      ws.on('message', receive);
    });
    ws.send(JSON.stringify({kind: 'call', name, input, id, request: id}));
    return answer;
  };
  return {app, auth, bearer, cookie, clock, resolve, socket, call, comms};
}
it('derives window capability from a validated cookie session, never bearer or caller headers', async () => {
  const f = await setup();
  expect(f.resolve()).toMatchObject({window: true, viewer: {kind: 'member', id: 'jonathan'}});
  const token = f.resolve({authorization: `Bearer ${f.bearer}`, 'x-window': 'yes', 'x-loom-window': 'true'});
  expect(token?.viewer).toEqual({kind: 'member', id: 'jonathan'});
  expect(f.resolve({authorization: 'Bearer invalid'})).toBeUndefined();
  expect(token?.window).not.toBe(true); // Bearer wins even when a valid cookie accompanies it.
  expect(f.resolve({cookie: 'loom_ui=forged', 'x-window': 'yes'})).toBeUndefined();
  expect(f.resolve({}, 'POST')).toBeUndefined();
  expect(f.resolve({'x-loom-csrf': f.auth.csrf(f.cookie)}, 'POST')?.window).toBe(true);
});
it('opens real Comms socket operations to the signed-in page and keeps member bearer sockets denied', async () => {
  const f = await setup(), page = await f.socket();
  expect(await f.call(page, 'comms.route', {})).toMatchObject({ok: true, value: {agents: ['art'], pick: 'art'}});
  const opened = await f.call(page, 'comms.open', {agent: 'art', id: 'abcdefghijklmnop', text: 'Private fixture words'}, 'open');
  expect(opened.ok).toBe(true);
  const thread = (opened.value as {thread: string}).thread;
  await f.comms.deliver('art', thread, 1);
  expect(await f.call(page, 'comms.messages', {thread}, 'read')).toMatchObject({ok: true, value: [{text: 'Private fixture words'}]});
  const token = await f.socket({authorization: `Bearer ${f.bearer}`, 'x-window': 'yes'});
  expect(await f.call(token, 'comms.route', {})).toMatchObject({ok: false, code: 'denied'});
  const answer = once(token, 'message'); token.send(JSON.stringify({kind: 'subscribe', type: 'thread'}));
  expect(JSON.parse(String((await answer)[0]))).toMatchObject({ok: false, code: 'denied'});
  const snapshot = once(page, 'message'); page.send(JSON.stringify({kind: 'subscribe', type: 'thread'}));
  expect(JSON.parse(String((await snapshot)[0]))).toMatchObject({kind: 'set', type: 'thread', records: [{id: thread}]});
});
it('keeps capability validity bound to session and token revocation and closes the page socket', async () => {
  const f = await setup(), auth = f.resolve()!, ws = await f.socket();
  expect(auth.valid()).toBe(true);
  const ended = once(ws, 'close'); f.auth.end(f.cookie);
  expect(auth.valid()).toBe(false); expect(f.resolve()).toBeUndefined();
  expect((await ended)[0]).toBe(1008);
  const cookie = f.auth.createSession(hash(f.bearer));
  const before = f.auth.resolve({headers: {cookie: `loom_ui=${cookie}`}, method: 'GET'} as IncomingMessage)!;
  expect(before.window).toBe(true);
  f.auth.tokens.change(tokens => { tokens.find(t => t.label === 'window-test')!.revoked = new Date(f.clock.now()).toISOString(); });
  expect(before.valid()).toBe(false);
});
it('does not retain a window capability after the central session deadline', async () => {
  const f = await setup();
  f.auth.sessions.change(file => { file.sessions[hash(f.cookie)].issuedAt = f.clock.now()/1000 - 30*86400 + 1; });
  const auth = f.resolve()!; expect(auth.window).toBe(true);
  f.clock.advance(1000);
  expect(auth.valid()).toBe(false); expect(f.resolve()).toBeUndefined();
});

it('rechecks the page session after private decryption before returning words', async () => {
  let pause = false, began!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { began = r; }), wait = new Promise<void>(r => { release = r; });
  const f = await setup(async () => { if (pause) { began(); await wait; } });
  const auth = f.resolve()!, page = await f.socket();
  const opened = await f.call(page, 'comms.open', {agent: 'art', id: 'abcdefghijklmnop', text: 'Revoked private words'}, 'open');
  const thread = (opened.value as {thread: string}).thread;
  await f.comms.deliver('art', thread, 1);
  pause = true;
  const result = f.app.operations.callAsync('socket', auth.viewer, 'comms.messages', {thread}, undefined, auth.window, auth.valid);
  await entered;
  f.auth.end(f.cookie); release();
  const answer = await result;
  expect(answer).toMatchObject({ok: false, code: 'denied'});
  expect(JSON.stringify(answer)).not.toContain('Revoked private words');
});
