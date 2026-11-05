/**
 * The system bar's words (web/src/system-bar.tsx): loom's clock as a phone has it, in loom's zone; and what each glyph
 * says, only from what the shell has. Its place on the page: desk-bar.integration.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { clockText, statusItems } from '../../web/src/system-bar';
import type { Shell } from '../../web/src/loom';

const shell = (o: Partial<Shell> = {}): Shell => ({ owner: 'jonathan', scope: 'household', household: true, agents: [], asks: 0, home: '/', core: [], pieces: [], tab: 'home', ...o });
const said = (s: Shell, offline = false) => statusItems(s, offline).map(({ key, label, dim, count, href }) => ({ key, label, dim: !!dim, count, href }));

describe('the system bar', () => {
  it('its clock: the time alone, in loom\'s zone, not the browser\'s', () => {
    const at = Date.UTC(2026, 10, 5, 14, 2);
    expect(clockText(at, 'America/Chicago')).toBe('8:02');
    expect(clockText(at, 'Asia/Tokyo')).toBe('11:02');
    expect(clockText(at, 'UTC')).toBe('2:02');
    // An older loom says no zone: its own clock's time.
    expect(clockText(at, undefined, 'Thu 8:02 AM CST')).toBe('8:02');
    expect(clockText(at, 'Not/AZone', 'Thu 8:02 AM CST')).toBe('8:02');
  });

  it('live or offline, in words', () => {
    expect(said(shell())).toEqual([{ key: 'signal', label: 'Live: connected to loom', dim: false, count: undefined, href: undefined }]);
    expect(said(shell(), true)[0]).toMatchObject({ label: 'Offline: can’t reach loom, showing a saved copy', dim: true });
  });

  it('the boxes: how many, dimmed while one of their alerts is open; only with a Boxes piece', () => {
    const quiet = shell({ pieces: [{ label: 'Boxes', href: '/p/runtime', current: false, stat: '3 boxes' }] });
    expect(said(quiet)[1]).toEqual({ key: 'boxes', label: '3 boxes, all quiet', dim: false, count: '3', href: '/p/runtime' });
    const alert = shell({ pieces: [{ label: 'Boxes', href: '/p/runtime', current: false, stat: '3 boxes', alerts: 2 }] });
    expect(said(alert)[1]).toMatchObject({ label: '3 boxes: 2 alerts', dim: true });
    const warn = shell({ pieces: [{ label: 'Boxes', href: '/p/runtime', current: false, stat: '1 box', tone: 'warn' }] });
    expect(said(warn)[1]).toMatchObject({ label: '1 box: something needs a look', dim: true, count: '1' });
    expect(said(shell({ pieces: [{ label: 'Tasks', href: '/p/tasks', current: false, stat: '3' }] })).map((i) => i.key)).toEqual(['signal']);
  });

  it('the backup: its last good one, or what\'s wrong; only when the shell has it (a household owner)', () => {
    expect(said(shell({ backup: { tone: 'ok', text: '5h ago', href: '/a/art/setup' } }))[1]).toEqual({ key: 'backup', label: 'Last good backup 5h ago', dim: false, count: undefined, href: '/a/art/setup' });
    expect(said(shell({ backup: { tone: 'bad', text: 'failed', href: '/a/art/setup' } }))[1]).toMatchObject({ label: 'Backup failed', dim: true });
    expect(said(shell({ backup: { tone: 'warn', text: 'not set up', href: '/a/art/setup' } }))[1]).toMatchObject({ label: 'Backup: not set up', dim: true });
  });
});
