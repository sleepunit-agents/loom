/** Canonical SQLite port. Restriction markers are never removed by grant edits. */
import {statement} from '../db/index.js';
import {eq} from 'drizzle-orm';
import type {DataDatabase} from './database.js';
import {programTokens,programRecordGrants,programOperationGrants} from './schema.js';
import {normalizeProgramGrants,type ProgramGrantStore} from '../../shared-program-access.js';
export function programGrantStore(db:DataDatabase):ProgramGrantStore{
 // One statement gives marker and both grant lists the same read snapshot,
 // without a Cartesian join between record and operation grants.
 const read=statement(db.$client,`SELECT 'marker' AS kind,NULL AS name FROM program_tokens WHERE token=?
 UNION ALL SELECT 'record',record_type FROM program_record_grants WHERE token=?
 UNION ALL SELECT 'operation',operation FROM program_operation_grants WHERE token=?`);
 return{
  read(fingerprint){
   const rows=read.all(fingerprint,fingerprint,fingerprint) as Array<{kind:string;name:string|null}>;
   if(!rows.some(row=>row.kind==='marker'))return undefined;
   return normalizeProgramGrants({records:rows.filter(row=>row.kind==='record').map(row=>row.name!),operations:rows.filter(row=>row.kind==='operation').map(row=>row.name!)});
  },
  write(fingerprint,input){
   if(!db.$client.inTransaction)throw Error('Program grants require the token transaction');
   const grants=normalizeProgramGrants(input);
   db.insert(programTokens).values({token:fingerprint}).onConflictDoNothing().run();
   db.delete(programRecordGrants).where(eq(programRecordGrants.token,fingerprint)).run();
   db.delete(programOperationGrants).where(eq(programOperationGrants.token,fingerprint)).run();
   for(const record of grants.records)db.insert(programRecordGrants).values({token:fingerprint,recordType:record}).run();
   for(const operation of grants.operations)db.insert(programOperationGrants).values({token:fingerprint,operation}).run();
   return undefined;
  },
 };
}
