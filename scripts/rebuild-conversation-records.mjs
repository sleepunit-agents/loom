/** Check the running program's canonical rows through the signed-in browser. */
import {join} from 'node:path';
export async function conversationRecords({page,app,example,out}){
 const screenshot='action-conversationRecords.png';
 try{
  const check=(yes,message)=>{if(!yes)throw Error(message);};
  const service=app.services.comms.threads.conversations,original=service.conversation(example.conversation);
  const rows=[original];
  for(const venue of ['discord','slack','wake','handoff'])rows.push(app.writes.run(()=>service.open({agent:'fern',venue,place:`example-${venue}-place`,label:`Fictitious ${venue} conversation`})).value);
  for(const row of rows){
   const repeated=app.writes.run(()=>service.open({agent:row.agent,venue:row.venue,place:row.place,label:'A repeat must not make another record'})).value;
   check(repeated.id===row.id,'Opening the same agent/place made a second conversation');
  }
  const other=app.writes.run(()=>service.open({agent:'moss',venue:'discord',place:'example-discord-place',label:'Moss in the same fictitious channel'})).value;
  check(other.id!==rows[1].id,'Two agents at one place were collapsed into one conversation');
  const result=await page.evaluate(async()=>{const response=await fetch('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'query WalkthroughConversations { conversations { id agent venue place label member project } }'})});return{status:response.status,body:await response.json()};});
  check(result.status===200&&!result.body.errors,`Canonical browser query failed: ${JSON.stringify(result.body.errors)}`);
  const visible=result.body.data.conversations;
  for(const expected of [...rows,other]){
   const actual=visible.filter(row=>row.agent===expected.agent&&row.venue===expected.venue&&row.place===expected.place);
   check(actual.length===1&&actual[0].id===expected.id,'A venue was missing, duplicated or represented differently in the canonical query');
  }
  check(original.venue==='loom'&&original.member==='alex'&&original.agent==='fern','The example private thread lost its person or agent');
  await page.screenshot({path:join(out,screenshot),fullPage:true});
  return{ok:true,reason:'The browser’s canonical query returned one row per agent/place for all five venues; repeated opens kept the same ID, while Moss in Fern’s channel had a separate row.',venues:rows.map(row=>({id:row.id,venue:row.venue,place:row.place})),otherAgent:other.id,screenshot};
 }catch(error){await page.screenshot({path:join(out,screenshot),fullPage:true});return{ok:false,error:String(error),screenshot};}
}
