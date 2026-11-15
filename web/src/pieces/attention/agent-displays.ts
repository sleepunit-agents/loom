import { useMemo } from 'react';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';
import type { FaceShape, FaceEyes } from '../../face';
import type { AgentDisplay } from './agent-face';
export const deskAgentDisplaysQuery = `query DeskAgentDisplays { agents { id markBg markFg faceShape faceEyes } }`;
export interface DeskAgentDisplaysData { agents:{id:string;markBg:string;markFg:string;faceShape:FaceShape;faceEyes:FaceEyes}[] }
/** Shared drawn metadata. Optional pixel assets need the root's actual asset
 * contract; the desk does not synthesize it from legacy settings. */
export function deskAgentDisplays(query: DataQuerySnapshot<DeskAgentDisplaysData>): AgentDisplay[] {
  if(query.status!=='live'||!query.data)return [];
  return query.data.agents.map(row=>({id:row.id,agent:row.id,mark:{bg:row.markBg,fg:row.markFg},face:{shape:row.faceShape,eyes:row.faceEyes}}));
}
export function useDeskAgentDisplays() {
  const query=useDataQuery<DeskAgentDisplaysData>(deskAgentDisplaysQuery);
  return useMemo(()=>deskAgentDisplays(query),[query]);
}
