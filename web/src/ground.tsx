import { useId } from 'react';
import { WovenCloth } from './woven-cloth';
import './ground.css';

/** Two planes of the login cloth recede towards a shared horizon. */
export function Depth(){
  return <div aria-hidden="true" className="loom-ground loom-depth-cloth pointer-events-none fixed inset-0 -z-10">
    <div className="loom-depth-far"><WovenCloth /></div>
    <div className="loom-depth-near"><WovenCloth /></div>
  </div>;
}

/** Loops of thread follow the terrain. Short lengths of coloured yarn travel along the same paths. */
export function Contours(){
  const id=useId();
  const loop="M-190 310C-190 136 -32 82 132 99S374 252 502 246S660 327 619 432S408 496 307 559S96 649 -60 548S-197 444 -190 310Z";
  return <div aria-hidden="true" className="loom-ground loom-contour-cloth pointer-events-none fixed inset-0 -z-10">
    <svg viewBox="0 0 1200 720" preserveAspectRatio="xMidYMid slice" focusable="false">
      <defs><path id={id} d={loop} pathLength="1000" /></defs>
      {['translate(-32 -78)','translate(1232 780) rotate(180)'].map(transform=>
        <g key={transform} transform={transform}>
          {Array.from({length:19},(_,i)=><g key={i} transform={`translate(190 350) scale(${.32+i*.065}) translate(-190 -350)`}>
            <use href={'#'+id} className="loom-contour-thread" />
            {i%4===1&&<use href={'#'+id} className="loom-contour-stitch" style={{stroke:['var(--v-pink)','var(--v-blue)','var(--v-olive)','var(--v-yellow)'][((i-1)/4)%4],animationDelay:`-${i*2}s`}} strokeDashoffset={i*47}/>}
          </g>)}
        </g>)}
    </svg>
  </div>;
}
