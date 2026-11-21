import type { DataDatabase } from '../data/database.js';
import { threadRefs } from '../data/schema.js';

/** Each reference points to the latest message that named it. */
export function recordThreadRef(db:DataDatabase, thread:string, ref:string, seq:number) {
  db.insert(threadRefs).values({thread,ref,messageSeq:seq}).onConflictDoUpdate({
    target:[threadRefs.thread,threadRefs.ref],set:{messageSeq:seq},
  }).run();
}
