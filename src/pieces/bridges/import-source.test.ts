import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, openSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readBridgeInventory, type BridgeSourceFile, type BridgeSourceKind } from './import-source.js';
const io = vi.hoisted(()=>({ afterStat: undefined as (()=>void) | undefined, forbidWholeFile: false, nonregular: false }));
vi.mock('node:fs',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs')>();
  return {...actual,openSync:vi.fn(actual.openSync),readSync:vi.fn(actual.readSync),
    readFileSync:vi.fn((...args:Parameters<typeof actual.readFileSync>)=>{
      if(io.forbidWholeFile)throw Error('unbounded whole-file read');
      return actual.readFileSync(...args);
    }),
    fstatSync:(...args:Parameters<typeof actual.fstatSync>)=>{
      const stat=actual.fstatSync(...args),hook=io.afterStat;io.afterStat=undefined;hook?.();return io.nonregular ? {...stat,isFile:()=>false} : stat;
    },
  };
});
const roots: string[] = [];
afterEach(()=>{io.afterStat=undefined;io.forbidWholeFile=false;io.nonregular=false;vi.clearAllMocks();for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});});
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
      discord:{token_file:'art-discord'},slack:{secrets_env:'art-slack'},channel_notes:{notes_channels:'work'}}),
    file('agent/people.json','people',{people:{jonathan:{name:'ignored private label',tier:3,grants:['ignored'],discord:['123'],slack:{T1:['U1']}}},agents:{peer:{discord:'456'}}}),
    file('agent/routes.json','routes',{guild:'789',bots:{art:'100'},bot_roles:{art:['200','201']},
      channels:{'300':{name:'ignored name',primary:'art',peer:true,pair:'pair-name',guest_venue:true,readers:['jonathan']}},
      threads:{'400':{primary:'peer',parent:'300'}},only:['300'],ignore:{'500':1},webhook_peers:{'600':'peer'},notify:{general:'300'},peer_turns_each:4})];
    const before=sources.map(f=>readFileSync(f.path));
    const v=readBridgeInventory(sources);
    expect(v.instances).toEqual([{source:'agent/shuttle.json',agent:'art',discordSecret:'art-discord',slackBundle:'art-slack',channelNotes:{notes_channels:'work'}}]);
    expect(v.accounts).toEqual([{source:'agent/people.json',owner:'jonathan',kind:'person',platform:'discord',user:'123'},
      {source:'agent/people.json',owner:'jonathan',kind:'person',platform:'slack',workspace:'T1',user:'U1'},
      {source:'agent/people.json',owner:'peer',kind:'agent',platform:'discord',user:'456'}]);
    expect(v.routes[0]).toEqual({source:'agent/routes.json',guild:'789',bots:{art:'100'},botRoles:{art:['200','201']},
      channels:[{channel:'300',thread:false,primary:'art',peer:true,pair:'pair-name',guest:true,readers:['jonathan']},
        {channel:'400',thread:true,primary:'peer',parent:'300',peer:false,guest:false,readers:[]}],only:['300'],ignore:['500'],webhookPeers:{'600':'peer'},notify:{general:'300'},peerTurnsEach:4});
    expect(JSON.stringify(v)).not.toMatch(/ignored|exit 99|do-not-open|tier|grants/);
    expect(sources.map(f=>readFileSync(f.path))).toEqual(before);
  });
  it('skips underscore keys before validating every nested source map and serialized settings map',()=>{
    const {file}=fixture(), note='PRIVATE_ANNOTATION'.repeat(30);
    const sources=[file('shuttle.json','shuttle',{_updated:note,agent:{slug:'art',_note:note},channel_notes:{_note:note,work:'channels'},slack:{secrets_env:'bundle',workspaces:{_note:note,T1:'Work'}}}),
      file('people.json','people',{_comment:note,agents:{_note:note,art:{discord:'100'}},people:{_note:note,jonathan:{discord:'123',slack:{_note:note,T1:'U1'}}}}),
      file('routes.json','routes',{_comment:note,bots:{_note:note,art:'100'},bot_roles:{_note:note,art:['200']},
        channels:{_note:note,'300':{primary:'art',_note:note,onterris:true}},threads:{_note:note,'400':{parent:'300',_note:note}},
        only:{_note:note,'300':true},ignore:{_note:note,'500':true},guests:{_note:note},webhook_peers:{_comment:'x'.repeat(395),'600':'peer'},notify:{_note:note,general:'300'}}),
      file('pieces/discord/settings.json','discord-settings',{_comment:note,DISCORD_BOTS:JSON.stringify({_note:note,art:'discord-token'})})];
    const before=sources.map(f=>readFileSync(f.path));
    const v=readBridgeInventory(sources);
    expect(v.instances[0]).toMatchObject({slackWorkspaces:{T1:'Work'},channelNotes:{work:'channels'}});
    expect(v.accounts.map(a=>a.user)).toEqual(['123','U1','100']);
    expect(v.routes[0]).toMatchObject({bots:{art:'100'},botRoles:{art:['200']},only:['300'],ignore:['500'],webhookPeers:{'600':'peer'},notify:{general:'300'}});
    expect(v.routes[0].channels.map(c=>c.channel)).toEqual(['300','400']);
    expect(v.settings[0].bots).toEqual({art:'discord-token'});
    expect(JSON.stringify(v)).not.toContain('PRIVATE_ANNOTATION');
    expect(sources.map(f=>readFileSync(f.path))).toEqual(before);
  });
  it('reports only file and field path for a non-annotation value that still fails validation',()=>{
    const {file}=fixture(),f=file('routes.json','routes',{webhook_peers:{bad:'PRIVATE_VALUE'.repeat(40)}});
    expect(()=>readBridgeInventory([f])).toThrow(/^Invalid offline Bridges configuration inventory: routes.json at \$\["webhook_peers"\]\["bad"\]$/);
  });
  it('retains only supplied platform references, including absent, null and empty sections',()=>{
    const {file}=fixture();
    for (const sections of [{}, {discord:null,slack:null}, {discord:{},slack:{}}]) {
      const inventory=readBridgeInventory([file('shuttle.json','shuttle',{agent:{slug:'art'},...sections})]);
      expect(inventory.instances).toEqual([{source:'shuttle.json',agent:'art',channelNotes:{}}]);
    }
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
    const expectedSources=[a,b].map(f=>{
      const bytes=readFileSync(f.path);
      return {name:f.name,kind:f.kind,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
    });
    expect(v.sources).toEqual(expectedSources);
    expect(v.checksum).toBe(createHash('sha256').update(JSON.stringify(expectedSources)).digest('hex'));
    writeFileSync(a.path,'{"people":{"a":{"discord":"1"}},"_comment":"changed"}');
    expect(readBridgeInventory([a,b]).checksum).not.toBe(v.checksum);
    expect(readBridgeInventory([{...a,name:'c/people.json'},b]).checksum).not.toBe(v.checksum);
  });
  it('accepts exact safe numeric legacy ids and refuses lossy numbers',()=>{
    const {file}=fixture();const f=file('people.json','people',{people:{a:{discord:123,slack:{T1:456}}}});
    expect(readBridgeInventory([f]).accounts.map(a=>a.user)).toEqual(['123','456']);
    writeFileSync(f.path,'{"people":{"a":{"discord":0}},"agents":{"peer":{"discord":0}}}');
    expect(readBridgeInventory([f]).accounts.map(a=>a.user)).toEqual(['0','0']);
    const roleSource=file('routes.json','routes',{bot_roles:{art:[0,123]}});
    expect(readBridgeInventory([roleSource]).routes[0].botRoles).toEqual({art:['0','123']});
    for (const spelling of ['9007199254740993','9007199254740991.1','123.000000000000001','1e2','123.0']) {
      writeFileSync(f.path,`{"people":{"a":{"discord":${spelling}}}}`);
      expect(()=>readBridgeInventory([f])).toThrow('people.json at $["people"]["a"]["discord"]');
    }
  });
  it('refuses nonregular descriptors before reading otherwise valid JSON',()=>{
    const {file}=fixture();const f=file('people.json','people',{});
    vi.clearAllMocks();io.nonregular=true;
    expect(()=>readBridgeInventory([f])).toThrow(/^Invalid offline Bridges configuration inventory$/);
    expect(vi.mocked(readSync)).not.toHaveBeenCalled();
  });
  it('refuses malformed, duplicate, traversal, unknown leaf, oversized, symlink and nonregular inputs with sanitized errors',()=>{
    const {file,root}=fixture();const f=file('people.json','people',{});
    for (const sources of [[],[f,f],[{...f,name:'../people.json'}],[{...f,path:join(root,'credential.env')}],[{...f,name:'/people.json'}]]) {
      expect(()=>readBridgeInventory(sources)).toThrow('Invalid offline Bridges configuration inventory');
    }
    writeFileSync(f.path,'{"people":{"a":{"discord":true}},"private":"SENTINEL"}');
    expect(()=>readBridgeInventory([f])).toThrow('people.json at $["people"]["a"]["discord"]');
    writeFileSync(f.path,'{"private":"PARSER_SENTINEL",');
    expect(()=>readBridgeInventory([f])).toThrow(/^Invalid offline Bridges configuration inventory: people.json at \$$/);
    expect(()=>readBridgeInventory([{...f,path:join(root,'FS_SENTINEL','people.json')}])).toThrow(/^Invalid offline Bridges configuration inventory$/);
    writeFileSync(f.path,Buffer.alloc(8*1024*1024+1,32));expect(()=>readBridgeInventory([f])).toThrow('Invalid offline');
    const target=file('target/people.json','people',{});rmSync(f.path);symlinkSync(target.path,f.path);
    expect(()=>readBridgeInventory([f])).toThrow('Invalid offline');
    rmSync(f.path);mkdirSync(f.path);expect(()=>readBridgeInventory([f])).toThrow('Invalid offline');
  });
});
