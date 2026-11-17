import {SHA256_HEX} from './core/sha256-hex.js';
import {readProgramSetupTokens} from './core/data/program-setup-read.js';
/** Trusted owner-setup logic. Outside ownership and reply release belong at
 * Root's door; persistence is supplied by the schema-owned same-DB adapter. */
import {z} from 'zod';
import {types} from 'node:util';
import {eq} from 'drizzle-orm';
import type {DataDatabase} from './core/data/database.js';
import type {Clock} from './core/clock.js';
import {tokens} from './core/data/schema.js';
import {currentToken} from './core/data/authentication.js';
import {OperationError} from './core/operations/index.js';
import {sharedTokens,sharedTokenInput,currentMemberToken} from './core/signin/shared-tokens.js';
import {isReservedProgramOperation,normalizeProgramGrants,programSnapshot,sameProgramGrants,type ProgramGrantStore,type ProgramGrants} from './shared-program-access.js';
const grants={records:z.array(z.string().min(1).max(200)).max(200),operations:z.array(z.string().min(1).max(200)).max(200)};
export const programIssueInput=sharedTokenInput.options[0].omit({kind:true}).extend(grants).strict();
export const programEditInput=z.object({fingerprint:z.string().regex(SHA256_HEX),...grants}).strict();
export function sharedProgramSetup(db:DataDatabase,clock:Clock,store:ProgramGrantStore,choices:()=>ProgramGrants){
 if(types.isAsyncFunction(store.read)||types.isAsyncFunction(store.readMany)||types.isAsyncFunction(store.write))throw Error('Program persistence must be synchronous SQLite');
 const issuer=sharedTokens(db,clock);
 const catalogue=()=>{
  const value=choices();return normalizeProgramGrants({records:value.records,operations:value.operations.filter(name=>!isReservedProgramOperation(name))});
 };
 const validate=(input:ProgramGrants)=>{
  const allowed=catalogue();
  if(input.records.some(name=>!allowed.records.includes(name)))throw new OperationError('invalid','Choose supported record types');
  if(input.operations.some(name=>!allowed.operations.includes(name)))throw new OperationError('invalid','Choose supported non-credential operations');
  return normalizeProgramGrants(input);
 };
 const persist=(fingerprint:string,value:ProgramGrants)=>{
  const result:unknown=store.write(fingerprint,value);
  if(result!==undefined)throw new OperationError('unavailable','Program permissions could not be saved');
  // Refuse to release an ordinary token if an adapter forgot the marker or
  // stored broader grants. The enclosing SQLite transaction rolls it back.
  if(!sameProgramGrants(programSnapshot(id=>store.read(id),fingerprint),value))throw new OperationError('unavailable','Program permissions could not be saved');
 };
 return {
  catalogue,
  list(){
   return db.transaction(()=>{
    const rows=readProgramSetupTokens(db),grants=store.readMany(rows.map(row=>row.fingerprint));
    return rows.flatMap(token=>{
     const input=grants.get(token.fingerprint);if(!input)return[];
     const value=normalizeProgramGrants(input);
     return[{...token,ended:!currentToken(db,token.fingerprint,clock.now()),...value}];
    });
   });
  },
  issue(input:z.input<typeof programIssueInput>){
   const value=programIssueInput.parse(input),grant=validate(value);
   return db.transaction(()=>{
    const issued=issuer.issue({kind:'owner',member:value.member,label:value.label,...(value.expiresAt?{expiresAt:value.expiresAt}:{})});
    persist(issued.fingerprint,grant);return issued;
   });
  },
  set(input:z.input<typeof programEditInput>){
   const value=programEditInput.parse(input),grant=validate(value);
   return db.transaction(()=>{
    const token=db.select().from(tokens).where(eq(tokens.fingerprint,value.fingerprint)).get();
    if(!token||!store.read(value.fingerprint))throw new OperationError('not-found','Program token not found');
    if(!currentMemberToken(db,clock,value.fingerprint))throw new OperationError('invalid','Program token is not active');
    persist(value.fingerprint,grant);return{saved:true as const};
   });
  },
 };
}
