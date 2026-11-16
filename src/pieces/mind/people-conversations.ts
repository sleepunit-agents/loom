/** Metadata-only seam for the new conversation owner. Never reads legacy Comms. */
import type { Viewer } from '../../core/index.js';
export interface PeopleConversations {
  list(viewer:Viewer,person:string): {available:boolean;rows:Array<{id:string;title:string;href:string}>};
}

import type {DataDatabase} from '../../core/data/database.js';
import {readPeopleConversations} from '../../core/data/people-conversations-read.js';

/** Card access never grants access to its conversations. Current scope is
 * constrained in SQL before metadata is returned, with no pre-visibility cap. */
export function sharedPeopleConversations(db:DataDatabase,href:(id:string)=>string):PeopleConversations {
 return {list(viewer,person) {
  return {available:true,rows:readPeopleConversations(db,viewer,person).map(row=>({id:row.id,title:row.label,href:href(row.id)}))};
 }};
}
