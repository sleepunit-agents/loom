import {expect,it} from 'vitest';
import {bodyChannelBrief,bodyMemoryIdentity} from './body-memory-identity.js';
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
it('gives a bridge body the brief its channel names, and goes on without one that is not there',async()=>{
 const calls:string[]=[];
 const client=(brief:string|null|'refused'|'down',page:string|null)=>({
  command:async(operation:string)=>{calls.push(operation);if(brief==='down')throw Error('PRIVATE_TRANSPORT');if(operation==='bridges.briefMissing')return{ok:true as const,value:{saved:true}};
   return brief==='refused'?{ok:false as const,code:'denied' as const,message:'no'}:{ok:true as const,value:{brief}};},
  query:async(input:{variables?:Record<string,unknown>|null})=>{calls.push('page:'+String(input.variables?.name));return{data:{memoryIdentity:{agent:'art',role:page}}};},
 });
 // Named and found: the page's words, labelled as the channel's brief.
 expect(await bodyChannelBrief(client('onterris','Speak carefully here.') as never,'art')).toBe('# Brief for this channel: onterris\n\nSpeak carefully here.');
 expect(calls).toEqual(['bridges.brief','page:onterris']);calls.length=0;
 // Named and not found: no brief, and loom is told so that the owners are.
 expect(await bodyChannelBrief(client('onterris',null) as never,'art')).toBeNull();
 expect(calls).toEqual(['bridges.brief','page:onterris','bridges.briefMissing']);calls.length=0;
 // None named, loom refusing, loom unreachable: no brief, no page read, no failure.
 for(const brief of [null,'refused','down'] as const){expect(await bodyChannelBrief(client(brief,'unused') as never,'art')).toBeNull();}
 expect(calls).toEqual(['bridges.brief','bridges.brief','bridges.brief']);calls.length=0;
 // A name that is no page's name is never asked for.
 expect(await bodyChannelBrief(client('../creed','unused') as never,'art')).toBeNull();
 expect(calls).toEqual(['bridges.brief','bridges.briefMissing']);
});
