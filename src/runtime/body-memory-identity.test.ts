import {expect,it} from 'vitest';
import {bodyMemoryIdentity} from './body-memory-identity.js';
const identity={agent:'art',readAt:'2026-11-14T18:00:00.000Z',creed:null,preferences:null,selfModel:null,topOfMind:null,recent:null};
it('omits absent Identity and rejects a producer returning another agent',async()=>{
 expect(await bodyMemoryIdentity({query:async()=>({data:{memoryIdentity:null}})},'art')).toBeNull();
 expect(await bodyMemoryIdentity({query:async()=>({data:{memoryIdentity:identity}})},'art')).toBeNull();
 await expect(bodyMemoryIdentity({query:async()=>({data:{memoryIdentity:{...identity,agent:'mark',creed:'PRIVATE_OTHER_IDENTITY'}}})},'art')).rejects.toThrow('Identity unavailable');
});
it('sanitizes producer errors and unexpected private result keys before they reach a caller',async()=>{
 for(const reply of [{errors:[{message:'PRIVATE_GRAPHQL_DIAGNOSTIC'}]},{data:{memoryIdentity:{...identity,PRIVATE_RESULT_KEY:'words'}}}]){
  await expect(bodyMemoryIdentity({query:async()=>reply},'art')).rejects.toThrow(/^Identity unavailable$/);
 }
});
