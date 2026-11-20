import { describe, expect, it, vi } from 'vitest';
import { discordMessage, type DiscordChannel } from './discord.js';
import { addressed } from './routing.js';
import { routeSchema, venueSchema } from './model.js';

const io = vi.hoisted(() => ({attempt: vi.fn(() => {throw new Error('Discord intake attempted IO');})}));
// Guard the intake boundary, including named imports, without changing the test runner's IO.
vi.mock('node:fs', async original => ({...await original<typeof import('node:fs')>(),
  readFileSync:io.attempt,writeFileSync:io.attempt,readFile:io.attempt,writeFile:io.attempt}));
vi.mock('node:fs/promises', async original => ({...await original<typeof import('node:fs/promises')>(),readFile:io.attempt,writeFile:io.attempt}));
vi.mock('node:http', async original => ({...await original<typeof import('node:http')>(),request:io.attempt,get:io.attempt}));
vi.mock('node:https', async original => ({...await original<typeof import('node:https')>(),request:io.attempt,get:io.attempt}));

const art = venueSchema.parse({id:'art',platform:'discord',agent:'art',workspace:'1',bot:'100',tokenSecret:'discord',botRoles:['900']});
const mark = venueSchema.parse({...art,id:'mark',agent:'mark',bot:'101',botRoles:['901']});
const channel: DiscordChannel = {id:'300',kind:'channel',name:'general'};
const route = routeSchema.parse({id:'primary',platform:'discord',workspace:'1',channel:'300',primary:'art'});
const raw = (extra: Record<string,unknown>={}) => ({id:'1234567890123456789',channel_id:'300',guild_id:'1',type:0,
  content:'hello',author:{id:'200'},mentions:[],mention_roles:[],timestamp:'2026-11-12T17:00:00.123456Z',...extra});
const convert = (extra: Record<string,unknown>={}, ch=channel) => discordMessage(raw(extra),art,ch,[art,mark]);

describe('Discord intake contract',()=>{
  it('distinguishes automatic reply pings, unresolved text and explicit resolved summons',()=>{
    for (const extra of [{mentions:[{id:'101'}]}, {content:'<@101>'}]) {
      const m=convert(extra)!;
      expect(m.mentions).toEqual([]);
      expect(addressed(art,m,route,[art,mark])).toBe(true);
      expect(addressed(mark,m,route,[art,mark])).toBe(false);
    }
    for (const content of ['<@101> hello','<@!101> hello']) {
      const m=convert({content,mentions:[{id:'101'}]})!;
      expect(addressed(art,m,route,[art,mark])).toBe(false);
      expect(addressed(mark,m,route,[art,mark])).toBe(true);
    }
  });
  it('resolves only written, resolved managed bot roles in this workspace',()=>{
    expect(convert({content:'<@&901>',mention_roles:['901']})!.mentions).toEqual(['101']);
    for (const extra of [{content:'<@&901>'},{mention_roles:['901']},{content:'<@&999>',mention_roles:['999']}]) expect(convert(extra)!.mentions).toEqual([]);
    const other = venueSchema.parse({...mark,workspace:'2'});
    expect(discordMessage(raw({content:'<@&901>',mention_roles:['901']}),art,channel,[art,other])!.mentions).toEqual([]);
    expect(convert({content:'<@101> <@&901>',mentions:[{id:'101'}],mention_roles:['901']})!.mentions).toEqual(['101']);
  });
  it('requires known peers and explicit summons in peer routes',()=>{
    const peer=routeSchema.parse({...route,peer:true});
    const m=convert({author:{id:'101',bot:true},content:'<@100>',mentions:[{id:'100'}]})!;
    expect(addressed(art,m,route,[art,mark])).toBe(false);
    expect(addressed(art,m,peer,[art,mark])).toBe(true);
    expect(addressed(art,{...m,user:'999'},peer,[art,mark])).toBe(false);
    expect(addressed(art,{...m,mentions:[]},peer,[art,mark])).toBe(false);
  });
  it('keeps thread identity, parent routing and safe labels without the starter text',()=>{
    const thread: DiscordChannel={id:'400',kind:'thread',parent:'300',name:'private starter text',parentName:'general'};
    const m=convert({channel_id:'400'},thread)!;
    expect(m).toMatchObject({channel:'400',thread:'400',parent:'300',label:'#general thread'});
    expect(convert({channel_id:'400'},{...thread,parentName:undefined})!.label).toBe('thread');
    expect(addressed({...art,ignore:['300']},m,route,[art,mark])).toBe(false);
    expect(addressed({...art,only:['300']},m,route,[art,mark])).toBe(true);
    expect(convert({channel_id:'400'},{...thread,parent:undefined})).toBeNull();
  });
  it('rejects own, system, malformed and workspace/channel mismatched events',()=>{
    for (const extra of [{author:{id:'100'}},{type:6},{guild_id:'2'},{guild_id:undefined},{channel_id:'999'},{mentions:['100']},{id:12}]) expect(convert(extra)).toBeNull();
    expect(convert({type:19})).not.toBeNull();
    expect(discordMessage(null,art,channel,[art])).toBeNull();
  });
  it.each(['0','-1','01','1.5','1e3','18446744073709551616','9'.repeat(100)])('rejects noncanonical or out-of-range snowflake %s',id=>{
    for (const extra of [{id},{author:{id}},{mentions:[{id}]},{mention_roles:[id]},{webhook_id:id}]) expect(convert(extra)).toBeNull();
  });
  it('accepts the full positive uint64 snowflake range without numeric rounding',()=>{
    for (const id of ['1','18446744073709551615']) expect(convert({id})!.id).toBe(id);
  });
  it('accepts direct messages only without a guild and preserves original time and words',()=>{
    const dm: DiscordChannel={id:'300',kind:'dm'};
    expect(convert({},dm)).toBeNull();
    const m=convert({guild_id:undefined},dm)!;
    expect(m).toMatchObject({dm:true,text:'hello',at:'2026-11-12T17:00:00.123456Z',label:'Direct message'});
    expect(convert({timestamp:undefined})!.at).toBeUndefined();
    expect(convert({timestamp:'bad'})!.at).toBe('bad'); // Engine holds it; never replace with receipt time.
    expect(addressed(art,m,undefined,[art,mark])).toBe(true);
  });
  it('retains attachment descriptions as text without fetching their URLs',()=>{
    const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(io.attempt);
    io.attempt.mockClear();
    try {
      const event=raw({attachments:[{filename:'report.pdf',url:'https://cdn.discordapp.com/attachments/report.pdf'}]});
      const bots=[art,mark], before=structuredClone({event,art,channel,bots});
      expect(discordMessage(event,art,channel,bots)!.text)
        .toBe('hello [attachment: report.pdf https://cdn.discordapp.com/attachments/report.pdf]');
      expect({event,art,channel,bots}).toEqual(before);
      expect(convert({attachments:[{filename:'report.pdf'}]})).toBeNull();
      expect(io.attempt).not.toHaveBeenCalled();
    } finally {fetch.mockRestore();}
  });
});
