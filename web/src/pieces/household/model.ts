/** What Household setup reads and says, with no component: its selection, the shapes loom answers, who owns an
 * agent, and the words of a change that saved or did not. The desktop's app (./index.tsx, ./programs.tsx) and the
 * boards page's `household` brick share them. */
export interface SetupMember{id:string;role:'owner'|'member';fullOwner:boolean;agents:string[]}
/** `removedAt`: set on an agent taken out of use. It keeps its row and its owner link, so it can be restored. */
export interface SetupAgent{id:string;spriteVersion:string|null;about:string;markBg:string;markFg:string;faceShape:string;faceEyes:string;github:string[];removedAt?:string|null}
export interface SetupToken{fingerprint:string;label:string;kind:string;expired:boolean;identity:string;createdAt:string;expiresAt:string|null;revokedAt:string|null;lastUsedAt:string|null}
export interface SetupSession{ref:string;device:string;member:string|null;tokenLabel:string|null;isAgent:boolean;ended:boolean;issuedAt:string;seenAt:string}
export interface HouseholdSetup{defaultAgent:string|null;members:SetupMember[];agents:SetupAgent[];tokens:SetupToken[];sessions:SetupSession[]}
export function agentOwnership(members: SetupMember[], agent: string) {
 const owners = members.filter(member => member.agents.includes(agent)).map(member => member.id);
 return owners.length ? 'Owned by ' + owners.join(', ') : 'No assigned owner';
}
export const householdSetupQuery=`{ householdSetup { defaultAgent members { id role fullOwner agents } agents { id about markBg markFg faceShape faceEyes github removedAt spriteVersion } tokens { fingerprint label kind expired identity createdAt expiresAt revokedAt lastUsedAt } sessions { ref device member tokenLabel isAgent ended issuedAt seenAt } } boxes { id name revokedAt } boxAlertSettings(limit:1) { diskPercent diskUrgentPercent diskFreeMib memoryFreeMib } }`;
export const tokenState=(token:SetupToken)=>token.revokedAt?'Revoked':token.expired?'Expired':'Active';
export const sessionLine=(session:SetupSession)=>`${session.member} · ${session.tokenLabel} · ${session.isAgent?'Agent browser':'Browser'} · ${session.ended?'Ended':'Active'}`;
/** What a change says when it ends. Revoking a token or a browser can end the member's own sign-in. */
export const setupWords={saved:'Saved',notRevoked:'Could not confirm revocation. Check your sign-in and connection.',notSaved:'Could not save. Check the values and connection.'};

/** Outside programs: the tokens that act for a member and what each is allowed. */
export interface ProgramSetupData{owner:string;catalogue:{records:string[];operations:string[]};tokens:Array<{fingerprint:string;label:string;member:string|null;ended:boolean;records:string[];operations:string[]}>}
export const programQuery='{ programSetup { owner catalogue { records operations } tokens { fingerprint label member ended records operations } } }';
export const programNote='A program uses its member\'s permissions, limited to the record types and operations you allow.';
export const programLine=(token:ProgramSetupData['tokens'][number])=>`Acts as ${token.member??'an unavailable member'} · ${token.ended?'Ended':'Active'}`;
