import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startHttpServer } from './http-server.js';
import { createFoundation } from '../core/app.js';
import { installFixture } from '../fixture.js';
import { loadHousehold, createToken, revokeToken, loadTokens, mintReviewToken, type Role } from '../household.js';
import { sessionStore } from '../ui/sessions.js';
let close: (() => Promise<void>) | undefined;
let dir: string;
afterEach(async () => { await close?.(); close = undefined; if (dir) rmSync(dir, { recursive: true, force: true }); });
it('mounts the new doors behind existing token/session checks and keeps the old page route', async () => {
  dir = mkdtempSync(join(tmpdir(), 'loom-mount-'));
  mkdirSync(join(dir, 'agents/art'), { recursive: true });
  writeFileSync(join(dir, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
  const household = loadHousehold(dir)!;
  const token = createToken(household, { role: { kind: 'agent', agent: 'art' }, label: 'test' }).token;
  const foundation = createFoundation({ home: dir }); installFixture(foundation);
  const server = await startHttpServer({ contextDir: join(dir, 'agents/art'), household, foundation, host: '127.0.0.1', port: 0, token: 'owner-token' }); close = () => server.close();
  const url = `http://127.0.0.1:${server.port}`;
  const input = { id: 'one', title: 'from token', agent: 'art' };
  const post = (headers: Record<string, string>, id: string) => fetch(url + '/api/example/put', { method: 'POST', headers, body: JSON.stringify({ input, id }) });
  expect((await post({}, 'no')).status).toBe(401);
  expect(await (await post({ authorization: 'Bearer ' + token }, 'agent')).json()).toMatchObject({ ok: true });
  const sessions = sessionStore(dir), cookie = sessions.create(createHash('sha256').update('owner-token').digest());
  expect((await post({ cookie: 'loom_ui=' + cookie }, 'session')).status).toBe(401);
  const csrf = createHmac('sha256', sessions.key).update(`loom-ui-csrf|${cookie}`).digest('hex');
  expect(await (await post({ cookie: 'loom_ui=' + cookie, 'x-loom-csrf': csrf }, 'session')).json()).toMatchObject({ ok: true });
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/live', { headers: { cookie: 'loom_ui=' + cookie } });
  await once(ws, 'open');
  const bad = new WebSocket(url.replace('http:', 'ws:') + '/live', { headers: { cookie: 'loom_ui=' + cookie, origin: 'https://attacker.test' } });
  await expect(once(bad, 'open')).rejects.toThrow('401');
  const ended = once(ws, 'close');
  sessions.delete(cookie);
  // Existing page handling is the bridge until sign-in operations migrate.
  const old = await fetch(url + '/login/' + 'a'.repeat(64), { headers: { authorization: 'Bearer owner-token' } });
  expect(old.status).toBe(200);
  expect(old.headers.get('content-type')).toContain('text/html');
  await ended;
});

async function mounted() {
  dir = mkdtempSync(join(tmpdir(), 'loom-mount-'));
  mkdirSync(join(dir, 'agents/art'), { recursive: true });
  mkdirSync(join(dir, 'agents/mark'), { recursive: true });
  writeFileSync(join(dir, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [
    { person: 'jonathan', role: 'owner', agents: '*' }, { person: 'pollock', role: 'owner', agents: ['mark'] },
  ] }));
  const household = loadHousehold(dir)!;
  const foundation = createFoundation({ home: dir }); installFixture(foundation);
  const server = await startHttpServer({ contextDir: join(dir, 'agents/art'), household, foundation, host: '127.0.0.1', port: 0, token: 'owner-token' });
  close = () => server.close();
  const url = `http://127.0.0.1:${server.port}`;
  const post = (headers: Record<string, string>, id = 'write') => fetch(url + '/api/example/put', {
    method: 'POST', headers, body: JSON.stringify({ input: { id: 'one', title: 'Hello', agent: 'art' }, id }),
  });
  return { household, foundation, url, post };
}
it('binds mixed cookie and bearer credentials to the original member and source', async () => {
  const { household, foundation, url, post } = await mounted();
  const bearer = createToken(household, { role: { kind: 'owner', member: 'pollock' }, label: 'other-member' }).token;
  const sessions = sessionStore(dir), cookie = sessions.create(createHash('sha256').update('owner-token').digest());
  const headers = { cookie: 'loom_ui=' + cookie, authorization: 'Bearer ' + bearer };
  // The bearer must not rescue a cookie that failed CSRF.
  expect((await post(headers)).status).toBe(401);
  const csrf = createHmac('sha256', sessions.key).update(`loom-ui-csrf|${cookie}`).digest('hex');
  expect(await (await post({ ...headers, 'x-loom-csrf': csrf })).json()).toMatchObject({ ok: true });
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/live', { headers });
  await once(ws, 'open');
  const ended = once(ws, 'close'); sessions.delete(cookie);
  expect((await ended)[0]).toBe(1008);
  // An ended cookie cannot keep its former viewer through the live bearer.
  const result = await (await post({ authorization: 'Bearer ' + bearer }, 'other')).json();
  expect(result).toMatchObject({ ok: false, code: 'denied' });
  expect(foundation.db.prepare("SELECT viewer FROM core_operations WHERE id='write'").get()).toEqual({ viewer: '{"id":"jonathan","kind":"member"}' });
});
it.each(['peer', 'piece', 'runtime', 'review'] as const)('rejects unsupported legacy %s tokens at HTTP and live doors', async kind => {
  const { household, url, post } = await mounted();
  const roles: Record<string, Role> = { peer: { kind: 'peer', name: 'guest' }, piece: { kind: 'piece', piece: 'outside', subject: 'guest' }, runtime: { kind: 'runtime', piece: 'runtime' } };
  const token = kind === 'review' ? mintReviewToken(household, 'runtime').token
    : createToken(household, { role: roles[kind], label: kind, runtimePieces: ['runtime'] }).token;
  expect((await post({ authorization: 'Bearer ' + token })).status).toBe(401);
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/live', { headers: { authorization: 'Bearer ' + token } });
  await expect(once(ws, 'open')).rejects.toThrow('401');
});
it('rejects revoked agent tokens and closes their established sockets on revocation', async () => {
  const { household, url, post } = await mounted();
  const token = createToken(household, { role: { kind: 'agent', agent: 'art' }, label: 'agent' }).token;
  const headers = { authorization: 'Bearer ' + token };
  expect(await (await post(headers)).json()).toMatchObject({ ok: true });
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/live', { headers }); await once(ws, 'open');
  const ended = once(ws, 'close'); revokeToken(household, 'agent');
  expect((await ended)[0]).toBe(1008);
  expect((await post(headers, 'revoked')).status).toBe(401);
  const rejected = new WebSocket(url.replace('http:', 'ws:') + '/live', { headers });
  await expect(once(rejected, 'open')).rejects.toThrow('401');
});
it('closes an established socket if its agent token resolves to a different agent', async () => {
  const { household, foundation, url } = await mounted();
  const token = createToken(household, { role: { kind: 'agent', agent: 'art' }, label: 'agent' }).token;
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/live', { headers: { authorization: 'Bearer ' + token } }); await once(ws, 'open');
  const tokens = loadTokens(dir); tokens.find(t => t.label === 'agent')!.role = 'agent:mark';
  writeFileSync(join(dir, 'tokens.json'), JSON.stringify(tokens));
  const ended = once(ws, 'close'); foundation.live.refreshAccess();
  expect((await ended)[0]).toBe(1008);
});
