import { lazy, Suspense, useLayoutEffect, type ReactNode } from 'react';
import { useRecords, type LiveRecord } from '../data';
import { keep, lookOf, wearLook, PixelContext, type Prefs } from '../look';
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
  for (const [key, fallback] of Object.entries({ sound:false, pixel:true, icons:false, haptics:true, zoom:false, oneWindow:false })) {
    const on = p[key as keyof Prefs] ?? fallback;
    keep(`loom-${key === 'oneWindow' ? 'one-window' : key}`, on ? 'on' : 'off');
    document.documentElement.dataset[key] = on ? 'on' : 'off';
  }
  allowZoom(p.zoom ?? false);
  document.documentElement.dataset.ground = p.ground ?? 'depth';
  keep('loom-ground', p.ground ?? 'depth');
}
export default function Appearance({ children }: { children: ReactNode }) {
  const records = useRecords<LiveRecord & { prefs: Prefs }>('household.preferences');
  const prefs = records.records[0]?.prefs;
  useLayoutEffect(() => { if (prefs) wearPreferences(prefs); }, [prefs]);
  const ground = prefs?.ground ?? 'depth';
  return <PixelContext.Provider value={prefs?.pixel ?? true}>
    <Suspense fallback={null}>{ground === 'depth' ? <Depth /> : ground === 'contours' ? <Contours /> : null}</Suspense>
    {children}
  </PixelContext.Provider>;
}
