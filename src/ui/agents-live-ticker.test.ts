/**
 * The shell's agents read from their live cards (web/src/agents-live.ts shellAgentOf; agent-status 1.2, t-2028): at work
 * by the card's state, "active 4m ago" from its last step (handler.ts lastActive's rule), and the bar's ticker, so the
 * system bar stays current on any page without Home's page being asked again.
 */
import { describe, it, expect } from 'vitest';
import { shellAgentOf } from '@/agents-live';

const now = Date.parse('2026-11-10T12:00:00.000Z');
const at = (s: number) => new Date(now + s * 1000).toISOString();
const page = { id: 'art', label: 'Art', working: true as const, sub: 'active 2h ago', activity: { action: 'Working', observedAt: at(-5), expiresAt: at(20) } };

describe('shellAgentOf', () => {
  it('says what the card says: state, last active and its ticker', () => {
    const a = shellAgentOf(page, { id: 'art', label: 'Art', bg: '', fg: '', state: 'available', seen: { at: at(-240), where: 'Comms' },
      activity: { action: 'Reading a file', where: 'Comms', observedAt: at(-1), expiresAt: at(25) } }, now);
    expect(a).toEqual({ id: 'art', label: 'Art', sub: 'active 4m ago', activity: { action: 'Reading a file', where: 'Comms', observedAt: at(-1), expiresAt: at(25) } });
  });
  it('drops a ticker past its expiry, says loom can\'t tell, and is quiet with no step in three days', () => {
    const a = shellAgentOf(page, { id: 'art', label: 'Art', bg: '', fg: '', state: 'unavailable', activityUnavailable: true,
      activity: { action: 'Working', observedAt: at(-40), expiresAt: at(-10) } }, now);
    expect(a).toEqual({ id: 'art', label: 'Art', sub: 'quiet for 3 days', activityUnavailable: true });
  });
  it('keeps the page\'s ticker for a record from before 1.2, and leaves an agent with no card as it was', () => {
    expect(shellAgentOf(page, { id: 'art', label: 'Art', bg: '', fg: '', state: 'working', seen: { at: at(-10), where: 'Comms' } }, now))
      .toEqual({ ...page, sub: 'active just now' });
    expect(shellAgentOf(page, undefined, now)).toBe(page);
  });
});
