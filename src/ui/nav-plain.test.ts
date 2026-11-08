import { describe, expect, it } from 'vitest';
import { ACCESSIBILITY, ACCOUNT, APPEARANCE, placesOf, settingsOf } from '../../web/src/nav';
import { launcherOf, launchFilter, firstMatch } from '../../web/src/launch-list';

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
  it('Places holds the apps; not the Inbox (its own tab), not a setting, not Appearance (Setup\'s)', () => {
    expect(placesOf(shell()).map((p) => p.label)).toEqual(['Activity', 'Knowledge', 'People', 'Tasks']);
  });

  it('Setup holds the household\'s configuration, then Appearance and Accessibility as tiles of their own: no passkeys, no sign out', () => {
    expect(settingsOf(shell()).map((p) => p.label)).toEqual(['Boxes', 'Bridges', 'Members', 'Pieces', 'Appearance', 'Accessibility']);
    expect(settingsOf(shell()).at(-2)).toMatchObject({ href: APPEARANCE.href, current: false });
    expect(settingsOf(shell()).at(-1)).toMatchObject({ href: ACCESSIBILITY.href, current: false });
    expect(settingsOf(shell({ tab: 'appearance' })).map((p) => p.current).slice(-2)).toEqual([true, false]);
    expect(settingsOf(shell({ tab: 'accessibility' })).map((p) => p.current).slice(-2)).toEqual([false, true]);
    // An agent owner (admin false) manages neither the members nor the pieces; their look and access are still theirs.
    expect(settingsOf(shell({ admin: false })).map((p) => p.label)).toEqual(['Boxes', 'Bridges', 'Appearance', 'Accessibility']);
  });

  it('no destination is in two of Places, Setup and the account', () => {
    const homes = [placesOf(shell()), settingsOf(shell()), [...ACCOUNT]].map((l) => l.map((p) => p.href));
    const all = homes.flat();
    expect(all.filter((h, n) => all.indexOf(h) !== n)).toEqual([]);
    expect(homes[2]).toEqual(['/account']);
  });
});

