import {expect,it} from 'vitest';
import {mayInspectMachine,type Woke} from './policy.js';
const sharing={members:{sam:{owner:false,agents:['fern']}},agents:['fern'],projects:{}};
it.each([
 ['own',false,true,null,true],
 ['owners',false,true,null,true],
 ['others',false,true,['fern'],false],
 ['own',true,true,null,false],
 ['owners',true,false,['fern'],true],
 ['own',false,false,null,false],
] satisfies [Woke,boolean,boolean,string[]|null,boolean][])('checks word %s, reportOnly %s, hosting %s and explicit grant %j', (word,reportOnly,hostsAny,readers,allowed)=>{
 expect(mayInspectMachine({owner:'sam',hostsAny,reportOnly,readers},undefined,'fern',sharing,word)).toBe(allowed);
});
it('removing either principal invalidates an old grant',()=>{
 const machine={owner:'sam',hostsAny:false,reportOnly:true,readers:['fern']};
 expect(mayInspectMachine(machine,undefined,'fern',{...sharing,members:{}},'own')).toBe(false);
 expect(mayInspectMachine(machine,undefined,'fern',{...sharing,agents:[]},'owners')).toBe(false);
});
