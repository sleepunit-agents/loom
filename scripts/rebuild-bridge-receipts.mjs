import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { bridgeConnections, bridgeIncoming, bridgeSendParts, bridgeSends } from '../dist/core/data/schema.js';
import { BridgeSends } from '../dist/pieces/bridges/sends.js';

/** A disposable example home with no bridge daemon. Only the provider's post
 * acknowledgment is simulated; the queue, storage and owner's review route are real. */
export async function bridgeReceipts({app,clock,page,open}) {
 const db=app.services.comms.db;
 assert.equal(db.select().from(bridgeSends).all().length,0);
 const attempts=[];
 const transport={async post(connection,address,text){
   assert.equal(address.channel,'example-intake-channel');
   attempts.push([connection.platform,text]);
   if(text==='Unconfirmed example reply')throw Error('Fixture connection ended before acknowledgment');
   return {id:'example-receipt-'+connection.platform};
 }};
 const queue=new BridgeSends(db,transport,()=>new Date(clock.now()).toISOString(),undefined,write=>app.writes.run(write).value);
 const tile=await open('Bridges');
 await tile.getByRole('button',{name:/^Pending sends/}).click();
 const review=async(text,decision)=>{
   await tile.locator('[data-split-row]').filter({hasText:text}).click();
   const reader=tile.getByRole('region',{name:'Bridges: the open item',exact:true});
   const release=reader.getByRole('button',{name:'Release send',exact:true});
   if(text==='Unconfirmed example reply'){
     await reader.getByText(/Delivery could not be confirmed/).waitFor();
     assert.equal(await release.count(),0);
   }
   const action=decision==='release'?release:reader.getByRole('button',{name:'Dismiss send',exact:true});
   const [response]=await Promise.all([
     page.waitForResponse(res=>res.url().endsWith('/api/bridges/command')&&res.request().method()==='POST'),
     action.click(),
   ]);
   assert.equal(response.status(),200);
   assert.equal((await response.json()).value?.saved,true);
 };
 const state=id=>db.select().from(bridgeSends).where(eq(bridgeSends.id,id)).get().state;
 const receipts=id=>db.select({id:bridgeSendParts.postedId}).from(bridgeSendParts).where(eq(bridgeSendParts.send,id)).all();
 const connections=[];
 try {
   for(const platform of ['discord','slack']){
     const connection='walkthrough-intake-'+platform;
     // Review a reply to the first delivered message in the original room.
     const source=db.select({id:bridgeIncoming.id}).from(bridgeIncoming).where(and(
       eq(bridgeIncoming.connection,connection),eq(bridgeIncoming.channel,'example-intake-channel'),eq(bridgeIncoming.state,'delivered'),
     )).orderBy(bridgeIncoming.postedAt,bridgeIncoming.id).get();
     assert.ok(source,'Missing delivered message in the reply fixture room');
     connections.push(connection);
     db.update(bridgeConnections).set({enabled:true}).where(eq(bridgeConnections.id,connection)).run();
     const incoming=source.id, held='example-held-'+platform, uncertain='example-uncertain-'+platform;
     queue.queue({id:held,incoming,text:'Held example reply',held:true});
     queue.queue({id:uncertain,incoming,text:'Unconfirmed example reply'});
     await queue.flush();
     assert.equal(state(held),'held');
     assert.equal(state(uncertain),'uncertain');
     assert.deepEqual(receipts(uncertain),[]);
     await review('Unconfirmed example reply','dismiss');
     assert.equal(state(uncertain),'dismissed');
     await review('Held example reply','release');
     await queue.flush();
     assert.equal(state(held),'sent');
     assert.deepEqual(receipts(held),[{id:'example-receipt-'+platform}]);
     await queue.flush();
     assert.deepEqual(attempts.filter(([which])=>which===platform),[[platform,'Unconfirmed example reply'],[platform,'Held example reply']]);
   }
   return {ok:true,reason:'On both platforms a missing acknowledgment left an uncertain reply for owner review. The owner dismissed it and released a held reply. Only the released reply acquired a provider receipt, and further queue drains made no duplicate attempt.'};
 } finally {
   await queue.close();
   for(const id of connections)db.update(bridgeConnections).set({enabled:false}).where(eq(bridgeConnections.id,id)).run();
 }
}
