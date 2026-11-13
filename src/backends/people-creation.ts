/** Synchronous create primitive on an existing card schema. Caller owns transaction. */
import type { Database } from 'better-sqlite3';
import { validateCard, type PersonCard } from './people.js';
import { OperationError } from '../core/index.js';
import type { NewPerson } from '../pieces/mind/people-actions.js';
export function createPersonHalf(db:Database,input:NewPerson,now:number,half:'directory'|'relationship') {
  if(db.prepare('SELECT 1 FROM people WHERE slug=?').get(input.slug)) throw new OperationError('conflict',`${input.name} already has a card in ${half}`);
  const card:PersonCard={slug:input.slug,name:input.name,where:{},how:{},may:[]};
  if(half==='directory' && input.channel && input.handle) card.where[input.channel]={value:input.handle,source:`${input.actor} on loom's page`};
  if(half==='relationship' && input.summary) card.summary=input.summary;
  try {validateCard(card,now);} catch(e){throw new OperationError('invalid',e instanceof Error?e.message:'Invalid person card');}
  db.prepare('INSERT INTO people(slug,name,card_json,updated,synthesized_at) VALUES(?,?,?,?,NULL)').run(input.slug,input.name,JSON.stringify(card),new Date(now).toISOString());
}
