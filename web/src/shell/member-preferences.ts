import { useMemo } from 'react';
import type { LiveRecord, Snapshot } from '../data';
import { homeCommsQuery, type HomeCommsData } from '../pieces/attention/home-comms-data';
import { useDataQuery, type DataQuerySnapshot } from '../data/graphql';
import type { Prefs } from '../look';

export type MemberPreferenceRow = Omit<Prefs, 'mode' | 'at'> & { member: string; changedAt: string };
export type MemberPreferencesData = { memberPreferences: MemberPreferenceRow[] };
export type PreferenceRecord = LiveRecord & { prefs: Prefs };
export const memberPreferencesQuery = `query DeskPreferences {
  memberPreferences { member look ground sound pixel haptics oneWindow zoom motion contrast changedAt }
}`;

/** The current authenticated mailbox supplies member identity. Never infer the
 * current member from directory access or generated preference row ordering. */
export function memberPreferences(identity: DataQuerySnapshot<HomeCommsData>, query: DataQuerySnapshot<MemberPreferencesData>): Snapshot<PreferenceRecord> {
  if (identity.status !== 'live') return { status: identity.status, records: [] };
  if (query.status !== 'live') return { status: query.status, records: [] };
  if (!query.data) return { status: 'loading', records: [] };
  const member = identity.data?.homeComms?.member;
  if (!identity.data) return { status: 'loading', records: [] };
  if (!member) return { status: 'denied', records: [] };
  const rows = query.data.memberPreferences.filter(row => row.member === member);
  if (rows.length !== 1) return { status: rows.length ? 'denied' : 'live', records: [] };
  const { look, ground, sound, pixel, haptics, oneWindow, zoom, motion, contrast } = rows[0];
  return { status: 'live', records: [{ id: member, prefs: { look, ground, sound, pixel, haptics, oneWindow, zoom, motion, contrast } }] };
}
export function useMemberPreferences(): Snapshot<PreferenceRecord> {
  const identity = useDataQuery<HomeCommsData>(homeCommsQuery);
  const query = useDataQuery<MemberPreferencesData>(memberPreferencesQuery);
  return useMemo(() => memberPreferences(identity, query), [identity, query]);
}
