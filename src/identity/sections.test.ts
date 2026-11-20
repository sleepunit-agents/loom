import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IDENTITY_SECTIONS, identitySection, identityPiecesIndex } from './sections.js';
import { loadIdentity } from '../tools/identity.js';

vi.mock('../backends/salience.js', () => ({ digestForContext: () => null }));
vi.mock('../backends/episodes.js', () => ({ tapeForContext: () => null }));
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'loom-section-contract-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it('defines the eight standard sections and their boot policy independently of any agent', () => {
  expect(IDENTITY_SECTIONS.map(s => s.name).sort()).toEqual(['creed', 'harness', 'last-24h', 'model', 'owners', 'preferences', 'self-model', 'top-of-mind']);
  expect(IDENTITY_SECTIONS.filter(s => s.boot === 'core').map(s => s.name)).toEqual(['creed', 'preferences', 'owners', 'top-of-mind']);
  for (const section of IDENTITY_SECTIONS) {
    expect(identitySection(section.name)).toBe(section);
    for (const value of [section.purpose, section.writer, section.loadWhen]) expect(value.length).toBeGreaterThan(0);
    expect(section.byteBudget).toBeGreaterThan(0);
    expect(Number.isInteger(section.byteBudget)).toBe(true);
  }
  expect(identitySection('memories')).toBeUndefined();
  expect(identitySection('../secret')).toBeUndefined();
});

it('omits missing content for every named section and for all, including missing creed', async () => {
  const load = (selection?: string) => loadIdentity(dir, undefined, 'absent-client', 'absent-model', undefined, undefined, dir, undefined, selection);
  for (const section of IDENTITY_SECTIONS) expect(await load(section.name)).toBe('');
  expect(await load('all')).toBe('');
  expect(await load()).toBe(identityPiecesIndex());
});

it('uses the same table and omission behavior for Art and Mark', async () => {
  for (const name of ['art', 'mark']) {
    const agent = join(dir, name);
    await mkdir(agent);
    await writeFile(join(agent, 'IDENTITY.md'), `${name} creed`);
    await writeFile(join(agent, 'self-model.md'), `${name} self-model`);
    const core = await loadIdentity(agent);
    expect(core).toContain(`# Identity\n\n${name} creed`);
    expect(core).toContain(identityPiecesIndex());
    expect(core).not.toContain('# Self-Model');
    const piece = await loadIdentity(agent, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'self-model');
    expect(piece).toBe(`# Self-Model\n\n${name} self-model`);
    const creed = await loadIdentity(agent, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'creed');
    expect(creed).toBe(`# Identity\n\n${name} creed`);
  }
});

it('derives boot selection and index from the table instead of a second list', async () => {
  const selfModel = identitySection('self-model')!;
  const before = { boot: selfModel.boot, loadWhen: selfModel.loadWhen };
  await writeFile(join(dir, 'self-model.md'), 'table-selected content');
  try {
    Object.assign(selfModel, { loadWhen: 'when the table says so' });
    expect(identityPiecesIndex()).toContain('- self-model — load when the table says so');
    Object.assign(selfModel, { boot: 'core' });
    const core = await loadIdentity(dir);
    expect(core).toContain('# Self-Model\n\ntable-selected content');
    expect(identityPiecesIndex()).not.toContain('- self-model');
  } finally { Object.assign(selfModel, before); }
});
