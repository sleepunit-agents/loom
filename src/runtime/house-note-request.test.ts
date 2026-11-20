import { expect, it, vi } from 'vitest';
import { houseNoteRequest } from './house-note-request.js';

const signal = new AbortController().signal;
function fixture(denied: string[] = []) {
  return { agent: 'art', denied, allowsCall: () => true,
    call: vi.fn(async () => ({content: [{type: 'text' as const, text: '{}'}]})) };
}

it('reads only the assigned agent and uses variables for paths and prefixes', async () => {
  const port = fixture();
  await houseNoteRequest(port, {operation:'read', path:'plans/alpha'}, signal);
  await houseNoteRequest(port, {operation:'list', prefix:'plans/', limit:2}, signal);
  expect(port.call.mock.calls).toEqual([
    ['loom_query', {query:expect.stringContaining('fileList'), variables:{agent:'art',path:'plans/alpha'}}, signal],
    ['loom_query', {query:expect.stringContaining('memoryNotes'), variables:{agent:'art',prefix:'plans/',first:2}}, signal],
  ]);
});

it('passes the same write receipt id through on a retry', async () => {
  const port = fixture();
  const fields = {path:'plans/alpha',body:'one',lifespan:'short'};
  for (let i=0; i<2; i++) await houseNoteRequest(port,{operation:'write',id:'one-intent',...fields},signal);
  for(const call of port.call.mock.calls) expect(call).toEqual(['loom_command',{operation:'memory.noteWrite',input:fields,id:'one-intent'},signal]);
});

it('enforces named denials, generic denials, the secret filter and the request shape before contacting the service', async () => {
  for (const rule of ['mcp__loom__note_read','mcp__loom_secrets__loom_query','mcp__loom__loom_command','mcp__loom__note_*']) {
    const port=fixture([rule]);
    await expect(houseNoteRequest(port,{operation:'read',path:'plans/alpha'},signal)).rejects.toThrow();
    expect(port.call).not.toHaveBeenCalled();
  }
  const port=fixture();
  for (const input of [{operation:'read',path:'plans/alpha',agent:'other'}, {operation:'list',limit:501}, {operation:'loom_query',query:'{anything}'}]) {
    await expect(houseNoteRequest(port,input,signal)).rejects.toThrow();
  }
  await expect(houseNoteRequest({...port,allowsCall:()=>false},{operation:'read',path:'plans/alpha'},signal)).rejects.toThrow();
  expect(port.call).not.toHaveBeenCalled();
});

it.each(['pin','unpin','delete'])('applies write and specific room denials to %s',async operation=>{
 for(const rule of ['mcp__loom__note_write','mcp__loom_secrets__loom_query','mcp__loom__loom_command','mcp__loom_secrets__note_'+operation]){
  const port=fixture([rule]);
  await expect(houseNoteRequest(port,{operation,path:'plans/alpha',id:'intent'},signal)).rejects.toThrow();
  expect(port.call).not.toHaveBeenCalled();
 }
});

it('honors room denials when reading an attachment by name',async()=>{
 for(const rule of ['mcp__loom__note_read','mcp__loom__loom_query','mcp__loom__loom_command','mcp__loom_secrets__note_f*']){
  const port=fixture([rule]);
  await expect(houseNoteRequest(port,{operation:'file',path:'plans/alpha',name:'a.bin'},signal)).rejects.toThrow();
  expect(port.call).not.toHaveBeenCalled();
 }
});
