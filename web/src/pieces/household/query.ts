export interface SetupMember {id:string;role:'owner'|'member';fullOwner:boolean;memberAgentsByMember:{agent:string}[]}
export interface SetupAgent {id:string;about:string;markBg:string;markFg:string;faceShape:'pebble'|'trefoil'|'clover'|'drop';faceEyes:'dot'|'oval'}
export interface SetupData {members:SetupMember[];agents:SetupAgent[]}
export const setupQuery=`query HouseholdSetup {
 members { id role fullOwner memberAgentsByMember { agent } }
 agents { id about markBg markFg faceShape faceEyes }
}`;
