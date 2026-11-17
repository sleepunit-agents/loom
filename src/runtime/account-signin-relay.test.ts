import { existsSync } from 'node:fs';
import { RELAY_MS, SIGNIN_MS } from './account-signin-time.js';
import { expect, it } from 'vitest';
import {relaySignIn, type SignInRemote } from './account-signin-relay.js';
const request = { id: 'signin-1', account: 'account', owner: 'member', provider: 'provider' };
/** A stand-in for a provider's sign-in program, speaking the same files. Its last argument is the directory. */
const program = (body: string) => ({ command: process.execPath, args: ['-e', `const fs=require('fs'),dir=process.argv.at(-1),at=n=>dir+'/'+n;${body}`], cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } });
const waitForCode = `const t=setInterval(()=>{if(fs.existsSync(at('code'))){const c=fs.readFileSync(at('code'),'utf8');fs.unlinkSync(at('code'));clearInterval(t);if(c==='GOODCODE123')process.exit(0);fs.writeFileSync(at('why'),'wrong-code\\nPRIVATE SECOND LINE');process.exit(1);}},20);`;
/** A stand-in for loom. `codes` is what the owner has answered at each ask (null: nothing yet); the code is
 * handed over only to the take id that took it. `lose` drops that many replies, after loom has acted. */
function remote(codes: (string | null)[] = [], stopAfter = Infinity, lose = 0) {
  const calls: unknown[] = [], takes = new Set<string>(); let asked = 0, waiting: string | null = null, held: { take: string; code: string } | undefined;
  const reply = <T>(value: T): T => { if (lose-- > 0) throw new Error('reply lost'); return value; };
  const value: SignInRemote = { page: async page => { calls.push(['page', page]); }, done: async done => { calls.push(['done', done]); },
    take: async (_id, take) => { takes.add(take); if (waiting && !held) { held = { take, code: waiting }; waiting = null; } return reply({ taken: held?.take === take }); },
    code: async (_id, take) => {
      asked++; takes.add(take);
      if (asked > stopAfter) return reply({ code: null, stop: true, answered: false });
      if (held) return reply(held.take === take ? { code: held.code, stop: false, answered: true } : { code: null, stop: true, answered: false });
      waiting ??= codes.shift() ?? null;
      return reply({ code: null, stop: false, answered: waiting !== null });
    } };
  return { value, calls, takes };
}
const options = () => ({ signal: new AbortController().signal, everyMs: 20, timeoutMs: 10_000 });

it('shows the page, hands the answered code to the program once, and reports what the program\'s exit says', async () => {
  const r = remote([null, null, 'GOODCODE123']);
  expect(await relaySignIn(program(`fs.writeFileSync(at('link'),'https://provider.example/oauth?x=1\\n');${waitForCode}`), request, r.value, options())).toBe(true);
  expect(r.calls).toEqual([['page', { id: 'signin-1', link: 'https://provider.example/oauth?x=1' }], ['done', { id: 'signin-1', signedIn: true }]]);
  const bad = remote(['WRONGCODE999']);
  expect(await relaySignIn(program(`fs.writeFileSync(at('link'),'https://provider.example/oauth');${waitForCode}`), request, bad.value, options())).toBe(false);
  expect(bad.calls.at(-1)).toEqual(['done', { id: 'signin-1', signedIn: false, why: 'wrong-code' }]);
});
it('takes the code once under one take id, and gets it through replies that never arrive', async () => {
  const r = remote([null, 'GOODCODE123'], Infinity, 0), lossy = remote(['GOODCODE123'], Infinity, 3);
  for (const each of [r, lossy]) {
    expect(await relaySignIn(program(`fs.writeFileSync(at('link'),'https://provider.example/oauth');${waitForCode}`), request, each.value, options())).toBe(true);
    expect(each.calls.at(-1)).toEqual(['done', { id: 'signin-1', signedIn: true }]);
    expect(each.takes.size).toBe(1);
  }
});
it('shows a device flow\'s code and waits for the program to finish by itself, never typing anything', async () => {
  const r = remote(['SHOULD-NOT-BE-USED']);
  const device = `fs.writeFileSync(at('user-code'),'ABCD-12345\\n');fs.writeFileSync(at('link'),'https://auth.example/device\\n');setTimeout(()=>process.exit(fs.existsSync(at('code'))?3:0),300);`;
  expect(await relaySignIn(program(device), request, r.value, options())).toBe(true);
  expect(r.calls).toEqual([['page', { id: 'signin-1', link: 'https://auth.example/device', userCode: 'ABCD-12345' }], ['done', { id: 'signin-1', signedIn: true }]]);
});
it('ends the program and says why when loom ends the request, nobody answers in time, the page is unusable, or the worker stops', async () => {
  const hang = `fs.writeFileSync(at('link'),'https://provider.example/oauth');setInterval(()=>{},1000);`;
  const ended = remote([], 1); expect(await relaySignIn(program(hang), request, ended.value, options())).toBe(false);
  expect(ended.calls.at(-1)).toEqual(['done', { id: 'signin-1', signedIn: false, why: 'ended' }]);
  const late = remote(); expect(await relaySignIn(program(hang), request, late.value, { ...options(), timeoutMs: 400 })).toBe(false);
  expect(late.calls.at(-1)).toEqual(['done', { id: 'signin-1', signedIn: false, why: 'timed-out' }]);
  const unusable = remote(); expect(await relaySignIn(program(`fs.writeFileSync(at('link'),'javascript:alert(1)');setInterval(()=>{},1000);`), request, unusable.value, options())).toBe(false);
  expect(unusable.calls).toEqual([['done', { id: 'signin-1', signedIn: false, why: 'no-page' }]]);
  const abort = new AbortController(), stopped = remote(); setTimeout(() => abort.abort(), 200);
  expect(await relaySignIn(program(hang), request, stopped.value, { ...options(), signal: abort.signal })).toBe(false);
  expect(stopped.calls.at(-1)).toEqual(['done', { id: 'signin-1', signedIn: false, why: 'stopped' }]);
  const missing = remote(); expect(await relaySignIn({ command: '/nonexistent/program', args: [], cwd: process.cwd(), env: {} }, request, missing.value, options())).toBe(false);
  expect((missing.calls.at(-1) as [string, { signedIn: boolean }])[1].signedIn).toBe(false);
  expect(existsSync('/tmp')).toBe(true);
});
it('carries none of the program\'s own words: a reason outside the list is the plain word', async () => {
  const leak = `fs.writeFileSync(at('link'),'https://provider.example/oauth');setTimeout(()=>{fs.writeFileSync(at('why'),'token sk-PRIVATE-0123456789 was rejected');process.exit(1);},50);`;
  const r = remote(); expect(await relaySignIn(program(leak), request, r.value, options())).toBe(false);
  expect(r.calls.at(-1)).toEqual(['done', { id: 'signin-1', signedIn: false, why: 'unsaid' }]);
  expect(JSON.stringify(r.calls)).not.toContain('PRIVATE');
  const proto = `fs.writeFileSync(at('link'),'https://provider.example/oauth');setTimeout(()=>{fs.writeFileSync(at('why'),'constructor');process.exit(1);},50);`;
  const p = remote(); await relaySignIn(program(proto), request, p.value, options());
  expect(p.calls.at(-1)).toEqual(['done', { id: 'signin-1', signedIn: false, why: 'unsaid' }]);
});

it('gives up before loom closes the request, so the worker says why and loom does not time it out unsaid', () => {
  expect(RELAY_MS).toBeLessThan(SIGNIN_MS);
});
