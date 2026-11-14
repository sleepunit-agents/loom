import './agent-face.css';
import { lazy, Suspense, useContext } from 'react';
import { useRecords, type LiveRecord } from '../../data';
import type { FaceEyes, FaceShape, FaceState } from '../../face';
import { PixelContext } from '../../look';
import type { Sprite } from '../../pixel-face';
const PixelFace = lazy(() => import('../../pixel-face'));
const Face = lazy(() => import('../../face'));
export interface AgentDisplay extends LiveRecord {
  agent: string; sprite?: Sprite; mark: { bg: string; fg: string }; face: { shape: FaceShape; eyes: FaceEyes };
}
export function useAgentDisplays() {
  const snapshot = useRecords<AgentDisplay>('household.agentDisplay');
  return snapshot.status === 'live' ? snapshot.records : [];
}
export function faceState(state?: string, needsYou = false): FaceState {
  return needsYou ? 'needs-input' : state === 'working' ? 'working' : state === 'waiting' ? 'thinking' : state === 'offline' ? 'error' : 'idle';
}
/** Display state comes from the owning feed; unavailable metadata keeps a neutral initial. */
export default function AgentFace({ display, name, state, size, dark = false }: { display?: AgentDisplay; name: string; state: FaceState; size: number; dark?: boolean }) {
  const pixel = useContext(PixelContext);
  const fallback = <span className="desk-agent-initial" aria-hidden="true" style={{ width: size, height: size }}>{name.slice(0,1)}</span>;
  const drawn = display ? <Face {...display.mark} {...display.face} state={state} size={size} label={name} dark={dark} /> : fallback;
  return <span className="desk-agent-face" style={{ width: size, height: size }}><Suspense fallback={fallback}>{pixel && display?.sprite ? <PixelFace sprite={display.sprite} state={state} size={size} label={name} fallback={drawn} /> : drawn}</Suspense></span>;
}
