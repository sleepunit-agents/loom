import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadIdentity } from './identity.js';
vi.mock('../backends/episodes.js', () => ({ tapeForContext: () => 'TAPE-CONTENT' }));
vi.mock('../backends/salience.js', () => ({ digestForContext: () => 'SALIENCE-CONTENT' }));
vi.mock('../backends/people.js', () => ({ roomBlock: (_dir: string, people: string[]) => people?.includes('owner') ? '# In the room\nROOM-CONTENT' : null }));
vi.mock('../backends/projects.js', () => ({ projectBlock: (_dir: string, project: string) => project === 'repo' ? '# This project\nPROJECT-CARD' : null }));
vi.mock('../backends/people-household.js', () => ({ commonsPeoplePath: () => '/no-such-owner-db' }));
vi.mock('../household.js', () => ({ householdOf: () => ({ agent: 'art', household: { members: [{ person: 'owner', agents: '*' }] } }) }));
vi.mock('../clients.js', () => ({ loadClientAdapter: async (_dir: string, client: string) => client === 'claude-code' ? 'CLIENT-RESTRICTIONS' : null }));
vi.mock('../blocks/harness.js', () => ({ read: async () => ({ body: 'HARNESS-BOILERPLATE' }) }));
vi.mock('../blocks/model.js', () => ({ read: async () => ({ body: 'MODEL-BOILERPLATE' }) }));
vi.mock('../backends/recorder-health.js', () => ({ readHealth: () => ({}), recordFailure: () => {}, warningBlock: () => 'RECORDER-WARNING' }));
describe('work identity profile', () => {
  it('uses the agent authored work brief, omits boilerplate, full remains available', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-work-'));
    try {
      writeFileSync(join(dir, 'IDENTITY.md'), '# Full creed\nFull identity details');
      writeFileSync(join(dir, 'work-identity.md'), '# Work creed\nDo the authorized work.');
      writeFileSync(join(dir, 'preferences.md'), 'Full personal preferences');
      writeFileSync(join(dir, 'self-model.md'), 'Full self model');
      mkdirSync(join(dir, 'roles')); mkdirSync(join(dir, 'projects')); mkdirSync(join(dir, 'memories'));
      writeFileSync(join(dir, 'roles', 'coding.md'), 'ROLE-CONTENT');
      writeFileSync(join(dir, 'projects', 'repo.md'), 'PROJECT-BRIEF');
      writeFileSync(join(dir, 'memories', 'INDEX.md'), '- legacy-memory-summary');
      const work = await loadIdentity(dir, 'repo', 'claude-code', 'gpt-test', 'coding', ['owner'], undefined, undefined, 'work');
      expect(work).toContain('Work creed');
      expect(work).toContain('Do the authorized work.');
      expect(work).not.toContain('Full creed');
      expect(work).not.toContain('Full identity details');
      expect(work).not.toContain('Full personal preferences');
      for (const text of ['TAPE-CONTENT', 'SALIENCE-CONTENT', 'Full self model', 'HARNESS-BOILERPLATE', 'MODEL-BOILERPLATE', 'legacy-memory-summary']) expect(work).not.toContain(text);
      for (const text of ['# Owners', 'owner (`owner`): owns the household and every agent in it', 'ROOM-CONTENT', 'PROJECT-CARD', 'PROJECT-BRIEF', 'ROLE-CONTENT', 'CLIENT-RESTRICTIONS', 'RECORDER-WARNING']) expect(work).toContain(text);
      const full = await loadIdentity(dir);
      expect(full).toContain('Full creed');
      expect(full).toContain('Full personal preferences');
      expect(await loadIdentity(dir, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'full')).toBe(full);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('falls back to full identity when the work brief is missing, empty or too big', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'identity-work-'));
    try {
      writeFileSync(join(dir, 'IDENTITY.md'), 'Full creed');
      writeFileSync(join(dir, 'preferences.md'), 'fallback preferences');
      writeFileSync(join(dir, 'self-model.md'), 'fallback self model');
      mkdirSync(join(dir, 'memories')); writeFileSync(join(dir, 'memories', 'INDEX.md'), '- fallback legacy');
      const call = (profile?: 'full' | 'work') => loadIdentity(dir, undefined, 'claude-code', 'gpt-test', undefined, ['owner'], undefined, undefined, profile);
      for (const text of [undefined, '', '   ', 'x'.repeat(8001), 'é'.repeat(4001), ' '.repeat(8000) + 'brief']) {
        if (text !== undefined) writeFileSync(join(dir, 'work-identity.md'), text);
        expect(await call('work')).toBe(await call('full'));
      }
      writeFileSync(join(dir, 'work-identity.md'), 'é'.repeat(4000));
      expect(await loadIdentity(dir, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'work')).toContain('é'.repeat(4000));
      writeFileSync(join(dir, 'work-identity.md'), 'x'.repeat(8000));
      expect(await loadIdentity(dir, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'work')).toContain('x'.repeat(8000));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
