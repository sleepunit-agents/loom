/** Metadata-only seam for the new conversation owner. Never reads legacy Comms. */
import type { Viewer } from '../../core/index.js';
export interface PeopleConversations {
  list(viewer:Viewer,person:string): {available:boolean;rows:Array<{id:string;title:string;href:string}>};
}
