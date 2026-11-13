/** Small synchronous seam until the NEW Conversations/Comms owner is composed.
 * No legacy stores or adapters. The owner filters before bounding, never returns
 * another member's private thread, and emits conversation/digest/comms changes.
 */
import type {Viewer} from '../../core/index.js';
export interface ActivityConversation {id:string;agent:string;venue:string;place:string;label:string;people:string[];expires?:number;member?:string}
export interface ActivityRun {
 kind:'digest'|'conversation';key:string;at:string;expires?:number;conversation:ActivityConversation;
 summary?:string;turns?:number;replies?:number;asked:string[];decided:string[];tasks:string[];
 links:Array<{label:string;href?:string}>;steps?:Array<{label:string;state:string;tool:string}>;
 needs?:string;needsHref?:string;needsForMember?:string;
 more:Array<{id:string;at:string;title:string}>;
}
export interface ActivityConversations {
 /** [from,until), newest first, <=601 per agent. Digests replace moved conversations
  * in the same window. No prompt titles. read() uses the same visibility rules. */
 list(viewer:Viewer,query:{agent:string;from:number;until:number;limit:number}):{available:boolean;rows:ActivityRun[];expires?:number};
 read(viewer:Viewer,agent:string,kind:'digest'|'conversation',key:string):ActivityRun|undefined;
 /** Only an authorized NEW conversation, including its member scope. Used to
  * authorize episodes about Comms even if it has no run in the current window. */
 conversation(viewer:Viewer,agent:string,id:string):ActivityConversation|undefined;
}
