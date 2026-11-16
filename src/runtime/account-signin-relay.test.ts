import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { relaySignIn, type SignInRemote } from './account-signin-relay.js';
const request = { id: 'signin-1', account: 'account', owner: 'member', provider: 'provider' };
/** A stand-in for a provider's sign-in program, speaking the same files. Its last argument is the directory. */
const program = (body: string) => ({ command: process.execPath, args: ['-e', `const fs=require('fs'),dir=process.argv.at(-1),at=n=>dir+'/'+n;${body}`], cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } });
const waitForCode = `const t=setInterval(()=>{if(fs.existsSync(at('code'))){const c=fs.readFileSync(at('code'),'utf8');fs.unlinkSync(at('code'));clearInterval(t);if(c==='GOODCODE123')process.exit(0);fs.writeFileSync(at('why'),'The page refused that code\\nPRIVATE SECOND LINE');process.exit(1);}},20);`;
function remote(codes: (string | null)[] = [], stopAfter = Infinity) {
  const calls: unknown[] = []; let asked = 0;
  const value: SignInRemote = { page: async page => { calls.push(['page', page]); }, done: async done => { calls.push(['done', done]); },
    code: async () => { asked++; return { code: codes.shift() ?? null, stop: asked > stopAfter }; } };
  return { value, calls, dirs: () => calls.filter(call => (call as [string])[0] === 'page') };
}
const options = () => ({ signal: new AbortController().signal, everyMs: 20, timeoutMs: 10_000 });

it('shows the page, hands the answered code to the program once, and reports what the program\'s exit says', async () => {
  const r = remote([null, null, 'GOODCODE123']);
  expect(await relaySignIn(program(`fs.writeFileSync(at('link'),'https://provider.example/oauth?x=1\\n');${waitForCode}`), request, r.value, options())).toBe(true);
  expect(r.calls).toEqual([['page', { id: 'signin-1', link: 'https://provider.example/oauth?x=1' }], ['done', { id: 'signin-1', signedIn: true }]]);
  const bad = remote(['WRONGCODE999']);
  expect(await relaySignIn(program(`fs.writeFileSync(at('link'),'https://provider.example/oauth');${waitForCode}`), request, bad.value, options())).toBe(false);
  expect(bad.calls.at(-1)).toEqual(['done', { id: 'signin-1', signedIn: false, why: 'The page refused that code' }]);
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
  expect(ended.calls.at(-1)).toEqual(['done', { id: 'signin-1', signedIn: false, why: 'The sign-in was ended before it finished' }]);
  const late = remote(); expect(await relaySignIn(program(hang), request, late.value, { ...options(), timeoutMs: 400 })).toBe(false);
  expect(late.calls.at(-1)).toEqual(['done', { id: 'signin-1', signedIn: false, why: 'Nobody finished the sign-in in time' }]);
  const unusable = remote(); expect(await relaySignIn(program(`fs.writeFileSync(at('link'),'javascript:alert(1)');setInterval(()=>{},1000);`), request, unusable.value, options())).toBe(false);
  expect(unusable.calls).toEqual([['done', { id: 'signin-1', signedIn: false, why: 'The sign-in program gave no usable page' }]]);
  const abort = new AbortController(), stopped = remote(); setTimeout(() => abort.abort(), 200);
  expect(await relaySignIn(program(hang), request, stopped.value, { ...options(), signal: abort.signal })).toBe(false);
  expect(stopped.calls.at(-1)).toEqual(['done', { id: 'signin-1', signedIn: false, why: 'The worker stopped' }]);
  const missing = remote(); expect(await relaySignIn({ command: '/nonexistent/program', args: [], cwd: process.cwd(), env: {} }, request, missing.value, options())).toBe(false);
  expect((missing.calls.at(-1) as [string, { signedIn: boolean }])[1].signedIn).toBe(false);
  expect(existsSync('/tmp')).toBe(true);
});
