import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {withFictionalMemoryHome} from './rebuild-memory-home.mjs';

export async function agentToolsEvidence(){
 return withFictionalMemoryHome(async ({connectAgent})=>{
  const client=new Client({name:'fictional-agent',version:'1'});
  const {url,token}=connectAgent();
  try{
   await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',url),{requestInit:{headers:{authorization:'Bearer '+token}}}));
   const call=async(name,args)=>{
    const result=await client.callTool({name,arguments:args});
    assert.ok(!result.isError,name+' failed');
    return result.content.map(part=>part.text).join('\n');
   };
   const actions={};
   try{
    const path='orchard/shift',body='Water the fictional orchard after sunset.';
    await call('note_write',{path,body,lifespan:'short'});
    await call('note_write',{path:'workshop/shift',body:'Sort the example screws.',lifespan:'short'});
    assert.ok((await call('note_read',{path})).endsWith(body));
    const listed=await call('note_list',{prefix:'orchard/'});
    assert.match(listed,/orchard\/shift /);
    assert.doesNotMatch(listed,/workshop\/shift/);
    actions.namedNotes={ok:true,reason:'The agent wrote notes under two paths, read the exact body back, and listed only the note under the requested prefix.'};
   }catch(error){actions.namedNotes={ok:false,error:String(error)};}
   try{
    const title='Fictional orchard calibration',body='The fictional orchard uses a violet tensiometer.';
    const answer=await call('knowledge_write',{title,domain:'fixture',body});
    const slug=/^Wrote knowledge page (\S+)$/.exec(answer)?.[1];assert.ok(slug);
    await call('knowledge_write',{title:'Fictional workshop supplies',domain:'fixture',body:'The shelf holds screws.'});
    const found=await call('knowledge_recall',{query:'violet tensiometer',domain:'fixture'});
    assert.ok(found.includes(slug)&&found.includes(body));
    assert.doesNotMatch(found,/workshop supplies/);
    const page=await call('knowledge_read',{slug});assert.ok(page.includes(title)&&page.includes(body));
    actions.namedKnowledge={ok:true,reason:'The agent created two distinct pages, found the matching page by its text, and read its title and body by slug.'};
   }catch(error){actions.namedKnowledge={ok:false,error:String(error)};}
   return actions;
  }finally{await client.close();}
 });
}
