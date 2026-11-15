import { useMemo } from 'react';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';
import type { FaceShape, FaceEyes } from '../../face';
import type { AgentDisplay } from './agent-face';
export const deskAgentDisplaysQuery = `query DeskAgentDisplays { agents { id markBg markFg faceShape faceEyes spriteVersion } }`;
export interface DeskAgentDisplaysData { agents:{id:string;markBg:string;markFg:string;faceShape:FaceShape;faceEyes:FaceEyes;spriteVersion?:string|null}[] }
/** Metadata only; the visible pixel renderer selects its versioned sheets lazily. */
export function deskAgentDisplays(query: DataQuerySnapshot<DeskAgentDisplaysData>): AgentDisplay[] {
  if(query.status!=='live'||!query.data)return [];
  return query.data.agents.map(row=>({id:row.id,agent:row.id,mark:{bg:row.markBg,fg:row.markFg},face:{shape:row.faceShape,eyes:row.faceEyes},...(row.spriteVersion?{sprite:{agent:row.id,v:row.spriteVersion}}:{})}));
}
export function useDeskAgentDisplays() {
  const query=useDataQuery<DeskAgentDisplaysData>(deskAgentDisplaysQuery);
  return useMemo(()=>deskAgentDisplays(query),[query]);
}
