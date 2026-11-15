import { expect, it, vi } from 'vitest';
import { settingsCommand, submitSecret } from './commands';
it('clears the write-only field before sending and returns only a fixed acknowledgement', async () => {
 const field={value:'synthetic-private-value'};let finish!:(response:Response)=>void;
 const request=vi.fn((_url:unknown,init?:RequestInit)=>{
  expect(field.value).toBe('');
  const body=JSON.parse(String(init?.body));
  expect(body.input).toMatchObject({name:'TOKEN',mode:'replace',description:'Description',value:'synthetic-private-value'});
  expect(body.input).not.toHaveProperty('member');expect(body.id).not.toBe(body.input.id);
  expect(init?.credentials).toBe('same-origin');return new Promise<Response>(resolve=>{finish=resolve;});
 });
 const pending=submitSecret({field,name:'TOKEN',description:'Description',mode:'replace'},request as typeof fetch);
 expect(field.value).toBe('');expect(request).toHaveBeenCalledOnce();
 finish(Response.json({ok:true,value:{saved:true}}));expect(await pending).toBe(true);expect(field.value).toBe('');
});
it('does not replay an ambiguous write or return upstream error bodies', async () => {
 const field={value:'synthetic-private-value'},request=vi.fn(async()=>{throw Error(field.value);});
 expect(await submitSecret({field,name:'TOKEN',description:'',mode:'add'},request as typeof fetch)).toBe(false);
 expect(field.value).toBe('');expect(request).toHaveBeenCalledOnce();
 const rejected=vi.fn(async()=>Response.json({ok:false,message:'synthetic-private-value'},{status:503}));
 expect(await settingsCommand('remove',{id:'fake',name:'TOKEN'},rejected as typeof fetch)).toBe(false);
 const malformed=vi.fn(async()=>Response.json({ok:true,value:{saved:'synthetic-private-value'}}));
 expect(await settingsCommand('command',{action:'default',answer:'ask'},malformed as typeof fetch)).toBe(false);
});
