import type { Db } from '../../core/index.js';
export interface Thread {
 id: string; member: string; agent: string; conversation: string; project?: string;
 title: string | null; titledBy: 'member' | 'agent' | null; pinned: boolean; archived: number | null;
 opened: number; last: number; readSeq: number; nextSeq: number; stop: boolean;
 firstId: string; firstHash: string; working: boolean;
 [key: string]: unknown;
}
export interface MessageRow {
 thread: string; seq: number; id: string; kind: string; at: number; sender: string;
 words: Buffer | null; hash: string; record: string;
}
export const thread = (db: Db, id: string): Thread | undefined => {
 const row = db.prepare('SELECT record FROM comms_threads WHERE id=?').get(id) as { record: string } | undefined;
 return row ? JSON.parse(row.record) as Thread : undefined;
};
export function saveThread(db: Db, t: Thread) {
 db.prepare('INSERT INTO comms_threads VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project=excluded.project,record=excluded.record').run(t.id,t.member,t.agent,t.project ?? null,JSON.stringify(t));
}
export const messageId = (thread: string, seq: number) => `${thread}/${seq}`;
export function messageRows(db: Db, id: string, before = Number.MAX_SAFE_INTEGER, limit = 100): MessageRow[] {
 return (db.prepare('SELECT * FROM comms_messages WHERE thread=? AND seq < ? ORDER BY seq DESC LIMIT ?').all(id,before,limit) as MessageRow[]).reverse();
}
export function append(db: Db, t: Thread, row: Omit<MessageRow, 'thread' | 'seq'>): { seq: number; repeat: boolean } {
 const old = db.prepare('SELECT seq,hash FROM comms_messages WHERE thread=? AND kind=? AND id=?').get(t.id,row.kind,row.id) as {seq:number;hash:string}|undefined;
 if (old) { if (old.hash !== row.hash) throw new Error('conflict'); return {seq:old.seq,repeat:true}; }
 const seq = t.nextSeq++;
 db.prepare('INSERT INTO comms_messages VALUES (?,?,?,?,?,?,?,?,?)').run(t.id,seq,row.id,row.kind,row.at,row.sender,row.words,row.hash,row.record);
 t.last = row.at; saveThread(db,t); return {seq,repeat:false};
}
