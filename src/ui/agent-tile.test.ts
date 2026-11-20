// An agent's Clock tile on its Today (t-1925: it showed the household's next wake as a bare time, "11:08 AM", which
// read as the time of day): the piece's word for that agent, its next wake with how soon, and its last wake from loom's
// own record. handler.ts agentTile.
import { describe, expect, it } from 'vitest';
import { agentTile } from './handler.js';
import type { PieceInfo } from './pieces.js';

const NOW = Date.parse('2026-11-07T16:07:00Z');
const clock = (agents?: Record<string, unknown>): PieceInfo => ({ piece: 'clock', path: '/bin/loom-clock', manifest: {
  v: 2, scope: true, tab: { label: 'Clock', kind: 'setting' }, agentTab: { label: 'Clock' },
  tile: { label: 'Clock', value: '11:08 AM', detail: 'Art: Loren checks follow-up round 1', page: 'agent:art' },
  asks: [], ...(agents ? { agents } : {}),
} as never });
const wake = { ref: 'e1', title: 'wake-chain-density round 7', created: '2026-11-07T15:55:00Z', where: 'wake' };

describe('an agent\'s tile from a scoped piece (its Today)', () => {
  it('is its next wake, how soon, then its last wake, opening its own Clock', () => {
    const t = agentTile(clock({ mark: { readings: [{ label: 'Next', value: 'Morning check, 7:13 PM', detail: 'in 3 hours', page: '' }] } }), 'mark', wake, NOW);
    expect(t).toEqual({ label: 'Clock', value: 'in 3 hours', detail: 'Next: Morning check, 7:13 PM\nLast: wake-chain-density round 7, 12m ago',
      page: 'agent:mark', source: { id: 'clock', base: '/p/clock/' } });
  });

  it('never says another agent\'s wake: without a report for this one, the piece\'s own tile', () => {
    expect(agentTile(clock({ art: { readings: [{ label: 'Next', value: 'x', detail: 'in 1 hour' }] } }), 'mark', wake, NOW))
      .toMatchObject({ value: '11:08 AM', detail: 'Art: Loren checks follow-up round 1' });
  });

  it('a paused clock says so, with its tone; no last wake known, no line for it', () => {
    const t = agentTile(clock({ art: { state: 'unavailable', readings: [{ label: 'Next', value: 'paused', tone: 'warn', page: '' }] } }), 'art', undefined, NOW);
    expect(t).toEqual({ label: 'Clock', value: 'paused', tone: 'warn', page: 'agent:art', source: { id: 'clock', base: '/p/clock/' } });
  });

  it('a reading that isn\'t a wake gets no last wake under it', () => {
    const t = agentTile(clock({ art: { readings: [{ label: 'Bridges', value: 'Discord ✓', detail: 'all up' }] } }), 'art', wake, NOW);
    expect(t.detail).toBe('Bridges: Discord ✓');
  });
});
