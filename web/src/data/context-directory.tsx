import { useEffect } from 'react';
import { useDataQuery, type DataQuerySnapshot } from './graphql';
export type DirectoryStatus = DataQuerySnapshot<unknown>['status'];
export const contextTitlePrefix = 'Context · ';
export type ContextRow = {
  id: string;
  title: string;
  agent: string;
  member: string;
  conversation: string;
  working: boolean;
  readSeq: number;
};
const directory =
  'query ContextRing($member:String!,$offset:Int!){rows:commsThreads(member:$member,limit:50,offset:$offset){id member agent title conversation working readSeq}}';
export function ContextDirectory({
  member,
  offset,
  onPage,
}: {
  member: string;
  offset: number;
  onPage: (offset: number, rows: ContextRow[], status: DirectoryStatus) => void;
}) {
  const feed = useDataQuery<{ rows: ContextRow[] }>(directory, { member, offset });
  useEffect(() => {
    onPage(offset, feed.status === 'live' ? feed.data?.rows || [] : [], feed.status);
  }, [feed.status, feed.data, offset, onPage]);
  return feed.status === 'live' && feed.data?.rows.length === 50 ? (
    <ContextDirectory member={member} offset={offset + 50} onPage={onPage} />
  ) : null;
}
