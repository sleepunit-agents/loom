/**
 * Relay pairs (src/relay-pairs.ts): read from the grants authority's own grants document, never
 * household.json. agent-runtime.md, "What moves where": relay pairing moves from household.json to
 * the runtime's permissions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relayOf, relayPairs } from './relay-pairs.js';
import { PieceStore } from './stores.js';

describe('relay pairs', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'loom-pairs-'));
    // household.json's old "relay" key is never read.
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark', 'fez'], relay: { art: ['fez'] } }));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function authority(name: string) {
    mkdirSync(join(home, 'pieces', name), { recursive: true });
    writeFileSync(join(home, 'pieces', name, 'piece.json'), JSON.stringify({
      v: 1, name, source: { repo: 'o/r', commit: '1'.repeat(40) }, package: name, version: '1.0.0', installed: '', bins: [`loom-${name}`],
      loom: { role: 'runtime', settings: [], services: [], grants: [`loom-${name}`, 'grants', 'ask'] },
    }));
  }

  it('no grants authority: no pairs, whatever household.json says', () => {
    expect(relayPairs(home, {})).toEqual({ pairs: {} });
    expect(relayOf(home, ['art', 'mark', 'fez'], 'art', {})).toEqual({ to: [] });
  });

  it('the authority\'s grants document is where the pairs are', () => {
    authority('runtime');
    expect(relayPairs(home, {})).toEqual({ authority: 'runtime', pairs: {} });
    const st = new PieceStore(home, 'runtime');
    st.put('grants', 'household', { v: 1, pieces: {}, relay: { art: ['mark', 'art', 'gone'], mark: ['art'] } }, { piece: 'runtime', owner: true, exp: 2e9 }, { grants: { writers: 'owner' } });
    st.close();
    expect(relayPairs(home, {}).pairs).toEqual({ art: ['mark', 'art', 'gone'], mark: ['art'] });
    // Only the household's other agents.
    expect(relayOf(home, ['art', 'mark', 'fez'], 'art', {})).toEqual({ authority: 'runtime', to: ['mark'] });
    expect(relayOf(home, ['art', 'mark', 'fez'], 'fez', {})).toEqual({ authority: 'runtime', to: [] });
  });
});
