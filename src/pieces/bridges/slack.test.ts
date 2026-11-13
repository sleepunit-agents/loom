import { describe, expect, it, vi } from 'vitest';
import { slackMessage, type SlackConversation } from './slack.js';
import { keyFor, venueSchema } from './model.js';
import { eventTime } from './time.js';

const io = vi.hoisted(() => ({attempt:vi.fn(() => {throw new Error('Slack intake attempted IO');})}));
vi.mock('node:fs', async original => ({...await original<typeof import('node:fs')>(),readFileSync:io.attempt,writeFileSync:io.attempt,readFile:io.attempt,writeFile:io.attempt}));
vi.mock('node:fs/promises', async original => ({...await original<typeof import('node:fs/promises')>(),readFile:io.attempt,writeFile:io.attempt}));
vi.mock('node:http', async original => ({...await original<typeof import('node:http')>(),request:io.attempt,get:io.attempt}));
vi.mock('node:https', async original => ({...await original<typeof import('node:https')>(),request:io.attempt,get:io.attempt}));
const venue = venueSchema.parse({id:'kit',platform:'slack',agent:'kit',workspace:'T1',bot:'UK1T',tokenSecret:'slack'});
const dm: SlackConversation = {id:'D1',workspace:'T1',kind:'dm',members:[{user:'U1',name:'Robin'},{user:'U2',name:'Sam'},{user:'UK1T',name:'Kit Bot'}]};
const raw = (extra: Record<string,unknown>={}) => ({type:'message',channel:'D1',user:'U1',ts:'1793828004.242749',text:'hello',...extra});
const convert = (extra: Record<string,unknown>={}, c=dm) => slackMessage(raw(extra),venue,c);

