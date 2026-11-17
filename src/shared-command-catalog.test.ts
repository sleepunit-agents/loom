import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import {bodyFixture,bodyCredentials as raw} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
async function fixture(){
 const f=await bodyFixture(clean);const post=(input:unknown={},bearer=raw.body)=>f.root.http.request('/api/runtime/commandCatalog',{method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify({input})});return{...f,post};
}
it('lists the actual HTTP operation names and write flags without invoking them, reading records or creating receipts',async()=>{
 const f=await fixture();f.db.update(s.jobs).set({brief:'PRIVATE_CATALOGUE_CANARY',title:'PRIVATE_TITLE'}).run();f.db.insert(s.secrets).values({name:'PRIVATE_SECRET_NAME',description:'PRIVATE_DESCRIPTION',changedAt:new Date(f.clock.now()).toISOString(),changedBy:'alice'}).run();
 const before={jobs:f.db.select().from(s.jobs).all(),tasks:f.db.select().from(s.tasks).all(),receipts:f.db.select().from(s.operationResults).all()};
 const response=await f.post(),body=await response.json();expect(response.status).toBe(200);
 expect(body.ok).toBe(true);const names=body.value.commands.map((command:{name:string})=>command.name);expect(names).toEqual([...new Set<string>(names)].sort());expect(body.value.commands.every((command:Record<string,unknown>)=>Object.keys(command).sort().join(',')==='name,write')).toBe(true);
 const writes=new Map<string,boolean>(body.value.commands.map((command:{name:string;write:boolean})=>[command.name,command.write]));const registry=f.root.operations.offered('http');expect(new Set(names)).toEqual(new Set(registry.map(command=>command.name)));for(const command of registry)expect(writes.get(command.name)).toBe(command.write);
 expect(body.value.commands).toEqual(expect.arrayContaining([{name:'runtime.started',write:true},{name:'conversation.status',write:true}]));
 for(const canary of ['PRIVATE_CATALOGUE_CANARY','PRIVATE_TITLE','PRIVATE_SECRET_NAME','PRIVATE_DESCRIPTION',raw.body])expect(JSON.stringify(body)).not.toContain(canary);
 expect({jobs:f.db.select().from(s.jobs).all(),tasks:f.db.select().from(s.tasks).all(),receipts:f.db.select().from(s.operationResults).all()}).toEqual(before);
});
it('discovers newly registered HTTP commands with their structural input hints, while hiding direct-only commands',async()=>{
 const f=await fixture(),called=vi.fn(),may=vi.fn(()=>false);f.root.operations.register({name:'fixture.transformed',doors:['http'],input:z.object({value:z.string().transform(value=>Number(value))}).strict(),output:z.boolean(),may,run:called});
 const longName='fixture.'+'x'.repeat(300);f.root.operations.register({name:longName,doors:['http'],input:z.object({}),output:z.boolean(),may:()=>false,run:called});expect((await f.post({name:longName})).status).toBe(200);
 f.root.operations.register({name:'fixture.internal',doors:['direct'],input:z.object({}),output:z.boolean(),may:()=>false,run:called});
 const listed=await(await f.post()).json();expect(listed.value.commands).toContainEqual({name:'fixture.transformed',write:false});expect(listed.value.commands.some((command:{name:string})=>command.name==='fixture.internal')).toBe(false);expect((await f.post({name:'fixture.internal'})).status).toBe(404);
 const started=await(await f.post({name:'runtime.started'})).json();expect(started.value.commands[0].inputSchema.properties.job).toMatchObject({type:'string',minLength:1});expect(started.value.commands[0].inputSchema.required).toEqual(['job','build']);
 for(const {name} of listed.value.commands){const response=await f.post({name});expect(response.status,name).toBe(200);const commands=(await response.json()).value.commands;expect(commands).toHaveLength(1);expect(commands[0].name).toBe(name);}
 const transformed=await(await f.post({name:'fixture.transformed'})).json();expect(transformed.value.commands[0].inputSchema.properties.value.type).toBe('string');expect(called).not.toHaveBeenCalled();expect(may).not.toHaveBeenCalled();
 const denied=await f.root.http.request('/api/fixture/transformed',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({input:{value:'2'}})});expect(denied.status).toBe(403);expect(called).not.toHaveBeenCalled();expect(may).toHaveBeenCalled();
});
it('lists commands for a current member, and refuses a runner',async()=>{
 const f=await fixture();expect((await f.post({},raw.member)).status).toBe(200);expect((await f.post({},raw.runner)).status).toBe(403);
});
it('does not turn a plain agent label or a service label into a body proof',async()=>{
 const f=await fixture(),service={kind:'service' as const,id:'runtime'};
 for(const viewer of[{kind:'agent' as const,id:'art'},service])expect(f.root.operations.call('http',viewer,'runtime.commandCatalog',{})).toMatchObject({ok:false,code:'denied'});
});
it.each(['ended','revoked-machine','ownership','current-job','current-agent']as const)('denies a catalogue request after %s withdrawal',async change=>{
 const f=await fixture();expect((await f.post()).status).toBe(200);f.root.writes.run(()=>{
  if(change==='ended')f.db.update(s.jobs).set({state:'done'}).run();
  if(change==='revoked-machine')f.db.update(s.boxes).set({revokedAt:new Date(f.clock.now()).toISOString()}).run();
  if(change==='ownership')f.db.delete(s.memberAgents).run();
  if(change==='current-job')f.db.update(s.jobs).set({conversation:null}).run();
  if(change==='current-agent')f.db.update(s.conversations).set({agent:'mark'}).run();
 });expect([401,403]).toContain((await f.post()).status);
});
it('allows a still-bound running body and never grants it worker control',async()=>{
 const f=await fixture();expect((await f.post({name:'runtime.started'})).status).toBe(200);
 const denied=await f.root.http.request('/api/runtime/started',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({id:'cannot-control',input:{job:'job',build:'fake'}})});expect(denied.status).toBe(403);expect(f.db.select().from(s.jobs).get()?.state).toBe('running');
});
it('rejects overposted identity and unknown names without echoing caller strings',async()=>{
 const f=await fixture();expect((await f.post({agent:'art'})).status).toBe(400);const missing=await f.post({name:'PRIVATE_UNKNOWN_NAME'});expect(missing.status).toBe(404);expect(await missing.text()).not.toContain('PRIVATE_UNKNOWN_NAME');
});

it('keeps actual command transforms and refinements authoritative after structural discovery',async()=>{
 const f=await fixture(),seen=vi.fn();f.root.operations.register({name:'fixture.validated',doors:['http'],input:z.object({value:z.string().regex(/^\d+$/).transform(value=>Number(value)).refine(value=>value>5)}).strict(),output:z.object({seen:z.number()}).strict(),may:()=>true,run(_ctx,input){seen(input.value);return{seen:input.value};}});
 const metadata=await(await f.post({name:'fixture.validated'})).json();expect(metadata.value.commands[0].inputSchema.properties.value.type).toBe('string');expect(seen).not.toHaveBeenCalled();
 const invoke=(value:string)=>f.root.http.request('/api/fixture/validated',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({input:{value}})});
 expect(await(await invoke('7')).json()).toEqual({ok:true,value:{seen:7}});expect(seen).toHaveBeenCalledExactlyOnceWith(7);expect((await invoke('4')).status).toBe(400);expect(seen).toHaveBeenCalledTimes(1);
});
