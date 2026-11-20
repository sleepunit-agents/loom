import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { fixture, installFixture } from '../../fixture.js';
import { FakeClock } from '../clock.js';
import { HouseholdDatabase } from './document.js';
import type { Viewer } from '../../policy.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
it('restricts the summary to household owners on every door, including after membership changes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'household-show-')); fixture(home);
  const app = await startLoom({ home, next: true, clock: new FakeClock(), install: installFixture });
  cleanup.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  const household = new HouseholdDatabase(app.db);
  app.db.transaction(() => household.change(home, raw => {
    (raw.members as Array<{ person: string; role: string }>).find(m => m.person === 'pollock')!.role = 'owner';
  }))();
  for (const door of ['http', 'socket', 'mcp', 'direct'] as const) {
    for (const viewer of [{ kind: 'member', id: 'pollock' }, { kind: 'member', id: 'missing' }, { kind: 'agent', id: 'art' }, { kind: 'runner', id: 'box' }, { kind: 'service', id: 'sharing' }] as Viewer[]) {
      expect(app.operations.call(door, viewer, 'household.show', {})).toMatchObject({ ok: false, code: 'denied' });
    }
    expect(app.operations.call(door, { kind: 'member', id: 'jonathan' }, 'household.show', {})).toMatchObject({ ok: true, value: { home, agents: ['art', 'mark', 'pond-bot'], default: 'art' } });
  }
  app.db.transaction(() => household.change(home, raw => {
    (raw.members as Array<{ person: string; role: string; agents: unknown }>).find(m => m.person === 'pollock')!.agents = '*';
  }))();
  expect(app.operations.call('http', { kind: 'member', id: 'pollock' }, 'household.show', {})).toMatchObject({ ok: true });
});