describe('Slack intake contract',()=>{
  it('preserves sender and event time, and ignores envelope event time',()=>{
    const m=convert({event_ts:'1793828999.999999'})!;
    expect(m).toMatchObject({id:'1793828004.242749',user:'U1',channel:'D1',dm:true,group:false,label:'DM with Robin',text:'hello'});
    expect(m.at).toBeUndefined();
    expect(eventTime('slack',m.id,m.at)).toBe('2026-11-04T21:33:24.242Z');
    expect(convert({user:'U2'})!.label).toBe('DM with Sam');
    expect(convert({user:'U9'})!.label).toBe('DM');
  });
  it('rejects own, bot, edit, join, delete, wrong-type and malformed events',()=>{
    for (const extra of [{user:'UK1T'},{bot_id:'B1'},{subtype:'message_changed'},{subtype:'channel_join'},
      {subtype:'message_deleted'},{type:'reaction_added'},{user:undefined},{ts:undefined},{text:7},{files:[{name:'no-id'}]}]) expect(convert(extra)).toBeNull();
    expect(slackMessage(null,venue,dm)).toBeNull();
    expect(convert({subtype:null})).not.toBeNull();
    expect(convert({subtype:'file_share',text:undefined})).not.toBeNull();
  });
  it('requires matching workspace and conversation metadata',()=>{
    expect(convert({team:'T1'})).not.toBeNull();
    expect(convert({team:'T2'})).toBeNull();
    expect(convert({channel:'D2'})).toBeNull();
    expect(convert({}, {...dm,workspace:'T2'})).toBeNull();
    expect(slackMessage(raw(),{...venue,platform:'discord'},dm)).toBeNull();
    expect(slackMessage(raw(),venue,{...dm,kind:'channel'} as unknown as SlackConversation)).toBeNull();
    expect(slackMessage(raw(),venue,{...dm,members:[{user:'bad id'}]})).toBeNull();
  });
  it.each(['','1','-1.2','1e3.0','1.2x','9'.repeat(13)+'.1'])('rejects malformed Slack timestamp %s',ts=>{
    expect(convert({ts})).toBeNull();
    expect(convert({thread_ts:ts})).toBeNull();
  });
  it('keeps DM/group continuity while preserving the reply thread address',()=>{
    const reply=convert({thread_ts:'1793828000.000001',parent_user_id:'UK1T'})!;
    expect(reply.thread).toBe('1793828000.000001');
    expect(keyFor(venue,reply,'robin')).toEqual(keyFor(venue,convert()!,'robin'));
    expect(convert({thread_ts:raw().ts})!.thread).toBeUndefined();
    const group: SlackConversation={...dm,id:'G1',kind:'group'};
    const m=convert({channel:'G1',thread_ts:'1793828000.000001'},group)!;
    expect(m).toMatchObject({dm:false,group:true,thread:'1793828000.000001',label:'group DM with Robin, Sam'});
    expect(keyFor(venue,m,'robin').venue).toBe('slack:T1:group:G1');
    expect(convert({channel:'G1'},{...group,kind:'dm'})!.group).toBe(true);
  });
  it('cleans real mentions and links before decoding escapes exactly once',()=>{
    expect(convert({text:'hi <@U2|untrusted> and <@U9|Owner>, <@UK1T>, see <https://x.y|this> or <http://x.y>'})!.text)
      .toBe('hi @Sam and @someone, @kit, see this (https://x.y) or http://x.y');
    expect(convert({text:'<@UK1T> is 3 &lt; 4 &amp;&amp; 5 &gt; 2? &amp;lt;b&amp;gt;'})!.text)
      .toBe('@kit is 3 < 4 && 5 > 2? &lt;b&gt;');
    const m=convert({text:'type &lt;@U1&gt; or &lt;@UK1T&gt; &lt;https://x.y|this&gt;'})!;
    expect(m.text).toBe('type <@U1> or <@UK1T> <https://x.y|this>');
    expect(m.mentions).toEqual([]);
  });
  it('uses human names only, counts unknown people and deduplicates member ids',()=>{
    const c: SlackConversation={...dm,id:'G1',kind:'group',members:[...dm.members,{user:'U2',name:'Sam'},{user:'U3'}]};
    expect(convert({channel:'G1'},c)!.label).toBe('group DM with Robin, Sam and 1 more');
    expect(convert({channel:'G1'},{...c,members:[]})!.label).toBe('group DM');
    expect(convert({}, {...dm,members:[{user:'U1',name:'Ro\nbin\t'}]})!.label).toBe('DM with Ro bin');
  });
  it('bounds labels to 80 UTF16 units with whole group names',()=>{
    const names=['Alexandra Whitfield','Bartholomew Ng','Christopher Ruiz','Dominique Park','Evangeline Moss','Fitzgerald Kahananui','Gwendolyn Ortiz'];
    const members=names.map((name,i)=>({user:`U${i}`,name}));
    const c: SlackConversation={id:'G1',workspace:'T1',kind:'group',members};
    const label=convert({channel:'G1'},c)!.label!;
    expect(label.length).toBeLessThanOrEqual(80);
    expect(label).toBe('group DM with Alexandra Whitfield, Bartholomew Ng, Christopher Ruiz and 4 more');
    expect(convert({channel:'G1'},{...c,members:[{user:'U1',name:'😀'.repeat(40)}]})!.label).toBe('group DM with 1 people');
    expect(convert({}, {...dm,members:[{user:'U1',name:'😀'.repeat(50)}]})!.label).toBe('DM with '+'😀'.repeat(36));
  });
  it('preserves file descriptions without network/filesystem IO or input mutation',()=>{
    const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(io.attempt);
    io.attempt.mockClear();
    try {
      const event=raw({subtype:'file_share',files:[{id:'F1',name:'report.pdf',url_private:'https://files.slack.com/private'}]});
      const before=structuredClone({event,venue,dm});
      expect(slackMessage(event,venue,dm)!.text).toBe('hello [file: report.pdf]');
      expect({event,venue,dm}).toEqual(before);
      expect(io.attempt).not.toHaveBeenCalled();
    } finally {fetch.mockRestore();}
  });
});
