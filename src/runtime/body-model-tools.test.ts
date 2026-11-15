import {expect,it,vi} from 'vitest';
import {z} from 'zod';
import {bodyModelTools,type BodyModelTool} from './body-model-tools.js';
const tool=():BodyModelTool=>({name:'command',description:'Use canonical commands',inputSchema:z.object({command:z.string()}).strict(),execute:vi.fn(async()=>({content:[{type:'text' as const,text:'done'}]}))});
it('snapshots the exact tool identity and executor used by registration and native policy',()=>{
 const original=tool(),execute=original.execute,input=[original],result=bodyModelTools(input);original.name='other';original.execute=vi.fn();input.length=0;
 expect(result).toHaveLength(1);expect(result[0].name).toBe('command');expect(result[0].execute).toBe(execute);expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result[0])).toBe(true);expect(result[0].inputSchema.safeParse({command:'list',agent:'foreign'}).success).toBe(false);
});
it.each(['request_secret','use_secret','command\n','--option','mcp__foreign__tool!','a'.repeat(65)])('refuses a reserved or invalid tool name %j',name=>{expect(()=>bodyModelTools([{...tool(),name}])).toThrow('Body model tools unavailable');});
it('rejects duplicate names, oversized catalogues and invalid descriptors before registration',()=>{
 expect(()=>bodyModelTools([tool(),tool()])).toThrow();expect(()=>bodyModelTools(Array.from({length:33},(_,i)=>({...tool(),name:'command'+i})))).toThrow();expect(()=>bodyModelTools([{...tool(),description:''}])).toThrow();expect(()=>bodyModelTools([{...tool(),inputSchema:z.string() as unknown as z.ZodObject}])).toThrow();
});

it('reads changing descriptor fields once before validating and snapshotting them',()=>{
 const execute=vi.fn(async()=>({content:[]})),name=vi.fn().mockReturnValueOnce('command').mockReturnValue('use_secret'),description=vi.fn(()=> 'Canonical command'),schema=vi.fn(()=>z.object({})),executor=vi.fn(()=>execute);
 const result=bodyModelTools([{get name(){return name();},get description(){return description();},get inputSchema(){return schema();},get execute(){return executor();}}]);
 expect(result[0].name).toBe('command');expect(result[0].execute).toBe(execute);for(const getter of [name,description,schema,executor])expect(getter).toHaveBeenCalledOnce();
});

it('refuses coercible or missing names and malformed descriptor fields',()=>{
 for(const name of [undefined,{toString:()=> 'use_secret'}])expect(()=>bodyModelTools([{...tool(),name:name as unknown as string}])).toThrow('Body model tools unavailable');
 expect(()=>bodyModelTools([{...tool(),description:undefined as unknown as string}])).toThrow('Body model tools unavailable');expect(()=>bodyModelTools([{...tool(),description:'x'.repeat(4097)}])).toThrow('Body model tools unavailable');expect(()=>bodyModelTools([{...tool(),execute:undefined as unknown as BodyModelTool['execute']}])).toThrow('Body model tools unavailable');
});
