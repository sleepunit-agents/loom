import { lazy, Suspense, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { useMemberPreferences } from './member-preferences';
import { keep, lookOf, wearLook, PixelContext, type Prefs } from '../look';
import { HapticsContext, warmHaptics } from '../haptic';
import { allowZoom } from '../immersion';
import { wearMotion, wearContrast } from '../access';

const Depth = lazy(() => import('../ground').then(m => ({ default: m.Depth })));
const Contours = lazy(() => import('../ground').then(m => ({ default: m.Contours })));

export function wearPreferences(p: Prefs) {
  const look = lookOf(p.look, p.mode);
  wearLook(look); keep('loom-look', look);
  keep('loom-mode', document.documentElement.dataset.mode!);
  wearMotion(p.motion ?? 'follow'); keep('loom-motion', p.motion ?? 'follow');
  wearContrast(p.contrast ?? 'follow'); keep('loom-contrast', p.contrast ?? 'follow');
  for (const [key, fallback] of Object.entries({ sound:false, pixel:true, haptics:true, zoom:false, oneWindow:false })) {
    const on = p[key as keyof Prefs] ?? fallback;
    keep(`loom-${key === 'oneWindow' ? 'one-window' : key}`, on ? 'on' : 'off');
    document.documentElement.dataset[key] = on ? 'on' : 'off';
  }
  allowZoom(p.zoom ?? false);
  document.documentElement.dataset.ground = p.ground ?? 'depth';
  keep('loom-ground', p.ground ?? 'depth');
}
export default function Appearance({ children }: { children: ReactNode }) {
  const records = useMemberPreferences();
  const prefs = records.status === 'live' ? records.records[0]?.prefs : undefined;
  useLayoutEffect(() => { if (records.status !== 'loading') wearPreferences(prefs ?? {}); }, [prefs, records.status]);
  const ground = prefs?.ground ?? 'depth', haptics = prefs?.haptics ?? true;
  useEffect(()=>{if(haptics&&navigator.maxTouchPoints>0)warmHaptics();},[haptics]);
  return <PixelContext.Provider value={prefs?.pixel ?? true}><HapticsContext.Provider value={haptics}>
    <div className="relative isolate min-h-dvh">
    <span aria-hidden="true" className="loom-wash pointer-events-none fixed inset-0 -z-10" />
    <Suspense fallback={null}>{ground === 'depth' ? <Depth /> : ground === 'contours' ? <Contours /> : null}</Suspense>
    {children}
    </div>
  </HapticsContext.Provider></PixelContext.Provider>;
}
