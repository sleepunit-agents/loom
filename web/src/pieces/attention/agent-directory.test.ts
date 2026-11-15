import { expect, it } from 'vitest';
import { deskAgentDirectory } from './agent-directory';
const row={id:'commons:art',slug:'art',agent:null,name:'Art E Fish',kind:'agent'};
const query={status:'live' as const,data:{memoryPeopleAccess:{directory:true},memoryPeople:[row,{...row,id:'other:art',agent:'other',name:'Relationship name'},{...row,id:'commons:human',slug:'human',kind:'person'},{...row,id:'commons:wrong'},{...row,name:'  '}]}};
it('accepts only current shared-directory agent identities without relationship names',()=>{
 expect(deskAgentDirectory(query)).toEqual({status:'live',records:[{id:row.id,slug:'art',name:'Art E Fish',kind:'agent'}]});
});
it.each(['loading','offline','denied'] as const)('clears retained names on %s',status=>{
 expect(deskAgentDirectory({...query,status})).toEqual({status,records:[]});
});
it('distinguishes unavailable directory access, missing data and a live empty directory',()=>{
 expect(deskAgentDirectory({status:'live'})).toEqual({status:'loading',records:[]});
 expect(deskAgentDirectory({...query,data:{...query.data,memoryPeopleAccess:null}})).toEqual({status:'denied',records:[]});
 expect(deskAgentDirectory({...query,data:{...query.data,memoryPeopleAccess:{directory:false}}})).toEqual({status:'denied',records:[]});
 expect(deskAgentDirectory({...query,data:{...query.data,memoryPeople:null}})).toEqual({status:'offline',records:[]});
 expect(deskAgentDirectory({...query,data:{...query.data,memoryPeople:[]}})).toEqual({status:'live',records:[]});
});
