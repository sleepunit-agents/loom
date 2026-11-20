import {expect,it,vi} from 'vitest';
import {kitBroker} from './kit-broker.js';
import type {KitTool} from './kit-manifest.js';

const tool:KitTool={name:'mail',description:'Check a sender',program:'tools/mail',image:'sha256:'+'1'.repeat(64),
  repository:'https://example.org/agent',commit:'a'.repeat(40),parameters:{sender:{type:'string',description:'Sender address'}},
  args:['--sender',{parameter:'sender'}],secrets:{KIT_KEY:'mail'}};
const item={kit:'desk',tool,definition:'f'.repeat(64)};
function fixture(){
 const post=vi.fn(async (verb:string,_body:object)=>verb==='list'?{tools:[item]}:verb==='authorize'?{use:'use-1',tool,secrets:{KIT_KEY:Buffer.from('private_key').toString('base64')}}:{});
 const run=vi.fn(async(_request:unknown)=>Buffer.from('one message'));
 const broker=kitBroker({repository:tool.repository,commit:tool.commit,image:tool.image,denials:[],post,run});
 return {broker,run,post};
}
const signal=new AbortController().signal;
it('advertises just the named schema, reauthorizes a call and pins the program and argument vector',async()=>{
 const {broker,post,run}=fixture();
 expect(await broker.list(signal)).toEqual([{name:'kit_mail',description:tool.description,parameters:tool.parameters}]);
 expect(await broker.call('kit_mail',{sender:'me $(date) ; echo'},signal)).toBe('one message');
 expect(post.mock.calls.map(([verb])=>verb)).toEqual(['list','authorize','finish']);
 expect(run.mock.calls[0][0]).toMatchObject({entrypoint:'/home/agent/repo/tools/mail',image:tool.image,argv:['--sender','me $(date) ; echo']});
});
it('fails closed on revocation and never calls a mismatched or denied program',async()=>{
 const {broker,post,run}=fixture();
 await broker.list(signal);post.mockRejectedValueOnce(new Error('unavailable'));
 await expect(broker.call('kit_mail',{sender:'me'},signal)).rejects.toThrow();
 expect(run).not.toHaveBeenCalled();
 for(const change of [{image:'sha256:'+'2'.repeat(64)},{denials:['mcp__loom__kit_*']}]){
   const no=kitBroker({repository:tool.repository,commit:tool.commit,image:tool.image,denials:[],post,run,...change});
   expect(await no.list(signal)).toEqual([]);
 }
});
it('qualifies both eligible tools with the same declared name',async()=>{
 const {broker,post}=fixture();
 post.mockResolvedValueOnce({tools:[item],next:{kit:'desk',tool:'mail'}}).mockResolvedValueOnce({tools:[{...item,kit:'other'}]});
 const list=await broker.list(signal);
 expect(list).toHaveLength(2);
 expect(list[0].name).toMatch(/^kit_mail_desk_[a-f0-9]{16}$/);
 expect(list[1].name).toMatch(/^kit_mail_other_[a-f0-9]{16}$/);
});
it('closes the catalogue visibly if the harness has no room for every tool',async()=>{
 const {broker,post,run}=fixture();
 for(let i=0;i<63;i++)post.mockResolvedValueOnce({tools:[{...item,kit:'k'+i}],next:{kit:'k'+i,tool:'mail'}});
 await expect(broker.list(signal)).rejects.toThrow('more kit tools');
 await expect(broker.call('kit_mail',{sender:'me'},signal)).rejects.toThrow();
 expect(run).not.toHaveBeenCalled();
});
it('can retry failed discovery and records a malformed argument without its value',async()=>{
 const {broker,post,run}=fixture();
 post.mockRejectedValueOnce(Error('try again'));
 await expect(broker.list(signal)).rejects.toThrow();
 await broker.list(signal);
 await expect(broker.call('kit_mail',{sender:'../hidden'},signal)).rejects.toThrow();
 expect(post.mock.calls.map(([verb])=>verb)).toEqual(['list','list','refuse']);
 expect(JSON.stringify(post.mock.calls)).not.toContain('hidden');
 expect(run).not.toHaveBeenCalled();
});
