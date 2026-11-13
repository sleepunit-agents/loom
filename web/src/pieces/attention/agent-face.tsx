import './agent-face.css';
import { lazy, Suspense } from 'react';
import { useRecords, type LiveRecord } from '../../data';
import type { FaceEyes, FaceShape, FaceState } from '../../face';
const Face = lazy(() => import('../../face'));
export interface AgentDisplay extends LiveRecord {
  agent: string; mark: { bg: string; fg: string }; face: { shape: FaceShape; eyes: FaceEyes };
}
export function useAgentDisplays() {
  const snapshot = useRecords<AgentDisplay>('household.agentDisplay');
  return snapshot.status === 'live' ? snapshot.records : [];
}
export function faceState(state?: string, needsYou = false): FaceState {
  return needsYou ? 'needs-input' : state === 'working' ? 'working' : state === 'waiting' ? 'thinking' : state === 'offline' ? 'error' : 'idle';
}
/** Display state comes from the owning feed; unavailable metadata keeps a neutral initial. */
export default function AgentFace({ display, name, state, size }: { display?: AgentDisplay; name: string; state: FaceState; size: number }) {
  const fallback = <span className="desk-agent-initial" aria-hidden="true" style={{ width: size, height: size }}>{name.slice(0,1)}</span>;
  return <span className="desk-agent-face" style={{ width: size, height: size }}><Suspense fallback={fallback}>{display ?
    <Face {...display.mark} {...display.face} state={state} size={size} label={name} /> : fallback}</Suspense></span>;
}
