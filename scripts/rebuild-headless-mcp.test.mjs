import {expect,it} from 'vitest';
import {headlessMcpEvidence} from './rebuild-headless-mcp.mjs';
it('completes terminal Identity, Memory, Notes, Knowledge and Tasks on the actual built program without a browser',async()=>{
 expect(await headlessMcpEvidence()).toMatchObject({identity:true,memory:true,notes:true,knowledge:true,tasks:true,noBrowser:true,noWorkerJob:true});
});
