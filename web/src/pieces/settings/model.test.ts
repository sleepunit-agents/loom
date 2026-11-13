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
