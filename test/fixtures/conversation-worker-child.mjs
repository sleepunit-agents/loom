/** Fictitious configured recipient of the production worker stdin envelope. */
import {bodyConversationClient} from '../../src/runtime/conversation-client.ts';
let client;
try {
 const chunks=[];for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));
 const bytes=Buffer.concat(chunks),input=JSON.parse(bytes.toString());bytes.fill(0);for(const chunk of chunks)chunk.fill(0);
 if(input.job.brief!==''||input.bootstrap.job!==input.job.id||input.build!=='fixture-image')throw Error('Bad private envelope');
 client=bodyConversationClient({url:input.bootstrap.origin,token:input.bootstrap.token,job:input.job.id,conversation:input.job.conversation,signal:new AbortController().signal});
 await client.status({state:'working',work:'Reading fictitious input'});
 let words;
 const batch=await client.takeAndAccept(async(item,signal)=>{if(signal.aborted||item.source!=='thread'||item.words!=='PRIVATE WORKER INPUT')throw Error('Wrong input');words=item.words;});
 if(batch.accepted!==1)throw Error('Input was not accepted');
 await client.reply({clientId:'reply',words:'PRIVATE WORKER REPLY',model:'fixture-actual-model',outcome:'answered',latencyMs:23});
 await client.digest({summary:'Completed fictitious worker input',items:[]});
 await client.status({state:'idle',work:'Fictitious work complete'});
 // A credential-bearing child may print private values; its parent must discard them.
 process.stdout.write(words+input.bootstrap.token);process.stderr.write(words+input.bootstrap.token);
 client.close();
}catch{client?.close();process.stderr.write('Worker recipient fixture failed');process.exitCode=1;}
