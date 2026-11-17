/** Create-only form: one person saved as two cards in two files, both or neither. */
import { existsSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { operation, mayAct, OperationError, RecoveredWrite, type Context, type Operations, type Sharing } from '../../core/index.js';
import { mindReceiptsReady } from './receipt-schema.js';
export interface NewPerson { slug:string; name:string; summary:string; channel:string; handle:string; actor:string }
/** Composition injects the synchronous card validator/writer, with no schema opening. */
export type PersonCreator = (db:BetterSqlite3.Database,input:NewPerson,now:number,half:'directory'|'relationship')=>void;
export function installMindPeopleActions(operations:Operations,options:{directory?:string;relationship?:string;agent?:string;sharing():Sharing;create:PersonCreator}) {
  const sources:BetterSqlite3.Database[]=[];
  try {
    for(const path of [options.directory,options.relationship]) {
      if (!path || !existsSync(path)) break;
      const db=new BetterSqlite3(path,{fileMustExist:true,timeout:0});sources.push(db);
    }
  } catch(e){sources.forEach(db=>db.close());throw e;}
  const prior=(db:BetterSqlite3.Database,ctx:Context)=>{
    if(!mindReceiptsReady(db))return;
    const receipt=ctx.receipt!;
    const old=db.prepare('SELECT name,input_hash,result,expires FROM mind_operation_receipts WHERE viewer=? AND id=? AND expires>?').get(receipt.viewer,receipt.id,ctx.now) as {name:string;input_hash:string;result:string;expires:number}|undefined;
    if(old && (old.name!==receipt.name || old.input_hash!==receipt.inputHash)) throw new OperationError('conflict','Operation id already used for different input');
    return old;
  };
  const recover=(ctx:Context)=>{
    if(!ctx.receipt) return;
    const receipts=sources.map(db=>prior(db,ctx));
    // After a crash one half can be committed without the other. Its receipt reserves
    // this id but is not a successful operation until both halves exist.
    if(sources.length===2 && receipts.every(Boolean)) {
      const result=JSON.parse(receipts[0]!.result) as {slug:string;slugs:string[]};
      ctx.changed('person',`commons:${result.slug}`);ctx.changed('person',`${options.agent}:${result.slug}`);
      return new RecoveredWrite(result,receipts[0]!.expires);
    }
  };
  operations.register(operation({name:'mind.personAdd',write:true,recover,
    input:z.object({name:z.string().trim().min(1).max(80),summary:z.string().trim().max(1200).default(''),channel:z.enum(['','slack','discord','email','phone','github']).default(''),handle:z.string().trim().max(200).default('')}).strict(),output:z.unknown(),
    may:v=>mayAct(v,{type:'person'},options.sharing(),'act','mind.personAdd') && !!options.agent && mayAct(v,{type:'person',agent:options.agent},options.sharing(),'act','mind.personAdd'),
    run(ctx,input){
      if(sources.length!==2 || !options.agent) throw new OperationError('not-found','People sources are absent');
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
          db.prepare('DELETE FROM mind_operation_receipts WHERE expires<=?').run(ctx.now);
          if(!prior(db,ctx)) {
            options.create(db,person,ctx.now,index===0?'directory':'relationship');
            db.prepare('INSERT INTO mind_operation_receipts VALUES(?,?,?,?,?,?)').run(receipt.viewer,receipt.id,receipt.name,receipt.inputHash,JSON.stringify(result),expires);
          }
          if(index+1<sources.length) save(index+1);
        }).immediate();
      };
      save(0);
      ctx.changed('person',`commons:${slug}`);ctx.changed('person',`${options.agent}:${slug}`);
      return new RecoveredWrite(result,expires);
    },
  }));
  return {close(){sources.forEach(db=>db.close());}};
}
