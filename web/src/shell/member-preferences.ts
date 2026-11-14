import { useMemo } from 'react';
import { useRecords, type LiveRecord, type Snapshot } from '../data';
import { useDataQuery, type DataQuerySnapshot } from '../data/graphql';
import type { Prefs } from '../look';

export type PreferenceIdentity = LiveRecord & { member: string };
export type MemberPreferenceRow = Omit<Prefs, 'mode' | 'at'> & { member: string; changedAt: string };
export type MemberPreferencesData = { memberPreferences: MemberPreferenceRow[] };
export type PreferenceRecord = LiveRecord & { prefs: Prefs };
export const memberPreferencesQuery = `query DeskPreferences {
  memberPreferences { member look ground sound pixel icons haptics oneWindow zoom motion contrast changedAt }
}`;

/** The legacy member-scoped feed supplies identity only until root publishes its
 * replacement. Never infer the current member from generated row ordering. */
export function memberPreferences(identity: Snapshot<PreferenceIdentity>, query: DataQuerySnapshot<MemberPreferencesData>): Snapshot<PreferenceRecord> {
  if (identity.status !== 'live') return { status: identity.status, records: [] };
  if (query.status !== 'live') return { status: query.status, records: [] };
  if (!query.data) return { status: 'loading', records: [] };
  const member = identity.records.length === 1 ? identity.records[0].member : undefined;
  if (!member) return { status: 'denied', records: [] };
  const rows = query.data.memberPreferences.filter(row => row.member === member);
  if (rows.length !== 1) return { status: rows.length ? 'denied' : 'live', records: [] };
  const { look, ground, sound, pixel, icons, haptics, oneWindow, zoom, motion, contrast } = rows[0];
  return { status: 'live', records: [{ id: member, prefs: { look, ground, sound, pixel, icons, haptics, oneWindow, zoom, motion, contrast } }] };
}
export function useMemberPreferences(): Snapshot<PreferenceRecord> {
  const identity = useRecords<PreferenceIdentity>('household.preferences');
  const query = useDataQuery<MemberPreferencesData>(memberPreferencesQuery);
  return useMemo(() => memberPreferences(identity, query), [identity, query]);
}
