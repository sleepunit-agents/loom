import { expect, it } from 'vitest';
import { memberPreferences, memberPreferencesQuery, type MemberPreferencesData, type MemberPreferenceRow } from './member-preferences';
const identity = { status: 'live' as const, data: { homeComms: { member: 'sam', agents: [], summaries: [] } } };
const row: MemberPreferenceRow = { member: 'sam', look: 'daylight', ground: 'wash', sound: false, pixel: false, icons: true, haptics: false, oneWindow: true, zoom: true, motion: 'on', contrast: 'off', changedAt: '2026-11-14T00:00:00.000Z' };
const query = { status: 'live' as const, data: { memberPreferences: [{ ...row, member: 'other', look: 'lowlight' as const }, row] } };
it('matches the signed-in member rather than preference row order', () => {
  expect(memberPreferences(identity, query)).toEqual({ status: 'live', records: [{ id: 'sam', prefs: { look: 'daylight', ground: 'wash', sound: false, pixel: false, icons: true, haptics: false, oneWindow: true, zoom: true, motion: 'on', contrast: 'off' } }] });
  expect(memberPreferences(identity, { status: 'live', data: { memberPreferences: [query.data.memberPreferences[0]] } }).records).toEqual([]);
  expect(memberPreferences({ ...identity, data: { homeComms: null } }, query)).toEqual({ status: 'denied', records: [] });
  expect(memberPreferences({ status: 'live' }, query)).toEqual({ status: 'loading', records: [] });
  expect(memberPreferences({ ...identity, data: { homeComms: { member: 'other', agents: [], summaries: [] } } }, query).records[0].id).toBe('other');
});
it.each(['loading', 'offline', 'denied'] as const)('clears retained choices when either source is %s', status => {
  expect(memberPreferences({ ...identity, status }, query)).toEqual({ status, records: [] });
  expect(memberPreferences(identity, { ...query, status })).toEqual({ status, records: [] });
});
