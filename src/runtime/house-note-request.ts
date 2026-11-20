import { z } from 'zod';
import { NOTE_PATH, NOTE_PATH_MAX, MAX_NOTE_BYTES, LIFESPAN_NAMES } from '../notes.js';
import { harnessToolPrefix } from './body-harness.js';
import { denialCoversTool } from './tool-denial.js';
import { bodyDeniedTools } from './body-named-tools.js';
import type { BodyProgramToolResult } from './body-program-tools.js';

const path = z.string().max(NOTE_PATH_MAX).regex(NOTE_PATH);
const request = z.discriminatedUnion('operation', [
  z.object({ operation: z.enum(['pin','unpin','delete']), path, id:z.string().min(1).max(200) }).strict(),
  z.object({ operation: z.literal('read'), path }).strict(),
  z.object({ operation: z.literal('list'), prefix: z.string().max(NOTE_PATH_MAX).optional(),
    limit: z.number().int().min(1).max(500).optional() }).strict(),
  z.object({ operation: z.literal('write'), path, body: z.string().refine(text => Buffer.byteLength(text) <= MAX_NOTE_BYTES),
    lifespan: z.enum(LIFESPAN_NAMES).optional(), id: z.string().min(1).max(200) }).strict(),
]);

const summary = 'path lifespan created updated by pinned bytes files expires';
const read = 'query($agent:String!,$path:String!){memoryNote(agent:$agent,path:$path){' + summary + ' body fileList{name sha256 bytes type added}}}';
const list = 'query($agent:String!,$prefix:String,$first:Int){memoryNotes(agent:$agent,prefix:$prefix,first:$first){' + summary + '}}';

interface NotePort {
  agent: string;
  denied: readonly string[];
  allowsCall(value: unknown): boolean;
  call(name: string, args: unknown, signal: AbortSignal): Promise<BodyProgramToolResult>;
}

/** Translate shell inputs to the same job-owned program tools used by the native harness. */
export async function houseNoteRequest(port: NotePort, input: unknown, signal: AbortSignal) {
  const parsed = request.safeParse(input);
  if (!parsed.success || signal.aborted || !port.agent || !port.allowsCall(parsed.data)) throw Error('House note request unavailable');
  const note = parsed.data;
  if (bodyDeniedTools(port.denied).includes(harnessToolPrefix + 'note_' + note.operation)) throw Error('House note operation denied');
  if(note.operation==='pin'||note.operation==='unpin'||note.operation==='delete'){
    const denied=bodyDeniedTools(port.denied);
    if(denied.includes(harnessToolPrefix+'note_write') ||
       port.denied.some(rule=>['mcp__loom__','mcp__loom_secrets__'].some(prefix=>denialCoversTool(rule,prefix+'note_'+note.operation))))throw Error('House note operation denied');
    const deleting=note.operation==='delete';
    return port.call('loom_command',{operation:deleting?'memory.noteDelete':'memory.notePin',
      input:deleting?{path:note.path}:{path:note.path,pinned:note.operation==='pin'},id:note.id},signal);
  }
  if (note.operation === 'write') {
    const { operation, id, ...fields } = note;
    return port.call('loom_command', { operation: 'memory.noteWrite', input: fields, id }, signal);
  }
  if (note.operation === 'read') {
    return port.call('loom_query', { query: read, variables: { agent: port.agent, path: note.path } }, signal);
  }
  if(note.operation!=='list')throw Error('Unknown note operation');
  return port.call('loom_query', { query: list, variables: { agent: port.agent, prefix: note.prefix ?? null, first: note.limit ?? 100 } }, signal);
}
