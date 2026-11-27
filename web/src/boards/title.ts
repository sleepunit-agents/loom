/** The tab's title on the boards page: the open thread's title, or "Loom", with a mark in front while the tab is
 * hidden and the thread holds a reply the member has not read. The mark goes when the tab is seen again. */
import { useEffect, useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { threadHeadQuery } from './threads';

export const UNREAD_MARK = '● ';
export const pageTitle = (title: string | null | undefined, marked: boolean) => (marked ? UNREAD_MARK : '') + (title?.trim() || 'Loom');

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** `unread`: the thread holds a reply after the member's read mark (the transcript's tail says so). */
export function usePageTitle(thread: string, unread: boolean) {
  const read = useDataQuery<{ thread: { id: string; title: string } | null }>(threadHeadQuery, { id: thread }, { keep: true });
  const title = read.data?.thread?.id === thread ? read.data.thread.title : undefined;
  const [away, setAway] = useState(hidden);
  useEffect(() => {
    const see = () => setAway(hidden());
    see();
    document.addEventListener?.('visibilitychange', see);
    return () => document.removeEventListener?.('visibilitychange', see);
  }, []);
  useEffect(() => { document.title = pageTitle(title, unread && away); }, [title, unread, away]);
  useEffect(() => () => { document.title = pageTitle(undefined, false); }, []);
}
