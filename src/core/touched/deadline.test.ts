import { expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, Socket } from 'node:net';
import { FakeClock } from '../clock.js';
import { touched, touchSocketPath } from './index.js';
vi.mock('node:net', async importOriginal => {
  const actual = await importOriginal<typeof import('node:net')>();
  return { ...actual, createConnection: vi.fn(actual.createConnection) };
});
it('includes connection establishment in its absolute deadline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'touch-pending-'));
  mkdirSync(join(dir, '.loom-live')); writeFileSync(touchSocketPath(dir), 'test marker');
  const pending = new Socket(), clock = new FakeClock();
  vi.mocked(createConnection).mockReturnValueOnce(pending);
  try {
    touched(dir, 'memory', 'ref', clock);
    // No connect event is emitted: a deadline started on connect would never fire.
    clock.advance(249); expect(pending.destroyed).toBe(false);
    clock.advance(1); expect(pending.destroyed).toBe(true);
  } finally { pending.destroy(); rmSync(dir, { recursive: true, force: true }); }
});
