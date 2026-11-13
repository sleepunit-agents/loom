import type { LiveRecord } from '../../data';
export interface SettingsAccess extends LiveRecord { agents: string[]; valuesAvailable: boolean; now: number }
export interface SecretName extends LiveRecord { description: string; changedAt: number; by: string }
export interface Grant extends LiveRecord { agent: string; kind: 'secret'|'piece'|'runner'|'tailnet'; target: string; by: string; expiresAt?: number; scope?: {house:string;service?:string}; movedTo?: string }
export interface Request extends LiveRecord { agent: string; kind: Grant['kind']; target: string; why: string; state: string; scope?: Grant['scope']; minutes?: number }
export interface Policy extends LiveRecord { default: 'ask'|'auto'|'never'; secrets: Record<string,{grant?:'ask'|'auto'|'never';agents?:string[];houses?:string[];minutes?:number}> }
export interface Use extends LiveRecord { name:string; at:number; state:string; by:{kind:string;id:string} }
export interface Change extends LiveRecord { name:string; at:number; action:string; by:string }
export function warnings(name: SecretName, uses: readonly Use[], changes: readonly Change[], now: number): string[] {
  const events=changes.filter(c=>c.name===name.id&&c.action!=='removed');
  const last=events.length?events.reduce((at,c)=>Math.max(at,c.at),-Infinity):undefined;
  return [...(!uses.some(u=>u.name===name.id&&u.state==='released')?['No recorded use']:[]),
    ...(last!==undefined&&now-last>=365*86400_000?['Not changed in a year']:[])];
}
export const revokeInput=(g:Grant)=>({agent:g.agent,kind:g.kind,target:g.target,...(g.scope?{scope:g.scope}:{})});
export const activeGrant=(g:Grant,now:number)=>!g.movedTo&&(g.expiresAt===undefined||g.expiresAt>now);

export const missingNames=(policy:Policy,names:readonly SecretName[])=>Object.keys(policy.secrets).filter(name=>!names.some(n=>n.id===name));
export function grantLabel(grant:Grant,policy:Policy,now:number):string {
  const rule=Object.hasOwn(policy.secrets,grant.target)?policy.secrets[grant.target]:undefined;
  if(grant.kind==='secret'&&(rule?.grant??policy.default)==='never')return 'Blocked by Never policy';
  return activeGrant(grant,now)?'Granted':grant.movedTo?'Moved to another house':'Expired';
}
