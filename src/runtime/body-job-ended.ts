import { z } from 'zod';

export class BodyJobEnded extends Error {
  constructor() { super('Body credential ended'); }
}

const denied = z.object({ok:z.literal(false),code:z.literal('denied'),message:z.string()}).strict();
const queryDenied = z.object({errors:z.tuple([z.object({
  message:z.enum(['Authentication required','Authentication ended']),
}).strict()])}).strict();

export function bodyJobEnded(status:number,value:unknown,door:'command'|'take'|'query'='command'):boolean {
  if(door==='query' && status===401 && queryDenied.safeParse(value).success)return true;
  const failure=denied.safeParse(value);
  if(!failure.success)return false;
  if(status===401)return true;
  if(status!==403)return false;
  const message=failure.data.message;
  return message==='Authentication ended'||message==='Job has ended'||
    (door==='take'&&(message==='Current body required'||message==='Current conversation body required'));
}
