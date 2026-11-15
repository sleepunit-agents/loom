import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { readBodyStdin } from './body-stdin.js';
it('erases the original received buffer and returns a separate owned envelope', async () => {
 const source=new PassThrough(),raw=Buffer.from('PRIVATE BOOTSTRAP'),abort=new AbortController(),pending=readBodyStdin(source,abort.signal);
 source.end(raw);const result=await pending;expect(Buffer.from(result).toString()).toBe('PRIVATE BOOTSTRAP');expect(raw.every(byte=>byte===0)).toBe(true);result.fill(0);
});
it('cancels while stdin stays open and erases received bytes without waiting for EOF', async () => {
 const source=new PassThrough(),raw=Buffer.from('PRIVATE BOOTSTRAP'),abort=new AbortController(),pending=readBodyStdin(source,abort.signal);
 const checked=expect(pending).rejects.toThrow();source.write(raw);await new Promise<void>(resolve=>setImmediate(resolve));expect(raw.every(byte=>byte===0)).toBe(true);abort.abort();await checked;expect(source.destroyed).toBe(true);
});
it('refuses oversized stdin and erases its received mutable buffer',async()=>{
 const source=new PassThrough(),raw=Buffer.alloc(1_048_577,65),pending=readBodyStdin(source,new AbortController().signal);
 source.end(raw);await expect(pending).rejects.toThrow();expect(raw.every(byte=>byte===0)).toBe(true);
});

it('keeps the returned buffer erasable across the async ownership handoff',async()=>{
 const source=new PassThrough(),abort=new AbortController(),pending=readBodyStdin(source,abort.signal);
 source.end(Buffer.from('PRIVATE BOOTSTRAP'));
 const result=await pending.then(value=>{abort.abort();return value;});expect(result.every(byte=>byte===0)).toBe(true);
});
