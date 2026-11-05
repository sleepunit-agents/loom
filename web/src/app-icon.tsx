// An app's icon wherever it stands for the app at a key's size (Jonathan, 2026-11-05: "Pixel icons", Appearance's, off
// unless turned on): the household's pixel icon when the person wears them and the set has one for the app, else its
// line icon. Everything pixel is in its own chunk (pixel-icons.tsx), loaded only then: this file is what the first page
// carries, and it's small.
//
// Where: the dock's keys, the launcher's tiles (Places, and Setup, a phone's More), an app's tile in its header and in
// Find, and a desktop window's title strip: each 36 px or more, room for the 32 px icon at 1×. A row's 16 px icon (the
// side, the More list) keeps its line icon: 2:1 down, the pixel art turns to mush on a 1× screen, so it doesn't read.
import { createContext, lazy, Suspense, useContext } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { useTint } from './tint';

/** The household's set (chrome.shell.icons) while the person wears it; none otherwise. */
export type PixelIcons = { v: string; apps: Record<string, { line?: true }> } | null;
export const PixelIconsContext = createContext<PixelIcons>(null);

const PixelIcon = lazy(() => import('./pixel-icons'));

/** The app an icon is for, from a label as the page shows it (src/icon-set.ts iconApp; Today is Home). */
export const pixelApp = (label: string): string => (label === 'Today' ? 'home'
  : label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));

type Size = Parameters<typeof AnimatedIcon>[0]['size'];

/** An app's icon: its pixel icon (lit on the current key) when worn and there is one, else its line icon. */
export function AppIcon({ label, name, size, active, lit }: { label: string; name: string; size?: Size; active?: boolean; lit?: boolean }) {
  const set = useContext(PixelIconsContext);
  const tint = useTint();
  const line = <AnimatedIcon name={name as never} size={size} active={active} />;
  const app = pixelApp(label);
  const has = set && Object.hasOwn(set.apps, app) ? set.apps[app] : undefined;
  if (!set || !has) return line;
  return <Suspense fallback={line}><PixelIcon app={app} v={set.v} tint={tint(label)} lit={lit} line={!!has.line} fallback={line} /></Suspense>;
}
