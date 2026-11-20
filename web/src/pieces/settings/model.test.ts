import { expect,it } from 'vitest';
import { activeGrant,revokeInput,warnings,type Grant } from './model';
const name={id:'API',description:'',by:'migration',changedAt:0};
const now=2*365*86400_000;
it('never invents an old-change warning from name metadata or counts unconfirmed delivery',()=>{
 expect(warnings(name,[],[],now)).toEqual(['No recorded use']);
 expect(warnings(name,[{id:'u',name:'API',at:now,state:'started',by:{kind:'agent',id:'art'}}],[],now)).toEqual(['No recorded use']);
 expect(warnings(name,[{id:'u',name:'API',at:now,state:'released',by:{kind:'agent',id:'art'}}],[{id:'c',name:'API',action:'add',at:0,by:'jonathan'}],now)).toEqual(['Not changed in a year']);
 expect(warnings(name,[],[{id:'c',name:'OTHER',action:'add',at:0,by:'jonathan'}],now)).toEqual(['No recorded use']);
});
it('revokes exactly the displayed scoped grant and labels moved and expired grants honestly',()=>{
 const g:Grant={id:'one',agent:'art',kind:'secret',target:'API',by:'jonathan',scope:{house:'h-1',service:'discord'},expiresAt:now};
 expect(revokeInput(g)).toEqual({agent:'art',kind:'secret',target:'API',scope:{house:'h-1',service:'discord'}});
 expect(activeGrant(g,now-1)).toBe(true);expect(activeGrant(g,now)).toBe(false);
 expect(activeGrant({...g,movedTo:'q-1'},now-1)).toBe(false);
 expect(revokeInput({...g,scope:{house:'h-1'}})).toEqual({agent:'art',kind:'secret',target:'API',scope:{house:'h-1'}});
});
it('includes every missing policy name and lets Never override recorded grants',async()=>{
 const {missingNames,grantLabel}=await import('./model');
 const policy={id:'policy',default:'ask' as const,secrets:{API:{grant:'never' as const,houses:['art']},ASK:{grant:'ask' as const},DURATION:{minutes:30}}};
 expect(missingNames(policy,[])).toEqual(['API','ASK','DURATION']);
 expect(missingNames(policy,[name])).toEqual(['ASK','DURATION']);
 const g:Grant={id:'g',agent:'art',kind:'secret',target:'API',by:'jonathan'};
 expect(grantLabel(g,policy,now)).toBe('Blocked by Never policy');
 expect(grantLabel({...g,target:'OTHER'},{id:'p',default:'never',secrets:{}},now)).toBe('Blocked by Never policy');
});

it.each(['piece','runner','tailnet'] as const)('never applies secret policy to a %s grant',async kind=>{
 const {grantLabel}=await import('./model');
 expect(grantLabel({id:'g',agent:'art',kind,target:'API',by:'jonathan'},{id:'policy',default:'never',secrets:{API:{grant:'never'}}},now)).toBe('Granted');
});

it('shows inherited automatic requests, explicit overrides and exact service absence',async()=>{
 const {automaticRequest,grantScopeLabel}=await import('./model');
 const policy={id:'p',default:'auto' as const,secrets:{ASK:{grant:'ask' as const},SOME:{grant:'auto' as const,agents:['art']}}};
 expect(automaticRequest(policy,'API','art')).toBe(true);expect(automaticRequest(policy,'API','mark')).toBe(true);
 expect(automaticRequest(policy,'ASK','art')).toBe(false);expect(automaticRequest(policy,'SOME','art')).toBe(true);expect(automaticRequest(policy,'SOME','mark')).toBe(false);
 const g:Grant={id:'g',agent:'art',kind:'secret',target:'API',by:'jonathan'};
 expect(grantScopeLabel({...g,scope:{house:'h-1',service:'slack'}})).toBe('h-1 · slack');
 expect(grantScopeLabel({...g,scope:{house:'h-1'}})).toBe('h-1 · No service');
});
