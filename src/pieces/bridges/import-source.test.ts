import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, openSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readBridgeInventory, type BridgeSourceFile, type BridgeSourceKind } from './import-source.js';
const io = vi.hoisted(()=>({ afterStat: undefined as (()=>void) | undefined, forbidWholeFile: false }));
vi.mock('node:fs',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs')>();
  return {...actual,openSync:vi.fn(actual.openSync),readSync:vi.fn(actual.readSync),
    readFileSync:vi.fn((...args:Parameters<typeof actual.readFileSync>)=>{
      if(io.forbidWholeFile)throw Error('unbounded whole-file read');
      return actual.readFileSync(...args);
    }),
    fstatSync:(...args:Parameters<typeof actual.fstatSync>)=>{
      const stat=actual.fstatSync(...args),hook=io.afterStat;io.afterStat=undefined;hook?.();return stat;
    },
  };
});
const roots: string[] = [];
afterEach(()=>{io.afterStat=undefined;io.forbidWholeFile=false;vi.clearAllMocks();for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});});
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'bridges-source-'));roots.push(root);
  const file=(name:string,kind:BridgeSourceKind,value:unknown):BridgeSourceFile=>{
    const path=join(root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value));return {name,path,kind};
  };
  return {root,file};
}
describe('offline legacy Bridges source inventory',()=>{
  it('reads actual shuttle shapes without opening configured paths or leaking ignored fields',()=>{
    const {file,root}=fixture();
    const secret=join(root,'do-not-open');mkdirSync(secret);
    const sources=[file('agent/shuttle.json','shuttle',{agent:{slug:'art'},secrets:secret,secret_cmd:'exit 99',ext:secret,
      discord:{},slack:{secrets_env:'art-slack'},channel_notes:{notes_channels:'work'}}),
    file('agent/people.json','people',{people:{jonathan:{name:'ignored private label',tier:3,grants:['ignored'],discord:['123'],slack:{T1:['U1']}}},agents:{peer:{discord:'456'}}}),
    file('agent/routes.json','routes',{guild:'789',bots:{art:'100'},bot_roles:{art:['200','201']},
      channels:{'300':{name:'ignored name',primary:'art',peer:true,pair:'pair-name',guest_venue:true,readers:['jonathan']}},
      threads:{'400':{primary:'peer',parent:'300'}},only:['300'],ignore:{'500':1},webhook_peers:{'600':'peer'},notify:{general:'300'},peer_turns_each:4})];
    const before=sources.map(f=>readFileSync(f.path));
    const v=readBridgeInventory(sources);
    expect(v.instances).toEqual([{source:'agent/shuttle.json',agent:'art',discordSecret:'discord-token',slackBundle:'art-slack',channelNotes:{notes_channels:'work'}}]);
    expect(v.accounts).toEqual([{source:'agent/people.json',owner:'jonathan',kind:'person',platform:'discord',user:'123'},
      {source:'agent/people.json',owner:'jonathan',kind:'person',platform:'slack',workspace:'T1',user:'U1'},
      {source:'agent/people.json',owner:'peer',kind:'agent',platform:'discord',user:'456'}]);
    expect(v.routes[0]).toEqual({source:'agent/routes.json',guild:'789',bots:{art:'100'},botRoles:{art:['200','201']},
      channels:[{channel:'300',thread:false,primary:'art',peer:true,pair:'pair-name',guest:true,readers:['jonathan']},
        {channel:'400',thread:true,primary:'peer',parent:'300',peer:false,guest:false,readers:[]}],only:['300'],ignore:['500'],webhookPeers:{'600':'peer'},notify:{general:'300'},peerTurnsEach:4});
    expect(JSON.stringify(v)).not.toMatch(/ignored|exit 99|do-not-open|tier|grants/);
    expect(sources.map(f=>readFileSync(f.path))).toEqual(before);
  });
  it('opens only selected files and bounds descriptor IO when the source grows after stat',()=>{
    const {file}=fixture();const f=file('people.json','people',{});
    vi.clearAllMocks();io.forbidWholeFile=true;
    expect(readBridgeInventory([f]).accounts).toEqual([]);
    expect(vi.mocked(openSync).mock.calls.map(call=>call[0])).toEqual([f.path]);
    expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
    vi.clearAllMocks();
    io.afterStat=()=>writeFileSync(f.path,Buffer.alloc(9*1024*1024,32));
    expect(()=>readBridgeInventory([f])).toThrow('Invalid offline');
    const reads=vi.mocked(readSync).mock.calls;
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(call=>Buffer.isBuffer(call[1])&&call[1].byteLength<=8*1024*1024+1)).toBe(true);
    expect(reads.reduce((sum,call)=>sum+Number(call[3]),0)).toBeLessThanOrEqual(8*1024*1024+1);
    expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
  });
  it('retains ambiguous account and primary claims for importer refusal instead of picking a winner',()=>{
    const {file}=fixture();
    const v=readBridgeInventory([file('a/people.json','people',{people:{a:{discord:'123'},b:{discord:'123'}},agents:{peer:{discord:'123'}}}),
      file('a/routes.json','routes',{channels:{'1':{primary:'a'}}}),file('b/routes.json','routes',{channels:{'1':{primary:'b'}}})]);
    expect(v.accounts.map(a=>[a.owner,a.kind,a.user])).toEqual([['a','person','123'],['b','person','123'],['peer','agent','123']]);
    expect(v.routes.map(r=>r.channels[0].primary)).toEqual(['a','b']);
  });
  it('keeps Slack bundle references separate from missing token/app/workspace/bot mapping',()=>{
    const {file}=fixture();
    const v=readBridgeInventory([file('pieces/slack/settings.json','slack-settings',{SLACK_BOTS:'{"art":"slack-bundle"}',SLACK_TOKEN_FILE:'/never/read',SLACK_BOT_TOKEN:'private-value'}),
      file('pieces/discord/settings.json','discord-settings',{DISCORD_BOTS:{art:'discord-secret'}})]);
    expect(v.settings).toEqual([{source:'pieces/discord/settings.json',platform:'discord',bots:{art:'discord-secret'}},
      {source:'pieces/slack/settings.json',platform:'slack',bots:{art:'slack-bundle'}}]);
    expect(JSON.stringify(v)).not.toMatch(/private-value|never\/read|tokenSecret|appSecret|workspace|botUser/);
  });
  it('binds checksum to names, kinds and all bytes including ignored metadata, independent of argument order',()=>{
    const {file}=fixture();const a=file('a/people.json','people',{people:{a:{discord:'1'}}}),b=file('b/routes.json','routes',{});
    const v=readBridgeInventory([a,b]);expect(readBridgeInventory([b,a])).toEqual(v);
    writeFileSync(a.path,'{"people":{"a":{"discord":"1"}},"_comment":"changed"}');
    expect(readBridgeInventory([a,b]).checksum).not.toBe(v.checksum);
    expect(readBridgeInventory([{...a,name:'c/people.json'},b]).checksum).not.toBe(v.checksum);
  });
  it('accepts exact safe numeric legacy ids and refuses lossy numbers',()=>{
    const {file}=fixture();const f=file('people.json','people',{people:{a:{discord:123,slack:{T1:456}}}});
    expect(readBridgeInventory([f]).accounts.map(a=>a.user)).toEqual(['123','456']);
    writeFileSync(f.path,'{"people":{"a":{"discord":9007199254740993}}}');expect(()=>readBridgeInventory([f])).toThrow('Invalid offline');
  });
  it('refuses malformed, duplicate, traversal, unknown leaf, oversized, symlink and nonregular inputs with sanitized errors',()=>{
    const {file,root}=fixture();const f=file('people.json','people',{});
    for (const sources of [[],[f,f],[{...f,name:'../people.json'}],[{...f,path:join(root,'credential.env')}],[{...f,name:'/people.json'}]]) {
      expect(()=>readBridgeInventory(sources)).toThrow('Invalid offline Bridges configuration inventory');
    }
    writeFileSync(f.path,'{"people":{"a":{"discord":true}},"private":"SENTINEL"}');
    expect(()=>readBridgeInventory([f])).toThrow(/^Invalid offline Bridges configuration inventory$/);
    writeFileSync(f.path,Buffer.alloc(8*1024*1024+1,32));expect(()=>readBridgeInventory([f])).toThrow('Invalid offline');
    const target=file('target/people.json','people',{});rmSync(f.path);symlinkSync(target.path,f.path);
    expect(()=>readBridgeInventory([f])).toThrow('Invalid offline');
    rmSync(f.path);mkdirSync(f.path);expect(()=>readBridgeInventory([f])).toThrow('Invalid offline');
  });
});
