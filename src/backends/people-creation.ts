/** Create one half of a new person through the card store. Caller owns the transaction. */
import type { Database } from 'better-sqlite3';
import { CardError } from './cards.js';
import { PeopleStore, type PersonWriteInput } from './people.js';
import { OperationError } from '../core/index.js';
import type { NewPerson } from '../pieces/mind/people-actions.js';
export function createPersonHalf(db:Database,input:NewPerson,now:number,half:'directory'|'relationship') {
  const store=new PeopleStore({database:db,now:()=>now,actor:input.actor});
  if(!store.migrated) throw new OperationError('unavailable','People are not prepared for changes');
  // Create only. The store's write would merge into a card already at this address, or at the one
  // this address was merged into, so either is refused here first.
  if(store.rawRow(input.slug) || store.resolve(input.slug)!==input.slug) throw new OperationError('conflict',`${input.name} already has a card in ${half}`);
  const card:PersonWriteInput={slug:input.slug,name:input.name};
  if(half==='directory' && input.channel && input.handle) card.where={[input.channel]:{value:input.handle,source:`${input.actor} on loom's page`}};
  if(half==='relationship' && input.summary) card.summary=input.summary;
  try {store.write(card);} catch(e){if(e instanceof CardError)throw new OperationError('invalid',e.message);throw e;}
}
