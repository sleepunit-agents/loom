/** Independent source projection and read-only comparison; plaintext never leaves this module. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Db } from '../core/index.js';
import type { Thread } from '../pieces/comms/store.js';
import { readKey, wordsKey, type WordsKey } from '../pieces/comms/crypto.js';
import { canonicalPlanValue } from './migration-plan.js';
import { openSnapshotSqlite } from './migration-sqlite.js';
import type { Row, Tables } from './migration-projection.js';
const time = (value: unknown): number => typeof value === 'number' ? value : Date.parse(String(value));
const json = JSON.stringify;
function read(db: Db, table: string): Row[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return [];
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[];
}
function sourceRows(path: string, tables: string[]): Row[][] {
  const db = openSnapshotSqlite(path);
  try { return db.transaction(() => tables.map(table => read(db, table)))(); }
  finally { db.close(); }
}
/** Original envelopes must remain byte-identical; validate their cryptographic content too. */
async function original(value: unknown, key: WordsKey): Promise<Buffer | null> {
  if (value === null || value === undefined) return null;
  const bytes = Buffer.from(value as Uint8Array);
  await key.open(bytes);
  return bytes;
}
async function project(paths: string[], key: WordsKey, identity: string): Promise<Tables> {
  const path = (name: string) => paths.find(p => basename(p) === name)!;
  const [threads, deleted] = sourceRows(path('household.db'), ['comms_threads', 'comms_deleted']);
  const [messages, asks, steps] = sourceRows(path('comms.db'), ['comms_messages', 'comms_asks', 'conversation_steps']);
  const saltPath = path('comms.salt'), salt = saltPath ? readFileSync(saltPath) : undefined;
  if (salt && salt.length !== 32) throw Error('Invalid source Comms salt');
  const checksum = createHash('sha256').update(json({threads,messages,asks,deleted,steps,key:identity,salt:salt?.toString('base64'),destinationKey:identity})).digest('hex');
  const next = new Map<string, number>(), rows: Row[] = [];
  for (const message of messages) {
    const place = String(message.thread), seq = Number(message.seq);
    next.set(place, Math.max(next.get(place) ?? 1, seq + 1));
    rows.push({thread:place,seq,id:String(message.id),kind:String(message.kind),at:time(message.at),sender:String(message.sender),
      words:await original(message.text,key),hash:String(message.hash ?? ''),record:{
        encoding:'text',privateCipher:{card:typeof message.card_json === 'string' ? JSON.parse(message.card_json) : null,run:message.run},
        delivery:message.delivered === null ? 'sending' : message.delivered ? 'delivered' : 'failed',
        ...(message.step ? {stepCipher:(await original(message.step,key))!.toString('base64')} : {}),legacyHash:true,
      }});
  }
  for (const ask of asks) {
    const place = String(ask.thread), seq = next.get(place) ?? 1; next.set(place, seq + 1);
    rows.push({thread:place,seq,id:String(ask.ref),kind:'ask',at:time(ask.raised),sender:threads.find(t => t.id === place)?.agent,
      words:await original(ask.words,key),hash:'',record:{encoding:'ask',ref:ask.ref,approval:ask.approval,seen:ask.seen,
        privateCipher:{answer:ask.answer_json ? JSON.parse(String(ask.answer_json)) : null}}});
  }
  const projectedThreads = threads.map(source => {
    const {about_key:about,...metadata} = source;
    const record: Thread = {...metadata,...(typeof about === 'string' && about ? {aboutHash:key.hash(`about\0${about}`)} : {}),
      id:String(source.id),agent:String(source.agent),member:String(source.member),conversation:String(source.conversation),
      title:source.title as string|null,titledBy:source.titled_by as Thread['titledBy'],project:source.project ? String(source.project) : undefined,
      pinned:!!source.pinned,archived:source.archived ? time(source.archived) : null,opened:time(source.opened),last:time(source.last),
      readSeq:Number(source.read_seq),nextSeq:next.get(String(source.id)) ?? 1,stop:!!source.stop,firstId:String(source.first_id),
      firstHash:String(source.first_hash),working:!!source.working_since};
    return {id:record.id,member:record.member,agent:record.agent,project:record.project ?? null,record:JSON.parse(json(record))};
  });
  const projectedSteps: Row[] = [];
  for (const step of steps) {
    const words = await original(step.words,key);
    projectedSteps.push({seq:Number(step.seq),conversation:step.conversation,at:time(step.at),words,
      record:words === null ? null : {run:step.run,id:step.id,tool:step.tool,state:step.state}});
  }
  return {
    comms_threads:projectedThreads,comms_messages:rows,comms_deleted:deleted.map(d => ({id:d.id,member:d.member,agent:d.agent,conversation:d.conversation ?? '',at:time(d.at)})),
    comms_conversation_steps:projectedSteps,comms_meta:[...(salt ? [{key:'legacy-salt',value:salt.toString('base64')}] : []),{key:'source-checksum',value:checksum}],
  };
}
function normalized(rows: Row[]): string {
  // Use SQLite Buffer JSON encoding for binary originals, semantic JSON for records.
  return canonicalPlanValue(rows.map(row => json(row)).map(text => canonicalPlanValue(JSON.parse(text))).sort());
}
/** Only counts/table names escape, including when a private envelope is corrupt. */
export async function compareComms(db: Db, paths: string[], home: string): Promise<{table:string;expected:number;actual:number|null}[]> {
  const sourceKeyPath = paths.find(p => basename(p) === 'comms.key')!, targetKeyPath = join(home,'comms.key');
  const sourceBytes = readFileSync(sourceKeyPath), targetBytes = readFileSync(targetKeyPath);
  if (!sourceBytes.equals(targetBytes)) return [{table:'comms-key',expected:1,actual:1}];
  const identity = readKey(sourceKeyPath), key = wordsKey(identity);
  if (readKey(targetKeyPath) !== identity) throw Error('Comms key differs');
  const expected = await project(paths,key,identity), differences: {table:string;expected:number;actual:number|null}[] = [];
  for (const [table,rows] of Object.entries(expected)) {
    let actual: Row[] | null = null, equal = false;
    try {
      actual = db.prepare(`SELECT * FROM ${table}`).all() as Row[];
      for (const row of actual) {
        if (table === 'comms_threads') row.record = JSON.parse(String(row.record));
        if (table === 'comms_messages') {
          const record = JSON.parse(String(row.record));
          record.privateCipher = JSON.parse(await key.open(Buffer.from(record.privateCipher,'base64')));
          row.record = record;
        }
        if (table === 'comms_conversation_steps' && row.record !== null) row.record = JSON.parse(await key.open(row.record as Uint8Array));
      }
      equal = normalized(actual) === normalized(rows);
    } catch { /* missing tables or malformed private data are differences, never error text */ }
    if (!equal) differences.push({table,expected:rows.length,actual:actual?.length ?? null});
  }
  if (!sourceBytes.equals(readFileSync(sourceKeyPath)) || !targetBytes.equals(readFileSync(targetKeyPath))) throw Error('Comms key changed during verification');
  return differences;
}
