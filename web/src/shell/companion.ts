import { useCallback, useMemo, useState } from 'react';
import type { RailLink, OnAir } from '../desk-rail';
/** Only the visible Comms pane reports selection; late cleanup cannot clear a newer source. */
export function useCompanion(shown:boolean):RailLink {
  const [air,setAir]=useState<{agent:string;from:object}|null>(null);
  const [slot,setSlot]=useState<{agent:string;el:HTMLElement;from:object}|null>(null);
  const setScreen=useCallback((screen:{agent:string;el:HTMLElement}|null,from:object)=>setSlot(was=>screen
    ?was?.el===screen.el&&was.agent===screen.agent&&was.from===from?was:{...screen,from}
    :was?.from===from?null:was),[]);
  const onAir=useCallback((who:OnAir,from:object)=>setAir(was=>who
    ?was?.agent===who.agent&&was.from===from?was:{agent:who.agent,from}
    :was?.from===from?null:was),[]);
  return useMemo(()=>({onAir,shown,screen:shown&&slot?.agent===air?.agent?slot:null,setScreen,selected:air?.agent}),[onAir,shown,air?.agent,slot,setScreen]);
}
