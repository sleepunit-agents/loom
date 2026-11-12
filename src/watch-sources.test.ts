import { describe, expect, it } from 'vitest';
import { builtinWatchRegistry, WatchRegistry } from './watch-sources.js';
import type { PieceInfo } from './ui/pieces.js';
import type { Job } from './ui/vocab.js';
const piece = (name: string, jobs: Job[] = []): PieceInfo => ({ piece: name, path: '', manifest: {
  v: 2, asks: [], agents: { art: { readings: [], jobs }, mark: { readings: [], jobs: [{ id: 'secret', text: 'Hidden', kind: 'lane', status: 'running' }] } },
} });
const roles = { runtime: 'runner', tasks: 'work', clock: 'alarms', approvals: 'decisions' };

describe('read-only watch registry', () => {
  it('counts by stable identity and agent; observes current state without prose or activity churn', () => {
    const p = piece('runner', [{ id: 'r1', text: 'Lane', kind: 'lane', status: 'running', run: 'run-1' }, { id: 'r1', text: 'Lane', kind: 'lane', status: 'running', run: 'run-1' }]);
    const r = builtinWatchRegistry([p], roles);
    expect(r.list('art')[0]).toMatchObject({ count: 1, status: 'available' });
    expect(r.list('mark')[0].items[0].id).toBe('secret');
    const s = r.source('runtime.lane'), i = s.list('art')[0], v = s.observe(i);
    p.manifest.agents!.art.jobs![0].text = 'Renamed';
    p.manifest.agents!.art.jobs![0].activity = { action: 'Reading a file', observedAt: 'x', expiresAt: 'y' };
    expect(s.observe(i)).toBe(v);
    expect(s.identity({ ...i, title: 'Renamed' })).toBe(s.identity(i));
    expect(s.identity({ ...i, id: 'r2' })).not.toBe(s.identity(i));
    p.manifest.agents!.art.jobs!.forEach((j) => { j.run = 'run-2'; });
    expect(s.observe(i)).not.toBe(v);
    p.manifest.agents!.art.jobs = [];
    expect(() => s.observe(i)).toThrow('absent');
  });
  it('distinguishes unavailable providers from an explicitly empty report and isolates their failures', () => {
    const p = piece('runner');
    const r = builtinWatchRegistry([p], roles);
    expect(r.list('art').map((g) => g.count)).toEqual([0, null, null, null]);
    p.manifest.agents!.art.state = 'unavailable';
    expect(r.list('art')[0].count).toBeNull();
    expect(() => r.source('runtime.lane').observe({ id: 'x', agent: 'art', title: '', state: '' })).toThrow('unavailable');
    expect(() => r.source('missing')).toThrow('Unknown');
    const registry = new WatchRegistry();
    registry.register(r.source('runtime.lane'));
    expect(() => registry.register(r.source('runtime.lane'))).toThrow('duplicate');
  });
  it('uses the roles public reports for tasks, deadlines and stable approval ids', () => {
    const tasks = piece('work', [{ id: 't-1', text: 'Work', status: 'backlog' }]);
    const clock = piece('alarms', [{ id: 'w-1', text: 'Later', status: 'scheduled', at: '2026-11-13T12:00:00Z', page: 'wake/w-1' }]);
    const approvals = piece('decisions');
    approvals.manifest.asks = [{ text: 'Allow?', agent: 'art', actions: [{ label: 'Allow', action: 'allow', fields: { id: 'a-1' } }] },
      { text: 'Other', agent: 'mark', actions: [{ label: 'Allow', action: 'allow', fields: { id: 'a-2' } }] }];
    const r = builtinWatchRegistry([tasks, clock, approvals], roles);
    expect(r.list('art').map((g) => g.count)).toEqual([null, 1, 1, 1]);
    expect(r.source('clock.deadline').list('art')[0].href).toBe('/p/alarms/wake/w-1');
    approvals.manifest.asks[0].text = 'Reworded';
    expect(r.source('approvals.pending').observe({ id: 'a-1', agent: 'art', title: '', state: '' })).toBe('["pending",null,null]');
    approvals.manifest.asks[0].actions = [];
    expect(r.list('art')[3].count).toBeNull();
  });
});
