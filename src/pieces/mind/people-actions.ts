/** Create-only form: one person saved as two cards in two files, both or neither. */
import type {Viewer} from '../../policy.js';
import { existsSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { operation, mayAct, OperationError, RecoveredWrite, type Context, type Operations, type Sharing } from '../../core/index.js';
import { mindReceipts, mindReceiptsReady } from './receipt-schema.js';
import { CARD_NAME_MAX, CARD_SUMMARY_MAX } from '../../backends/cards.js';
import { MAX_STRING } from '../../backends/people.js';
export interface NewPerson { slug:string; name:string; summary:string; channel:string; handle:string; actor:string }
/** Composition injects the synchronous card validator/writer, with no schema opening. */
export type PersonCreator = (db:BetterSqlite3.Database,input:NewPerson,now:number,half:'directory'|'relationship')=>void;
/** `agent` is the agent a new person's relationship card belongs to, and `relationship` that agent's file.
 * Both may be given as functions: the household's default agent can be changed while the program runs, and
 * each call then reads who it is now. */
export function installMindPeopleActions(operations:Operations,options:{directory?:string;relationship?:string|(()=>string|undefined);agent?:string|(()=>string|undefined);sharing():Sharing;create:PersonCreator;
  /** Why this caller adds nobody, in words for the caller (the body of a job on anybody else's word), or nothing. */
  refused?(viewer:Viewer):string|undefined}) {
  const agentNow=()=>typeof options.agent==='function'?options.agent():options.agent;
  // One connection to each file, kept: the directory, and the file of each agent that has been the default.
  const opened=new Map<string,BetterSqlite3.Database>();
  const open=(path:string|undefined)=>{
    if(!path)return;
    const held=opened.get(path);if(held)return held;
    if(!existsSync(path))return;
    const db=new BetterSqlite3(path,{fileMustExist:true,timeout:0});opened.set(path,db);return db;
  };
  /** The directory and the current agent's file, in that order; shorter when either is absent. */
  const current=():BetterSqlite3.Database[]=>{
    const directory=open(options.directory);if(!directory)return [];
    const relationship=open(typeof options.relationship==='function'?options.relationship():options.relationship);
    return relationship?[directory,relationship]:[directory];
  };
  try{current();}catch(e){opened.forEach(db=>db.close());throw e;}
  const prior=(db:BetterSqlite3.Database,ctx:Context)=>mindReceiptsReady(db)?mindReceipts.find(db,ctx.receipt!,ctx.now):undefined;
  const recover=(ctx:Context)=>{
    if(!ctx.receipt) return;
    const sources=current(),receipts=sources.map(db=>prior(db,ctx));
    // After a crash one half can be committed without the other. Its receipt reserves
    // this id but is not a successful operation until both halves exist.
    if(sources.length===2 && receipts.every(Boolean)) {
      const result=JSON.parse(receipts[0]!.result) as {slug:string;slugs:string[]};
      ctx.changed('person',`commons:${result.slug}`);ctx.changed('person',`${agentNow()}:${result.slug}`);
      return new RecoveredWrite(result,receipts[0]!.expires);
    }
  };
  operations.register(operation({name:'mind.personAdd',write:true,recover,
    input:z.object({name:z.string().trim().min(1).max(CARD_NAME_MAX),summary:z.string().trim().max(CARD_SUMMARY_MAX).default(''),channel:z.enum(['','slack','discord','email','phone','github']).default(''),handle:z.string().trim().max(MAX_STRING).default('')}).strict(),output:z.unknown(),
    may:v=>{const agent=agentNow();return mayAct(v,{type:'person'},options.sharing(),'act') && !!agent && mayAct(v,{type:'person',agent},options.sharing(),'act');},
    run(ctx,input){
      const why=options.refused?.(ctx.viewer);if(why)throw new OperationError('denied',why);
      // Read once: the agent and its file are the same for the whole of this write.
      const agent=agentNow(),sources=current();
      if(sources.length!==2 || !agent) throw new OperationError('not-found','People sources are absent');
      if(!sources.every(mindReceiptsReady))throw new OperationError('unavailable','People are not prepared for changes');
      const slug=input.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').replace(/^[^a-z]+/,'').slice(0,40);
      if(!slug) throw new OperationError('invalid','A person needs a name that makes an address');
      const person={...input,slug,actor:ctx.viewer.id}, receipt=ctx.receipt!,result={slug,slugs:[slug]};
      const expires=Math.min(receipt.expires,...sources.flatMap(db=>{const old=prior(db,ctx);return old?[old.expires]:[];}));
      // The two halves live in two files. The relationship half is saved and committed inside the
      // directory half's open transaction, so a refusal or a busy file on either side saves neither.
      // Only a crash between the two commits can leave the relationship half alone; the receipt it
      // carries lets a retry with the same operation id finish the directory half.
      const save=(index:number):void=>{
        const db=sources[index];
        db.transaction(()=>{
          mindReceipts.expire(db,ctx.now);
          if(!prior(db,ctx)) {
            options.create(db,person,ctx.now,index===0?'directory':'relationship');
            mindReceipts.save(db,receipt,result,expires);
          }
          if(index+1<sources.length) save(index+1);
        }).immediate();
      };
      save(0);
      ctx.changed('person',`commons:${slug}`);ctx.changed('person',`${agent}:${slug}`);
      return new RecoveredWrite(result,expires);
    },
  }));
  return {close(){opened.forEach(db=>db.close());opened.clear();}};
}
