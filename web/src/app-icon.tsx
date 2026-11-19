// An app's icon wherever it stands for the app (Jonathan, 2026-11-19: loom's own icons are the standard ones, no
// switch, and "the same icon for the small one here too", so the dock and the app never show two different things).
// loom's house icon when the set has one for the app (assets/house-icons/, by the app's id), else the app's line icon:
// the set fills in app by app, and an app whose art isn't drawn yet looks as it did. Never a line icon at one size and
// the house icon at another for the same app.
//
// By id, not by title: a title is renamed ("Project sharing" became "Sharing"), an id isn't. The dock's two keys that
// aren't apps have ids of their own here: `home` and `launcher`.
//
// How big is the slot's to say (`house`, in px): the dock's keys 32 (in a 44 px key), the launcher's and the switcher's
// tiles 40 (in 56), a window's title-strip key 24 (in a 32 px strip). Unsaid, it's 32, or 16 wherever the line icon
// would be small (`size="sm"`: a row, your account's key in the launcher). The same art at every size: an app never
// shows its house icon in the dock and a line icon in a row.
import { useState } from 'react';
import { AnimatedIcon } from '@/components/ui/animated-icon';
import { HOUSE_ICONS } from './assets/house-icons';
import { installHouseTint } from './house-tint';
import './house-icons.css';

installHouseTint();

/** The set's two files' sizes in px (scripts/build-house-icons.py). */
const ART = 128, SMALL = 32;

type Size = Parameters<typeof AnimatedIcon>[0]['size'];

/** loom's own icon for an app id, if its art is in the set. */
export const houseIcon = (app: string | undefined): { art: string; small: string } | undefined => (app !== undefined && Object.hasOwn(HOUSE_ICONS, app) ? HOUSE_ICONS[app] : undefined);

/** An app's icon: its house icon when `app` (its id) has one, else its line icon `name` (and that if the file won't
 * load). `size` and `active` are the line icon's; `house` is the house icon's size in px (whole pixels). A house
 * icon's tint, and whether it's on a lit key, are its key's (house-tint.ts). */
export function AppIcon({ app, name, size, active, house: px = size === 'sm' ? 16 : 32 }: { app?: string; name: string; size?: Size; active?: boolean; house?: number }) {
  const house = houseIcon(app);
  const [broken, setBroken] = useState<string>();
  if (!house || broken === app) return <AnimatedIcon name={name as never} size={size} active={active} />;
  // The 32 px file wherever it covers the slot's device pixels (a 16 px slot up to 2x, the dock's 32 px at 1x: one
  // image pixel per screen pixel there), the 128 px master past that. The browser picks; nothing is measured here.
  const fits = px <= SMALL;
  return <img className="loom-house" src={fits ? house.small : house.art} srcSet={fits ? `${house.small} ${+(SMALL / px).toFixed(3)}x, ${house.art} ${+(ART / px).toFixed(3)}x` : undefined}
    width={px} height={px} style={{ width: px, height: px }} alt="" draggable={false} decoding="async" data-app={app} onError={() => setBroken(app)} />;
}
