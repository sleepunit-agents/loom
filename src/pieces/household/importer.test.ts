import { afterEach, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { HouseholdRows } from '../../core/household/rows.js';
import { TokenDatabase } from '../../core/household/tokens.js';
import { TokenResolver } from '../../household.js';
import { SessionDatabase } from '../../ui/session-db.js';
import { SessionStore } from '../../ui/sessions.js';
import { importHousehold } from './importer.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'household-import-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const from = join(root, 'old'), home = join(root, 'new'); mkdirSync(from);
  const app = await startLoom({ home }); cleanup.push(() => app.close());
  const household = { v: 1, agents: ['art','mark'], default: 'mark', owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'pollock', role: 'member', agents: ['mark'] }], future: { kept: true } };
  const tokens = { v: 1, tokens: [ { label: 'browser', role: 'owner', member: 'pollock', sha256: hash('token'), created: '2026-11-12T00:00:00Z' }, { label: 'agent', role: 'agent:art', sha256: hash('agent'), created: '2026-11-12T00:00:00Z' } ] };
  const sessions = { v: 1, sessions: { [hash('cookie')]: { issuedAt: 1000, secret: hash('token'), signedInAt: 900, via: 'passkey' } },
    links: { [hash('link')]: { expires: 2000, secret: hash('token') } },
    passkeys: { cred: { id: 'cred', publicKey: 'EXACT_-', alg: -7, counter: 42, label: 'phone', created: 900, secret: hash('token'), tokenLabel: 'browser' } },
    members: { pollock: { prefs: { look: 'daylight' }, opened: { item: 42 } } },
    push: { subs: { 'https://push.invalid': { session: hash('cookie'), token: hash('token'), sub: { endpoint: 'https://push.invalid', keys: { p256dh: 'p', auth: 'a' } }, at: 1000, member: 'pollock' } } }, future: ['kept'] };
  const files: Record<string, Buffer> = {};
  for (const [name, value] of Object.entries({ 'household.json': household, 'tokens.json': tokens, 'tokens.used.json': { [hash('token')]: 'yesterday' }, 'ui-sessions.json': sessions, 'pieces/runtime/settings.json': { choice: 'kept' } })) {
    const path = join(from,name); mkdirSync(join(path,'..'), { recursive: true }); files[name] = Buffer.from(JSON.stringify(value)); writeFileSync(path, files[name]);
  }
  files['ui-cookie.key'] = randomBytes(32); writeFileSync(join(from,'ui-cookie.key'),files['ui-cookie.key']);
  return { app, home, from, files, household, tokens, sessions };
}
it('compares every concern, leaves source bytes untouched, and repeats without overwriting later changes', async () => {
  const f = await fixture();
  expect(importHousehold(f.app.db,f.home,f.from,1000)).toMatchObject({ imported: true, counts: { agents: 2, members: 2, tokens: 2, sessions: 1, pieces: 1 } });
  expect(new HouseholdDatabase(f.app.db).document()).toEqual(f.household);
  expect(new SessionDatabase(f.app.db).read()).toEqual(f.sessions);
  expect(new TokenDatabase(f.app.db).document()).toEqual(f.tokens);
  expect(new HouseholdRows(f.app.db,'piece_settings').get('runtime')).toEqual({choice:'kept'});
  const store = new SessionStore(f.home,new SessionDatabase(f.app.db));
  expect(store.key).toEqual(f.files['ui-cookie.key']);
  expect(store.get('cookie')).toMatchObject({ secret: Buffer.from(hash('token'),'hex'), signedInAt: 900 });
  expect(store.passkey('cred')).toEqual(f.sessions.passkeys.cred);
  expect(store.spendLink('link',1001)?.secret).toEqual(Buffer.from(hash('token'),'hex'));
  expect(store.spendLink('link',1001)).toBeNull();
  const h = new HouseholdDatabase(f.app.db).household(f.home)!;
  const resolver = new TokenResolver(h, { persistence: new TokenDatabase(f.app.db) });
  expect(resolver.resolve('token')).toEqual({kind:'owner',member:'pollock'});
  expect(resolver.resolve('agent')).toEqual({kind:'agent',agent:'art'});
  expect(importHousehold(f.app.db,f.home,f.from,2000)).toMatchObject({ imported: false });
  expect(store.spendLink('link',1001)).toBeNull();
  for (const [name,bytes] of Object.entries(f.files)) expect(readFileSync(join(f.from,name))).toEqual(bytes);
  for (const name of ['household.json','tokens.json','tokens.used.json','ui-sessions.json']) expect(existsSync(join(f.home,name))).toBe(false);
  writeFileSync(join(f.from,'tokens.used.json'),'{}');
  expect(() => importHousehold(f.app.db,f.home,f.from,3000)).toThrow('source changed');
});
it('rolls back an interrupted import and succeeds on retry', async () => {
  const f = await fixture();
  expect(() => importHousehold(f.app.db,f.home,f.from,1000,{interrupt:()=>{throw new Error('power lost');}})).toThrow('power lost');
  expect(f.app.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'household_%'").all()).toEqual([]);
  expect(importHousehold(f.app.db,f.home,f.from,1000).imported).toBe(true);
});
it('refuses source mutation during import and mismatched cookie keys', async () => {
  const f = await fixture();
  expect(() => importHousehold(f.app.db,f.home,f.from,1000,{interrupt:()=>writeFileSync(join(f.from,'tokens.used.json'),'{}')})).toThrow('Source changed during');
  expect(f.app.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'household_%'").all()).toEqual([]);
  writeFileSync(join(f.home,'ui-cookie.key'), randomBytes(32));
  expect(() => importHousehold(f.app.db,f.home,f.from,1000)).toThrow('cookie key differs');
});
it('refuses importing into the source home and refuses overwriting populated tables', async () => {
  const f = await fixture();
  expect(() => importHousehold(f.app.db,f.from,f.from,1000)).toThrow('different destination');
  importHousehold(f.app.db,f.home,f.from,1000);
  new HouseholdRows(f.app.db,'imports').remove('legacy-home');
  expect(() => importHousehold(f.app.db,f.home,f.from,1000)).toThrow('must be empty');
});
