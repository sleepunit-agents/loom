import { useId } from 'react';

// The ground: one tile of plain weave, eight warp and eight weft threads, each broken where it passes under.
const TILE=192,GAP=5,AT=[12,36,60,76,108,132,156,172];
const WARP=['border','edge','pink','border','border','blue','edge','border'],WEFT=['border','olive','border','edge','border','yellow','border','edge'];
function threadPath(i:number,weft:boolean){
  const line=(a:number,b:number)=>weft?`M${a} ${AT[i]}H${b}`:`M${AT[i]} ${a}V${b}`;
  let d='',from=0;
  for(const [j,at] of AT.entries())if((i+j)%2===(weft?0:1)){d+=line(from,at-GAP);from=at+GAP;}
  return d+line(from,TILE);
}
const THREADS=[...WEFT.map((tint,i)=>({tint,d:threadPath(i,true)})),...WARP.map((tint,i)=>({tint,d:threadPath(i,false)}))];
export function WovenCloth(){
  const id=useId();
  return <div className="loom-gate__cloth"><svg width="100%" height="100%" focusable="false">
      <defs><pattern id={id} width={TILE} height={TILE} patternUnits="userSpaceOnUse">{THREADS.map(t=><path key={t.d} className="loom-gate__ply" data-tint={t.tint} d={t.d} />)}</pattern></defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg></div>;
}
