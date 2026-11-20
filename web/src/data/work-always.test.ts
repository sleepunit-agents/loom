import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {alwaysInput,alwaysLabel,sendWorkAlways,type WorkAlwaysInput} from './work-always';
const row={id:'github:acme/app#1',state:'open' as const,agent:'art',project:'pond',headCommit:'a'.repeat(40)};
const card={id:'a-1',kind:'merge',state:'pending',agent:'art',project:'pond',target:`${row.id}@${row.headCommit}`,actingFor:'pat',operation:null};
const people=[{id:'pat',role:'owner'},{id:'sam',role:'member'}];
const input:WorkAlwaysInput={approval:card.id,change:row.id,head:row.headCommit,project:'pond',person:''};
it('derives only current pending exact-head/project/agent requests with concrete member roles and names personal grants',()=>{
 expect(alwaysInput(card,[row],people)).toEqual(input);expect(alwaysLabel(input)).toBe('Always for pond');
 expect(alwaysInput({...card,actingFor:'sam'},[row],people)).toEqual({...input,person:'sam'});expect(alwaysLabel({...input,person:'sam'})).toBe('Always for pond, Sam’s work only');
 for(const changed of [{...card,kind:'setting'},{...card,state:'allowed'},{...card,operation:'prepared'},{...card,operation:undefined},{...card,project:'other'},{...card,agent:'other'},...['unknown','?','missing','owner',''].map(actingFor=>({...card,actingFor}))])expect(alwaysInput(changed,[row],people)).toBeUndefined();
 for(const changed of [{...row,state:'closed' as const},{...row,headCommit:'b'.repeat(40)},{...row,project:'other'},{...row,agent:null}])expect(alwaysInput(card,[changed],people)).toBeUndefined();
 expect(alwaysInput(card,[],people)).toBeUndefined();expect(alwaysInput(card,[row],[])).toBeUndefined();expect(alwaysInput(card,[row],[{id:'pat',role:'unknown'}])).toBeUndefined();
});
it('keeps the actor-free immutable ID across a lost response and a fresh module without secure-context crypto',async()=>{
 const cryptoSource=crypto;vi.stubGlobal('crypto',{getRandomValues:cryptoSource.getRandomValues.bind(cryptoSource)});
 const request=vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('lost')).mockImplementation(async()=>Response.json({ok:true,value:{id:card.id}}));
 try{
  await expect(sendWorkAlways({...input,actor:'other'} as WorkAlwaysInput,request)).rejects.toThrow('Could not confirm');vi.resetModules();await (await import('./work-always')).sendWorkAlways(input,request);
  const bodies=request.mock.calls.map(([,init])=>JSON.parse(String(init!.body)));expect(bodies[1]).toEqual(bodies[0]);expect(bodies[0]).toEqual({input,id:'work-always-'+createHash('sha256').update(JSON.stringify(['approvals.always',input])).digest('hex')});
  for(const [url,init] of request.mock.calls){expect(url).toBe('/api/approvals/always');expect(init).toMatchObject({method:'POST',credentials:'same-origin'});}
 }finally{vi.unstubAllGlobals();}
});
it('binds every intent field and rejects failed, malformed or other-card acknowledgments without retries',async()=>{
 const request=vi.fn<typeof fetch>(async()=>Response.json({ok:true,value:{id:card.id}}));
 for(const change of [input,{...input,approval:'a-2'},{...input,change:'github:acme/app#2'},{...input,head:'b'.repeat(40)},{...input,project:'other'},{...input,person:'sam'}]){request.mockImplementationOnce(async()=>Response.json({ok:true,value:{id:change.approval}}));await sendWorkAlways(change,request);}
 expect(new Set(request.mock.calls.map(([,init])=>JSON.parse(String(init!.body)).id)).size).toBe(6);
 const bad=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ok:true,value:{id:card.id}},{status:403})).mockResolvedValueOnce(Response.json({ok:false})).mockResolvedValueOnce(Response.json({ok:true,value:{id:'other'}})).mockResolvedValueOnce(new Response('invalid'));
 for(let n=0;n<4;n++)await expect(sendWorkAlways(input,bad)).rejects.toThrow('Could not confirm');expect(bad).toHaveBeenCalledTimes(4);
});
