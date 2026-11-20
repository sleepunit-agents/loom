import {expect,it,vi} from 'vitest';
import {headlessMcpEvidence} from './rebuild-headless-mcp.mjs';
it('completes terminal Identity, Memory, Notes, Knowledge and Tasks on the actual built program without a browser',async()=>{
 expect(await headlessMcpEvidence()).toMatchObject({identity:true,memory:true,notes:true,knowledge:true,tasks:true,noBrowser:true,noWorkerJob:true,cleanup:{credentialsRevoked:true,rootClosed:true,homeRemoved:true}});
});
it('never returns positive evidence when the real MCP client cleanup reports failure',async()=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const close=Client.prototype.close;
 const fault=vi.spyOn(Client.prototype,'close').mockImplementation(async function(this:InstanceType<typeof Client>){await close.call(this);throw Error('Injected cleanup failure');});
 try{await expect(headlessMcpEvidence()).rejects.toThrow('Headless evidence cleanup failed');expect(fault).toHaveBeenCalled();}finally{fault.mockRestore();}
});
