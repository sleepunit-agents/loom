/** Send from Home through the normal private-conversation operations. */
import {join} from 'node:path';
export async function homeActions({page,tile,app,out}){
 const screenshot='action-homeMessage.png';
 try{
  const check=(yes,message)=>{if(!yes)throw Error(message);};
  const fern=tile.getByRole('region',{name:'Fern card',exact:true}),moss=tile.getByRole('region',{name:'Moss card',exact:true});
  await fern.getByText(/Three fit\. The quiet model/).waitFor();
  const recent=await page.evaluate(async()=>{
   const response=await fetch('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'{recentConversations(agent:"fern",limit:3){id label venue place lastAt}}'})});
   const result=await response.json();
   if(!response.ok||result.errors)throw Error('Could not read Fern’s recent conversations');
   return result.data.recentConversations;
  });
  check(recent.length>0,'Expected recent conversations for Fern');
  const links=fern.getByRole('navigation',{name:'Fern conversations',exact:true}).getByRole('listitem').getByRole('link');
  await links.first().waitFor();
  check(await links.count()===recent.length,'Home displayed a different number of recent conversations');
  for(const [index,row] of recent.sort((a,b)=>b.lastAt.localeCompare(a.lastAt)||a.id.localeCompare(b.id)).entries()){
   const path=['loom','terminal'].includes(row.venue)?'/p/comms-preview/thread/'+encodeURIComponent(row.place.replace(/^th:/,'')):'/p/comms-preview/conversation/'+encodeURIComponent(row.id);
   const link=links.nth(index);
   check(await link.getAttribute('title')===(row.label||'Conversation')&&await link.getAttribute('href')===path,'Home recent conversation title or destination differs');
  }
  for(const [card,name] of [[fern,'Message Fern'],[moss,'Message Moss']])check(await card.getByRole('textbox',{name,exact:true}).count()===1&&await card.getByRole('button',{name:'Send',exact:true}).count()===1,'An owned agent has no Home composer');
  const words='Fictitious Home request: check the garden latch.';
  await fern.getByRole('textbox',{name:'Message Fern',exact:true}).fill(words);
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/comms/send'&&r.request().method()==='POST',{timeout:4000});void pending.catch(()=>{});
  await fern.getByRole('button',{name:'Send',exact:true}).click();const response=await pending,body=await response.json();check(response.ok()&&body.ok===true,'Home send was refused');
  const comms=page.getByRole('region',{name:'Comms tile',exact:true});await comms.getByText(words,{exact:true}).waitFor();
  await page.reload();await page.locator('.next-shell').waitFor();await comms.getByText(words,{exact:true}).waitFor();
  const result=body.value,db=app.services.comms.db.$client;
  const rows=db.prepare('SELECT * FROM inbox WHERE thread=? AND message_seq=?').all(result.thread,result.seq);
  check(rows.length===1&&rows[0].to_kind==='agent'&&rows[0].to==='fern'&&rows[0].source==='thread','Home send did not make one delivery for Fern');
  const cv=db.prepare('SELECT * FROM conversations WHERE id=?').get(rows[0].conversation);
  check(cv.agent==='fern'&&cv.member==='alex'&&cv.venue==='loom','Home send did not start Alex’s private conversation with Fern');
  await page.screenshot({path:join(out,screenshot),fullPage:true});
  return{ok:true,reason:'Home displayed Fern’s last answer and recent thread, offered each owned agent a composer, and sent one persisted private message to Fern.',thread:result.thread,conversation:cv.id,inboxCopies:rows.length,persistedAfterReload:true,screenshot};
 }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true});return{ok:false,error:String(error),screenshot};}
 finally{const comms=page.getByRole('region',{name:'Comms tile',exact:true});if(await comms.isVisible())await comms.getByRole('button',{name:'Close Comms',exact:true}).click();}
}
