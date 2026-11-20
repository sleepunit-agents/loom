/**
 * Agent grants (docs/specs/agent-runtime.md, "6. Permissions"; "What the tests must pin", 5):
 * through the real HTTP server, a stub grants authority (a managed piece offering `grants`) and a
 * stub piece an agent calls (`thing`, which keeps its own agent list, as taskstore's
 * TASKSTORE_AGENTS does, and writes $LOOM_HOME/thing-ran for every call that reaches it).
 *
 *  - with the authority, a call for an agent without the grant is refused by core before the
 *    piece runs; with the grant, it runs;
 *  - with no piece offering grants, the piece decides as today;
 *  - a second piece offering grants is refused at install (offerConflicts, the installer's check;
 *    the install itself: src/cli/pieces-managed.test.ts);
 *  - owner calls work in all three cases;
 *  - and the authority failing (slow, an error, an answer that isn't the contract's, removed
 *    mid-ask) is a 503, the piece never run.
 *
 * The stub authority answers from $LOOM_HOME/grants.json, {agent: [piece/path, ...]}, or by
 * $LOOM_HOME/grants-mode (slow, fail, bad, remove).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHttpServer, type HttpServeHandle } from './transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from './household.js';
import { managedPieces, parseLoomBlock } from './cli/pieces-managed.js';
import { offerConflicts } from './offers.js';
import { clearPieceCache } from './ui/pieces.js';
import { clearGrantAnswers, parseGrantAnswer } from './grants.js';
import { PieceStore } from './stores.js';
import { createRequire } from 'node:module';

// An authority that answers from its own store (it declares grants_store), as the runtime does: the
// collection `grants`, key `household`, {agent: [piece/path, ...]}; asked with basis: true, it says
// what it read. grants-mode: fail; write (it empties the grants while it's asked, then says yes);
// elsewhere (it reads another store, as a runtime pointed at another piece's would); nobasis.
const SQLITE = createRequire(import.meta.url).resolve('better-sqlite3');
const STORE_AUTHORITY_BIN = `#!${process.execPath}
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require(${JSON.stringify(SQLITE)});
const home = process.env.LOOM_HOME;
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const ask = JSON.parse(s);
  fs.appendFileSync(home + '/asked', JSON.stringify({ agent: ask.agent, piece: ask.piece, path: ask.path }) + '\\n');
  const mode = fs.existsSync(home + '/grants-mode') ? fs.readFileSync(home + '/grants-mode', 'utf-8').trim() : '';
  if (mode === 'fail') process.exit(1);
  const read = mode === 'elsewhere' ? 'other' : 'storeauth';
  const file = home + '/commons/stores/' + read + '.db';
  let text = null;
  if (fs.existsSync(file)) {
    const db = new Database(file, { readonly: true });
    const row = db.prepare("SELECT doc FROM docs WHERE collection = 'grants' AND key = 'household'").get();
    db.close();
    text = row ? row.doc : null;
  }
  const basis = ask.basis === true && mode !== 'nobasis' ? { basis: { piece: read, collection: mode === 'othercoll' ? 'policy' : 'grants', key: 'household', sha256: text === null ? null : crypto.createHash('sha256').update(text).digest('hex') } } : {};
  if (mode === 'write') {
    const db = new Database(file);
    db.prepare("UPDATE docs SET doc = '{}', rev = rev + 1 WHERE collection = 'grants' AND key = 'household'").run();
    db.prepare("INSERT INTO revisions (collection, key, doc, rev, op, at, by) VALUES ('grants', 'household', '{}', 99, 'put', 'x', 'test')").run();
    db.close();
    return console.log(JSON.stringify({ allow: true, ...basis }));
  }
  const g = text === null ? null : JSON.parse(text);
  if (g === null) return console.log(JSON.stringify({ allow: true, ...basis }));
  const mine = g[ask.agent] || [];
  const ok = mine.includes(ask.piece + '/*') || mine.includes(ask.piece + '/' + ask.path);
  console.log(JSON.stringify(ok ? { allow: true, ...basis } : { allow: false, reason: ask.agent + ' has no grant for ' + ask.piece + ' (' + ask.path + ')', ...basis }));
});
`;

const THING_BIN = `#!${process.execPath}
const fs = require('node:fs');
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const r = JSON.parse(s);
  fs.appendFileSync(process.env.LOOM_HOME + '/thing-ran', JSON.stringify({ caller: r.caller, path: r.path }) + '\\n');
  // Its own agent list (art only), the fallback when no grants authority decided the call.
  if (r.caller.kind === 'agent' && r.caller.granted !== true && r.caller.agent !== 'art') return console.log(JSON.stringify({ status: 403, body: { error: 'thing: not one of my agents' } }));
  console.log(JSON.stringify({ body: { ok: true, caller: r.caller, path: r.path } }));
});
`;

const AUTHORITY_BIN = `#!${process.execPath}
const fs = require('node:fs');
const home = process.env.LOOM_HOME;
let s = ''; process.stdin.on('data', (d) => s += d).on('end', async () => {
  const ask = JSON.parse(s);
  fs.appendFileSync(home + '/asked', s + '\\n');
  const mode = fs.existsSync(home + '/grants-mode') ? fs.readFileSync(home + '/grants-mode', 'utf-8').trim() : '';
  if (mode === 'slow') return setTimeout(() => console.log('{"allow":true}'), 11000);
  if (mode === 'loaded') await new Promise(resolve => setTimeout(resolve, 2300));
  if (mode === 'fail') process.exit(1);
  if (mode === 'bad') return console.log('{"allow":"yes"}');
  if (mode === 'remove') { fs.rmSync(home + '/pieces/authority', { recursive: true, force: true }); return console.log('{"allow":true}'); }
  const g = JSON.parse(fs.readFileSync(home + '/grants.json', 'utf-8'));
  const mine = g[ask.agent] || [];
  const ok = mine.includes(ask.piece + '/*') || mine.includes(ask.piece + '/' + ask.path);
  console.log(JSON.stringify(ok ? { allow: true } : { allow: false, reason: ask.agent + ' has no grant for ' + ask.piece + ' (' + ask.path + ')' }));
});
`;

function piece(home: string, name: string, raw: Record<string, unknown>, body: string): void {
  const loom = parseLoomBlock(raw, name, [`loom-${name}`]);
  if (typeof loom === 'string') throw new Error(`${name}: ${loom}`);
  const dir = join(home, 'pieces', name);
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name, source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: name, version: '1', installed: 'x',
    bins: [`loom-${name}`], loom: { settings: [], services: [], ...loom } }));
  const bin = join(dir, 'current', 'cli');
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  rmSync(join(home, 'pieces', 'bin', `loom-${name}`), { force: true });
  symlinkSync(bin, join(home, 'pieces', 'bin', `loom-${name}`));
}

describe('agent grants: core asks the grants authority before an agent\'s piece call', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  const tok: Record<string, string> = {};
  const saved = process.env.LOOM_HOME;

  const ran = (): Array<{ caller: Record<string, unknown>; path: string }> => {
    const f = join(h.home, 'thing-ran');
    return existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  const asked = (): unknown[] => {
    const f = join(h.home, 'asked');
    return existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  const call = async (path: string, token: string, body: unknown = {}) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  const authority = () => piece(h.home, 'authority', { grants: ['loom-authority', 'ask'] }, AUTHORITY_BIN);
  const grants = (g: Record<string, string[]>) => writeFileSync(join(h.home, 'grants.json'), JSON.stringify(g));
  const mode = (m: string) => writeFileSync(join(h.home, 'grants-mode'), m);

  beforeAll(async () => {
    h = loadHousehold((() => {
      const home = mkdtempSync(join(tmpdir(), 'loom-grants-'));
      for (const a of ['art', 'mark']) { mkdirSync(join(home, 'agents', a), { recursive: true }); writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`); }
      writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
      return home;
    })())!;
    process.env.LOOM_HOME = h.home;
    piece(h.home, 'thing', {}, THING_BIN);
    tok.owner = createToken(h, { role: { kind: 'owner' }, label: 'owner' }).token;
    tok.art = createToken(h, { role: { kind: 'agent', agent: 'art' }, label: 'art' }).token;
    tok.mark = createToken(h, { role: { kind: 'agent', agent: 'mark' }, label: 'mark' }).token;
    tok.thing = createToken(h, { role: { kind: 'piece', piece: 'thing', subject: 'svc' }, label: 'thing' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    await handle?.close();
    rmSync(h.home, { recursive: true, force: true });
  });
  beforeEach(() => {
    for (const f of ['thing-ran', 'asked', 'grants-mode']) rmSync(join(h.home, f), { force: true });
    authority();
    grants({ art: ['thing/*'], mark: ['thing/run'] });
    clearPieceCache();
  });

  describe('with the authority installed', () => {
    it('a call for an agent without the grant is refused by core (403, the authority\'s reason) before the piece runs', async () => {
      grants({ art: [] });
      const r = await call('/api/thing/boxes/list', tok.art);
      expect(r).toEqual({ status: 403, body: { error: 'forbidden: art has no grant for thing (boxes/list)' } });
      expect(asked()).toEqual([{ agent: 'art', piece: 'thing', path: 'boxes/list' }]);
      expect(ran()).toEqual([]);
    });

    it('with the grant, it runs; the path is what follows /api/<piece>/ (run, for its remote CLI)', async () => {
      const r = await call('/api/thing/boxes/list', tok.art);
      expect(r.status).toBe(200);
      expect(ran()).toEqual([{ caller: { kind: 'agent', agent: 'art', granted: true }, path: 'boxes/list' }]);
      // mark is granted thing's `run` and nothing else of it.
      expect((await call('/api/thing/boxes/list', tok.mark)).status).toBe(403);
      expect(ran()).toHaveLength(1);
      const run = await call('/api/thing/run', tok.mark, { argv: ['list'] });
      expect(asked()).toContainEqual({ agent: 'mark', piece: 'thing', path: 'run' });
      // The authority decided, and the caller says so (granted: true), so the piece's own list isn't consulted (t-1971).
      expect(run.status).toBe(200);
      expect(ran()[1]).toEqual({ caller: { kind: 'agent', agent: 'mark', granted: true }, path: 'run' });
      expect(ran()).toHaveLength(2);
    });

    it('owner calls work and never ask; a piece calling its own API is the piece, not an agent', async () => {
      grants({});
      expect((await call('/api/thing/boxes/list', tok.owner)).status).toBe(200);
      expect((await call('/api/thing/poll', tok.thing)).status).toBe(200);
      expect(asked()).toEqual([]);
      expect(ran()).toHaveLength(2);
    });

    it('waits for cold authority startup under load and still enforces its refusal', async () => {
      mode('loaded');
      grants({ art: ['thing/x'] });
      expect((await call('/api/thing/x', tok.art)).status).toBe(200);
      grants({});
      expect((await call('/api/thing/x', tok.art)).status).toBe(403);
      expect(ran()).toHaveLength(1);
    }, 15_000);

    it('fails closed: a slow authority, one that errors, or answers off-contract is a 503 with the reason; the piece never runs', async () => {
      mode('slow');
      const slow = await call('/api/thing/x', tok.art);
      expect(slow.status).toBe(503);
      expect(slow.body.error).toMatch(/the grants authority \(authority\) didn't answer \(timed out\), so art's call to thing is refused/);
      mode('fail');
      expect((await call('/api/thing/x', tok.art)).status).toBe(503);
      mode('bad');
      const bad = await call('/api/thing/x', tok.art);
      expect(bad.status).toBe(503);
      expect(bad.body.error).toMatch(/invalid: a refusal says why|invalid: allow is true or false/);
      expect(ran()).toEqual([]);
      // ...and owner calls still work while it's down.
      mode('slow');
      expect((await call('/api/thing/x', tok.owner)).status).toBe(200);
    }, 15_000);

    it('an authority removed while it was asked: 503, even though it said yes', async () => {
      mode('remove');
      const r = await call('/api/thing/x', tok.art);
      expect(r.status).toBe(503);
      expect(r.body.error).toMatch(/was removed while it was asked/);
      expect(ran()).toEqual([]);
    });

    it('a piece that isn\'t there is still a 404, asked or not', async () => {
      expect((await call('/api/nothing/x', tok.art)).status).toBe(404);
    });
  });

  describe('an authority that answers from its own store (grants_store): answers reused, never stale (t-2065)', () => {
    const decl = { grants: { writers: 'owner' as const } };
    const install = (extra: Record<string, unknown> = {}) =>
      piece(h.home, 'storeauth', { grants: ['loom-storeauth', 'ask'], grants_store: 'grants', store: decl, ...extra }, STORE_AUTHORITY_BIN);
    const setGrants = (doc: Record<string, string[]>) => {
      const st = new PieceStore(h.home, 'storeauth');
      try { st.put('grants', 'household', doc, { piece: 'storeauth', owner: true, who: 'jonathan', exp: Number.MAX_SAFE_INTEGER }, decl); } finally { st.close(); }
    };
    beforeEach(() => {
      rmSync(join(h.home, 'pieces', 'authority'), { recursive: true, force: true });
      rmSync(join(h.home, 'pieces', 'bin', 'loom-authority'), { force: true });
      rmSync(join(h.home, 'commons', 'stores'), { recursive: true, force: true });
      install();
      clearGrantAnswers();
    });
    afterAll(() => {
      rmSync(join(h.home, 'pieces', 'storeauth'), { recursive: true, force: true });
      rmSync(join(h.home, 'pieces', 'bin', 'loom-storeauth'), { force: true });
    });

    it('the same ask is answered once while the grants are unchanged: allowed and refused alike', async () => {
      setGrants({ art: ['thing/*'] });
      for (let i = 0; i < 3; i++) expect((await call('/api/thing/x', tok.art)).status).toBe(200);
      for (let i = 0; i < 3; i++) expect(await call('/api/thing/x', tok.mark)).toEqual({ status: 403, body: { error: 'forbidden: mark has no grant for thing (x)' } });
      expect(asked()).toEqual([{ agent: 'art', piece: 'thing', path: 'x' }, { agent: 'mark', piece: 'thing', path: 'x' }]);
      expect(ran()).toHaveLength(3);
    });

    it('a grant taken away refuses the very next call, and one given allows it: no wait, no stale answer', async () => {
      setGrants({ art: ['thing/*'] });
      expect((await call('/api/thing/x', tok.art)).status).toBe(200);
      expect((await call('/api/thing/x', tok.mark)).status).toBe(403);
      setGrants({ mark: ['thing/*'] });
      expect(await call('/api/thing/x', tok.art)).toEqual({ status: 403, body: { error: 'forbidden: art has no grant for thing (x)' } });
      expect((await call('/api/thing/x', tok.mark)).status).toBe(200);
      // Written back exactly as it was: still a new state (revisions only grow), asked again.
      setGrants({ art: ['thing/*'] });
      expect((await call('/api/thing/x', tok.art)).status).toBe(200);
      expect((await call('/api/thing/x', tok.mark)).status).toBe(403);
      expect(asked()).toHaveLength(6);
    });

    it('the first grants ever written (no store before: every agent allowed) are in force at once', async () => {
      expect((await call('/api/thing/x', tok.mark)).status).toBe(200);
      expect((await call('/api/thing/x', tok.mark)).status).toBe(200);
      expect(asked()).toHaveLength(1);
      setGrants({ art: ['thing/*'] });
      expect((await call('/api/thing/x', tok.mark)).status).toBe(403);
    });

    it('an answer given while the grants changed under it is used once and never kept', async () => {
      setGrants({ art: ['thing/*'] });
      mode('write');
      expect((await call('/api/thing/x', tok.art)).status).toBe(200);
      rmSync(join(h.home, 'grants-mode'));
      // The authority emptied the grants while it said yes: the next call asks, and is refused.
      expect((await call('/api/thing/x', tok.art)).status).toBe(403);
      expect(asked()).toHaveLength(2);
    });

    it('a failure is never kept: the authority down is a 503 each time, and back up it is asked', async () => {
      setGrants({ art: ['thing/*'] });
      mode('fail');
      expect((await call('/api/thing/x', tok.art)).status).toBe(503);
      expect((await call('/api/thing/x', tok.art)).status).toBe(503);
      rmSync(join(h.home, 'grants-mode'));
      expect((await call('/api/thing/x', tok.art)).status).toBe(200);
      expect(asked()).toHaveLength(3);
      expect(ran()).toHaveLength(1);
    });

    it('a new version of the authority is asked again; one that declares no grants_store is asked every time', async () => {
      setGrants({ art: ['thing/*'] });
      expect((await call('/api/thing/x', tok.art)).status).toBe(200);
      install({ grants: ['loom-storeauth', 'ask', '--v2'] });
      expect((await call('/api/thing/x', tok.art)).status).toBe(200);
      expect(asked()).toHaveLength(2);
      piece(h.home, 'storeauth', { grants: ['loom-storeauth', 'ask'], store: decl }, STORE_AUTHORITY_BIN);
      expect((await call('/api/thing/x', tok.art)).status).toBe(200);
      expect((await call('/api/thing/x', tok.art)).status).toBe(200);
      expect(asked()).toHaveLength(4);
    });

    it('an authority that read another store than its own: its answer is used, never kept, even when the two agree', async () => {
      const putOther = (doc: Record<string, string[]>) => {
        const other = new PieceStore(h.home, 'other');
        try { other.put('grants', 'household', doc, { piece: 'other', owner: true, exp: Number.MAX_SAFE_INTEGER }, decl); } finally { other.close(); }
      };
      setGrants({ art: ['thing/*'] });
      putOther({ art: ['thing/*'] });
      mode('elsewhere');
      expect((await call('/api/thing/x', tok.art)).status).toBe(200);
      // A write core can't see (the other store): the next call asks, and is refused at once.
      putOther({ mark: ['thing/*'] });
      expect((await call('/api/thing/x', tok.art)).status).toBe(403);
      expect((await call('/api/thing/x', tok.mark)).status).toBe(200);
      expect((await call('/api/thing/x', tok.mark)).status).toBe(200);
      expect(asked()).toHaveLength(4);
      // Back on its own store, mark's answer is its own grants', not the other store's kept one.
      rmSync(join(h.home, 'grants-mode'));
      expect((await call('/api/thing/x', tok.mark)).status).toBe(403);
    });

    it('an authority that says it read another collection than grants_store: never kept', async () => {
      setGrants({ art: ['thing/*'] });
      mode('othercoll');
      for (let i = 0; i < 2; i++) expect((await call('/api/thing/x', tok.art)).status).toBe(200);
      expect(asked()).toHaveLength(2);
    });

    it('an authority that says no basis is asked every time', async () => {
      setGrants({ art: ['thing/*'] });
      mode('nobasis');
      for (let i = 0; i < 3; i++) expect((await call('/api/thing/x', tok.art)).status).toBe(200);
      expect(asked()).toHaveLength(3);
    });

    it('grants_store is declared only with grants, and names a collection the piece keeps revisions of', () => {
      expect(parseLoomBlock({ grants_store: 'grants' }, 'p', ['loom-p'])).toMatch(/only with loom.grants/);
      expect(parseLoomBlock({ grants: ['loom-p', 'ask'], grants_store: 'Bad Name', store: decl }, 'p', ['loom-p'])).toMatch(/names one of/);
      expect(parseLoomBlock({ grants: ['loom-p', 'ask'], grants_store: 'constructor', store: decl }, 'p', ['loom-p'])).toMatch(/declares in loom.store/);
      expect(parseLoomBlock({ grants: ['loom-p', 'ask'], grants_store: 'grants', store: { grants: { writers: 'piece', history: false } } }, 'p', ['loom-p'])).toMatch(/keeps its revisions/);
      expect(parseLoomBlock({ grants: ['loom-p', 'ask'], grants_store: 'grants', store: decl }, 'p', ['loom-p'])).toMatchObject({ grants_store: 'grants' });
    });

    it('an answer\'s basis is checked: {key, sha256}, and only when asked for', () => {
      const basis = { piece: 'runtime', collection: 'grants', key: 'household', sha256: 'a'.repeat(64) };
      expect(parseGrantAnswer({ allow: true, basis }, true)).toEqual({ allow: true, basis });
      expect(parseGrantAnswer({ allow: true, basis: { piece: 'runtime', collection: 'grants', key: 'household', sha256: null } }, true)).toEqual({ allow: true, basis: { piece: 'runtime', collection: 'grants', key: 'household', sha256: null } });
      expect(parseGrantAnswer({ allow: true, basis: { piece: 'runtime', key: 'household', sha256: null } }, true)).toMatch(/basis is/);
      expect(parseGrantAnswer({ allow: true, basis: { key: 'household', sha256: null } }, true)).toMatch(/basis is/);
      expect(parseGrantAnswer({ allow: true, basis })).toMatch(/unknown key/);
      expect(parseGrantAnswer({ allow: true, basis: { piece: 'runtime', collection: 'grants', key: 'household', sha256: 'x' } }, true)).toMatch(/basis is/);
      expect(parseGrantAnswer({ allow: true, basis: { piece: 'runtime', collection: 'grants', key: '../x', sha256: null } }, true)).toMatch(/basis is/);
    });
  });

  describe('with no piece offering grants', () => {
    it('the piece decides as today, by its own list; owner calls work', async () => {
      rmSync(join(h.home, 'pieces', 'authority'), { recursive: true, force: true });
      rmSync(join(h.home, 'pieces', 'bin', 'loom-authority'), { force: true });
      grants({});
      expect((await call('/api/thing/x', tok.art)).status).toBe(200);
      expect(await call('/api/thing/x', tok.mark)).toEqual({ status: 403, body: { error: 'thing: not one of my agents' } });
      expect((await call('/api/thing/x', tok.owner)).status).toBe(200);
      expect(asked()).toEqual([]);
      // Nobody decided for the piece, so no caller says granted.
      expect(ran().every((r) => (r as { caller: { granted?: boolean } }).caller.granted === undefined)).toBe(true);
      expect(ran()).toHaveLength(3);
    });
  });

  describe('a second piece offering grants', () => {
    it('is refused at install (the installer\'s check against what\'s installed); the authority itself may update', () => {
      const installed = managedPieces(process.env).map((r) => ({ name: r.name, loom: r.loom }));
      expect(offerConflicts('rival', { grants: ['loom-rival', 'ask'] }, installed)).toBe('the authority piece is already the grants authority: there is only one');
      expect(offerConflicts('authority', { grants: ['loom-authority', 'ask', '--v2'] }, installed)).toBeUndefined();
    });

    it('owner calls work with two present (piece.json edited by hand), and an agent\'s call is a 503: there\'s no authority to ask', async () => {
      piece(h.home, 'rival', { grants: ['loom-rival', 'ask'] }, AUTHORITY_BIN);
      try {
        const r = await call('/api/thing/x', tok.art);
        expect(r.status).toBe(503);
        expect(r.body.error).toMatch(/more than one piece offers grants \(authority, rival\)/);
        expect((await call('/api/thing/x', tok.owner)).status).toBe(200);
      } finally {
        rmSync(join(h.home, 'pieces', 'rival'), { recursive: true, force: true });
      }
    });
  });

  it('the answer is checked: {allow: true}, or {allow: false, reason}', () => {
    expect(parseGrantAnswer({ allow: true })).toEqual({ allow: true });
    expect(parseGrantAnswer({ allow: false, reason: 'no' })).toEqual({ allow: false, reason: 'no' });
    expect(parseGrantAnswer({ allow: false })).toMatch(/says why/);
    expect(parseGrantAnswer({ allow: true, extra: 1 })).toMatch(/unknown key/);
    expect(parseGrantAnswer([])).toMatch(/not a JSON object/);
  });
});
