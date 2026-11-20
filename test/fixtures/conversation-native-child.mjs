/** Fictitious configured body. Only startup bytes use stdin; IPC is a
 * test-only metadata latch so the person can answer without timed polling. */
import {createHash} from 'node:crypto';
import {bodyConversationClient} from '../../src/runtime/conversation-client.ts';
let client;
try {
 const chunks=[];for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));
 const bytes=Buffer.concat(chunks),startup=JSON.parse(bytes.toString('utf8'));bytes.fill(0);for(const chunk of chunks)chunk.fill(0);
 client=bodyConversationClient({url:startup.url,token:startup.token,job:startup.job,conversation:startup.conversation,signal:new AbortController().signal});
 await client.status({state:'working',work:'Checking fictitious input'});
 const first=await client.takeAndAccept(async(item,signal)=>{
  if(signal.aborted||item.source!=='thread'||createHash('sha256').update(item.words??'').digest('hex')!==startup.inputHash)throw Error('Wrong input');
  const accepted=new Promise(resolve=>process.once('message',resolve));process.stdout.write(JSON.stringify({accepting:true})+'\n');await accepted;
 });
 if(first.accepted!==1)throw Error('Wrong initial batch');
 await client.card({clientId:'read-step',words:startup.card,tool:'Read',cardState:'done',model:'fictitious-actual-model'});
 const reply=await client.reply({clientId:'reply',words:startup.reply,model:'fictitious-actual-model',outcome:'answered',latencyMs:17});
 await client.turn({kind:'note',model:'fictitious-actual-model',outcome:'progressed'});
 const question=await client.digest({summary:'Awaiting a fictitious answer',items:[{kind:'decision',text:'Use the fixture'}],question:{to:'alice',answers:'yes-no',words:startup.question}});
 const resume=new Promise(resolve=>process.once('message',resolve));
 process.stdout.write(JSON.stringify({ask:question.item})+'\n');await resume;
 const second=await client.takeAndAccept(async(item,signal)=>{if(signal.aborted||item.source!=='answer'||item.sourceId!==question.item||item.verdict!=='yes')throw Error('Wrong answer');});
 if(second.accepted!==1||!second.stopRequested)throw Error('Wrong answer batch');
 await client.settle();
 const stop=await client.status({state:'idle',work:'Fictitious work complete'});
 if(!stop.stopRequested)throw Error('Stop was not preserved');
 const digest=await client.digest({summary:'Fictitious work complete',items:[{kind:'task',text:'t-4242'}]});
 process.stdout.write(JSON.stringify({accepted:2,reply:reply.seq,revision:digest.revision})+'\n');
 client.close();process.disconnect();
}catch{
 client?.close();process.stderr.write('Native conversation fixture failed\n');process.exitCode=1;if(process.connected)process.disconnect();
}
