#!/usr/bin/env node
// A substitute for the model provider. It talks MCP with only what the actual
// native launcher hands it on fd 3, using the same args a held Claude receives.
import {readFileSync,writeFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const args=process.argv.slice(2),session=args[args.indexOf('--session-id')+1];
const endpoint=JSON.parse(readFileSync(3,'utf8')).mcpServers.loom;
const client=new Client({name:'fixture-model',version:'1'},{capabilities:{}});
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url),{requestInit:{headers:endpoint.headers}}));
try{
  const names=(await client.listTools()).tools.map(t=>t.name), results=[];
  if(names.includes('kit_lookup'))for(const sample of ['pond $(date); echo','leak','after withdrawal']){
    results.push(await client.callTool({name:'kit_lookup',arguments:{sample}}));
  }
  writeFileSync('model-report.json',JSON.stringify({names,results,ambient:Object.hasOwn(process.env,'KIT_POND'),args,
    ephemeral:args.includes('--no-session-persistence')&&!args.includes('--resume')}));
}finally{await client.close();}
const answer='Finished the requested check.';
for(const event of [{type:'assistant',session_id:session,parent_tool_use_id:null,message:{model:'fixture-model',content:[{type:'text',text:answer}]}},
  {type:'result',session_id:session,is_error:false,subtype:'success',result:answer}])console.log(JSON.stringify(event));
