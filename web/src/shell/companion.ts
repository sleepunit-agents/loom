import { useCallback, useMemo, useState } from 'react';
import type { RailLink, OnAir } from '../desk-rail';
/** Only the visible Comms pane reports selection; late cleanup cannot clear a newer source. */
export function useCompanion(shown:boolean):RailLink {
  const [air,setAir]=useState<{agent:string;from:object}|null>(null);
  const onAir=useCallback((who:OnAir,from:object)=>setAir(was=>who
    ?was?.agent===who.agent&&was.from===from?was:{agent:who.agent,from}
    :was?.from===from?null:was),[]);
  return useMemo(()=>({onAir,shown,screen:null,selected:air?.agent}),[onAir,shown,air?.agent]);
}
