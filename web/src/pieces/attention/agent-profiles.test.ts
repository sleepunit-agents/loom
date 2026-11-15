import { expect, it } from 'vitest';
import { deskAgentProfiles } from './agent-profiles';
const query={status:'live' as const,data:{agents:[{id:'art',about:'Shared description',aboutAskedAt:'2026-11-14T00:00:00Z'},{id:'mark',about:'',aboutAskedAt:null}]}};
it('adapts shared description/request facts without deriving an edit capability',()=>{
 expect(deskAgentProfiles(query)).toEqual({status:'live',records:[{id:'art',agent:'art',description:'Shared description',requestedAt:'2026-11-14T00:00:00Z'},{id:'mark',agent:'mark'}]});
 expect(deskAgentProfiles(query).records[0]).not.toHaveProperty('canEdit');
});
it.each(['loading','offline','denied'] as const)('clears retained descriptions on %s',status=>{
 expect(deskAgentProfiles({...query,status})).toEqual({status,records:[]});
});
it('distinguishes missing query data from a live empty result',()=>{
 expect(deskAgentProfiles({status:'live'})).toEqual({status:'loading',records:[]});
 expect(deskAgentProfiles({status:'live',data:{agents:[]}})).toEqual({status:'live',records:[]});
});
