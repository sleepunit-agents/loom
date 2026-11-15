/** Fake UI/HTTP ports, real SQLite: the actual action must use the returned receipt. */
import {expect,it} from 'vitest';
import Database from 'better-sqlite3';
import {conversationActions} from '../../scripts/rebuild-conversation-actions.mjs';
it.each([[1,'one',true],[2,'one',false],[1,'wrong-item',false]] as const)('binds the actual action receipt with %s stored copies and item %s',async(count,item,ok)=>{
 const db=new Database(':memory:');
 try{
  db.exec('CREATE TABLE inbox(id TEXT,conversation TEXT,to_kind TEXT,"to" TEXT,source TEXT,thread TEXT,message_seq INTEGER)');
  for(let n=0;n<count;n++)db.prepare('INSERT INTO inbox VALUES(?,?,?,?,?,?,?)').run(n===0?'one':'duplicate','fictional-cv','agent','fern','thread','th:fiction',1);
  const control={async waitFor(){},async isVisible(){return true;},first(){return this;},or(){return this;},filter(){return this;},async click(){},async fill(){},async evaluateAll(){return[];}};
  const tile={async isVisible(){return true;},getByRole:()=>control,getByText:()=>control,locator:()=>control};
  const response={url:()=> 'https://fiction.invalid/api/comms/send',status:()=>200,json:async()=>({ok:true,value:{thread:'th:fiction',seq:1,item}}),request:()=>({method:()=> 'POST',postDataJSON:()=>({input:{thread:'th:fiction',words:'Fictitious input',clientId:'fiction'}})})};
  const page={getByRole:(role:string)=>role==='region'?tile:control,locator:()=>control,async reload(){},async screenshot(){},async waitForResponse(predicate:(value:typeof response)=>boolean){expect(predicate(response)).toBe(true);return response;}};
  const result=await conversationActions({page,actions:['commsSend'],previous:{alreadyCollected:{ok:true}},app:{services:{comms:{db:{$client:db}}}},example:{thread:'th:fiction',conversation:'fictional-cv'},out:'/fictional-artifacts',open:async(title:string)=>{if(title!=='Comms')throw Error('Other action is outside this focused proof');return tile;}});
  expect(Object.keys(result).sort()).toEqual(['alreadyCollected','commsSend']);
  expect(result.alreadyCollected).toEqual({ok:true});
  expect(result).toMatchObject({commsSend:{ok,inboxCopies:count,persistedAfterReload:true}});
 }finally{db.close();}
});
