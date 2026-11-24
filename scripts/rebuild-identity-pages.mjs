import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {withFictionalMemoryHome} from './rebuild-memory-home.mjs';

export function identityPages() {
  return withFictionalMemoryHome(async ({home, connectAgent}) => {
    const pages = [
      {folder:'harnesses', args:{piece:'harness', client:'codex'}, name:'codex'},
      {folder:'models', args:{piece:'model', model:'garden-model'}, name:'garden-model'},
      {folder:'roles', args:{role:'gardener'}, name:'gardener'},
      {folder:'projects', args:{project:'garden'}, name:'garden'},
    ];
    for (const agent of ['fern','moss']) {
      for (const {folder,name} of pages) {
        const directory = join(home,'agents',agent,folder);
        mkdirSync(directory,{recursive:true});
        writeFileSync(join(directory,name+'.md'), agent+' fixture page for '+folder);
      }
    }
    const client = new Client({name:'garden-page-reader',version:'1'});
    const {url,token} = connectAgent();
    const transport = new StreamableHTTPClientTransport(new URL('/mcp',url),{
      requestInit:{headers:{authorization:'Bearer '+token,'x-loom-agent':'fern'}},
    });
    try {
      await client.connect(transport);
      for (const selection of [undefined,...pages]) {
        const result = await client.callTool({name:'identity',arguments:selection?.args??{}});
        assert.ok(!result.isError);
        const words = result.content[0].text;
        assert.ok(words.startsWith('Agent: fern'));
        for (const page of pages) {
          assert.equal(words.includes('fern fixture page for '+page.folder),page===selection);
          assert.ok(!words.includes('moss fixture page for '+page.folder));
        }
      }
    } finally {
      await client.close();
    }
    return {ok:true,reason:'An enrolled fictional terminal requested harness, model, role and project pages separately over HTTP MCP. Each request returned only its own corresponding page. A default identity read omitted all four.'};
  });
}
