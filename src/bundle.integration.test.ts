/**
 * The bundle (docs/specs/household.md, "Export and restore"): pins that
 *  - a restore into an empty LOOM_HOME answers like the household it came
 *    from: identity, recall, person cards, knowledge, tokens;
 *  - each piece's part comes back through its import, byte for byte, and
 *    core never reads inside it;
 *  - the bundle is unreadable without the owner's key, and holds no
 *    plaintext of the household;
 *  - the drill passes against the live household, and notices a change.
 * Needs the `age` and `tar` programs (CI installs age).
 */
import { Notes } from './notes.js';
import { PieceStore } from './stores.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { createToken, loadHousehold, TokenResolver, type Household } from './household.js';
import { BundleError, drillBundle, exportBundle, restoreBundle } from './bundle.js';
import { personWrite, readPerson } from './tools/person.js';
import { remember } from './tools/remember.js';
import { recall } from './tools/recall.js';
import { knowledgeWrite } from './tools/knowledge-write.js';
import { closeAllBackends } from './backends/index.js';
import { loadIdentity } from './tools/identity.js';

const which = (name: string) => (spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf-8' }).stdout || '').trim();
const AGE = which('age');
const AGE_KEYGEN = which('age-keygen');
const hasAge = AGE !== '' && AGE_KEYGEN !== '';
/**
 * Only this test's pieces, never the host's: PATH is the test's bin plus the system's basics,
 * and HOME is a throwaway, since managed pieces are found under $HOME/.config/loom/pieces (a
 * machine with installed pieces otherwise leaks them into every export here).
 */
const sealedHome = mkdtempSync(join(tmpdir(), 'loom-bundle-home-'));
const sealed = (bin?: string): NodeJS.ProcessEnv => {
  const { LOOM_HOME: _h, LOOM_CONTEXT_DIR: _c, ...rest } = process.env;
  return { ...rest, HOME: sealedHome, LOOM_AGE: AGE, PATH: [...(bin ? [bin] : []), '/usr/bin', '/bin'].join(delimiter) };
};

function keypair(dir: string, name: string): { identity: string; recipient: string } {
  const identity = join(dir, `${name}.key`);
  const r = spawnSync(AGE_KEYGEN, ['-o', identity], { encoding: 'utf-8' });
  const recipient = (r.stderr + r.stdout).match(/age1[0-9a-z]+/)![0];
  return { identity, recipient };
}

describe.skipIf(!hasAge)('loom export / restore', () => {
  let work: string;
  let h: Household;
  let bin: string;
  let env: NodeJS.ProcessEnv;
  let owner: { identity: string; recipient: string };
  let ownerToken: string;

  beforeEach(async () => {
    work = mkdtempSync(join(tmpdir(), 'loom-bundle-'));
    const home = join(work, 'home');
    for (const [agent, creed] of [['art', 'Art E Fish'], ['mark', 'Visual Mark']]) {
      mkdirSync(join(home, 'agents', agent), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, 'agents', agent, 'IDENTITY.md'), `# ${creed}\n\nI am ${creed}.\n`);
    }
    chmodSync(home, 0o700);
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan' }), { mode: 0o600 });
    h = loadHousehold(home)!;
    ownerToken = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    await remember(join(home, 'agents', 'art'), { category: 'project', title: 'zebra kiln secret', content: 'only art knows the zebra kiln' });
    await remember(join(home, 'agents', 'mark'), { category: 'project', title: 'iambic glaze', content: 'mark knows the iambic glaze' });
    await personWrite(join(home, 'agents', 'art'), { slug: 'loren', name: 'Loren', summary: 'data manager', where: { slack: { value: 'U0LOREN' } }, how: { tz: 'America/Chicago', mode: 'caveman' } });
    await personWrite(join(home, 'agents', 'mark'), { slug: 'loren', how: { mode: 'shakespearean' } });
    await knowledgeWrite(join(home, 'agents', 'art'), {
      title: 'Cone 6', domain: 'ceramics', body: 'Cone 6 reaches about 1222 °C.', slug: 'cone-6',
      citations: [{ claim: 'cone 6 temperature', source_kind: 'web', source_locator: 'https://example.com', excerpt: '1222 °C' }],
    } as never, 'art');
    await closeAllBackends();

    owner = keypair(work, 'owner');
    // A piece that exports a part (already "encrypted": we only check bytes) and records its import.
    bin = join(work, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'loom-vault'), `#!/bin/sh
case "$1 $2" in
  "bundle export") printf 'VAULT-PART for %s' "$LOOM_EXPORT_RECIPIENTS" ;;
  "bundle import") cat > "${work}/vault-imported"; printf '%s' "$LOOM_IMPORT_IDENTITY" > "${work}/vault-identity" ;;
  # Its own export command must never be what the bundle calls.
  "export ") echo 'WRONG: the bare export verb'; exit 0 ;;
  *) exit 2 ;;
esac
`);
    writeFileSync(join(bin, 'loom-noexport'), '#!/bin/sh\nexit 2\n');
    chmodSync(join(bin, 'loom-vault'), 0o755);
    chmodSync(join(bin, 'loom-noexport'), 0o755);
    env = sealed(bin);
  });
  afterEach(async () => {
    await closeAllBackends();
    rmSync(work, { recursive: true, force: true });
  });

  it('a restore into an empty LOOM_HOME is the same household', async () => {
    const file = join(work, 'household.bundle');
    // A piece's store in loom (docs/specs/piece-storage.md) rides along with no verbs from the piece.
    const st = new PieceStore(h.home, 'vault');
    try { st.put('gates', 'loren', { tier: 'STORE-DOC' }, { piece: 'vault', owner: true, who: 'jonathan', exp: 9e9 }, { gates: { writers: 'owner' } }); } finally { st.close(); }
    // An agent's notes, with a file, ride along with the rest of its directory (src/notes.ts).
    const notes = new Notes(join(h.home, 'agents', 'art'));
    try {
      notes.write('homelab/dns', 'NOTE-TEXT about the drops', { lifespan: 'keep', by: 'art' });
      writeFileSync(join(work, 'bench.sh'), 'BENCH-BYTES');
      notes.attach('homelab/dns', 'bench.sh', join(work, 'bench.sh'));
    } finally { notes.close(); }
    const m = await exportBundle({ contextDir: join(h.home, 'agents', 'art'), to: file, recipients: [owner.recipient], env });
    expect(m.household.agents).toEqual(['art', 'mark']);
    expect(m.pieces.find((p) => p.name === 'vault')).toMatchObject({ included: true });
    expect(m.pieces.find((p) => p.name === 'noexport')).toMatchObject({ included: false });

    // The file is encrypted: none of the household's text is in it.
    const raw = readFileSync(file);
    for (const s of ['zebra kiln', 'Art E Fish', 'U0LOREN', 'VAULT-PART', 'caveman', 'STORE-DOC', 'NOTE-TEXT', 'BENCH-BYTES']) expect(raw.includes(Buffer.from(s))).toBe(false);

    const to = join(work, 'restored');
    const r = await restoreBundle({ file, identity: owner.identity, home: to, env });
    // loom-vault is on PATH but not one the restored household installed: where it writes is its
    // own business, so it isn't handed the part (t-1846). The part waits, byte for byte.
    expect(r.pieces).toEqual([{ name: 'vault', restored: false, reason: expect.stringMatching(/isn't one this restore installed/) }]);
    expect(existsSync(join(work, 'vault-imported'))).toBe(false);
    expect(readFileSync(join(to, 'pieces-pending', 'vault.part'), 'utf-8')).toBe(`VAULT-PART for ${owner.recipient}`);

    const h2 = loadHousehold(to)!;
    expect(h2.agents).toEqual(['art', 'mark']);
    const art2 = join(to, 'agents', 'art');
    const mark2 = join(to, 'agents', 'mark');
    expect(await loadIdentity(art2)).toContain('Art E Fish');
    expect(await recall(art2, { query: 'zebra kiln' })).toContain('zebra kiln secret');
    expect(await recall(mark2, { query: 'iambic glaze' })).toContain('iambic glaze');
    const la = readPerson(art2, 'loren');
    const lm = readPerson(mark2, 'loren');
    if (!('card' in la) || !('card' in lm)) throw new Error('loren restored');
    expect([la.card.how.mode, lm.card.how.mode, la.card.where.slack.value]).toEqual(['caveman', 'shakespearean', 'U0LOREN']);
    expect(new TokenResolver(h2).resolve(ownerToken)).toEqual({ kind: 'owner', member: 'jonathan' });
    expect(existsSync(join(to, 'commons', 'knowledge.db'))).toBe(true);
    const st2 = new PieceStore(to, 'vault');
    try { expect(st2.get('gates', 'loren')).toMatchObject({ doc: { tier: 'STORE-DOC' }, by: 'jonathan' }); } finally { st2.close(); }
    const notes2 = new Notes(art2);
    try {
      expect(notes2.read('homelab/dns')).toMatchObject({ body: 'NOTE-TEXT about the drops', lifespan: 'keep' });
      expect(readFileSync(notes2.filePath('homelab/dns', 'bench.sh')!, 'utf-8')).toBe('BENCH-BYTES');
    } finally { notes2.close(); }
  });

  // The household's own settings come along whole (the relay pairs, t-1597), and
  // so do the managed pieces: which ones, at which commit, with their settings.
  // A restore puts them back and installs them before it hands each its part,
  // so a fresh machine gets a working household, not parts left pending.
  it('household.json comes back whole, and the managed pieces are installed (pinned, with their settings) before their parts are imported', async () => {
    writeFileSync(join(h.home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan', relay: { art: ['mark'] } }), { mode: 0o600 });
    const piece = join(h.home, 'pieces', 'vault');
    mkdirSync(piece, { recursive: true });
    writeFileSync(join(piece, 'piece.json'), JSON.stringify({ v: 1, name: 'vault', source: { repo: 'sleepunit-agents/vault', commit: 'a'.repeat(40) }, package: 'vault', version: '1.0.0', installed: 'x', bins: ['loom-vault'], loom: { settings: [{ name: 'VAULT_DIR', label: 'v', kind: 'text' }] } }));
    writeFileSync(join(piece, 'settings.json'), JSON.stringify({ VAULT_DIR: '/srv/vault' }));
    const file = join(work, 'household.bundle');
    await exportBundle({ contextDir: join(h.home, 'agents', 'art'), to: file, recipients: [owner.recipient], env });

    const to = join(work, 'restored');
    const installs: Array<{ name: string; commit: string }> = [];
    // Install by putting the piece's bin in the new home's managed bin dir, as installPiece would.
    const install = async (e: NodeJS.ProcessEnv, source: { repo: string; commit: string }, name: string, opts?: { services?: boolean }) => {
      expect(opts?.services).toBe(false);
      installs.push({ name, commit: source.commit });
      const root = join(e.LOOM_HOME!, 'pieces');
      mkdirSync(join(root, 'bin'), { recursive: true });
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, 'piece.json'), JSON.stringify({ v: 1, name, source, package: name, version: '1.0.0', installed: 'x', bins: [`loom-${name}`], loom: { settings: [{ name: 'VAULT_DIR', label: 'v', kind: 'text' }] } }));
      writeFileSync(join(root, 'bin', `loom-${name}`), `#!/bin/sh\n[ "$1 $2" = "bundle import" ] && cat > "${work}/fresh-imported" && printf '%s' "$LOOM_IMPORT_IDENTITY" > "${work}/fresh-identity"\n`);
      chmodSync(join(root, 'bin', `loom-${name}`), 0o755);
    };
    // The restoring machine has no pieces at all: only what restore installs. A bundle
    // isn't signed (age only encrypts, to a public key), so it names pieces, never code:
    // only this loom's catalog's repos install, at the catalog's commit.
    const catalog = [{ name: 'vault', repo: 'sleepunit-agents/vault', commit: 'b'.repeat(40) }];
    // A piece's services start only after every part is in (the rebuild drill, t-1607: the box
    // piece's service wrote an empty state first, and its part was refused).
    const order: string[] = [];
    const r = await restoreBundle({ file, identity: owner.identity, home: to, env: { ...sealed(), LOOM_HOME: to }, install, catalog, allowOutside: true,
      startServices: (_e, name) => { order.push(`services ${name} (part in: ${existsSync(join(work, 'fresh-imported'))})`); } });
    expect(installs).toEqual([{ name: 'vault', commit: 'b'.repeat(40) }]);
    expect(order).toEqual(['services vault (part in: true)']);
    expect(JSON.parse(readFileSync(join(to, 'pieces', 'vault', 'settings.json'), 'utf-8'))).toEqual({ VAULT_DIR: '/srv/vault' });
    expect(r.pieces).toEqual([{ name: 'vault', restored: true }]);
    expect(readFileSync(join(work, 'fresh-imported'), 'utf-8')).toBe(`VAULT-PART for ${owner.recipient}`);
    expect(readFileSync(join(work, 'fresh-identity'), 'utf-8')).toBe(owner.identity);
    expect(JSON.parse(readFileSync(join(to, 'household.json'), 'utf-8')).relay).toEqual({ art: ['mark'] });
  });

  // The backup drill (loom#488, t-1846): a restore into a throwaway home on the live machine
  // handed taskstore its part with the caller's environment, which named the live store. It
  // only didn't write there by luck. A restore's pieces write inside the home it restores to.
  describe('a restore hands a part only to a piece it installed, and only inside its home', () => {
    let live: string;
    let to: string;
    let file: string;
    // The machine's live store, with something in it a restore must never touch.
    beforeEach(async () => {
      live = join(work, 'live-store');
      mkdirSync(live);
      writeFileSync(join(live, 'store.db'), 'LIVE');
      to = join(work, 'restored');
      file = join(work, 'household.bundle');
    });
    const exportWith = async (settings: Record<string, string>) => {
      const piece = join(h.home, 'pieces', 'vault');
      mkdirSync(piece, { recursive: true });
      writeFileSync(join(piece, 'piece.json'), JSON.stringify({ v: 1, name: 'vault', source: { repo: 'sleepunit-agents/vault', commit: 'a'.repeat(40) }, package: 'vault', version: '1.0.0', installed: 'x', bins: ['loom-vault'], loom: { settings: [{ name: 'VAULT_DIR', label: 'v', default: '${LOOM_PIECE_HOME}/data' }] } }));
      writeFileSync(join(piece, 'settings.json'), JSON.stringify(settings));
      await exportBundle({ contextDir: join(h.home, 'agents', 'art'), to: file, recipients: [owner.recipient], env });
    };
    // Installs vault the way installPiece would; its import writes into $VAULT_DIR, like taskstore's into TASKSTORE_DB.
    const install = async (e: NodeJS.ProcessEnv, source: { repo: string; commit: string }, name: string) => {
      const root = join(e.LOOM_HOME!, 'pieces');
      mkdirSync(join(root, 'bin'), { recursive: true });
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, 'piece.json'), JSON.stringify({ v: 1, name, source, package: name, version: '1.0.0', installed: 'x', bins: [`loom-${name}`], loom: { settings: [{ name: 'VAULT_DIR', label: 'v', default: '${LOOM_PIECE_HOME}/data' }] } }));
      writeFileSync(join(root, 'bin', `loom-${name}`), `#!/bin/sh\n[ "$1 $2" = "bundle import" ] || exit 2\nmkdir -p "$VAULT_DIR" && cat > "$VAULT_DIR/store.db"\n`);
      chmodSync(join(root, 'bin', `loom-${name}`), 0o755);
    };
    const catalog = [{ name: 'vault', repo: 'sleepunit-agents/vault', commit: 'b'.repeat(40) }];

    it('the caller\'s environment naming the live store is scrubbed: the piece writes under the restored home', async () => {
      await exportWith({});
      const r = await restoreBundle({ file, identity: owner.identity, home: to, env: { ...sealed(), VAULT_DIR: live }, install, catalog, startServices: () => {} });
      expect(readFileSync(join(live, 'store.db'), 'utf-8')).toBe('LIVE');
      expect(r.pieces).toEqual([{ name: 'vault', restored: true }]);
      expect(readFileSync(join(to, 'pieces', 'vault', 'data', 'store.db'), 'utf-8')).toBe(`VAULT-PART for ${owner.recipient}`);
    });

    // A piece's units live in the caller's ~/.config/systemd/user under its name, the live
    // household's too: a drill that started them would point the live units at its throwaway.
    it('a restore into a home that isn\'t this machine\'s household (a drill\'s --to) starts no services', async () => {
      await exportWith({});
      const started: string[] = [];
      const r = await restoreBundle({ file, identity: owner.identity, home: to, env: sealed(), install, catalog, startServices: (_e, name) => { started.push(name); } });
      expect(r.pieces).toEqual([{ name: 'vault', restored: true }]);
      expect(started).toEqual([]);
      expect(r.notes).toEqual([expect.stringMatching(/^services not started: .* isn't this machine's household/)]);
    });

    it('services start with the restored settings, never the caller\'s environment', async () => {
      await exportWith({});
      const seen: Array<string | undefined> = [];
      await restoreBundle({ file, identity: owner.identity, home: to, env: { ...sealed(), LOOM_HOME: to, VAULT_DIR: live }, install, catalog, startServices: (e) => { seen.push(e.VAULT_DIR); } });
      expect(seen).toEqual([undefined]);
    });

    it('a relative setting is its piece home\'s (where it runs), never loom\'s working directory: one that climbs out to a live store is refused', async () => {
      await exportWith({ VAULT_DIR: relative(join(to, 'pieces', 'vault'), live) });
      const r = await restoreBundle({ file, identity: owner.identity, home: to, env: sealed(), install, catalog, startServices: () => {} });
      expect(readFileSync(join(live, 'store.db'), 'utf-8')).toBe('LIVE');
      expect(r.pieces).toEqual([{ name: 'vault', restored: false, reason: expect.stringMatching(/outside .* and already there/) }]);
    });

    it('a piece that brought no part still gets its settings checked before its services start', async () => {
      // Exported where no piece answers `bundle export`: vault is a managed piece with settings, and no part.
      const piece = join(h.home, 'pieces', 'vault');
      mkdirSync(piece, { recursive: true });
      writeFileSync(join(piece, 'piece.json'), JSON.stringify({ v: 1, name: 'vault', source: { repo: 'sleepunit-agents/vault', commit: 'a'.repeat(40) }, package: 'vault', version: '1.0.0', installed: 'x', bins: ['loom-vault'], loom: { settings: [{ name: 'VAULT_DIR', label: 'v', default: '${LOOM_PIECE_HOME}/data' }] } }));
      writeFileSync(join(piece, 'settings.json'), JSON.stringify({ VAULT_DIR: live }));
      await exportBundle({ contextDir: join(h.home, 'agents', 'art'), to: file, recipients: [owner.recipient], env: sealed() });
      const started: string[] = [];
      const r = await restoreBundle({ file, identity: owner.identity, home: to, env: { ...sealed(), LOOM_HOME: to }, install, catalog, startServices: (_e, name) => { started.push(name); } });
      expect(r.pieces).toEqual([]);
      expect(started).toEqual([]);
      expect(r.notes).toEqual([expect.stringMatching(/^vault's services not started: its setting VAULT_DIR is /)]);
    });

    // A bundle is encrypted, not signed: one made by anyone with the owner's public key could
    // name a path that isn't there yet (a new unit, an autostart file) for its part to land in.
    it('a setting naming a path outside the home that isn\'t there yet is refused, unless the owner allows it', async () => {
      const fresh = join(work, 'elsewhere', 'vault');
      await exportWith({ VAULT_DIR: fresh });
      const r = await restoreBundle({ file, identity: owner.identity, home: to, env: sealed(), install, catalog, startServices: () => {} });
      expect(existsSync(fresh)).toBe(false);
      expect(r.pieces).toEqual([{ name: 'vault', restored: false, reason: expect.stringMatching(/outside .*: restore with --allow-outside/) }]);
      // The owner's real restore onto a fresh machine, keeping their own paths.
      const to2 = join(work, 'restored-2');
      const r2 = await restoreBundle({ file, identity: owner.identity, home: to2, env: sealed(), install, catalog, startServices: () => {}, allowOutside: true });
      expect(r2.pieces).toEqual([{ name: 'vault', restored: true }]);
      expect(readFileSync(join(fresh, 'store.db'), 'utf-8')).toBe(`VAULT-PART for ${owner.recipient}`);
    });

    it('a restored setting that points at a store already on this machine, outside the home, is refused', async () => {
      await exportWith({ VAULT_DIR: live });
      const started: string[] = [];
      const r = await restoreBundle({ file, identity: owner.identity, home: to, env: { ...sealed(), LOOM_HOME: to }, install, catalog, startServices: (_e, name) => { started.push(name); } });
      // Its services would write there too, so they don't start.
      expect(started).toEqual([]);
      expect(readFileSync(join(live, 'store.db'), 'utf-8')).toBe('LIVE');
      expect(r.pieces).toEqual([{ name: 'vault', restored: false, reason: expect.stringMatching(new RegExp(`VAULT_DIR is ${live}, which is outside ${to} and already there`)) }]);
      expect(readFileSync(join(to, 'pieces-pending', 'vault.part'), 'utf-8')).toBe(`VAULT-PART for ${owner.recipient}`);
    });
  });

  it('a piece the catalog doesn\'t have (or names another repo) isn\'t installed from a bundle; it\'s reported', async () => {
    const piece = join(h.home, 'pieces', 'vault');
    mkdirSync(piece, { recursive: true });
    writeFileSync(join(piece, 'piece.json'), JSON.stringify({ v: 1, name: 'vault', source: { repo: 'someone/evil', commit: 'a'.repeat(40) }, package: 'vault', version: '1', installed: 'x', bins: ['loom-vault'], loom: { settings: [] } }));
    const file = join(work, 'household.bundle');
    await exportBundle({ contextDir: join(h.home, 'agents', 'art'), to: file, recipients: [owner.recipient], env });
    const calls: string[] = [];
    const r = await restoreBundle({ file, identity: owner.identity, home: join(work, 'restored'), env: sealed(),
      install: async (_e, s) => { calls.push(s.repo); }, catalog: [{ name: 'vault', repo: 'sleepunit-agents/vault', commit: 'b'.repeat(40) }] });
    expect(calls).toEqual([]);
    expect(r.installs).toEqual([{ name: 'vault', commit: 'a'.repeat(40), installed: false, reason: expect.stringMatching(/not this loom's catalog/) }]);
  });

  it('a local piece is listed in a bundle but never installed from it; the restore says so', async () => {
    const piece = join(h.home, 'pieces', 'homelab');
    mkdirSync(piece, { recursive: true });
    writeFileSync(join(piece, 'piece.json'), JSON.stringify({ v: 1, name: 'homelab', source: { path: '/home/art/homelab', hash: 'c'.repeat(64) }, package: 'homelab', version: '1', installed: 'x', bins: ['loom-homelab'], loom: { settings: [] } }));
    const file = join(work, 'household.bundle');
    await exportBundle({ contextDir: join(h.home, 'agents', 'art'), to: file, recipients: [owner.recipient], env });
    const calls: unknown[] = [];
    const r = await restoreBundle({ file, identity: owner.identity, home: join(work, 'restored'), env: sealed(),
      install: async (_e, s) => { calls.push(s); }, catalog: [{ name: 'homelab', repo: 'sleepunit-agents/homelab', commit: 'b'.repeat(40) }] });
    expect(calls).toEqual([]);
    expect(r.installs).toEqual([{ name: 'homelab', commit: 'c'.repeat(64), installed: false, reason: expect.stringMatching(/^a local piece, from \/home\/art\/homelab on the machine the bundle was made on/) }]);
  });

  it('a bundle that brings anything but parts into pieces/ (a bin, a link, a directory) is refused before anything runs', async () => {
    const file = join(work, 'household.bundle');
    await exportBundle({ contextDir: join(h.home, 'agents', 'art'), to: file, recipients: [owner.recipient], env });
    // Re-pack it with a planted bin, the way anyone holding the owner's public key could.
    const x = join(work, 'x');
    mkdirSync(x);
    spawnSync(AGE, ['-d', '-i', owner.identity, '-o', join(work, 'h.tgz'), file]);
    spawnSync('tar', ['-C', x, '-xzf', join(work, 'h.tgz')]);
    mkdirSync(join(x, 'pieces', 'bin'), { recursive: true });
    writeFileSync(join(x, 'pieces', 'bin', 'loom-vault'), `#!/bin/sh\ntouch ${work}/pwned\n`, { mode: 0o755 });
    spawnSync('tar', ['-C', x, '-czf', join(work, 'evil.tgz'), '.']);
    spawnSync(AGE, ['-e', '-r', owner.recipient, '-o', join(work, 'evil.bundle'), join(work, 'evil.tgz')]);
    await expect(restoreBundle({ file: join(work, 'evil.bundle'), identity: owner.identity, home: join(work, 'restored'), env: sealed(), install: false }))
      .rejects.toThrow(/pieces\/ holds something other than parts/);
    expect(existsSync(join(work, 'pwned'))).toBe(false);
  });

  it('a bundle whose pieces/, commons/ or an agents/<name> is a link is refused: restore would write through it', async () => {
    const file = join(work, 'household.bundle');
    await exportBundle({ contextDir: join(h.home, 'agents', 'art'), to: file, recipients: [owner.recipient], env });
    spawnSync(AGE, ['-d', '-i', owner.identity, '-o', join(work, 'h.tgz'), file]);
    const outside = join(work, 'outside');
    mkdirSync(outside);
    // tokens.json is chmod'ed and manifest.json read before anything else: a link there would reach outside too.
    writeFileSync(join(outside, 'precious'), 'x', { mode: 0o644 });
    for (const [i, where] of ['pieces', 'commons', 'agents/mark', 'tokens.json', 'manifest.json'].entries()) {
      const x = join(work, `x${i}`);
      mkdirSync(x);
      spawnSync('tar', ['-C', x, '-xzf', join(work, 'h.tgz')]);
      rmSync(join(x, where), { recursive: true, force: true });
      symlinkSync(where.endsWith('.json') ? join(outside, 'precious') : outside, join(x, where));
      spawnSync('tar', ['-C', x, '-czf', join(work, `evil${i}.tgz`), '.']);
      spawnSync(AGE, ['-e', '-r', owner.recipient, '-o', join(work, `evil${i}.bundle`), join(work, `evil${i}.tgz`)]);
      await expect(restoreBundle({ file: join(work, `evil${i}.bundle`), identity: owner.identity, home: join(work, `restored${i}`), env: sealed(), install: false }), where)
        .rejects.toThrow(/is a link/);
    }
    expect(readdirSync(outside)).toEqual(['precious']);
    expect(statSync(join(outside, 'precious')).mode & 0o777).toBe(0o644);
  });

  it('a bundle from before compression (a plain tar) still restores', async () => {
    const file = join(work, 'new.bundle');
    await exportBundle({ contextDir: join(h.home, 'agents', 'art'), to: file, recipients: [owner.recipient], env });
    // Rebuild it the way 0.12 and 0.13 wrote bundles: the same tar, uncompressed.
    const gz = join(work, 'b.tar.gz');
    expect(spawnSync(AGE, ['-d', '-i', owner.identity, '-o', gz, file]).status).toBe(0);
    expect(spawnSync('gzip', ['-d', gz]).status).toBe(0);
    const old = join(work, 'old.bundle');
    expect(spawnSync(AGE, ['-e', '-r', owner.recipient, '-o', old, join(work, 'b.tar')]).status).toBe(0);
    const to = join(work, 'restored');
    await restoreBundle({ file: old, identity: owner.identity, home: to, env });
    expect(await recall(join(to, 'agents', 'art'), { query: 'zebra kiln' })).toContain('zebra kiln secret');
  });

  it('refuses a non-empty target, the wrong key, and no recipient', async () => {
    const file = join(work, 'b');
    await exportBundle({ contextDir: join(h.home, 'agents', 'art'), to: file, recipients: [owner.recipient], env });
    await expect(restoreBundle({ file, identity: owner.identity, home: h.home, env })).rejects.toThrow(/isn't empty/);
    const stranger = keypair(work, 'stranger');
    await expect(restoreBundle({ file, identity: stranger.identity, home: join(work, 'x'), env })).rejects.toThrow(BundleError);
    await expect(exportBundle({ contextDir: join(h.home, 'agents', 'art'), to: file, recipients: [], env })).rejects.toThrow(/recipient/);
    await expect(exportBundle({ contextDir: join(h.home, 'agents', 'art'), to: file, recipients: ['not-a-key'], env })).rejects.toThrow(/isn't an age recipient/);
  });

  it('a piece that isn\'t installed where you restore keeps its part for later', async () => {
    const file = join(work, 'b');
    await exportBundle({ contextDir: join(h.home, 'agents', 'art'), to: file, recipients: [owner.recipient], env });
    const r = await restoreBundle({ file, identity: owner.identity, home: join(work, 'r'), env: sealed() });
    expect(r.pieces[0]).toMatchObject({ name: 'vault', restored: false });
    expect(readFileSync(join(work, 'r', 'pieces-pending', 'vault.part'), 'utf-8')).toBe(`VAULT-PART for ${owner.recipient}`);
  });

  it('the drill passes against the live household, and notices when it has moved on', async () => {
    const file = join(work, 'b');
    await exportBundle({ contextDir: join(h.home, 'agents', 'art'), to: file, recipients: [owner.recipient], env });
    const ok = await drillBundle({ file, identity: owner.identity, contextDir: join(h.home, 'agents', 'art'), env });
    expect(ok.differences).toEqual([]);
    expect(ok.ok).toBe(true);
    // The drill imports nothing into live pieces.
    expect(existsSync(join(work, 'vault-imported'))).toBe(false);
    await remember(join(h.home, 'agents', 'mark'), { category: 'project', title: 'a new thing', content: 'after the bundle' });
    await closeAllBackends();
    const moved = await drillBundle({ file, identity: owner.identity, contextDir: join(h.home, 'agents', 'art'), env });
    expect(moved.ok).toBe(false);
    expect(moved.differences.map((d) => d.what)).toEqual(['mark.memories']);
  });

  it('a plain context dir exports as a household of one, and restores as one with its cards split', async () => {
    const plain = join(work, 'solo');
    mkdirSync(plain);
    writeFileSync(join(plain, 'IDENTITY.md'), '# Solo\n');
    await personWrite(plain, { slug: 'pat', name: 'Pat', where: { email: { value: 'pat@example.com' } }, how: { mode: 'terse' } });
    await closeAllBackends();
    const file = join(work, 'solo.bundle');
    const m = await exportBundle({ contextDir: plain, to: file, recipients: [owner.recipient], env: sealed() });
    expect(m.household.agents).toEqual(['solo']);
    const to = join(work, 'solo-restored');
    await restoreBundle({ file, identity: owner.identity, home: to, env: sealed() });
    const p = readPerson(join(to, 'agents', 'solo'), 'pat');
    if (!('card' in p)) throw new Error('pat');
    expect(p.card.where.email.value).toBe('pat@example.com');
    expect(p.card.how.mode).toBe('terse');
    expect(existsSync(join(to, 'commons', 'people.db'))).toBe(true);
  });
});
