/**
 * An owner's run of a managed piece (`loom <piece> …` at loom's machine) gets an owner's grant for
 * that piece's store, as an owner's page action does (src/cli/pieces.ts, dispatchEnv): what lets
 * `loom shuttle gates export --json | loom runtime gates import` write the runtime's owner-written
 * collection (agent-runtime.md, "What moves where"; test 9). A piece's own process, a call loom
 * gave a grant, and a house never get one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dispatchEnv, ownersRun } from './pieces.js';
import { mintGrant, readGrant } from '../stores.js';

describe('dispatchEnv: an owner\'s run of a managed piece', () => {
  let home: string;
  let bin: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'loom-dispatch-'));
    const dir = join(home, 'pieces', 'runtime');
    mkdirSync(join(dir, 'current'), { recursive: true });
    writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name: 'runtime', source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: 'runtime', version: '1', installed: 'x',
      bins: ['loom-runtime'], loom: { settings: [], services: [] } }));
    writeFileSync(join(dir, 'current', 'cli'), '#!/bin/sh\n');
    chmodSync(join(dir, 'current', 'cli'), 0o755);
    mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
    bin = join(home, 'pieces', 'bin', 'loom-runtime');
    symlinkSync(join(dir, 'current', 'cli'), bin);
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('gets an owner\'s grant for that piece, and its own name', () => {
    const env = dispatchEnv(bin, { LOOM_HOME: home, PATH: '/usr/bin' });
    expect(env.LOOM_PIECE_NAME).toBe('runtime');
    expect(readGrant(home, env.LOOM_STORE_GRANT)).toMatchObject({ piece: 'runtime', owner: true });
  });

  it.each([
    ['a piece\'s own process', { LOOM_PIECE_NAME: 'shuttle' }],
    ['a house (its token file)', { LOOM_TOKEN_FILE: '/run/secrets/loom-token' }],
    ['a house (loom\'s URL)', { LOOM_URL: 'http://loom:8787/mcp' }],
    ['a house (its id)', { HOUSE_ID: 'h-1' }],
  ])('%s gets none', (_w, extra) => {
    const env = dispatchEnv(bin, { LOOM_HOME: home, ...extra });
    expect(env.LOOM_STORE_GRANT).toBeUndefined();
    expect(ownersRun({ ...extra })).toBe(false);
  });

  it('a call loom gave a grant keeps that grant, never an owner\'s', () => {
    const agentGrant = mintGrant(home, { piece: 'shuttle', agent: 'art' });
    const env = dispatchEnv(bin, { LOOM_HOME: home, LOOM_STORE_GRANT: agentGrant });
    expect(env.LOOM_STORE_GRANT).toBe(agentGrant);
  });

  it('a piece found on PATH (not managed) gets none', () => {
    const env = dispatchEnv('/usr/local/bin/loom-now', { LOOM_HOME: home });
    expect(env.LOOM_STORE_GRANT).toBeUndefined();
  });
});
