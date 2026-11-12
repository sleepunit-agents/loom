/**
 * The system bar's words (web/src/system-bar.tsx): loom's clock as a phone has it, in loom's zone; and what each glyph
 * says, only from what the shell has. Its place on the page: desk-bar.integration.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { clockText, clockWords, placeWords, statusItems } from '../../web/src/system-bar';
import type { Shell } from '../../web/src/loom';

const shell = (o: Partial<Shell> = {}): Shell => ({ owner: 'jonathan', scope: 'household', household: true, agents: [], asks: 0, home: '/', core: [], pieces: [], tab: 'home', ...o });
const said = (s: Shell, offline = false) => statusItems(s, offline).map(({ key, label, dim, count, href }) => ({ key, label, dim: !!dim, count, href }));
const agent = (id: string, working?: true) => ({ id, label: id, bg: '#000', fg: '#fff', href: `/a/${id}`, current: false, ...(working ? { working } : {}) });

describe('the system bar', () => {
  it('a place in a line says each word once: a tile that names what it counts stands alone', () => {
    // Before: "Boxes 3 boxes" in the ticker.
    expect(placeWords('Boxes', '3 boxes')).toBe('3 boxes');
    expect(placeWords('Boxes', '1 box')).toBe('1 box');
    expect(placeWords('Tasks', '29 in progress')).toBe('Tasks 29 in progress');
    expect(placeWords('Secrets', '61')).toBe('Secrets 61');
    expect(placeWords('Changes', '15 open')).toBe('Changes 15 open');
    // A word inside another isn't it.
    expect(placeWords('Box', '3 inboxes')).toBe('Box 3 inboxes');
  });

  it('its clock: the time alone, in loom\'s zone, not the browser\'s', () => {
    const at = Date.UTC(2026, 10, 5, 14, 2);
    expect(clockText(at, 'America/Chicago')).toBe('8:02');
    expect(clockText(at, 'Asia/Tokyo')).toBe('11:02');
    expect(clockText(at, 'UTC')).toBe('2:02');
    // An older loom says no zone: its own clock's time.
    expect(clockText(at, undefined, 'Thu 8:02 AM CST')).toBe('8:02');
    expect(clockText(at, 'Not/AZone', 'Thu 8:02 AM CST')).toBe('8:02');
    // Said whole: the half of the day and the zone.
    expect(clockWords(at, 'America/Chicago')).toBe('8:02 AM, America/Chicago time');
    expect(clockWords(at, undefined, 'Thu 8:02 AM CST')).toBe('Thu 8:02 AM CST');
  });

  it('live or offline, in words', () => {
    expect(said(shell())[0]).toEqual({ key: 'signal', label: 'Live: connected to loom', dim: false, count: undefined, href: undefined });
    expect(said(shell(), true)[0]).toMatchObject({ label: 'Offline: can’t reach loom, showing a saved copy', dim: true });
  });

  it('the agents at work: how many, of how many, always there', () => {
    expect(said(shell({ agents: [agent('art'), agent('mark')] }))[1]).toEqual({ key: 'agents', label: 'No agent at work right now (2 in all)', dim: false, count: '0', href: '/' });
    expect(said(shell({ agents: [agent('art', true), agent('mark')] }))[1]).toMatchObject({ label: '1 of 2 agents at work', count: '1' });
    expect(said(shell({ agents: [agent('art', true), agent('mark', true)] }))[1]).toMatchObject({ label: 'All 2 agents are at work', count: '2' });
    expect(said(shell({ agents: [agent('art', true)] }))[1]).toMatchObject({ label: 'The agent is at work', count: '1' });
    // A lone agent's loom (no household): nothing to count, no glyph.
    expect(said(shell({ household: false, agents: [agent('agent')] })).map((i) => i.key)).toEqual(['signal']);
  });

  it('the boxes: how many, dimmed while one of their alerts is open; only with the Boxes piece, by its id not its label', () => {
    const quiet = shell({ pieces: [{ label: 'Boxes', href: '/p/runtime', current: false, stat: '3 boxes' }] });
    expect(said(quiet)[2]).toEqual({ key: 'boxes', label: '3 boxes, all quiet', dim: false, count: '3', href: '/p/runtime' });
    const alert = shell({ pieces: [{ label: 'Boxes', href: '/p/runtime', current: false, stat: '3 boxes', alerts: 2 }] });
    expect(said(alert)[2]).toMatchObject({ label: '3 boxes: 2 alerts', dim: true });
    const warn = shell({ pieces: [{ label: 'Boxes', href: '/p/runtime', current: false, stat: '1 box', tone: 'warn' }] });
    expect(said(warn)[2]).toMatchObject({ label: '1 box: something needs a look', dim: true, count: '1' });
    expect(said(shell({ pieces: [{ label: 'Boxes', href: '/p/box', current: false, stat: '2 boxes' }] }))[2]).toMatchObject({ key: 'boxes', count: '2' });
    // Another piece that calls itself Boxes isn't the boxes; the runtime renamed still is.
    expect(said(shell({ pieces: [{ label: 'Boxes', href: '/p/storage', current: false, stat: '9 bins' }] })).map((i) => i.key)).toEqual(['signal', 'agents']);
    expect(said(shell({ pieces: [{ label: 'Machines', href: '/p/runtime', current: false, stat: '3 boxes' }] })).map((i) => i.key)).toEqual(['signal', 'agents', 'boxes']);
  });

  it('the backup: its last good one, or what\'s wrong; only when the shell has it (a household owner)', () => {
    expect(said(shell({ backup: { tone: 'ok', text: '5h ago', href: '/a/art/setup' } }))[2]).toEqual({ key: 'backup', label: 'Last good backup 5h ago', dim: false, count: undefined, href: '/a/art/setup' });
    expect(said(shell({ backup: { tone: 'bad', text: 'failed', href: '/a/art/setup' } }))[2]).toMatchObject({ label: 'Backup failed', dim: true });
    expect(said(shell({ backup: { tone: 'warn', text: 'not set up', href: '/a/art/setup' } }))[2]).toMatchObject({ label: 'Backup: not set up', dim: true });
  });
});
