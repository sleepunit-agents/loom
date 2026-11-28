/** What of the member's own Appearance the boards page wears (docs/specs/boards.md, "The first bricks", appearance).
 *
 * It wears ONE preference: Reduce motion. On, off, or the device's own setting while the member follows it, through
 * the desktop's own switch (../access.ts, <html data-motion>), which this page's stylesheets and its moving
 * portrait both read (vite.boards.config.ts rewrites every motion media query onto that attribute).
 *
 * It ignores the rest, and says so in the `appearance` brick: the look (this page has one look of its own, light or
 * dark as the device is; a desktop look is a different set of colours, corners and type, and none of the three is
 * this page's), the desk background, higher contrast (this page has no higher-contrast styling), pixel faces, sound,
 * haptics, one window at a time and zoom (each is a thing of the desktop's shell). Until the member's record has
 * arrived, and whenever it cannot be read, the page keeps what it last wore: the device's setting at first. */
import { useLayoutEffect, useMemo } from 'react';
import { wearMotion } from '../access';
import { useDataQuery } from '../data/graphql';
import { homeCommsQuery, type HomeCommsData } from '../pieces/attention/home-comms-data';
import { memberPreferences, memberPreferencesQuery, type MemberPreferencesData } from '../shell/member-preferences';

/** The one honest line the `appearance` brick shows. */
export const WORN_WORDS = 'On this page only Reduce motion takes effect. This page keeps its own look, light or dark as this device is, and has no higher-contrast styling; the other choices are kept, and no page uses them yet.';

/** The member's own saved choices, live, as the desktop's shell reads them: the mailbox says who is signed in, and
 * only that member's one row counts (shell/member-preferences.ts). */
export function useOwnPreferences() {
  const identity = useDataQuery<HomeCommsData>(homeCommsQuery, undefined, { keep: true });
  const query = useDataQuery<MemberPreferencesData>(memberPreferencesQuery, undefined, { keep: true });
  return useMemo(() => memberPreferences(identity, query), [identity, query]);
}

/** Wears the member's Reduce motion on this page, and again whenever the record changes. Draws nothing. */
export function Wear() {
  const snapshot = useOwnPreferences();
  const motion = snapshot.status === 'live' ? snapshot.records[0]?.prefs.motion ?? 'follow' : undefined;
  useLayoutEffect(() => { if (motion) wearMotion(motion); }, [motion]);
  return null;
}
