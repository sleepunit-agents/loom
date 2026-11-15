/** Fake UI/HTTP ports, real SQLite: the actual action must use the returned receipt. */
import {expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {conversationActions} from '../../scripts/rebuild-conversation-actions.mjs';
it.each([[1,'one',true,false],[2,'one',false,false],[1,'wrong-item',false,false],[1,'one',false,true]] as const)('binds the actual action receipt with %s stored copies and item %s',async(count,item,ok,duplicateAfterSend)=>{
 const db=new Database(':memory:');
 try{
  db.exec('CREATE TABLE inbox(id TEXT,conversation TEXT,to_kind TEXT,"to" TEXT,source TEXT,thread TEXT,message_seq INTEGER)');
  for(let n=0;n<count;n++)db.prepare('INSERT INTO inbox VALUES(?,?,?,?,?,?,?)').run(n===0?'one':'duplicate','fictional-cv','agent','fern','thread','th:fiction',1);
  const control={async waitFor(){},async isVisible(){return true;},first(){return this;},or(){return this;},and(){return this;},filter(){return this;},async click(){},async focus(){},async press(){},async fill(){},async evaluateAll(){return[];}};
  const tile={async isVisible(){return true;},getByRole:()=>control,getByText:()=>control,locator:()=>control,async screenshot(){}};
  const response={url:()=> 'https://fiction.invalid/api/comms/send',status:()=>200,json:async()=>({ok:true,value:{thread:'th:fiction',seq:1,item}}),request:()=>({method:()=> 'POST',postDataJSON:()=>({input:{thread:'th:fiction',words:'Fictitious input',clientId:'fiction'}})})};
  const page={getByRole:(role:string)=>role==='region'?tile:control,locator:()=>control,async reload(){},async screenshot(){},async waitForResponse(predicate:(value:typeof response)=>boolean){expect(predicate(response)).toBe(true);return response;}};
  const options={page,app:{services:{comms:{db:{$client:db}}}},example:{thread:'th:fiction',conversation:'fictional-cv'},out:'/fictional-artifacts',open:async(title:string)=>{if(title!=='Comms')throw Error('Other action is outside this focused proof');return tile;}};
  const sent=await conversationActions({...options,actions:['commsSend'],previous:{alreadyCollected:{ok:true}}});
  expect(sent.commsSend).toMatchObject({ok:false,persistedAfterReload:false,receipt:{thread:'th:fiction',seq:1,item},inboxCopies:count});
  expect(sent.commsSend.inconclusive).toBe(count===1&&item==='one');
  if(duplicateAfterSend)db.prepare('INSERT INTO inbox VALUES(?,?,?,?,?,?,?)').run('late-duplicate','fictional-cv','agent','fern','thread','th:fiction',1);
  const result=await conversationActions({...options,actions:['commsSendReload'],previous:sent});
  expect(Object.keys(result).sort()).toEqual(['alreadyCollected','commsSend']);
  expect(result.alreadyCollected).toEqual({ok:true});
  expect(result).toMatchObject({commsSend:{ok,inboxCopies:count+(duplicateAfterSend?1:0),persistedAfterReload:true}});
 }finally{db.close();}
});
