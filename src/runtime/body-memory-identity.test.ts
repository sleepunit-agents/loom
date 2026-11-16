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
it('asks for the page of the venue the body was started on and puts it last, nearest the mail',async()=>{
 const asked:unknown[]=[];
 const client={query:async(input:unknown)=>{asked.push(input);return {data:{memoryIdentity:{...identity,creed:'Creed',role:'Every lane ends this way.'}}};}};
 expect(await bodyMemoryIdentity(client,'art','wake')).toBe('# Identity\n\nCreed\n\n# Mode: wake\n\nEvery lane ends this way.');
 expect(asked).toMatchObject([{variables:{agent:'art',venue:'wake'}}]);
 expect(JSON.stringify(asked[0])).toContain('page(kind:\\"role\\",name:$venue)');
 // No page for this venue, no venue, or a venue that is not a page name: the identity alone, and no page is asked for by a bad name.
 expect(await bodyMemoryIdentity({query:async()=>({data:{memoryIdentity:{...identity,creed:'Creed',role:null}}})},'art','wake')).toBe('# Identity\n\nCreed');
 asked.length=0;await bodyMemoryIdentity(client,'art','../x');await bodyMemoryIdentity(client,'art',null);
 expect(asked).toMatchObject([{variables:{agent:'art'}},{variables:{agent:'art'}}]);expect(JSON.stringify(asked)).not.toContain('venue');
});
