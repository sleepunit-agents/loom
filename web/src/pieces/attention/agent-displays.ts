import { useMemo } from 'react';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';
import type { FaceShape, FaceEyes } from '../../face-model';
import type { LiveRecord } from '../../data/snapshot';
import type { Sprite } from '../../pixel-face';
/** An agent's portrait as data: its sprite when it has one, its mark's colours and its face. */
export interface AgentDisplay extends LiveRecord {
  agent: string; sprite?: Sprite; mark: { bg: string; fg: string }; face: { shape: FaceShape; eyes: FaceEyes };
}
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
