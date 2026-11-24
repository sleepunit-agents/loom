import './agent-face.css';
import { lazy, Suspense, useContext } from 'react';
import type { LiveRecord } from '../../data';
export { useDeskAgentDisplays as useAgentDisplays } from './agent-displays';
import type { FaceEyes, FaceShape, FaceState } from '../../face';
import { PixelContext } from '../../look';
import type { Sprite } from '../../pixel-face';
const PixelFace = lazy(() => import('../../pixel-face'));
const Face = lazy(() => import('../../face'));
export interface AgentDisplay extends LiveRecord {
  agent: string; sprite?: Sprite; mark: { bg: string; fg: string }; face: { shape: FaceShape; eyes: FaceEyes };
}
export function faceState(state?: string, needsYou = false): FaceState {
  return needsYou ? 'needs-input' : state === 'working' ? 'working' : state === 'waiting' ? 'thinking' : state === 'offline' ? 'error' : 'idle';
}
/** Display state comes from the owning feed; unavailable metadata reserves the portrait space. */
export default function AgentFace({ display, name, state, size, dark = false, talk, scale, onShown, onFrom, onReady }: { display?: AgentDisplay; name: string; state: FaceState; size: number; dark?: boolean; talk?: {n:number;key:number}; scale?:number; onShown?:(state:FaceState)=>void; onFrom?:(from:string)=>void; onReady?:(ready:boolean)=>void }) {
  const pixel = useContext(PixelContext);
  const space = <span role="img" aria-label={name} style={{ display: 'inline-block', width: size, height: size }} />;
  const drawn = display ? <Face {...display.mark} {...display.face} state={state} size={size} label={name} dark={dark} /> : space;
  return <span className="desk-agent-face" style={{ width: size, height: size }}>
    <Suspense fallback={space}>
      {pixel && display?.sprite
        ? <PixelFace sprite={display.sprite} state={state} size={size} label={name} fallback={space} talk={talk} scale={scale} onShown={onShown} onFrom={onFrom} onReady={onReady} />
        : drawn}
    </Suspense>
  </span>;
}
