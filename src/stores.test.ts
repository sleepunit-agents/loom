/**
 * Piece storage (docs/specs/piece-storage.md): a piece's store in loom, who may
 * write it, compare-and-swap, revisions, and the grants loom signs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mayWrite, mintGrant, parseStoreDecl, PieceStore, readGrant, StoreError, storesDir, type StoreDecl } from './stores.js';

const decl: StoreDecl = { gates: { writers: 'owner' }, convos: { writers: 'piece' }, inbox: { writers: 'agent' } };

describe('piece storage', () => {
  let home: string;
  let st: PieceStore;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'loom-stores-'));
    st = new PieceStore(home, 'shuttle', () => Date.parse('2026-10-28T12:00:00Z'));
  });
  afterEach(() => { st.close(); rmSync(home, { recursive: true, force: true }); });

  const owner = { piece: 'shuttle', owner: true, who: 'jonathan-barket', exp: 9e9 };
  const piece = { piece: 'shuttle', exp: 9e9 };
  const art = { piece: 'shuttle', agent: 'art', exp: 9e9 };

  it("each piece has its own private file under commons/stores", () => {
    expect(statSync(join(storesDir(home), 'shuttle.db')).mode & 0o777).toBe(0o600);
    expect(() => new PieceStore(home, '../evil')).toThrow(StoreError);
  });

  it('an owner collection is written only by a household owner; piece and agent collections by their writers', () => {
    expect(mayWrite(decl, 'gates', 'loren', owner)).toBeNull();
    expect(mayWrite(decl, 'gates', 'loren', piece)).toMatch(/household owner/);
    expect(mayWrite(decl, 'gates', 'loren', art)).toMatch(/household owner/);
    expect(mayWrite(decl, 'convos', 'x', piece)).toBeNull();
    expect(mayWrite(decl, 'convos', 'x', art)).toBeNull();
    expect(mayWrite(decl, 'inbox', 'art/1', art)).toBeNull();
    expect(mayWrite(decl, 'inbox', 'mark/1', art)).toMatch(/its own keys/);
    expect(mayWrite(decl, 'nope', 'x', owner)).toMatch(/declares no collection/);
  });

  it('put, get, list, compare-and-swap, and every write a revision naming its writer', () => {
    expect(st.put('gates', 'loren', { tier: 1 }, owner, decl)).toBe(1);
    expect(st.get('gates', 'loren')).toMatchObject({ doc: { tier: 1 }, rev: 1, by: 'jonathan-barket' });
    expect(() => st.put('gates', 'loren', { tier: 3 }, piece, decl)).toThrow(/household owner/);
    expect(() => st.put('gates', 'loren', { tier: 2 }, owner, decl, 0)).toThrow(/at revision 1, not 0/);
    expect(st.put('gates', 'loren', { tier: 2 }, owner, decl, 1)).toBe(2);
    st.put('convos', 'art/slack/loren', { body: null }, piece, decl);
    st.put('convos', 'art/discord/pond', { body: null }, art, decl);
    expect(st.list('convos', { prefix: 'art/slack/' }).map((d) => d.key)).toEqual(['art/slack/loren']);
    expect(st.get('convos', 'art/discord/pond')!.by).toBe('agent:art');
    const h = st.history('gates', 'loren');
    expect(h.map((r) => [r.rev, r.op, r.by])).toEqual([[2, 'put', 'jonathan-barket'], [1, 'put', 'jonathan-barket']]);
    // Revert: back to revision 1's document, as a new revision.
    expect(st.revert('gates', 'loren', h[1].id, owner, decl)).toBe(3);
    expect(st.get('gates', 'loren')!.doc).toEqual({ tier: 1 });
    expect(st.del('gates', 'loren', owner, decl)).toBe(true);
    expect(st.get('gates', 'loren')).toBeNull();
  });

  it('refuses a document over 256 KB, and bad names', () => {
    expect(() => st.put('convos', 'big', 'x'.repeat(300 * 1024), piece, decl)).toThrow(/256 KB/);
    expect(() => st.put('Convos', 'k', 1, piece, decl)).toThrow(/collection/);
    expect(() => st.put('convos', '../k', 1, piece, decl)).toThrow(/key/);
  });

  it("a grant is loom's signature, for one piece, for a few minutes", () => {
    const t = mintGrant(home, { piece: 'shuttle', owner: true, who: 'jonathan-barket' }, 1000);
    expect(readGrant(home, t, 1001)).toMatchObject({ piece: 'shuttle', owner: true, who: 'jonathan-barket' });
    expect(readGrant(home, t, 1000 + 301)).toBeNull();
    const [body] = t.split('.');
    const forged = `${Buffer.from(JSON.stringify({ piece: 'shuttle', owner: true, exp: 9e9 })).toString('base64url')}.${t.split('.')[1]}`;
    expect(readGrant(home, forged, 1001)).toBeNull();
    expect(readGrant(home, `${body}.AAAA`, 1001)).toBeNull();
    expect(readGrant(home, 'nonsense', 1001)).toBeNull();
  });

  it('a declaration names collections and their writers, and nothing else', () => {
    expect(parseStoreDecl({ gates: { writers: 'owner' } })).toEqual({ gates: { writers: 'owner' } });
    expect(parseStoreDecl({ gates: { writers: 'anyone' } })).toMatch(/writers are owner, piece or agent/);
    expect(parseStoreDecl({ 'Bad Name': { writers: 'owner' } })).toMatch(/lowercase/);
    expect(parseStoreDecl(undefined)).toEqual({});
  });
});
