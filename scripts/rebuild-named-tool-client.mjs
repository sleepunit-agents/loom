import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function withNamedTools({url,token},measure){
  const client=new Client({name:'fictional-agent',version:'1'});
  try{
   await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',url),{requestInit:{headers:{authorization:'Bearer '+token}}}));
   const call=async(name,args)=>{
    const result=await client.callTool({name,arguments:args});
    assert.ok(!result.isError,name+' failed');
    return result.content.map(part=>part.text).join('\n');
   };
   return await measure(call);
  }finally{await client.close();}
}
