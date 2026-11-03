import { describe, expect, it } from 'vitest';
import { ACCOUNT, APPEARANCE, placesOf, settingsOf } from '../../web/src/nav';

// The shell as loom answers it for a household (handler.ts chrome): loom's own places, and the pieces with their kinds.
const shell = (over: Record<string, unknown> = {}) => ({
  tab: '', admin: true,
  core: [{ label: 'Activity', href: '/activity', current: false }, { label: 'Inbox', href: '/inbox', current: false, count: 3 },
    { label: 'Knowledge', href: '/knowledge', current: false }, { label: 'People', href: '/people', current: false }],
  pieces: [{ label: 'Boxes', href: '/p/runtime', current: false, kind: 'setting' as const }, { label: 'Bridges', href: '/p/shuttle', current: false, kind: 'setting' as const },
    { label: 'Tasks', href: '/p/tasks', current: false, kind: 'place' as const }],
  ...over,
});

describe('each destination has one home (web/src/nav.ts)', () => {
  it('Places holds the apps, Appearance last; not the Inbox (its own tab), not a setting', () => {
    expect(placesOf(shell()).map((p) => p.label)).toEqual(['Activity', 'Knowledge', 'People', 'Tasks', 'Appearance']);
    expect(placesOf(shell()).at(-1)).toMatchObject({ href: APPEARANCE.href, current: false });
    expect(placesOf(shell({ tab: 'appearance' })).at(-1)?.current).toBe(true);
  });

  it('Setup holds the household\'s configuration only: no appearance, no passkeys, no sign out', () => {
    expect(settingsOf(shell()).map((p) => p.label)).toEqual(['Boxes', 'Bridges', 'Members', 'Pieces']);
    // An agent owner (admin false) manages neither the members nor the pieces.
    expect(settingsOf(shell({ admin: false })).map((p) => p.label)).toEqual(['Boxes', 'Bridges']);
  });

  it('no destination is in two of Places, Setup and the account', () => {
    const homes = [placesOf(shell()), settingsOf(shell()), [...ACCOUNT]].map((l) => l.map((p) => p.href));
    const all = homes.flat();
    expect(all.filter((h, n) => all.indexOf(h) !== n)).toEqual([]);
    expect(homes[2]).toEqual(['/passkeys']);
  });
});
