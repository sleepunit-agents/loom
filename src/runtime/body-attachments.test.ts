import { expect, it } from 'vitest';
import { BODY_ATTACHMENTS, saveBodyAttachments } from './body-attachments.js';

type Kept = { file: string; name: string; bytes: Buffer };
function fixture(kept: Record<string, Kept[]>) {
  const written = new Map<string, Buffer>(), asked: unknown[] = [];
  const client = { command: async (operation: string, input: unknown) => {
    asked.push([operation, input]);
    const { incoming, file } = input as { incoming: string; file?: string };
    const files = kept[incoming];
    if (!files) return { ok: false as const, code: 'denied' as const, message: 'no' };
    const rows = files.filter(row => !file || row.file === file).map(row => ({ file: row.file, name: row.name, bytes: row.bytes.byteLength, fetchedAt: '2026-11-17T00:00:00.000Z', ...(file ? { contents: row.bytes.toString('base64') } : {}) }));
    return { ok: true as const, value: { files: rows } };
  } };
  const write = (path: string, bytes: Buffer) => { written.set(path, Buffer.from(bytes)); };
  return { client: client as never, written, asked, write };
}

it('writes what was sent with the messages it took into the scratch directory, and names each file', async () => {
  const f = fixture({ 'bi:1': [{ file: 'A', name: 'cat photo.png', bytes: Buffer.from('PNG') }], 'bi:2': [{ file: 'B', name: '../../.ssh/key', bytes: Buffer.from('secret') }], 'bi:3': [] });
  const words = await saveBodyAttachments(f.client, ['bi:1', 'bi:2', 'bi:3'], '/scratch', f.write);
  const paths = [...f.written.keys()];
  expect(paths).toHaveLength(2);
  // Each is inside one new directory under the scratch directory, whatever its name was.
  expect(paths[0]).toMatch(/^\/scratch\/attachments-[0-9a-f-]{36}\/1-cat_photo\.png$/);
  expect(paths[1]).toMatch(/^\/scratch\/attachments-[0-9a-f-]{36}\/2-ssh_key$/);
  expect(f.written.get(paths[0])?.toString()).toBe('PNG');
  expect(words).toBe(`Files sent with these messages are saved here for you to open:\n- ${paths[0]} (cat_photo.png, 3 bytes)\n- ${paths[1]} (ssh_key, 6 bytes)`);
});

it('says nothing when there is nothing, no scratch directory, or loom will not say', async () => {
  const f = fixture({ 'bi:1': [] });
  expect(await saveBodyAttachments(f.client, ['bi:1'], '/scratch', f.write)).toBeNull();
  expect(await saveBodyAttachments(f.client, [], '/scratch', f.write)).toBeNull();
  expect(await saveBodyAttachments(f.client, ['bi:other'], '/scratch', f.write)).toBeNull();
  const with_ = fixture({ 'bi:1': [{ file: 'A', name: 'a', bytes: Buffer.from('x') }] });
  expect(await saveBodyAttachments(with_.client, ['bi:1'], undefined, with_.write)).toBeNull();
  expect(with_.asked).toEqual([]);
});

it('stops at the count it may write, keeps what it wrote when a later read fails, and never fails the caller', async () => {
  const many = fixture({ 'bi:1': Array.from({ length: 14 }, (_, n) => ({ file: 'F' + n, name: `n${n}.txt`, bytes: Buffer.from('x') })) });
  const words = await saveBodyAttachments(many.client, ['bi:1'], '/scratch', many.write);
  expect(many.written.size).toBe(BODY_ATTACHMENTS);
  expect(words?.split('\n')).toHaveLength(BODY_ATTACHMENTS + 1);
  const broken = fixture({ 'bi:1': [{ file: 'A', name: 'a', bytes: Buffer.from('x') }, { file: 'B', name: 'b', bytes: Buffer.from('y') }] });
  let n = 0;
  const words2 = await saveBodyAttachments(broken.client, ['bi:1'], '/scratch', (path, bytes) => { if (++n === 2) throw Error('disk full'); broken.write(path, bytes); });
  expect(words2?.split('\n')).toHaveLength(2);
});

it('names a failed seventh Discord attachment and opens the following file, keeping names and URLs out of commands', async () => {
  const kept = fixture({'bi:1':[{file:'18', name:'pic8.png', bytes:Buffer.from('PNG')}]});
  const calls:unknown[] = [];
  const client = {command: async (op:string, input:{index?:number}, key:string) => {
    if (op !== 'bridges.prepareFile') return (kept.client as {command:(op:string,input:unknown,key:string)=>Promise<unknown>}).command(op,input,key);
    calls.push(input);
    return {ok:true, value:{state:input.index===6?'unavailable':'saved',count:8,bytes:input.index===6?0:3}};
  }};
  const words=Array.from({length:8},(_,n)=>`[attachment: pic${n+1}.png (image/png, 3 bytes)]`).join('\n');
  const input=await saveBodyAttachments(client as never,['bi:1'],'/scratch',kept.write,new Map([['bi:1',words]]));
  expect(input).toContain('pic7.png (download failed)');
  expect(input).toContain('1-pic8.png');
  expect(calls).toHaveLength(8);
  expect(calls.at(-1)).toEqual({incoming:'bi:1',index:7,maxBytes:32*1024*1024-18});
});

it('keeps one preparation budget when scratch writes fail and a later message is text-only', async () => {
  const calls: string[] = [], writes: string[] = [], messages = Array.from({length:12}, (_,n)=>'bi:'+n);
  const descriptions = new Map(messages.map(id=>[id,'[attachment: pic.png (image/png, 3 bytes)]']));
  const client = {command: async(op:string,input:{incoming:string;file?:string;maxBytes?:number})=>{
    if(op==='bridges.prepareFile'){calls.push(input.incoming);return {ok:true,value:{state:'saved',count:1,bytes:3}};}
    return {ok:true,value:{files:descriptions.has(input.incoming)?[{file:'F',name:'pic.png',bytes:3,fetchedAt:'now',...(input.file?{contents:'UE5H'}:{})}]:[]}};
  }};
  const result=await saveBodyAttachments(client as never,[...messages,'text-only'],'/scratch',path=>{writes.push(path);throw Error('disk full');},descriptions);
  expect(calls).toHaveLength(BODY_ATTACHMENTS);
  expect(writes).toHaveLength(BODY_ATTACHMENTS);
  expect(result).toContain('pic.png (run attachment limit)');
  expect(result).not.toContain('Additional attachments exceed');
});
it('charges the allowance spent on unavailable network files across messages', async () => {
  const budgets:number[]=[];
  const client={command:async(op:string,input:{maxBytes:number})=>{
    if(op!=='bridges.prepareFile')return {ok:true,value:{files:[]}};
    budgets.push(input.maxBytes);return {ok:true,value:{state:input.maxBytes?'unavailable':'limit',count:1,bytes:Math.min(input.maxBytes,8*1024*1024)}};
  }};
  const messages=['one','two','three','four','five'];
  const labels=new Map(messages.map(id=>[id,'[attachment: pic.png (image/png, 8388608 bytes)]']));
  expect(await saveBodyAttachments(client as never,messages,'/scratch',()=>{},labels)).toContain('pic.png (run attachment limit)');
  expect(budgets.map(n=>n/(1024*1024))).toEqual([32,24,16,8,0]);
});
