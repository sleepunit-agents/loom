import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { sendWorkAnswer, type WorkAnswer } from './work-answer';
const answer: WorkAnswer = {piece:'approvals',id:'a-1',answer:'allow'};
const success = vi.fn<typeof fetch>(async (_url,init) => Response.json({ok:true,value:{id:JSON.parse(String(init!.body)).input.id}}));
it('uses the actual same-origin envelope, omits actor metadata and reuses one immutable answer ID after an unknown response', async () => {
  const request = vi.fn<typeof fetch>(success).mockRejectedValueOnce(new Error('Response lost'));
  await expect(sendWorkAnswer({...answer,actor:'not-sent'} as WorkAnswer,request)).rejects.toThrow('Could not confirm');
  expect(request).toHaveBeenCalledTimes(1);
  vi.resetModules();
  const fresh=(await import('./work-answer')).sendWorkAnswer;
  await fresh(answer,request);
  const bodies = request.mock.calls.map(([,init])=>JSON.parse(String(init!.body)));
  expect(bodies[0]).toEqual({input:{id:'a-1',answer:'allow'},id:expect.stringMatching(/^work-[a-f0-9]{64}$/)});
  expect(bodies[1]).toEqual(bodies[0]);
  expect(request.mock.calls[0].slice(0,1)).toEqual(['/api/approvals/answer']);
  expect(request.mock.calls[0][1]).toMatchObject({method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'}});
});
it('distinguishes another card, answer, head and merge request', async () => {
  const request = vi.fn<typeof fetch>(success), base = {piece:'changes' as const,id:'github:house/pond#1',head:'a'.repeat(40),approval:'a-merge',answer:'yes' as const};
  for (const command of [answer,{...answer,id:'a-2'},{...answer,answer:'deny' as const},base,{...base,head:'b'.repeat(40)},{...base,approval:'a-other'}]) await sendWorkAnswer(command,request);
  expect(new Set(request.mock.calls.map(([,init])=>JSON.parse(String(init!.body)).id)).size).toBe(6);
  expect(request.mock.calls[3][0]).toBe('/api/changes/answer');
});
it('does not treat denial, malformed JSON or another target acknowledgement as confirmation', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ok:false,message:'private detail'},{status:403}))
    .mockResolvedValueOnce(new Response('not json')).mockResolvedValueOnce(Response.json({ok:true,value:{id:'a-other'}}));
  for (let n=0;n<3;n++) await expect(sendWorkAnswer(answer,request)).rejects.toThrow('Could not confirm your answer. Try again.');
  expect(request).toHaveBeenCalledTimes(3);
  expect(new Set(request.mock.calls.map(([,init])=>JSON.parse(String(init!.body)).id)).size).toBe(1);
});

it('preserves immutable answer IDs on plain HTTP where crypto.subtle is unavailable',async()=>{
 const cryptoSource=globalThis.crypto;vi.stubGlobal('crypto',{getRandomValues:cryptoSource.getRandomValues.bind(cryptoSource)});
 try{
  const request=vi.fn<typeof fetch>(success);await sendWorkAnswer(answer,request);
  const id='work-'+createHash('sha256').update(JSON.stringify(['approvals',{id:'a-1',answer:'allow'}])).digest('hex');
  expect(JSON.parse(String(request.mock.calls[0][1]!.body)).id).toBe(id);
 }finally{vi.unstubAllGlobals();}
});
it('says the program\'s own refusal of an approval answer as it is, and nothing else a failed answer carries', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ok:false,code:'conflict',message:'At least one household owner must remain'},{status:409}))
    .mockResolvedValueOnce(Response.json({ok:false,code:'unavailable',message:'Operation could not complete'},{status:503}))
    .mockResolvedValueOnce(Response.json({ok:false,code:'conflict',message:'x'.repeat(201)},{status:409}));
  await expect(sendWorkAnswer(answer,request)).rejects.toMatchObject({name:'WorkRefused',message:'At least one household owner must remain'});
  for (let n=0;n<2;n++) await expect(sendWorkAnswer(answer,request)).rejects.toThrow('Could not confirm your answer. Try again.');
  const merge = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ok:false,code:'conflict',message:'The merge request changed. Open it again.'},{status:409}));
  await expect(sendWorkAnswer({piece:'changes',id:'github:house/pond#1',head:'a'.repeat(40),approval:'a-merge',answer:'yes'},merge)).rejects.toThrow('Could not confirm your answer. Try again.');
});