describe('the launcher\'s list (web/src/launch-list.ts, t-1925 G)', () => {
  const full = () => ({ ...shell(),
    core: [...shell().core, { label: 'Projects', href: '/projects', current: false }, { label: 'Comms', href: '/comms', current: false, count: 2 }],
    pieces: [...shell().pieces, { label: 'Changes', href: '/p/changes', current: false, kind: 'place' as const, stat: '7 open' },
      { label: 'Clock', href: '/p/clock', current: false, kind: 'place' as const, stat: '4 wakes today', tone: 'warn' as const }],
    agents: [{ id: 'art', label: 'Art E Fish', href: '/a/art', working: true as const }, { id: 'mark', label: 'Visual Mark', href: '/a/mark', asks: 1 }] });

  it('groups every app in loom\'s sections, in order, each app once', () => {
    const l = launcherOf(full(), { look: 'Neon Noir', motion: 'Full motion' });
    expect(l.map((s) => [s.name, s.apps.map((a) => a.label)])).toEqual([
      ['Work', ['Inbox', 'Activity', 'Projects', 'Tasks', 'Changes']],
      ['People & agents', ['Comms', 'Art E Fish', 'Visual Mark', 'People']],
      ['Library', ['Knowledge']],
      ['System', ['Boxes', 'Bridges', 'Clock', 'Members', 'Profile']],
      ['Look & feel', ['Appearance', 'Accessibility']],
      ['Pieces', ['Pieces']],
    ]);
    const hrefs = l.flatMap((s) => s.apps.map((a) => a.href));
    expect(hrefs.filter((h, n) => hrefs.indexOf(h) !== n)).toEqual([]);
    // Everything Places and Setup held is here (the launcher replaces both on a desktop), and Profile is an app (t-1970).
    for (const p of [...placesOf(full()), ...settingsOf(full())]) expect(hrefs).toContain(p.href);
    expect(hrefs).toContain('/account');
  });

  it('says each app\'s live state under its name', () => {
    const at = (label: string) => launcherOf(full(), { look: 'Neon Noir', motion: 'Full motion' }).flatMap((s) => s.apps).find((a) => a.label === label)!;
    expect([at('Inbox').sub, at('Inbox').count]).toEqual(['3 need you', 3]);
    expect([at('Comms').sub, at('Comms').count]).toEqual(['2 unread', 2]);
    expect(at('Art E Fish')).toMatchObject({ sub: 'Working', agent: 'art' });
    expect(at('Visual Mark')).toMatchObject({ sub: '1 waiting on you', count: 1 });
    expect(at('Changes').sub).toBe('7 open');
    expect([at('Clock').sub, at('Clock').tone]).toEqual(['4 wakes today', 'warn']);
    expect(at('Appearance').sub).toBe('Neon Noir');
    expect(at('Pieces').sub).toBe('5 installed');
  });

  it('says nothing is waiting, and all read, when nothing is', () => {
    const quiet = { ...full(), core: full().core.map((p) => ({ ...p, count: 0 })) };
    const at = (label: string) => launcherOf(quiet).flatMap((s) => s.apps).find((a) => a.label === label)!;
    expect([at('Inbox').sub, at('Inbox').count]).toEqual(['Nothing waiting', undefined]);
    expect([at('Comms').sub, at('Comms').count]).toEqual(['All read', undefined]);
    expect(launcherOf(quiet, { motion: 'Less motion' }).flatMap((s) => s.apps).find((a) => a.label === 'Accessibility')!.sub).toBe('Less motion');
    // A third party's place piece is Work's; only a setting (or one of loom's own that runs the house) is System's.
    const third = launcherOf({ ...quiet, pieces: [{ label: 'Gardening', href: '/p/garden', current: false, kind: 'place' as const }] });
    expect(third.find((s) => s.name === 'Work')!.apps.map((a) => a.label)).toContain('Gardening');
  });

  it('Approvals is Work\'s, by its own override, though its kind is a setting (t-1925, the mockups)', () => {
    const withApprovals = { ...full(), pieces: [...full().pieces, { label: 'Approvals', href: '/p/approvals', current: false, kind: 'setting' as const, stat: '2 waiting' }] };
    const l = launcherOf(withApprovals);
    expect(l.find((s) => s.name === 'Work')!.apps.map((a) => a.label)).toContain('Approvals');
    expect(l.find((s) => s.name === 'System')!.apps.map((a) => a.label)).not.toContain('Approvals');
    // Its kind is unchanged: Setup (the phone's More) still holds it.
    expect(settingsOf(withApprovals).map((p) => p.label)).toContain('Approvals');
  });

  it('an agent owner (admin false) gets no Members, no Pieces and no Permissions; Profile is theirs too', () => {
    const names = launcherOf({ ...full(), admin: false, permissions: '/p/runtime/permissions' }).flatMap((s) => s.apps.map((a) => a.label));
    expect(names).not.toContain('Members');
    expect(names).not.toContain('Pieces');
    expect(names).not.toContain('Permissions');
    expect(names).toContain('Profile');
  });

  it('Permissions is a System app, by name among the others, where the household has a grants authority (t-1970)', () => {
    const l = launcherOf({ ...full(), permissions: '/p/runtime/permissions' });
    const sys = l.find((s) => s.name === 'System')!.apps;
    expect(sys.map((a) => a.label)).toEqual(['Boxes', 'Bridges', 'Clock', 'Members', 'Permissions', 'Profile']);
    expect(sys.find((a) => a.label === 'Permissions')!.href).toBe('/p/runtime/permissions');
    const found = launchFilter(l, 'perm').flatMap((s) => s.apps);
    expect(firstMatch(found, 'perm')).toMatchObject({ label: 'Permissions', href: '/p/runtime/permissions' });
    // Without one (no runtime), there's no page to open, so no app.
    expect(launcherOf(full()).flatMap((s) => s.apps.map((a) => a.label))).not.toContain('Permissions');
  });

  it('Profile is an app a search finds by profile, passkey, account or sign out; Enter opens it (t-1970)', () => {
    const l = launcherOf(full());
    for (const q of ['profile', 'Prof', 'passkey', 'account', 'sign out']) {
      const found = launchFilter(l, q).flatMap((s) => s.apps);
      expect(found.map((a) => a.label), q).toContain('Profile');
      expect(firstMatch(found, q), q).toMatchObject({ label: 'Profile', href: '/account' });
    }
  });

  it('filters by an app\'s name or its section\'s; Enter\'s pick is the first name that starts with it', () => {
    const l = launcherOf(full());
    expect(launchFilter(l, 'acc').flatMap((s) => s.apps.map((a) => a.label))).toEqual(['Profile', 'Accessibility']);
    expect(firstMatch(launchFilter(l, 'acc').flatMap((s) => s.apps), 'acc').label).toBe('Accessibility');
    expect(launchFilter(l, 'system').flatMap((s) => s.apps.map((a) => a.label))).toEqual(['Boxes', 'Bridges', 'Clock', 'Members', 'Profile']);
    expect(launchFilter(l, 'zzz')).toEqual([]);
    expect(launchFilter(l, '  ')).toBe(l);
    // "people" matches People & agents' section and People: Enter opens People, not Comms (shown first).
    const people = launchFilter(l, 'people').flatMap((s) => s.apps);
    expect(people[0].label).toBe('Comms');
    expect(firstMatch(people, 'people').label).toBe('People');
  });
});
