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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
/** Only this test's pieces, never the host's: PATH is the test's bin plus the system's basics. */
const sealed = (bin?: string): NodeJS.ProcessEnv => ({
  ...process.env, LOOM_AGE: AGE, PATH: [...(bin ? [bin] : []), '/usr/bin', '/bin'].join(delimiter),
});

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
    const m = await exportBundle({ contextDir: join(h.home, 'agents', 'art'), to: file, recipients: [owner.recipient], env });
    expect(m.household.agents).toEqual(['art', 'mark']);
    expect(m.pieces.find((p) => p.name === 'vault')).toMatchObject({ included: true });
    expect(m.pieces.find((p) => p.name === 'noexport')).toMatchObject({ included: false });

    // The file is encrypted: none of the household's text is in it.
    const raw = readFileSync(file);
    for (const s of ['zebra kiln', 'Art E Fish', 'U0LOREN', 'VAULT-PART', 'caveman']) expect(raw.includes(Buffer.from(s))).toBe(false);

    const to = join(work, 'restored');
    const r = await restoreBundle({ file, identity: owner.identity, home: to, env });
    expect(r.pieces).toEqual([{ name: 'vault', restored: true }]);
    expect(readFileSync(join(work, 'vault-imported'), 'utf-8')).toBe(`VAULT-PART for ${owner.recipient}`);
    expect(readFileSync(join(work, 'vault-identity'), 'utf-8')).toBe(owner.identity);

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
    expect(new TokenResolver(h2).resolve(ownerToken)).toEqual({ kind: 'owner' });
    expect(existsSync(join(to, 'commons', 'knowledge.db'))).toBe(true);
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
